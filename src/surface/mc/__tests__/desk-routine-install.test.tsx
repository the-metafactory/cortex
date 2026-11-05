import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { buildRoutineCard } from "../desk/routines";
import { buildRoutineCapabilities } from "../desk/routine-capability";
import { CapabilityRefusalSchema } from "../desk/routine-capability-contract";
import { readDraftViews } from "../desk/routine-draft-state";
import { actOnCapabilityInstall, runCapabilityInstalls } from "../desk/routine-install";
import { readCapabilityInstall } from "../desk/routine-install-store";
import { discardRoutineDraft } from "../desk/routine-store";
import { HandledLedger } from "../desk/actions";
import { readDone, setGrant } from "../desk/autonomy";
import { composeDesk, type DeskRuntime, type DeskOptions } from "../desk/compose";
import { handleDeskRoutines } from "../api/desk-routines";
import { handleDeskAutonomy } from "../api/desk-action";
import { RoutineDrafts } from "../dashboard-v2/components/desk-routine-drafts";
import { DoneForYou } from "../dashboard-v2/components/desk-view";
import { RoutineOptionsSchema, type RoutineOptions } from "../../../common/types/desk-routines";
import type { RoutineRunner } from "../desk/routine-command";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { submitCapabilityInstall } from "../dashboard-v2/lib/desk-capability-install";
import { startDeskAutonomy } from "../desk/push";

