import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ProposalView } from "../../creation";
import type { OperationRecord, OwnerType } from "../../types";
import { ToolHost } from "../capabilities";
import type { ToolSession } from "../capabilities";
import type { WorkerHandoff, WorkerOwner, WorkerRead } from "../worker-handoff";
import type { CreationOwner } from "../proposals";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const MAP = "example/maps#12";
const REPO = "example/maps";
const PARENT = "example/maps#12";
const NODE = "example/maps#31";

interface Proposed { proposalId: string; type?: string; fields: Record<string, string>; entryId?: string }

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return { operationId: "op-1", conversationId: "c", proposalId: "p", revision: 1, owner: "work-start", state: "created", canonicalId: NODE, history: [{ state: "created", at: new Date(NOW).toISOString() }], ...overrides };
}

const view = (body: Proposed, op: OperationRecord | null = null): ProposalView => ({
  proposal: { proposalId: body.proposalId, conversationId: "c", type: (body.type ?? null) as ProposalView["proposal"]["type"], fields: body.fields, revision: 1, entryId: body.entryId ?? null, dismissed: false, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() },
  digest: "0".repeat(64), sentence: "A proposal.", capability: null, missing: [], refusal: null, feedback: op ? "accepted" : "proposed", operation: op, earlier: [],
});

interface Rig {
  call: (name: string, input: unknown) => Promise<{ outcome: string; json: Record<string, unknown> }>;
  proposed: Proposed[];
  remembered: string[];
  proposeWith: (op: OperationRecord | null) => void;
  handoff: WorkerHandoff;
}

function rig(options: { session?: Partial<ToolSession>; read?: WorkerRead; maps?: string[]; operation?: OperationRecord | null; remember?: boolean } = {}): Rig {
  const session: ToolSession = { principal: "p", conversationId: "c", transport: "web", route: "cloud", policy: "cloud", scope: [], entryId: "7", ...options.session };
  const proposed: Proposed[] = [];
  const remembered: string[] = [];
  let nextOperation = options.operation ?? null;
  const handoff: WorkerHandoff = {
    node: NODE, map: MAP, policy: "cloud", state: "prepared", reason: null, generation: null, pr: null, result: null,
    url: `https://example.test/issues/31`, observedAt: NOW, ...(options.read?.state === "available" ? options.read.handoff : {}),
  };
  const creation = {
    capabilities: () => [],
    propose: async (_conversationId: string, body: Proposed) => {
      proposed.push(body);
      return { view: view(body, nextOperation), duplicate: false };
    },
    revise: async () => { throw new Error("revise is not used"); },
    check: async () => { throw new Error("check is not used"); },
    list: async () => ({ proposals: [], grants: [] }),
  } as unknown as CreationOwner;
  const owner: WorkerOwner = {
    maps: () => options.maps ?? [MAP],
    read: () => Promise.resolve(options.read ?? { state: "available", handoff }),
    recorded: () => "cloud",
    remember: (_session, entry) => { remembered.push(entry.node); return Promise.resolve(options.remember ?? true); },
    now: () => NOW,
  };
  const host = new ToolHost({ config: () => undefined, session: () => Promise.resolve(session), creation, workers: owner });
  const call = async (name: string, input: unknown) => {
    const out = await host.call({ conversationId: "c", route: session.route, callId: "id", name, input, signal: new AbortController().signal });
    const text = out.text;
    const start = text.indexOf("\n") + 1;
    const end = text.lastIndexOf("\n</tool-result>");
    return { outcome: out.outcome, json: out.outcome === "done" ? JSON.parse(text.slice(start, end)) as Record<string, unknown> : {} };
  };
  return { call, proposed, remembered, proposeWith: op => { nextOperation = op; }, handoff };
}

const brief = (overrides: Record<string, unknown> = {}) => ({
  proposalId: randomUUID(), repository: REPO, map: MAP, parent: PARENT, title: "Speed up the mail digest",
  scope: "Only the digest renderer, no provider code.", acceptanceChecks: ["The digest is shorter than before.", "Mail tests pass."],
  checkpoint: "digest-slim", budget: { tokens: 200_000, minutes: 60 }, ...overrides,
});

