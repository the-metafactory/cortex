import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult } from "../../../conversations/types";
import type { WorkerHandoffOptions } from "../../../common/types/desk-workers";
import type { DeskOptions } from "../desk/compose";
import { initDatabase } from "../db/init";
import type { WriterRunner } from "../desk/create";
import { setGraphRepositoryEnabled } from "../desk/graph-repositories";
import { workerOwner } from "../desk/worker-conversation-owner";
import { workBriefWriter, workCancelWriter, workStartWriter } from "../desk/worker-conversation-writer";
import { readWorkerRecord, recordWorkerRecord, recordWorkerState, recordWorkerOperation, readWorkerOperation } from "../desk/worker-handoff-store";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const MAP = "example/maps#12";
const NODE = "example/maps#30";
const WORKERS: WorkerHandoffOptions = {
  maps: [MAP],
  start: ["builder", "build-now", "{id}", "--map", "{map}"],
  stop: ["builder", "stop-node", "{id}", "--map", "{map}", "--generation", "{generation}"],
  status: ["status-command", "{ref}", "--map", "{map}"],
  timeoutSeconds: 5,
};

const DESK: DeskOptions = {
  enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], somaBin: "/fake/soma", workers: WORKERS,
  areas: [{ id: "lab", label: "Lab", color: "", repos: ["example/maps"], goals: [], policy: "cloud" }],
};

interface Call { argv: string[]; stdin: string; timeoutMs: number }
interface Harness { db: Database; calls: Call[]; run: WriterRunner; answer: (key: string, reply: string, code?: number, stderr?: string) => void }

function harness(): Harness {
  const calls: Call[] = [];
  const answers = new Map<string, { code: number; stdout: string; stderr: string }>();
  const run: WriterRunner = async (argv, stdin, timeoutMs) => {
    calls.push({ argv, stdin, timeoutMs });
    const key = argv.findLast(arg => answers.has(arg));
    return key ? answers.get(key)! : { code: 0, stdout: "{}", stderr: "" };
  };
  return { db: initDatabase(":memory:"), calls, run, answer: (key, reply, code = 0, stderr = "") => { answers.set(key, { code, stdout: reply, stderr }); } };
}

const provenance = { conversationId: "c", proposalId: "p", revision: 1, operationId: "op-1", entryId: "7", link: "?desk=conversation&conversation=c" };
const request = (fields: Record<string, string>, operationId = "op-1"): CreateRequest => ({ operationId, type: "work-brief", fields, activation: "none", signal: new AbortController().signal, provenance: { ...provenance, operationId } });
const session = { principal: "p", conversationId: "c", transport: "web" as const, route: "cloud" as const, policy: "cloud" as const, scope: [] };

const BRIEF: Record<string, string> = {
  repository: "example/maps", map: MAP, parent: MAP, title: "Shorten the digest", checkpoint: "digest-slim",
  body: "## Scope\nOnly the renderer.\n\n## Acceptance checks\n- It is shorter.", budgetTokens: "200000", budgetMinutes: "60",
  probes: '{"type":"artifact-exists","path":"src/digest.ts"}', dependencies: "example/maps#11",
};

const deps = (h: Harness, desk: DeskOptions = DESK) => ({ db: h.db, desk: () => desk, run: h.run, now: () => NOW });

async function filed(h: Harness): Promise<CreateResult> {
  setGraphRepositoryEnabled(h.db, "example/maps", true, NOW);
  h.answer("add", '{"repo":"example/maps","node":"30"}');
  return await workBriefWriter(deps(h)).create(request(BRIEF));
}