const OPTIONS: RoutineOptions = {
  composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "UTC", timeoutSeconds: 1, readTimeoutSeconds: 0.1,
  capabilityBuild: { writer: ["writer"], map: "example/maps#12", status: ["status", "{ref}"], pack: "example-pack", install: ["install-pack", "{pack}"], uninstall: ["uninstall-pack", "{pack}"], budget: { tokens: 1000, invocations: 10, minutes: 5 } },
};
const YAML = "name: F_AGENT\nactions:\n  - agent:\n      name: judge\n      capability: compose.judgment\n      prompt: Judge\n      collect: result\n";
const NOW = Date.parse("2026-11-05T12:00:00Z");
const none = () => new Set<string>();
const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" });
const post = (body: unknown) => new Request("http://localhost/api/desk/routines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runtime = (): DeskRuntime & { options: DeskOptions } => ({ options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], routines: OPTIONS }, ledger: new HandledLedger() });

function harness() {
  const calls: string[][] = [];
  let state = "merged";
  let ref = "example/maps#21";
  let install: RoutineRunner = () => ok();
  const run: RoutineRunner = (argv, stdin, timeoutMs) => {
    if (argv[0] === "composer") return ok(JSON.stringify({ status: "complete", yaml: YAML }));
    if (argv[0] === "writer") return ok(JSON.stringify({ ref, url: "https://example.test/build/21", existing: true }));
    if (argv[0] === "status") return ok(JSON.stringify({ state }));
    if (argv[0]?.endsWith("install-pack")) { calls.push(argv); return install(argv, stdin, timeoutMs); }
    return ok("[]");
  };
  return { calls, run, setState: (value: string) => { state = value; }, setRef: (value: string) => { ref = value; }, setInstall: (value: RoutineRunner) => { install = value; } };
}

describe("installing a merged capability pack", () => {
  let db: Database;
  let h: ReturnType<typeof harness>;
  let proposalId: string;
  const request = (requestId = "install-request-1") => ({ action: "capability.install" as const, requestId, proposalId, capability: "compose.judgment" });
  const views = (present = none, at = NOW) => readDraftViews(db, OPTIONS, present, h.run, at);
  const html = async (at = NOW) => renderToStaticMarkup(<RoutineDrafts drafts={await views(none, at)} onChanged={() => undefined} />);
  const draft = async () => {
    const card = await buildRoutineCard(db, "every hour, judge a result", OPTIONS, NOW, h.run, none);
    const id = CapabilityRefusalSchema.parse(card.capabilities).proposalId;
    await buildRoutineCapabilities(db, OPTIONS, new HandledLedger(), { requestId: crypto.randomUUID(), proposalId: id }, h.run);
    return id;
  };
  beforeEach(async () => { db = initDatabase(":memory:"); h = harness(); proposalId = await draft(); });
  afterEach(() => { db.close(); });

  it("offers Install and the node link for a merged build, and runs the configured pack command once on confirm", async () => {
    const page = await html();
    expect(page).toContain("Merged, install?");
    expect(page).toContain(">Install</button>");
    expect(page).toContain('href="https://example.test/build/21"');
    expect(h.calls).toHaveLength(0);
    expect((await handleDeskRoutines(post(request()), db, runtime(), h.run, none)).status).toBe(200);
    await handleDeskRoutines(post(request()), db, runtime(), h.run, none);
    expect(h.calls).toEqual([["install-pack", "example-pack"]]);
    expect(await html()).toContain("Installed, waiting for local presence");
  });

  it("keeps the failure reason and Install action, and retries with a new request", async () => {
    h.setInstall(() => Promise.resolve({ code: 2, stdout: "", stderr: "fetch failed\npack release missing\n" }));
    expect(await actOnCapabilityInstall(db, OPTIONS, request(), none, h.run, () => NOW)).toEqual({ ok: false, error: "install failed: pack release missing" });
    const page = await html();
    expect(page).toContain("install failed: pack release missing");
    expect(page).toContain(">Install</button>");
    await actOnCapabilityInstall(db, OPTIONS, request(), none, h.run);
    expect(h.calls).toHaveLength(1);
    h.setInstall(() => ok());
    expect((await actOnCapabilityInstall(db, OPTIONS, request("install-request-2"), none, h.run)).ok).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it("uses the 90-second deadline and shows live only from local presence, even when status later fails", async () => {
    await actOnCapabilityInstall(db, OPTIONS, request(), none, h.run, () => NOW);
    expect(await html(NOW + 89_999)).not.toContain("installed, not in presence yet");
    expect(await html(NOW + 90_000)).toContain("installed, not in presence yet");
    h.setState("unknown-from-owner");
    const live = await views(() => new Set(["compose.judgment"]), NOW + 90_001);
    expect(live[0]?.nodes[0]?.build?.state).toBe("live");
    expect(renderToStaticMarkup(<RoutineDrafts drafts={live} onChanged={() => undefined} />)).toContain("Live");
  });

  it("shares an install across drafts and serializes competing requests for the same pack", async () => {
    const second = await draft();
    const started = Promise.withResolvers<boolean>();
    const installed = Promise.withResolvers<Awaited<ReturnType<RoutineRunner>>>();
    h.setInstall(() => { started.resolve(true); return installed.promise; });
    const first = actOnCapabilityInstall(db, OPTIONS, request(), none, h.run, () => NOW);
    await started.promise;
    expect((await actOnCapabilityInstall(db, OPTIONS, { ...request("install-request-2"), proposalId: second }, none, h.run)).ok).toBe(false);
    installed.resolve({ code: 0, stdout: "", stderr: "" });
    await first;
    expect(h.calls).toHaveLength(1);
    expect((await views()).every((entry) => entry.nodes[0]?.install?.state === "installed")).toBe(true);
  });

  it("refuses changed config, unknown capabilities, unmerged builds and present capabilities without running a pack command", async () => {
    h.setState("in-review");
    expect((await actOnCapabilityInstall(db, OPTIONS, request(), none, h.run)).ok).toBe(false);
    h.setState("merged");
    expect((await actOnCapabilityInstall(db, OPTIONS, request(), () => new Set(["compose.judgment"]), h.run)).ok).toBe(false);
    expect((await actOnCapabilityInstall(db, { ...OPTIONS, timeoutSeconds: 2 }, request(), none, h.run)).ok).toBe(false);
    expect((await actOnCapabilityInstall(db, OPTIONS, { ...request(), capability: "unrelated" }, none, h.run)).ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("preserves an uncertain command across retries rather than sending it twice", async () => {
    h.setInstall(() => Promise.reject(new Error("connection to installer lost")));
    expect(await actOnCapabilityInstall(db, OPTIONS, request(), none, h.run)).toMatchObject({ ok: false, uncertain: true });
    await actOnCapabilityInstall(db, OPTIONS, request("install-request-2"), none, h.run);
    expect(h.calls).toHaveLength(1);
  });

  it("asks by default, promotes without Ranger, and shows Done for you with Undo that uninstalls after draft discard", async () => {
    await runCapabilityInstalls(db, OPTIONS, none, h.run);
    expect(h.calls).toHaveLength(0);
    const rt = runtime();
    expect((await handleDeskAutonomy(post({ action: "capability.install", on: true }), db, rt)).status).toBe(200);
    await runCapabilityInstalls(db, OPTIONS, none, h.run, () => NOW);
    await runCapabilityInstalls(db, OPTIONS, none, h.run, () => NOW + 1000);
    expect(h.calls).toEqual([["install-pack", "example-pack"]]);
    const done = readDone(db, NOW);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ action: "capability.install", status: "done" });
    const desk = await composeDesk(db, rt.options, undefined, { now: NOW, runRoutine: h.run });
    expect(desk.autonomy.types.find((type) => type.action === "capability.install")?.on).toBe(true);
    expect(desk.autonomy.done[0]?.undo).toBe(done[0]?.itemKey);
    const page = renderToStaticMarkup(<DoneForYou autonomy={desk.autonomy} onPromote={() => undefined} onUndo={() => undefined} />);
    expect(page).toContain("Undo");
    discardRoutineDraft(db, proposalId);
    const id = done[0]?.itemKey;
    if (!id) throw new Error("No installation was recorded");
    const uninstall = { action: "capability.uninstall" as const, id };
    expect((await actOnCapabilityInstall(db, OPTIONS, uninstall, none, h.run)).ok).toBe(true);
    expect((await actOnCapabilityInstall(db, OPTIONS, uninstall, none, h.run)).ok).toBe(true);
    expect(h.calls).toEqual([["install-pack", "example-pack"], ["uninstall-pack", "example-pack"]]);
    expect(readDone(db, NOW)).toHaveLength(0);
  });

  it("keeps failed Undo available and stops automatic work after revocation", async () => {
    setGrant(db, "capability.install", true, NOW);
    await runCapabilityInstalls(db, OPTIONS, none, h.run, () => NOW);
    const id = readDone(db, NOW)[0]?.itemKey;
    if (!id) throw new Error("No installation was recorded");
    h.setInstall(() => Promise.resolve({ code: 1, stdout: "", stderr: "uninstall refused" }));
    expect((await actOnCapabilityInstall(db, OPTIONS, { action: "capability.uninstall", id }, none, h.run)).ok).toBe(false);
    expect(readCapabilityInstall(db, id)?.state).toBe("installed");
    setGrant(db, "capability.install", false, NOW);
    await runCapabilityInstalls(db, OPTIONS, none, h.run);
    expect(h.calls).toHaveLength(2);
  });

  it("retires every successful install receipt when Undo removes a shared pack", async () => {
    setGrant(db, "capability.install", true, NOW);
    await runCapabilityInstalls(db, OPTIONS, none, h.run, () => NOW);
    h.setRef("example/maps#22");
    await draft();
    await runCapabilityInstalls(db, OPTIONS, none, h.run, () => NOW + 1000);
    const done = readDone(db, NOW + 1000);
    expect(done).toHaveLength(2);
    const id = done[0]?.itemKey;
    if (!id) throw new Error("No installation was recorded");
    await actOnCapabilityInstall(db, OPTIONS, { action: "capability.uninstall", id }, none, h.run);
    for (const entry of done) {
      expect(readCapabilityInstall(db, entry.itemKey)?.state).toBe("undone");
      await actOnCapabilityInstall(db, OPTIONS, { action: "capability.uninstall", id: entry.itemKey }, none, h.run);
    }
    expect(h.calls.filter((argv) => argv[0] === "uninstall-pack")).toHaveLength(1);
    expect(readDone(db, NOW + 1000)).toHaveLength(0);
  });

  it("starts the capability autonomy loop without Ranger and rechecks a revoked grant after status reads", async () => {
    const loop = startDeskAutonomy(db, runtime());
    expect(loop).not.toBeNull();
    loop?.stop();
    setGrant(db, "capability.install", true, NOW);
    const revokeDuringRead: RoutineRunner = (argv, stdin, timeoutMs) => {
      if (argv[0] === "status") setGrant(db, "capability.install", false, NOW);
      return h.run(argv, stdin, timeoutMs);
    };
    await runCapabilityInstalls(db, OPTIONS, none, revokeDuringRead);
    expect(h.calls).toHaveLength(0);
  });

  it("preserves failure and uncertainty through the browser client on HTTP 409", async () => {
    const original = globalThis.fetch;
    h.setInstall(() => Promise.resolve({ code: 1, stdout: "", stderr: "no release" }));
    globalThis.fetch = ((url, init) => handleDeskRoutines(new Request(`http://localhost${typeof url === "string" ? url : url instanceof URL ? url.pathname : new URL(url.url).pathname}`, init), db, runtime(), h.run, none)) as typeof fetch;
    try {
      expect(await submitCapabilityInstall(request())).toMatchObject({ ok: false, error: "install failed: no release" });
      h.setInstall(() => Promise.reject(new Error("installer connection lost")));
      expect(await submitCapabilityInstall(request("install-request-2"))).toMatchObject({ ok: false, uncertain: true });
    } finally { globalThis.fetch = original; }
  });

  it("requires pack placeholders and complete portable install configuration", () => {
    expect(RoutineOptionsSchema.safeParse(OPTIONS).success).toBe(true);
    for (const change of [{ install: [] }, { install: ["installer"] }, { uninstall: undefined }, { pack: undefined }, { status: undefined }]) {
      expect(RoutineOptionsSchema.safeParse({ ...OPTIONS, capabilityBuild: { ...OPTIONS.capabilityBuild, ...change } }).success).toBe(false);
    }
  });

  it("gates install, Undo and promotion by identity and origin without step-up", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"] } }, db, { desk: runtime().options });
    const base = `http://localhost:${ctx.server.port}`;
    try {
      for (const [path, body] of [["routines", request()], ["routines", { action: "capability.uninstall", id: "install-request-1" }], ["autonomy", { action: "capability.install", on: true }]] as const) {
        const send = (email: string, origin = base) => fetch(`${base}/api/desk/${path}`, { method: "POST", headers: { "content-type": "application/json", origin, "Cf-Access-Authenticated-User-Email": email }, body: JSON.stringify(body) });
        expect((await send("unlisted@example.com")).status).toBe(403);
        expect((await send("principal@example.com", "https://evil.example")).status).toBe(403);
      }
      const allowed = await fetch(`${base}/api/desk/autonomy`, { method: "POST", headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": "principal@example.com" }, body: JSON.stringify({ action: "capability.install", on: true }) });
      expect(allowed.status).toBe(200);
    } finally { ctx.stop(true); }
  });
});