describe("worker brief", () => {
  test("files a concrete brief through the creation proposal path and starts nothing", async () => {
    const r = rig();
    const { json } = await r.call("worker_brief", brief({ probes: ['{"type":"artifact-exists","path":"src/digest.ts"}'], blockedBy: ["example/maps#30"] }));
    expect(json.status).toBe("pending");
    expect(r.proposed).toHaveLength(1);
    const sent = r.proposed[0]!;
    expect(sent.type).toBe("work-brief");
    expect(sent.entryId).toBe("7");
    expect(sent.fields).toMatchObject({ repository: REPO, map: MAP, parent: PARENT, checkpoint: "digest-slim", budgetTokens: "200000", budgetMinutes: "60", probes: '{"type":"artifact-exists","path":"src/digest.ts"}', dependencies: "example/maps#30" });
    expect(sent.fields.body).toContain("## Deliverable\nOnly the digest renderer, no provider code.");
    expect(sent.fields.body).toContain("- The digest is shorter than before.");
    expect(sent.fields.body).toContain("- 200000 tokens");
    expect(sent.fields.body).toContain("- 60 minutes");
    expect(sent.fields.body).not.toContain("autonomy");
  });

  test("refuses a map that is not configured, a map in another repository and a malformed probe before anything is filed", async () => {
    const r = rig();
    expect((await r.call("worker_brief", brief({ map: "example/other#3" }))).json).toMatchObject({ status: "refused" });
    expect((await r.call("worker_brief", brief({ repository: "example/other" }))).json).toMatchObject({ status: "refused" });
    expect((await r.call("worker_brief", brief({ probes: ["not json"] }))).json).toMatchObject({ status: "refused" });
    expect(r.proposed).toHaveLength(0);
  });

  test("keeps the originating entry bound and refuses when the conversation has no entry", async () => {
    const r = rig({ session: { entryId: undefined } });
    expect((await r.call("worker_brief", brief())).json).toMatchObject({ status: "refused" });
    expect(r.proposed).toHaveLength(0);
  });
});

describe("worker start", () => {
  test("requires the proposal path and reports the proposal state, never a start on its own", async () => {
    const r = rig();
    const { json } = await r.call("worker_start", { proposalId: randomUUID(), node: NODE });
    expect(json.status).toBe("pending");
    expect(r.proposed[0]).toMatchObject({ type: "work-start", fields: { node: NODE } });
  });

  test("reconciles a node that already has a running worker instead of starting a second", async () => {
    const r = rig({ read: { state: "available", handoff: { node: NODE, map: MAP, policy: "cloud", state: "running", reason: null, generation: 2, pr: "41", result: null, observedAt: NOW } } });
    const { json } = await r.call("worker_start", { proposalId: randomUUID(), node: NODE });
    expect(json).toMatchObject({ status: "already-started", state: "running", generation: 2 });
    expect(r.proposed).toHaveLength(0);
  });

  test("refuses an unknown node, a node outside the conversation and an unconfigured map", async () => {
    expect((await rig({ read: { state: "unknown", reason: "none" } }).call("worker_start", { proposalId: randomUUID(), node: NODE })).json).toMatchObject({ status: "refused" });
    expect((await rig({ read: { state: "unavailable", reason: "denied" } }).call("worker_start", { proposalId: randomUUID(), node: NODE })).json).toMatchObject({ status: "unavailable" });
    expect((await rig({ maps: ["example/other#1"] }).call("worker_start", { proposalId: randomUUID(), node: NODE })).json).toMatchObject({ status: "refused" });
  });

  test("shows a node Ranger will not run automatically as awaiting approval instead of rewriting it", async () => {
    const r = rig();
    r.proposeWith(operation({ state: "failed", canonicalId: undefined, history: [{ state: "failed", at: new Date(NOW).toISOString(), detail: "node 31 routes escalate-hitl: it waits for the principal." }] }));
    const { json, outcome } = await r.call("worker_start", { proposalId: randomUUID(), node: NODE });
    expect(outcome).toBe("done");
    expect(json.status).toBe("awaiting-approval");
    expect(String(json.message)).toContain("autonomy is unchanged");
  });
});