describe("worker brief writer", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("files an approval-gated build node with its budget, probes and one reconciliation marker", async () => {
    const result = await filed(h);
    expect(result).toMatchObject({ state: "created", canonicalId: NODE, url: "https://github.com/example/maps/issues/30" });
    const argv = h.calls[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(["/fake/soma", "graph", "add"]);
    expect(argv).toEqual(expect.arrayContaining(["--autonomy", "approve", "--kind", "build", "--checkpoint", "digest-slim", "--budget-tokens", "200000", "--budget-minutes", "60", "--probe", "--blocked-by", "example/maps#11", "--once"]));
    expect(argv.join(" ")).not.toContain("--budget-invocations");
    expect(h.calls[0]!.stdin).toBe("");
    expect(readWorkerRecord(h.db, NODE)).toMatchObject({ conversationId: "c", entryId: "7", proposalId: "p", operationId: "op-1", state: "prepared", generation: null, map: MAP });
  });

  test("refuses a map that is not configured or names another repository before soma runs", async () => {
    const writer = workBriefWriter(deps(h));
    expect(await writer.create(request({ ...BRIEF, map: "example/other#1" }))).toMatchObject({ state: "failed" });
    expect(await writer.create(request({ ...BRIEF, repository: "example/other" }))).toMatchObject({ state: "failed" });
    expect(h.calls).toHaveLength(0);
  });

  test("a brief whose answer was lost is reconciled from soma's marker, not filed twice", async () => {
    await filed(h);
    h.answer("--dry-run", JSON.stringify({ found: true, repo: "example/maps", node: "30", parent: MAP }));
    const readback = await workBriefWriter(deps(h)).readback({ operationId: "op-1", conversationId: "c", proposalId: "p", revision: 1, owner: "work-brief", state: "uncertain", history: [] });
    expect(readback).toMatchObject({ found: true, canonicalId: NODE });
    const args = h.calls.at(-1)!.argv;
    expect(args).toContain("--dry-run");
    expect(args.join(" ")).toContain("--once");
  });

  test("a failed soma call records nothing, so a retry cannot look like a start", async () => {
    h.answer("add", "", 1, "soma graph add: the parent is not on this map\n");
    expect((await workBriefWriter(deps(h)).create(request(BRIEF))).state).toBe("failed");
    expect(readWorkerRecord(h.db, NODE)).toBeNull();
  });
});

describe("worker start writer", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("starts the exact recorded node with the configured map and records the worker", async () => {
    await filed(h);
    h.answer("build-now", JSON.stringify({ nodeId: "30", repo: "example/maps", pid: 4242 }));
    const result = await workStartWriter(deps(h)).create({ ...request({ node: NODE }, "op-2"), type: "work-start" });
    expect(result.state).toBe("created");
    expect(h.calls.at(-1)!.argv).toEqual(["builder", "build-now", "30", "--map", MAP]);
    expect(readWorkerRecord(h.db, NODE)).toMatchObject({ state: "queued", operationId: "op-2" });
  });

  test("replaying a start reconciles the recorded worker instead of starting a second one", async () => {
    await filed(h);
    h.answer("build-now", JSON.stringify({ pid: 4242 }));
    const writer = workStartWriter(deps(h));
    await writer.create({ ...request({ node: NODE }, "op-2"), type: "work-start" });
    expect((await writer.create({ ...request({ node: NODE }, "op-3"), type: "work-start" })).state).toBe("created");
    expect(h.calls.filter(call => call.argv.includes("build-now"))).toHaveLength(1);
  });

  test("a claim without a worker is not a start and leaves the node as it was", async () => {
    await filed(h);
    h.answer("build-now", JSON.stringify({ nodeId: "30", repo: "example/maps", pid: null }), 3, "claimed #30 but no run-node was started\n");
    const result = await workStartWriter(deps(h)).create({ ...request({ node: NODE }, "op-2"), type: "work-start" });
    if (result.state !== "failed") throw new Error("expected a refusal");
    expect(result.error).toContain("did not confirm a worker start");
    expect(result.error).toContain("autonomy was unchanged");
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("prepared");
  });

  test("readback settles a start only once the status command observes the worker", async () => {
    await filed(h);
    recordWorkerRecord(h.db, { ...readWorkerRecord(h.db, NODE)!, operationId: "op-2" });
    recordWorkerState(h.db, NODE, { state: "queued", reason: null, pr: null, result: null, generation: 2 }, NOW);
    const operation = { operationId: "op-2", conversationId: "c", proposalId: "p", revision: 1, owner: "work-start" as const, state: "running" as const, canonicalId: NODE, history: [] };
    h.answer("status-command", "", 1, "ranger journal: no journal\n");
    expect(await workStartWriter(deps(h)).readback(operation)).toBeNull();
    h.answer("status-command", JSON.stringify({ state: "running", generation: 2 }));
    expect(await workStartWriter(deps(h)).readback(operation)).toMatchObject({ found: true, canonicalId: NODE });
  });

  test("refuses a node with no recorded brief from this conversation and calls nothing", async () => {
    expect((await workStartWriter(deps(h)).create({ ...request({ node: NODE }), type: "work-start" })).state).toBe("failed");
    expect(h.calls).toHaveLength(0);
  });
});

