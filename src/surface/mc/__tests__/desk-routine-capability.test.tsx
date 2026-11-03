import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { buildRoutineCard, actOnRoutine } from "../desk/routines";
import { readRoutineProposal } from "../desk/routine-store";
import { buildRoutineCapabilities } from "../desk/routine-capability";
import { CapabilityBuildResultSchema, CapabilityRefusalSchema } from "../desk/routine-capability-contract";
import type { RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { handleDeskAsk } from "../api/desk-ask";
import { handleDeskRoutineCapability } from "../api/desk-routine-capability";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { ProposalCard } from "../dashboard-v2/components/desk-proposal";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { RoutineOptionsSchema } from "../../../common/types/desk-routines";

const BUILD = { writer: ["capability-writer"], map: "example/maps#12", budget: { tokens: 200_000, invocations: 40, minutes: 60 } };
const BASE: RoutineOptions = { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 10, readTimeoutSeconds: 1 };
const CONFIGURED: RoutineOptions = { ...BASE, capabilityBuild: BUILD };
const NOW = Date.parse("2026-11-03T12:00:00Z");
const AGENT_YAML = "name: F_AGENT\nactions:\n  - agent:\n      name: derive\n      capability: compose.judgment\n      prompt: 'Judge {text}'\n      sovereignty:\n        model_class: local-only\n        frontier_ok: false\n        data_residency: CH\n      collect: result\n";
const TWO_YAML = `name: F_TWO\nactions:\n  - agent:\n      name: derive\n      capability: compose.judgment\n      prompt: 'Judge {text}'\n      collect: a\n  - tribunal:\n      name: review_it\n      seats:\n        - name: skeptic\n          capability: review.adversarial\n          prompt: 'Attack {a}'\n          sovereignty:\n            model_class: frontier\n            frontier_ok: true\n        - name: other\n          capability: compose.judgment\n          prompt: 'Second view on {a}'\n      collect: ruling\n`;

const composer = (yaml: string): RoutineRunner => () => Promise.resolve({ code: 0, stdout: JSON.stringify({ status: "complete", yaml }), stderr: "" });
const none = (): ReadonlySet<string> => new Set();
const REQUEST = "every minute, derive a result";
const post = (body: unknown): Request => new Request("http://localhost/api/desk", { method: "POST", body: JSON.stringify(body) });

interface WriterCall { stdin: Record<string, unknown> }
function fakeWriter(behaviour: (capability: string, call: number) => { code?: number; stdout?: string; stderr?: string; throws?: Error } = (capability) => ({ stdout: JSON.stringify({ ref: `example/maps#${capability.length}`, url: `https://example.test/${capability}`, existing: false }) })) {
  const calls: WriterCall[] = [];
  const run: RoutineRunner = (_argv, stdin) => {
    const parsed = JSON.parse(stdin) as Record<string, unknown>;
    calls.push({ stdin: parsed });
    const outcome = behaviour(String(parsed.capability), calls.length);
    if (outcome.throws) return Promise.reject(outcome.throws);
    return Promise.resolve({ code: outcome.code ?? 0, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" });
  };
  return { run, calls };
}

describe("a missing-capability refusal", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("lists each missing capability with its step, prompt and sovereignty, saves the draft and offers the build when configured", async () => {
    const refused = await buildRoutineCard(db, REQUEST, CONFIGURED, NOW, composer(AGENT_YAML), none);
    expect(refused.unwritable).toBe(true);
    expect(refused.problem).toContain("No fresh online local agent provides compose.judgment");
    const capabilities = CapabilityRefusalSchema.parse(refused.capabilities);
    expect(capabilities.offer).toBe(true);
    expect(capabilities.missing).toEqual([{ capability: "compose.judgment", steps: [{ label: "Ask an agent to derive", prompt: "Judge {text}", sovereignty: { model_class: "local-only", frontier_ok: false, data_residency: "CH" } }] }]);
    const draft = readRoutineProposal(db, capabilities.proposalId);
    expect(draft?.draft?.missing).toEqual(capabilities.missing);
    expect(draft?.yaml).toContain("capability: compose.judgment");
    expect(draft?.draft?.nodes).toEqual({});
  });

  it("groups steps by capability across agent and tribunal seats and omits the offer without configuration", async () => {
    const refused = await buildRoutineCard(db, REQUEST, BASE, NOW, composer(TWO_YAML), none);
    const capabilities = CapabilityRefusalSchema.parse(refused.capabilities);
    expect(capabilities.offer).toBe(false);
    expect(capabilities.missing.map((m) => [m.capability, m.steps.map((s) => s.prompt)])).toEqual([
      ["compose.judgment", ["Judge {text}", "Second view on {a}"]],
      ["review.adversarial", ["Attack {a}"]],
    ]);
    expect(capabilities.missing[1]?.steps[0]?.sovereignty).toEqual({ model_class: "frontier", frontier_ok: true });
    const html = renderToStaticMarkup(<ProposalCard proposal={refused} said={REQUEST} maps={[]} now={NOW} busy={false} onConfirm={() => undefined} onCancel={() => undefined} onGoto={() => undefined} onFieldsChange={() => undefined} />);
    expect(html).toContain("review.adversarial");
    expect(html).toContain("Attack {a}");
    expect(html).toContain("model class: frontier");
    expect(html).not.toContain("Build this capability");
  });

  it("shows the Build this capability action on the card only when the offer is configured", async () => {
    const refused = await buildRoutineCard(db, REQUEST, CONFIGURED, NOW, composer(AGENT_YAML), none);
    const html = renderToStaticMarkup(<ProposalCard proposal={refused} said={REQUEST} maps={[]} now={NOW} busy={false} onConfirm={() => undefined} onCancel={() => undefined} onGoto={() => undefined} onFieldsChange={() => undefined} />);
    expect(html).toContain("Build this capability");
    expect(html).toContain("data residency: CH");
    expect(html).not.toContain("Confirm");
  });

  it("offers nothing and says why for gate, research, targeted and federated steps", async () => {
    const flows: [string, string][] = [
      ["name: F_GATE\nactions:\n  - gate:\n      name: ask\n      prompt: ok?\n", "A gate provider is configured on pulse-flow, not built per routine"],
      ["name: F_TARGET\nactions:\n  - agent:\n      name: derive\n      capability: compose.judgment\n      prompt: x\n      distribution_mode: direct\n      target_assistant: did:example:1\n", "A targeted or federated agent is not a local capability"],
      ["name: F_FED\nactions:\n  - agent:\n      name: derive\n      capability: compose.judgment\n      prompt: x\n      federate:\n        principal: peer\n", "A targeted or federated agent is not a local capability"],
    ];
    for (const [yaml, why] of flows) {
      const refused = await buildRoutineCard(db, REQUEST, CONFIGURED, NOW, composer(yaml), none);
      expect(refused.unwritable).toBe(true);
      expect(refused.capabilities).toBeUndefined();
      expect(refused.problem).toContain(why);
      expect(refused.problem).toContain("cannot supply it");
    }
  });

  it("never installs a draft, even when the capability appears later", async () => {
    const refused = await buildRoutineCard(db, REQUEST, CONFIGURED, NOW, composer(AGENT_YAML), none);
    const proposalId = CapabilityRefusalSchema.parse(refused.capabilities).proposalId;
    const mutations: string[][] = [];
    const run: RoutineRunner = (argv) => { mutations.push(argv); return Promise.resolve({ code: 0, stdout: "[]", stderr: "" }); };
    const result = await actOnRoutine(db, CONFIGURED, { action: "install", target: proposalId, requestId: "install-a-draft" }, NOW, run, () => new Set(["compose.judgment"]));
    expect(result.ok).toBe(false);
    expect(mutations).toHaveLength(0);
  });
});

describe("building a missing capability", () => {
  let db: Database;
  let proposalId: string;
  beforeEach(async () => {
    db = initDatabase(":memory:");
    const refused = await buildRoutineCard(db, REQUEST, CONFIGURED, NOW, composer(TWO_YAML), none);
    proposalId = CapabilityRefusalSchema.parse(refused.capabilities).proposalId;
  });
  afterEach(() => { db.close(); });

  it("runs the writer once per missing capability with the documented input and records each ref on the draft", async () => {
    const writer = fakeWriter();
    const result = await buildRoutineCapabilities(db, CONFIGURED, new HandledLedger(), { requestId: "build-request-1", proposalId }, writer.run);
    expect(result.ok).toBe(true);
    expect(writer.calls.map((c) => c.stdin.capability)).toEqual(["compose.judgment", "review.adversarial"]);
    const first = writer.calls[0]?.stdin;
    expect(first).toMatchObject({ requestId: "build-request-1", capability: "compose.judgment", request: REQUEST, map: "example/maps#12", budget: { tokens: 200_000, invocations: 40, minutes: 60 } });
    expect(String(first?.yaml)).toContain("F_TWO");
    expect((first?.steps as { prompt: string }[]).map((s) => s.prompt)).toEqual(["Judge {text}", "Second view on {a}"]);
    expect(first).not.toHaveProperty("template");
    const draft = readRoutineProposal(db, proposalId)?.draft;
    expect(Object.keys(draft?.nodes ?? {})).toEqual(["compose.judgment", "review.adversarial"]);
    expect(draft?.nodes["compose.judgment"]).toEqual({ ref: "example/maps#16", url: "https://example.test/compose.judgment", existing: false });
    expect(CapabilityBuildResultSchema.parse(result).built).toHaveLength(2);
  });

  it("passes the configured template path to the writer", async () => {
    const writer = fakeWriter();
    const templated = { ...CONFIGURED, capabilityBuild: { ...BUILD, template: "/etc/desk/brief.md" } };
    const card = await buildRoutineCard(db, REQUEST, templated, NOW, composer(TWO_YAML), none);
    const templatedId = CapabilityRefusalSchema.parse(card.capabilities).proposalId;
    await buildRoutineCapabilities(db, templated, new HandledLedger(), { requestId: "build-request-t", proposalId: templatedId }, writer.run);
    expect(writer.calls[0]?.stdin.template).toBe("/etc/desk/brief.md");
  });

  it("answers a second confirm of the same request id from the draft without calling the writer", async () => {
    const writer = fakeWriter();
    const ledger = new HandledLedger();
    const first = await buildRoutineCapabilities(db, CONFIGURED, ledger, { requestId: "build-request-2", proposalId }, writer.run);
    const second = await buildRoutineCapabilities(db, CONFIGURED, ledger, { requestId: "build-request-2", proposalId }, writer.run);
    expect(writer.calls).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it("links an existing node the writer reports", async () => {
    const writer = fakeWriter((capability) => ({ stdout: JSON.stringify({ ref: "example/maps#99", url: "https://example.test/99", existing: capability === "compose.judgment" }) }));
    const result = await buildRoutineCapabilities(db, CONFIGURED, new HandledLedger(), { requestId: "build-request-3", proposalId }, writer.run);
    expect(result.built.find((b) => b.capability === "compose.judgment")?.existing).toBe(true);
    expect(readRoutineProposal(db, proposalId)?.draft?.nodes["compose.judgment"]?.existing).toBe(true);
    expect(result.message).toContain("already filed as example/maps#99");
  });

  it("records nothing for a capability whose writer exits non-zero, times out or answers badly, and a retry with the same request id files it", async () => {
    const failures: { code?: number; stdout?: string; stderr?: string; throws?: Error }[] = [
      { code: 1, stderr: "map unreachable\n" },
      { throws: new Error("Routine command timed out.") },
      { stdout: JSON.stringify({ ref: "", url: "not a url", existing: "yes" }) },
      { stdout: "not json" },
    ];
    for (const [index, failure] of failures.entries()) {
      const requestId = `build-failure-${index}`;
      let healthy = false;
      const writer = fakeWriter((capability) => healthy || capability === "review.adversarial"
        ? { stdout: JSON.stringify({ ref: `example/maps#${index}`, url: "https://example.test/n", existing: false }) }
        : failure);
      const ledger = new HandledLedger();
      const refused = await buildRoutineCapabilities(db, CONFIGURED, ledger, { requestId, proposalId }, writer.run);
      expect(refused.ok).toBe(false);
      expect(refused.failed.map((f) => f.capability)).toEqual(["compose.judgment"]);
      expect(refused.failed[0]?.error.length).toBeGreaterThan(0);
      expect(refused.built.map((b) => b.capability)).toEqual(["review.adversarial"]);
      expect(Object.keys(readRoutineProposal(db, proposalId)?.draft?.nodes ?? {})).toEqual(["review.adversarial"]);
      healthy = true;
      const before = writer.calls.length;
      const retried = await buildRoutineCapabilities(db, CONFIGURED, ledger, { requestId, proposalId }, writer.run);
      expect(retried.ok).toBe(true);
      expect(writer.calls.length - before).toBe(1);
      db.query("UPDATE desk_routine_proposals SET document = json_set(document, '$.draft.nodes', json('{}')) WHERE id = ?").run(proposalId);
    }
  });

  it("says which capability failed and why on the card", async () => {
    const writer = fakeWriter((capability) => capability === "compose.judgment" ? { code: 2, stderr: "label missing" } : { stdout: JSON.stringify({ ref: "example/maps#7", url: "https://example.test/7", existing: false }) });
    const result = await buildRoutineCapabilities(db, CONFIGURED, new HandledLedger(), { requestId: "build-request-4", proposalId }, writer.run);
    expect(result.message).toContain("compose.judgment failed: label missing");
  });

  it("refuses a second concurrent filing of the same request and capability", async () => {
    const ledger = new HandledLedger();
    expect(ledger.claim("capability-build:build-request-5:compose.judgment")).toBe(true);
    const writer = fakeWriter();
    const result = await buildRoutineCapabilities(db, CONFIGURED, ledger, { requestId: "build-request-5", proposalId }, writer.run);
    expect(writer.calls.map((c) => c.stdin.capability)).toEqual(["review.adversarial"]);
    expect(result.failed[0]?.capability).toBe("compose.judgment");
  });

  it("refuses when the build is not configured, the draft is unknown or the configuration changed", async () => {
    const writer = fakeWriter();
    expect((await buildRoutineCapabilities(db, BASE, new HandledLedger(), { requestId: "build-request-6", proposalId }, writer.run)).message).toContain("not set up");
    expect((await buildRoutineCapabilities(db, CONFIGURED, new HandledLedger(), { requestId: "build-request-6", proposalId: crypto.randomUUID() }, writer.run)).ok).toBe(false);
    const changed = { ...CONFIGURED, capabilityBuild: { ...BUILD, map: "example/maps#13" } };
    expect((await buildRoutineCapabilities(db, changed, new HandledLedger(), { requestId: "build-request-6", proposalId }, writer.run)).message).toContain("configuration changed");
    expect(writer.calls).toHaveLength(0);
  });
});

describe("the capability build route", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const runtime = (routines: RoutineOptions | undefined): DeskRuntime => ({ options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(routines ? { routines } : {}) }, ledger: new HandledLedger() });

  it("carries the offer from the command bar to the build and back as a result", async () => {
    const live = runtime(CONFIGURED);
    const asked = await handleDeskAsk(post({ text: REQUEST }), live, { now: () => NOW, runRoutine: composer(AGENT_YAML), routineCapabilities: none }, db);
    const { proposal } = (await asked.json()) as { proposal: { capabilities: unknown } };
    const { proposalId } = CapabilityRefusalSchema.parse(proposal.capabilities);
    const writer = fakeWriter();
    const built = await handleDeskRoutineCapability(post({ requestId: "route-request-1", proposalId }), db, live, writer.run);
    expect(built.status).toBe(200);
    expect(CapabilityBuildResultSchema.parse(await built.json()).built).toHaveLength(1);
    const again = await handleDeskRoutineCapability(post({ requestId: "route-request-1", proposalId }), db, live, writer.run);
    expect(again.status).toBe(200);
    expect(writer.calls).toHaveLength(1);
  });

  it("refuses unsupported methods, unset stacks and malformed requests", async () => {
    expect((await handleDeskRoutineCapability(new Request("http://localhost/x"), db, runtime(CONFIGURED))).status).toBe(405);
    expect((await handleDeskRoutineCapability(post({}), db, runtime(undefined))).status).toBe(409);
    expect((await handleDeskRoutineCapability(post({ requestId: "short" }), db, runtime(CONFIGURED))).status).toBe(400);
  });

  it("passes the rebind and identity gates without step-up", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"] } }, db, {
      desk: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], routines: CONFIGURED },
    });
    const base = `http://localhost:${ctx.server.port}`;
    const send = (email: string, origin = base): Promise<Response> => fetch(`${base}/api/desk/routine-capability`, { method: "POST", headers: { "content-type": "application/json", origin, "Cf-Access-Authenticated-User-Email": email }, body: "{}" });
    try {
      expect((await send("unlisted@example.com")).status).toBe(403);
      expect((await send("principal@example.com", "https://evil.example")).status).toBe(403);
      expect((await send("principal@example.com")).status).toBe(400);
    } finally {
      ctx.stop(true);
    }
  });
});

describe("the capabilityBuild configuration", () => {
  const base = { composer: ["c"], reflex: ["r"], target: "@example/pulse-flow", timeZone: "Europe/Zurich" };
  it("accepts a writer, a map and a budget, with an optional template", () => {
    expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: BUILD }).success).toBe(true);
    expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: { ...BUILD, map: "github:github.com/example/maps#12", template: "/etc/brief.md" } }).success).toBe(true);
    expect(RoutineOptionsSchema.safeParse(base).success).toBe(true);
  });
  it("rejects an empty writer, a malformed map and a missing or zero budget", () => {
    for (const bad of [{ ...BUILD, writer: [] }, { ...BUILD, map: "example/maps" }, { ...BUILD, budget: undefined }, { ...BUILD, budget: { ...BUILD.budget, minutes: 0 } }]) {
      expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: bad }).success).toBe(false);
    }
  });
});