describe("worker status", () => {
  test("reads the recorded state, links and freshness and never turns merged into deployed", async () => {
    const r = rig({ read: { state: "available", handoff: { node: NODE, map: MAP, policy: "cloud", state: "merged", reason: null, generation: 3, pr: "44", result: "Squash-merged as 1a2b3c", url: "https://example.test/issues/31", prUrl: "https://example.test/pull/44", observedAt: NOW - 11 * 60_000 } } });
    const { json } = await r.call("worker_status", { node: NODE });
    expect(json).toMatchObject({ status: "ok", state: "merged", generation: 3, pr: "44", merged: true, deployed: false, freshness: "stale" });
    expect(json.observedAt).toBe(new Date(NOW - 11 * 60_000).toISOString());
  });

  test("keeps unknown, unavailable and unauthorized distinct and remembers what it released", async () => {
    const unknown = await rig({ read: { state: "unknown", reason: "none" } }).call("worker_status", { node: NODE });
    expect(unknown.json.status).toBe("unknown");
    const unavailable = await rig({ read: { state: "unavailable", reason: "denied" } }).call("worker_status", { node: NODE });
    expect(unavailable.json.status).toBe("unavailable");
    const private_ = rig({ read: { state: "available", handoff: { node: NODE, map: MAP, policy: "local", state: "running", reason: null, generation: 1, pr: null, result: null, observedAt: NOW } } });
    expect((await private_.call("worker_status", { node: NODE })).json.status).toBe("unauthorized");
    expect(private_.remembered).toHaveLength(0);
    const yours = rig();
    expect((await yours.call("worker_status", { node: NODE })).json.status).toBe("ok");
    expect(yours.remembered).toEqual([NODE]);
  });

  test("withholds a result whose remembered policy could not be applied", async () => {
    const r = rig({ remember: false });
    expect((await r.call("worker_status", { node: NODE })).json.status).toBe("unknown");
  });
});

describe("worker cancel", () => {
  test("targets only the recorded active generation and goes through its own confirmation", async () => {
    const r = rig({ read: { state: "available", handoff: { node: NODE, map: MAP, policy: "cloud", state: "running", reason: null, generation: 5, pr: null, result: null, observedAt: NOW } } });
    const { json } = await r.call("worker_cancel", { proposalId: randomUUID(), node: NODE });
    expect(json.status).toBe("pending");
    expect(r.proposed[0]).toMatchObject({ type: "work-cancel", fields: { node: NODE, generation: "5" } });
  });

  test("refuses a node with no recorded generation and one that already stopped", async () => {
    expect((await rig().call("worker_cancel", { proposalId: randomUUID(), node: NODE })).json).toMatchObject({ status: "refused" });
    const stopped = rig({ read: { state: "available", handoff: { node: NODE, map: MAP, policy: "cloud", state: "cancelled", reason: "stopped", generation: 5, pr: null, result: null, observedAt: NOW } } });
    expect((await stopped.call("worker_cancel", { proposalId: randomUUID(), node: NODE })).json).toMatchObject({ status: "not-active" });
    expect(stopped.proposed).toHaveLength(0);
  });
});

describe("worker tool surface", () => {
  test("names worker authority and never offers merge, deploy or send", () => {
    const host = new ToolHost({ config: () => undefined, session: async () => null, creation: { capabilities: () => [], propose: async () => { throw new Error("unused"); }, revise: async () => { throw new Error("unused"); }, check: async () => { throw new Error("unused"); }, list: async () => ({ proposals: [], grants: [] }) }, workers: { maps: () => [], read: async () => ({ state: "unknown", reason: "none" }), recorded: () => null, remember: async () => true, now: () => NOW } });
    const specs = host.specs();
    const names = specs.map(spec => spec.name);
    expect(names).toEqual(expect.arrayContaining(["worker_brief", "worker_start", "worker_status", "worker_cancel"]));
    for (const name of ["worker_brief", "worker_start", "worker_status", "worker_cancel"]) {
      const description = specs.find(spec => spec.name === name)?.description ?? "";
      expect(name.startsWith("worker_")).toBe(true);
      expect(description).not.toMatch(/\bmerge it\b|deploy it|send the mail/i);
    }
  });
});