describe("worker status and cancel writers", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("reads the recorded generation and pull request, then stops exactly that generation", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "queued", reason: null, pr: null, result: null, generation: null }, NOW);
    h.answer("status-command", JSON.stringify({ state: "building", pr: 77, generation: 3 }));
    const read = await workerOwner(deps(h)).read(session, NODE);
    if (read.state !== "available") throw new Error("expected an available handoff");
    expect(read.handoff).toMatchObject({ state: "running", generation: 3, pr: "77" });
    expect(h.calls.at(-1)!.argv).toEqual(["status-command", NODE, "--map", MAP]);
    h.answer("stop-node", JSON.stringify({ ok: true, state: "stopped", reason: "worker stopped", generation: 3 }));
    expect((await workCancelWriter(deps(h)).create({ ...request({ node: NODE, generation: "3" }, "op-9"), type: "work-cancel" })).state).toBe("created");
    expect(h.calls.at(-1)!.argv).toEqual(["builder", "stop-node", "30", "--map", MAP, "--generation", "3"]);
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("cancelled");
  });

  test("an acknowledged stop stays explicit and a superseded generation is refused", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", reason: null, pr: null, result: null, generation: 4 }, NOW);
    const writer = workCancelWriter(deps(h));
    h.answer("stop-node", JSON.stringify({ state: "stopping", generation: 4 }));
    const stopping = await writer.create({ ...request({ node: NODE, generation: "4" }, "op-5"), type: "work-cancel" });
    if (stopping.state !== "accepted") throw new Error("expected an acknowledged stop");
    expect(stopping.receipt).toContain("has not confirmed it yet");
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("running");
    h.answer("stop-node", JSON.stringify({ state: "superseded", reason: "generation 4 was replaced by generation 5" }), 1);
    const superseded = await writer.create({ ...request({ node: NODE, generation: "4" }, "op-6"), type: "work-cancel" });
    if (superseded.state !== "failed") throw new Error("expected a refusal");
    expect(superseded.error).toContain("generation 4 was replaced");
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("running");
  });

  test("readback settles a cancellation only on a cancelled worker", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", reason: null, pr: null, result: null, generation: 6 }, NOW);
    const operation = { operationId: "op-7", conversationId: "c", proposalId: "p", revision: 1, owner: "work-cancel" as const, state: "running" as const, canonicalId: NODE, history: [] };
    h.answer("status-command", JSON.stringify({ state: "running", generation: 6 }));
    expect(await workCancelWriter(deps(h)).readback(operation)).toBeNull();
    h.answer("status-command", JSON.stringify({ state: "failed", reason: "the worker was stopped", generation: 6 }));
    expect(await workCancelWriter(deps(h)).readback(operation)).toBeNull();
  });

  test.each([
    ["nonzero exit", "", 1],
    ["missing generation", JSON.stringify({ state: "stopped" }), 0],
    ["malformed reply", "reply lost", 0],
    ["another node", JSON.stringify({ nodeId: "99", state: "stopped", generation: 3 }), 0],
  ])("keeps a stop with %s uncertain instead of claiming nothing was cancelled", async (_name, stdout, code) => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", reason: null, pr: null, result: null, generation: 3 }, NOW);
    h.answer("stop-node", stdout as string, code as number);
    const result = await workCancelWriter(deps(h)).create({ ...request({ node: NODE, generation: "3" }, "uncertain-stop"), type: "work-cancel" });
    expect(result.state).toBe("accepted");
    if (result.state !== "accepted") throw new Error("expected an uncertain stop");
    expect(result.receipt).toContain("not confirmed");
    expect(result.receipt).not.toContain("Nothing was cancelled");
    expect(readWorkerRecord(h.db, NODE)).toMatchObject({ state: "running", generation: 3 });
    expect(readWorkerOperation(h.db, "uncertain-stop")?.state).toBe("stopping");
  });

  test("an unmapped status state keeps the recorded state with its reason and never becomes merged", async () => {
    await filed(h);
    h.answer("status-command", JSON.stringify({ state: "deployed" }));
    const read = await workerOwner(deps(h)).read(session, NODE);
    if (read.state !== "available") throw new Error("expected an available handoff");
    expect(read.handoff.state).toBe("prepared");
    expect(read.handoff.reason).toContain("does not map");
  });

  test("reads only the conversation that recorded the node and reports others as unknown", async () => {
    await filed(h);
    const owner = workerOwner(deps(h));
    expect((await owner.read({ ...session, conversationId: "other" }, NODE)).state).toBe("unknown");
    expect((await owner.read(session, "example/maps#99")).state).toBe("unknown");
    expect(owner.recorded(session, NODE)).toBe("cloud");
    expect(owner.recorded({ ...session, conversationId: "other" }, NODE)).toBeNull();
  });

  test("falls back to the capability-build status adapter when no worker status command is configured", async () => {
    const desk: DeskOptions = {
      ...DESK, workers: { ...WORKERS, status: undefined },
      routines: { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 5, composeTimeoutSeconds: 5, readTimeoutSeconds: 1, capabilityBuild: { writer: ["writer"], map: MAP, status: ["capability-status", "{ref}"], budget: { tokens: 1, invocations: 1, minutes: 1 } } },
    };
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "queued", reason: null, pr: null, result: null, generation: 2 }, NOW);
    h.answer("capability-status", JSON.stringify({ state: "merged", pr: 88 }));
    const read = await workerOwner(deps(h, desk)).read(session, NODE);
    if (read.state !== "available") throw new Error("expected an available handoff");
    expect(read.handoff).toMatchObject({ state: "merged", pr: "88", generation: 2 });
    expect(h.calls.at(-1)!.argv).toEqual(["capability-status", NODE]);
  });
});

