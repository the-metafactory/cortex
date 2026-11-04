import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { buildRoutineCard, readRoutines } from "../desk/routines";
import { readRoutineProposal, recordDraftNode } from "../desk/routine-store";
import type { InstalledRoutine, RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { CapabilityRefusalSchema } from "../desk/routine-capability-contract";
import { RoutinesSection } from "../dashboard-v2/components/desk-routines";
import { handleDeskRoutines } from "../api/desk-routines";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";

const OPTIONS: RoutineOptions = { composer: ["compose-retry"], reflex: ["retry-owner"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 1, readTimeoutSeconds: 0.1 };
const NOW = Date.parse("2026-11-04T10:00:00Z");
const YAML = `name: F_RETRY
input:
  text: hello
actions:
  - agent:
      name: echo
      capability: probe.echo
      prompt: 'Echo {text}'
      collect: echoed
  - agent:
      name: review
      capability: probe.review
      prompt: 'Review {echoed}'
      collect: reviewed
`;
const reply = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const node = { ref: "example/builds#21", url: "https://example.test/builds/21", existing: true };

function owner() {
  const installed: InstalledRoutine[] = [];
  let writes = 0;
  let supplied = "";
  let down = false;
  let loseReply = false;
  const run: RoutineRunner = async (argv) => {
    if (argv[0] !== "retry-owner") throw new Error(`Unexpected command: ${argv.join(" ")}`);
    if (down) throw new Error("Owner read unavailable");
    if (argv[1] !== "routine") return reply([]);
    if (argv[2] === "list") return reply(installed);
    expect(argv[2]).toBe("add");
    writes++;
    const flag = (name: string): string => argv[argv.indexOf(name) + 1] ?? "";
    supplied = await readFile(flag("--flow-file"), "utf8");
    installed.push({ id: flag("--id"), schedule: flag("--schedule"), timezone: flag("--timezone"), target: flag("--target"), policy: "approval", paused: false, runtimeConfirmed: true, file: "/owned/retry.yaml", lastDecision: null });
    if (loseReply) { down = true; throw new Error("Lost install reply"); }
    return reply({ installed: true });
  };
  return { run, installed, writes: () => writes, supplied: () => supplied, lose: () => { loseReply = true; }, recover: () => { down = false; loseReply = false; } };
}

describe("retrying saved routine capability drafts", () => {
  let db: Database;
  let proposalId: string;
  let capabilities: Set<string>;
  let backend: ReturnType<typeof owner>;
  let runtime: DeskRuntime;
  const read = () => readRoutines(db, OPTIONS, backend.run, () => capabilities);
  const act = (action: "install" | "discard", requestId = `retry-${action}-request`) => handleDeskRoutines(new Request("http://localhost/api/desk/routines", { method: "POST", body: JSON.stringify({ action, target: proposalId, requestId }) }), db, runtime, backend.run, () => capabilities);

  beforeEach(async () => {
    db = initDatabase(":memory:"); capabilities = new Set(); backend = owner();
    runtime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], routines: OPTIONS }, ledger: new HandledLedger() };
    const card = await buildRoutineCard(db, "every Friday at 17:00, echo and review", OPTIONS, NOW - 172_800_000, () => Promise.resolve(reply({ status: "complete", yaml: YAML })), () => capabilities);
    proposalId = CapabilityRefusalSchema.parse(card.capabilities).proposalId;
    recordDraftNode(db, proposalId, "probe.echo", node);
  });
  afterEach(() => { db.close(); });

  it("names only capabilities still missing as none, some and all come online", async () => {
    expect((await read()).drafts?.[0]?.missing.map((m) => m.capability)).toEqual(["probe.echo", "probe.review"]);
    capabilities.add("probe.echo");
    const partial = await read();
    expect(partial.drafts?.[0]?.missing.map((m) => m.capability)).toEqual(["probe.review"]);
    const partialHtml = renderToStaticMarkup(<RoutinesSection view={partial} onChanged={() => undefined} />);
    expect(partialHtml).toContain("Still missing: probe.review.");
    expect(partialHtml).not.toContain("Ready:");
    expect(partialHtml).not.toContain(">Confirm<");
    capabilities.add("probe.review");
    const ready = await read();
    expect(ready.drafts?.[0]?.proposal?.fields).toEqual({ proposalId, title: "echo and review", schedule: "Every Friday at 17:00 (Europe/Zurich)", steps: ["Ask an agent to echo", "Ask an agent to review"] });
    const html = renderToStaticMarkup(<RoutinesSection view={ready} onChanged={() => undefined} />);
    expect(html).toContain("Ready: echo and review");
    expect(html).toContain("Every Friday at 17:00 (Europe/Zurich)");
    expect(html).toContain("Ask an agent to echo");
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Discard<");
    expect(backend.writes()).toBe(0);
    capabilities.delete("probe.review");
    expect((await read()).drafts?.[0]?.proposal).toBeUndefined();
  });

  it("checks YAML rather than trusting the saved missing list or step labels", async () => {
    db.query("UPDATE desk_routine_proposals SET document = json_set(document, '$.draft.missing', json(?), '$.steps', json(?)) WHERE id = ?").run(JSON.stringify([{ capability: "old.capability", steps: [{ label: "old", prompt: "old", sovereignty: {} }] }]), JSON.stringify(["old label"]), proposalId);
    capabilities = new Set(["old.capability", "probe.echo"]);
    expect((await read()).drafts?.[0]?.missing.map((m) => m.capability)).toEqual(["probe.review"]);
    capabilities.add("probe.review");
    expect((await read()).drafts?.[0]?.proposal?.fields.steps).toEqual(["Ask an agent to echo", "Ask an agent to review"]);
  });

  it("retries drafts without filed nodes or capability-build configuration", async () => {
    db.query("UPDATE desk_routine_proposals SET document = json_set(document, '$.draft.nodes', json('{}')) WHERE id = ?").run(proposalId);
    capabilities = new Set(["probe.echo", "probe.review"]);
    expect((await read()).drafts?.[0]?.proposal?.fields.proposalId).toBe(proposalId);
  });

  it("keeps elapsed schedules in words without adding a wall-clock timezone", async () => {
    const card = await buildRoutineCard(db, "every hour, echo and review", OPTIONS, NOW, () => Promise.resolve(reply({ status: "complete", yaml: YAML })), () => capabilities);
    const elapsed = CapabilityRefusalSchema.parse(card.capabilities).proposalId;
    capabilities = new Set(["probe.echo", "probe.review"]);
    expect((await read()).drafts?.find((draft) => draft.proposalId === elapsed)?.proposal?.fields.schedule).toBe("Every hour");
  });

  it("keeps invalid YAML and changed configuration unwritable with a reason", async () => {
    capabilities = new Set(["probe.echo", "probe.review"]);
    const changed = await readRoutines(db, { ...OPTIONS, target: "@other/pulse-flow" }, backend.run, () => capabilities);
    expect(changed.drafts?.[0]?.error).toContain("configuration changed");
    expect(changed.drafts?.[0]?.proposal).toBeUndefined();
    db.query("UPDATE desk_routine_proposals SET document = json_set(document, '$.yaml', ?) WHERE id = ?").run("name: [", proposalId);
    const invalid = await read();
    expect(invalid.drafts?.[0]?.error).toContain("could not be prepared");
    expect(invalid.drafts?.[0]?.proposal).toBeUndefined();
  });

  it("confirms an older ready draft through the action handler once, preserving the YAML and installed metadata", async () => {
    capabilities = new Set(["probe.echo", "probe.review"]);
    await read();
    const response = await act("install");
    expect(response.status).toBe(200);
    expect(backend.supplied()).toBe(YAML);
    expect(readRoutineProposal(db, proposalId)?.draft).toBeUndefined();
    expect((await read()).drafts).toBeUndefined();
    expect((await read()).installed[0]?.title).toBe("echo and review");
    capabilities.clear();
    expect((await act("install")).status).toBe(200);
    expect((await act("install", "different-confirm-id")).status).toBe(409);
    expect(backend.writes()).toBe(1);
  });

  it("rechecks capability presence at Confirm and leaves the draft when one goes offline", async () => {
    capabilities = new Set(["probe.echo", "probe.review"]);
    await read(); capabilities.delete("probe.review");
    const response = await act("install");
    expect(response.status).toBe(409);
    const result = await response.json() as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("probe.review");
    expect(readRoutineProposal(db, proposalId)?.draft).toBeDefined();
    expect(backend.writes()).toBe(0);
  });

  it("retains an uncertain install until read reconciliation confirms it, then replays without installing again", async () => {
    capabilities = new Set(["probe.echo", "probe.review"]); backend.lose();
    expect((await act("install")).status).toBe(409);
    expect(readRoutineProposal(db, proposalId)?.draft).toBeDefined();
    expect((await act("discard")).status).toBe(409);
    backend.recover();
    const reconciled = await read();
    expect(reconciled.changes).toHaveLength(0);
    expect(reconciled.drafts).toBeUndefined();
    expect(readRoutineProposal(db, proposalId)?.draft).toBeUndefined();
    expect((await act("install")).status).toBe(200);
    expect(backend.writes()).toBe(1);
  });

  it("does not install a draft discarded while the owner read was pending", async () => {
    capabilities = new Set(["probe.echo", "probe.review"]);
    let release = (): void => undefined;
    let started = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const delayed: RoutineRunner = async (argv, stdin, timeoutMs) => {
      if (argv[2] === "list") { started(); await blocked; }
      return backend.run(argv, stdin, timeoutMs);
    };
    const confirming = handleDeskRoutines(new Request("http://localhost/api/desk/routines", { method: "POST", body: JSON.stringify({ action: "install", target: proposalId, requestId: "discard-racing-install" }) }), db, runtime, delayed, () => capabilities);
    await reading;
    expect((await act("discard")).status).toBe(200);
    release();
    expect((await confirming).status).toBe(409);
    expect(backend.writes()).toBe(0);
  });

  it.each([false, true])("discards a draft with ready=%s, leaving its nodes and owner untouched", async (ready) => {
    if (ready) capabilities = new Set(["probe.echo", "probe.review"]);
    expect((await read()).drafts?.[0]?.nodes[0]?.ref).toBe(node.ref);
    expect((await act("discard")).status).toBe(200);
    expect(readRoutineProposal(db, proposalId)).toBeNull();
    expect((await read()).drafts).toBeUndefined();
    expect((await act("discard")).status).toBe(200);
    expect((await act("install")).status).toBe(409);
    expect(backend.writes()).toBe(0);
  });
});
