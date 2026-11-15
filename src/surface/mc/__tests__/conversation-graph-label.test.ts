import { afterEach, describe, expect, test } from "bun:test";
import { objectRef } from "../../../conversations/domain-adapters/fixtures";
import { createWorkGraphNodeBinding, workGraphNodeApprovedSnapshot, workGraphNodeCreateOutcome } from "../../../conversations/domain-adapters/work-graph/node-binding";
import { GRAPH_NODE_CONNECTION, GRAPH_NODE_NOW, GRAPH_NODE_REPOSITORY, graphNodeAuthority, graphNodeFields, graphNodeRequest, openGraphNodeRig, type GraphNodeRig } from "../../../conversations/domain-adapters/__tests__/fixtures/work-graph-node-fixtures";
import type { CreateRequest, ReadbackResult } from "../../../conversations/types";
import type { DeskOptions } from "../desk/compose";
import type { WriterRunner } from "../desk/create";
import { graphMapWriter, graphNodeWriter, recordedGraphOperation, recordGraphOperation } from "../desk/graph-conversation-writer";
import { workBriefWriter } from "../desk/worker-conversation-writer";

const rigs: GraphNodeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

const flag = (args: string[], name: string): string => args[args.indexOf(name) + 1] ?? "";
const parent = `${GRAPH_NODE_REPOSITORY}#12`;

async function open(kind: "graph-node" | "graph-map" | "work-brief" | "binding") {
  const rig = await openGraphNodeRig();
  rigs.push(rig);
  const request: CreateRequest = { ...graphNodeRequest(graphNodeFields({ parent, body: "Synthetic scope" })), type: kind === "binding" ? "graph-node" : kind };
  request.fields = { ...request.fields, map: parent, budgetTokens: "1000", budgetMinutes: "5" };
  const calls: string[][] = [];
  const nodes = new Map<string, string>();
  const key = (args: string[]): string => JSON.stringify([flag(args, "--label"), flag(args, "--once")]);
  const run: WriterRunner = args => {
    calls.push(args);
    const prior = nodes.get(key(args));
    const node = prior ?? String(40 + nodes.size);
    const report = { repo: "example/desk", node, parent: kind === "graph-map" ? null : parent };
    if (args.includes("--dry-run")) return Promise.resolve({ code: 0, stdout: JSON.stringify(prior ? { found: true, ...report } : { found: false }), stderr: "" });
    nodes.set(key(args), node);
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ ...report, existing: prior !== undefined }), stderr: "" });
  };
  const desk: DeskOptions = {
    enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], somaBin: "/fake/soma",
    workers: { maps: [parent], start: ["start"], stop: ["stop"], timeoutSeconds: 5 },
  };
  const deps = { db: rig.db, desk: () => desk, run };
  let create: () => Promise<unknown>;
  let readback: () => Promise<ReadbackResult>;
  if (kind === "binding") {
    const binding = createWorkGraphNodeBinding({ ...deps, stack: "test", connectionId: GRAPH_NODE_CONNECTION, journal: rig.journal });
    const { conversationId, proposalId, revision, entryId, link } = request.provenance;
    const snapshot = workGraphNodeApprovedSnapshot({
      connectionId: GRAPH_NODE_CONNECTION, provenance: { conversationId, proposalId, revision, entryId, link },
      input: { repository: objectRef("work-graph", "repository", GRAPH_NODE_REPOSITORY), parent: objectRef("work-graph", "node", parent), title: "Synthetic node", checkpoint: "synthetic-checkpoint" },
    });
    create = async () => workGraphNodeCreateOutcome(await binding.dispatch({ lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: "attempt", idempotencyKey: request.operationId, ownerRequestId: "request", snapshot, authority: graphNodeAuthority, supportDeclarationId: binding.support.declarationId, deadlineAt: new Date(GRAPH_NODE_NOW + 60_000).toISOString() }));
    readback = () => binding.readback(request.operationId);
  } else {
    const writer = (kind === "work-brief" ? workBriefWriter : kind === "graph-map" ? graphMapWriter : graphNodeWriter)(deps);
    create = () => writer.create(request);
    readback = () => writer.readback({ operationId: request.operationId, conversationId: request.provenance.conversationId, proposalId: request.provenance.proposalId, revision: 1, owner: kind, state: "uncertain", history: [] });
  }
  return { ...rig, request, calls, nodes, key, create, readback };
}

describe.each(["graph-node", "graph-map", "work-brief", "binding"] as const)("%s conversation label", kind => {
  test("a fresh filing and its retry use desk:conversation", async () => {
    const r = await open(kind);
    await r.create();
    await r.create();
    expect(r.calls.map(args => flag(args, "--label"))).toEqual(["desk:conversation", "desk:conversation"]);
    expect(r.nodes.size).toBe(1);
  });

  test("a legacy operation reads back its exact argv and retries without filing another node", async () => {
    const r = await open(kind);
    await r.create();
    const recorded = recordedGraphOperation(r.db, r.request.operationId)!;
    recorded.args[recorded.args.indexOf("--label") + 1] = "ivy:conversation";
    recorded.args.push("--label", "desk:conversation");
    recordGraphOperation(r.db, r.request.operationId, recorded, GRAPH_NODE_NOW);
    r.nodes.clear();
    r.nodes.set(r.key(recorded.args), "40");
    r.calls.length = 0;
    expect(await r.readback()).toMatchObject({ found: true, canonicalId: kind === "work-brief" ? `${GRAPH_NODE_REPOSITORY}#40` : "example/desk#40" });
    expect(r.calls[0]).toEqual(["/fake/soma", ...recorded.args, "--dry-run"]);
    await r.create();
    await r.create();
    expect(r.calls.slice(1).map(args => flag(args, "--label"))).toEqual(["ivy:conversation", "ivy:conversation"]);
    expect(r.nodes.size).toBe(1);
    expect(recordedGraphOperation(r.db, r.request.operationId)?.args).toContain("ivy:conversation");
  });

  test.each(["{", "null", '["--label", 1]', '["graph", "add"]', '["graph", "add", "--label"]'])("invalid or missing recorded label falls back safely: %s", async args => {
    const r = await open(kind);
    r.db.query("INSERT INTO desk_graph_operations (operation_id, repository, parent, args, at) VALUES (?, ?, ?, ?, ?)")
      .run(r.request.operationId, GRAPH_NODE_REPOSITORY, parent, args, GRAPH_NODE_NOW);
    await r.create();
    expect(r.calls).toHaveLength(1);
    expect(flag(r.calls[0]!, "--label")).toBe("desk:conversation");
  });
});