describe("worker handoff store", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  test("keeps one row per node and keeps a recorded generation when a later status omits it", () => {
    recordWorkerRecord(db, { node: NODE, map: MAP, repository: "example/maps", conversationId: "c", entryId: "7", proposalId: "p", operationId: "op-1", generation: null, state: "prepared", reason: null, pr: null, result: null, url: null, prUrl: null, startedAt: NOW, updatedAt: NOW });
    recordWorkerState(db, NODE, { state: "running", reason: null, pr: null, result: null, generation: 3 }, NOW + 1);
    recordWorkerState(db, NODE, { state: "review", reason: null, pr: "12", result: null, generation: null }, NOW + 2);
    expect(readWorkerRecord(db, NODE)).toMatchObject({ state: "review", generation: 3, pr: "12", conversationId: "c" });
  });
});


describe("worker handoff recovery and authority", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("a configured worker map does not bypass a revoked graph repository", async () => {
    h.answer("add", '{"repo":"example/maps","node":"30"}');
    const result = await workBriefWriter(deps(h)).create(request(BRIEF));
    expect(result.state).toBe("failed");
    expect(h.calls).toHaveLength(0);
  });

  test("a cancellation confirmed for an older generation never stops its replacement", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", generation: 5, pr: null, result: null, reason: null }, NOW);
    const result = await workCancelWriter(deps(h)).create({ ...request({ node: NODE, generation: "4" }, "op-stop"), type: "work-cancel" });
    expect(result.state).toBe("failed");
    expect(h.calls.filter(call => call.argv.includes("stop-node"))).toHaveLength(0);
  });

  test("a lost brief response restores its provenance and permits status after reconciliation", async () => {
    setGraphRepositoryEnabled(h.db, "example/maps", true, NOW);
    const timeout = async (argv: string[], stdin: string, timeoutMs: number) => {
      if (argv.includes("add") && !argv.includes("--dry-run")) throw new Error("lost response after create");
      return await h.run(argv, stdin, timeoutMs);
    };
    const writer = workBriefWriter({ ...deps(h), run: timeout });
    await expect(writer.create(request(BRIEF))).rejects.toThrow("lost response");
    h.answer("--dry-run", JSON.stringify({ found: true, repo: "example/maps", node: "30", parent: MAP }));
    const recovered = await writer.readback({ operationId: "op-1", conversationId: "c", proposalId: "p", revision: 1, owner: "work-brief", state: "uncertain", history: [] });
    expect(recovered).toMatchObject({ found: true, canonicalId: NODE });
    expect(readWorkerRecord(h.db, NODE)).toMatchObject({ conversationId: "c", entryId: "7", map: MAP, operationId: "op-1" });
  });

  test("a start whose response was lost is never dispatched a second time", async () => {
    await filed(h);
    let starts = 0;
    const run: WriterRunner = async (argv, stdin, timeoutMs) => {
      if (argv.includes("build-now")) { starts += 1; throw new Error("lost start response"); }
      return await h.run(argv, stdin, timeoutMs);
    };
    h.answer("status-command", JSON.stringify({ state: "cancelled", generation: 6 }));
    const writer = workStartWriter({ ...deps(h), run });
    await expect(writer.create({ ...request({ node: NODE }, "op-start"), type: "work-start" })).rejects.toThrow("lost start response");
    const replay = await writer.create({ ...request({ node: NODE }, "op-other"), type: "work-start" });
    expect(replay.state).toBe("accepted");
    expect(starts).toBe(1);
    h.answer("status-command", JSON.stringify({ state: "running", generation: 8 }));
    expect(await writer.readback({ operationId: "op-start", conversationId: "c", proposalId: "p", revision: 1, owner: "work-start", state: "uncertain", history: [] })).toBeNull();
    h.answer("status-command", JSON.stringify({ state: "running", generation: 7 }));
    expect(await writer.readback({ operationId: "op-start", conversationId: "c", proposalId: "p", revision: 1, owner: "work-start", state: "uncertain", history: [] })).toMatchObject({ found: true, canonicalId: NODE });
  });
});


describe("worker status authority and concurrent recovery", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("revoking a repository blocks status release and remembering an earlier read", async () => {
    await filed(h);
    const owner = workerOwner(deps(h));
    const prior = await owner.read(session, NODE);
    if (prior.state !== "available") throw new Error("expected initial status");
    const calls = h.calls.length;
    setGraphRepositoryEnabled(h.db, "example/maps", false, NOW);
    expect(await owner.read(session, NODE)).toMatchObject({ state: "unauthorized" });
    expect(owner.recorded(session, NODE)).toBeNull();
    expect(await owner.remember(session, prior.handoff, new AbortController().signal)).toBe(false);
    expect(h.calls).toHaveLength(calls);
  });

  test("removing a configured map blocks status and cancellation", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", generation: 3, pr: null, result: null, reason: null }, NOW);
    const changed = { ...DESK, workers: { ...WORKERS, maps: [] } };
    expect(await workerOwner(deps(h, changed)).read(session, NODE)).toMatchObject({ state: "unauthorized" });
    expect((await workCancelWriter(deps(h, changed)).create({ ...request({ node: NODE, generation: "3" }, "cancel"), type: "work-cancel" })).state).toBe("failed");
    expect(h.calls.filter(call => call.argv.includes("stop-node"))).toHaveLength(0);
  });

  test("a repository revoked while status waits cannot release its response", async () => {
    await filed(h);
    const run: WriterRunner = async () => {
      setGraphRepositoryEnabled(h.db, "example/maps", false, NOW);
      return { code: 0, stdout: JSON.stringify({ state: "running", generation: 3 }), stderr: "" };
    };
    expect(await workerOwner({ ...deps(h), run }).read(session, NODE)).toMatchObject({ state: "unauthorized" });
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("prepared");
  });

  test("an older status response cannot overwrite a newer generation", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", generation: 5, pr: null, result: null, reason: null }, NOW);
    h.answer("status-command", JSON.stringify({ state: "cancelled", generation: 4 }));
    const read = await workerOwner(deps(h)).read(session, NODE);
    expect(read).toMatchObject({ state: "available", handoff: { state: "running", generation: 5 } });
    expect(readWorkerRecord(h.db, NODE)!.generation).toBe(5);
  });

  test("a readback cannot settle an operation from another proposal", async () => {
    await filed(h);
    h.answer("build-now", JSON.stringify({ pid: 42, generation: 3 }));
    const writer = workStartWriter(deps(h));
    await writer.create({ ...request({ node: NODE }, "start"), type: "work-start" });
    h.answer("status-command", JSON.stringify({ state: "running", generation: 3 }));
    expect(await writer.readback({ operationId: "start", conversationId: "c", proposalId: "other", revision: 1, owner: "work-start", state: "uncertain", history: [] })).toBeNull();
  });

  test("simultaneous start requests dispatch only one worker", async () => {
    await filed(h);
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    let starts = 0;
    const run: WriterRunner = (argv, stdin, timeoutMs) => {
      if (!argv.includes("build-now")) return h.run(argv, stdin, timeoutMs);
      starts += 1;
      return new Promise(resolve => { finish = resolve; });
    };
    const writer = workStartWriter({ ...deps(h), run });
    const first = writer.create({ ...request({ node: NODE }, "first"), type: "work-start" });
    const second = await writer.create({ ...request({ node: NODE }, "second"), type: "work-start" });
    expect(second.state).toBe("accepted");
    finish({ code: 0, stdout: JSON.stringify({ pid: 42 }), stderr: "" });
    expect((await first).state).toBe("created");
    expect(starts).toBe(1);
  });
});


describe("worker reply identity and generation", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("a start reply for another node is not a confirmed start", async () => {
    await filed(h);
    h.answer("build-now", JSON.stringify({ nodeId: "99", repo: "example/maps", pid: 42 }));
    await expect(workStartWriter(deps(h)).create({ ...request({ node: NODE }, "start"), type: "work-start" })).rejects.toThrow("another node");
    expect(readWorkerRecord(h.db, NODE)!.state).toBe("prepared");
  });

  test("a settled cancellation cannot overwrite a replacement that appears while stop waits", async () => {
    await filed(h);
    recordWorkerState(h.db, NODE, { state: "running", generation: 3, pr: null, result: null, reason: null }, NOW);
    const run: WriterRunner = () => {
      recordWorkerState(h.db, NODE, { state: "running", generation: 4, pr: null, result: null, reason: null }, NOW + 1);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ state: "stopped", generation: 3 }), stderr: "" });
    };
    const result = await workCancelWriter({ ...deps(h), run }).create({ ...request({ node: NODE, generation: "3" }, "stop"), type: "work-cancel" });
    expect(result.state).toBe("failed");
    expect(readWorkerRecord(h.db, NODE)).toMatchObject({ state: "running", generation: 4, operationId: "op-1" });
  });
});


describe("start reply fencing", () => {
  test("a delayed start reply does not overwrite a worker observed in the meantime", async () => {
    const h = harness();
    try {
      await filed(h);
      const run: WriterRunner = (argv, stdin, timeoutMs) => {
        if (!argv.includes("build-now")) return h.run(argv, stdin, timeoutMs);
        recordWorkerState(h.db, NODE, { state: "running", generation: 4, pr: null, result: null, reason: null }, NOW + 1);
        return Promise.resolve({ code: 0, stdout: JSON.stringify({ pid: 42, generation: 3 }), stderr: "" });
      };
      expect((await workStartWriter({ ...deps(h), run }).create({ ...request({ node: NODE }, "start"), type: "work-start" })).state).toBe("accepted");
      expect(readWorkerRecord(h.db, NODE)).toMatchObject({ state: "running", generation: 4, operationId: "op-1" });
    } finally { h.db.close(); }
  });
});


describe("worker registration lag", () => {
  test("an empty journal after dispatch cannot erase the start and dispatch again", async () => {
    const h = harness();
    try {
      await filed(h);
      h.answer("build-now", JSON.stringify({ pid: 42 }));
      const writer = workStartWriter(deps(h));
      await writer.create({ ...request({ node: NODE }, "start"), type: "work-start" });
      h.answer("status-command", JSON.stringify({ state: "filed", generation: null }));
      expect(await workerOwner(deps(h)).read(session, NODE)).toMatchObject({ state: "available", handoff: { state: "queued" } });
      expect((await writer.create({ ...request({ node: NODE }, "retry"), type: "work-start" })).state).toBe("created");
      expect(h.calls.filter(call => call.argv.includes("build-now"))).toHaveLength(1);
    } finally { h.db.close(); }
  });
});


describe("uncorrelated start recovery", () => {
  test("learning a generation later cannot attribute an uncertain start without its baseline", async () => {
    const h = harness();
    try {
      await filed(h);
      const run: WriterRunner = (argv, stdin, timeoutMs) => {
        if (argv.includes("build-now")) return Promise.reject(new Error("lost start reply"));
        return h.run(argv, stdin, timeoutMs);
      };
      const writer = workStartWriter({ ...deps(h), run });
      await expect(writer.create({ ...request({ node: NODE }, "start"), type: "work-start" })).rejects.toThrow("lost start reply");
      h.answer("status-command", JSON.stringify({ state: "running", generation: 7 }));
      await workerOwner(deps(h)).read(session, NODE);
      expect(await writer.readback({ operationId: "start", conversationId: "c", proposalId: "p", revision: 1, owner: "work-start", state: "uncertain", history: [] })).toBeNull();
      expect((await writer.create({ ...request({ node: NODE }, "retry"), type: "work-start" })).state).toBe("created");
    } finally { h.db.close(); }
  });
});


describe("start command exits", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });

  test("exit one without a confirmed no-start reply remains uncertain and cannot dispatch again", async () => {
    await filed(h);
    h.answer("build-now", "", 1, "output failed after dispatch");
    const writer = workStartWriter(deps(h));
    await expect(writer.create({ ...request({ node: NODE }, "start"), type: "work-start" })).rejects.toThrow("did not confirm whether work started");
    expect((await writer.create({ ...request({ node: NODE }, "retry"), type: "work-start" })).state).toBe("accepted");
    expect(h.calls.filter(call => call.argv.includes("build-now"))).toHaveLength(1);
  });

  test("the exact node and map pre-dispatch refusal stays explicit and permits a later authorized retry", async () => {
    await filed(h);
    h.answer("build-now", "", 1, `ranger build-now: #30 on ${MAP}: routes escalate-hitl — waits for the principal`);
    const writer = workStartWriter(deps(h));
    const result = await writer.create({ ...request({ node: NODE }, "start"), type: "work-start" });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("waits for the principal") });
    h.answer("build-now", JSON.stringify({ pid: 42 }), 0);
    expect((await writer.create({ ...request({ node: NODE }, "retry"), type: "work-start" })).state).toBe("created");
  });
});


describe("brief response identity and current authority", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { h.db.close(); });
  const operation = { operationId: "op-1", conversationId: "c", proposalId: "p", revision: 1, owner: "work-brief" as const, state: "uncertain" as const, history: [] };

  test("a brief reply from another repository is not reinterpreted as the requested node", async () => {
    setGraphRepositoryEnabled(h.db, "example/maps", true, NOW);
    h.answer("add", JSON.stringify({ repo: "example/other", node: "30" }));
    await expect(workBriefWriter(deps(h)).create(request(BRIEF))).rejects.toThrow("another repository");
    expect(readWorkerRecord(h.db, NODE)).toBeNull();
  });

  test("a direct brief proposal cannot file below a parent in another repository", async () => {
    setGraphRepositoryEnabled(h.db, "example/maps", true, NOW);
    h.answer("add", JSON.stringify({ repo: "example/maps", node: "30" }));
    const result = await workBriefWriter(deps(h)).create(request({ ...BRIEF, parent: "example/other#12" }));
    expect(result.state).toBe("failed");
    expect(h.calls).toHaveLength(0);
  });

  test("brief readback checks proposal identity and permission before consulting Soma", async () => {
    await filed(h);
    h.answer("--dry-run", JSON.stringify({ found: true, repo: "example/maps", node: "30", parent: MAP }));
    const writer = workBriefWriter(deps(h));
    const calls = h.calls.length;
    expect(await writer.readback({ ...operation, proposalId: "other" })).toBeNull();
    setGraphRepositoryEnabled(h.db, "example/maps", false, NOW);
    expect(await writer.readback(operation)).toBeNull();
    expect(h.calls).toHaveLength(calls);
  });

  test("brief readback refuses an answer from another repository", async () => {
    await filed(h);
    h.answer("--dry-run", JSON.stringify({ found: true, repo: "example/other", node: "30", parent: MAP }));
    expect(await workBriefWriter(deps(h)).readback(operation)).toBeNull();
  });

  test("revocation while brief filing waits withholds its result and handoff record", async () => {
    setGraphRepositoryEnabled(h.db, "example/maps", true, NOW);
    const run: WriterRunner = () => {
      setGraphRepositoryEnabled(h.db, "example/maps", false, NOW);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ repo: "example/maps", node: "30" }), stderr: "" });
    };
    await expect(workBriefWriter({ ...deps(h), run }).create(request(BRIEF))).rejects.toThrow("permissions changed");
    expect(readWorkerRecord(h.db, NODE)).toBeNull();
  });

  test("revocation during brief readback withholds a found node", async () => {
    await filed(h);
    const run: WriterRunner = () => {
      setGraphRepositoryEnabled(h.db, "example/maps", false, NOW);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ found: true, repo: "example/maps", node: "30", parent: MAP }), stderr: "" });
    };
    expect(await workBriefWriter({ ...deps(h), run }).readback(operation)).toBeNull();
  });
});


describe("durable worker start reservation", () => {
  test("only an inserted pending intent wins and losing retries preserve the original request", () => {
    const db = initDatabase(":memory:");
    try {
      const first: CreateRequest = { ...request({ node: NODE }, "first"), type: "work-start" };
      expect(recordWorkerOperation(db, first, NODE, "starting")).toBe(true);
      expect(recordWorkerOperation(db, { ...first, fields: { node: "example/maps#99" } }, NODE, "starting")).toBe(false);
      expect(recordWorkerOperation(db, { ...request({ node: NODE }, "second"), type: "work-start" }, NODE, "starting")).toBe(false);
      expect(readWorkerOperation(db, "first")!.request.fields.node).toBe(NODE);
      expect(readWorkerOperation(db, "second")).toBeNull();
    } finally { db.close(); }
  });
});
