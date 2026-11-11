// glossary-ignore: node, host
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { WriterLease } from "../../../authority";
import type { Authority } from "../../operations/types";
import { initDatabase } from "../../../../surface/mc/db/init";
import type { DeskOptions } from "../../../../surface/mc/desk/compose";
import { setGraphRepositoryEnabled } from "../../../../surface/mc/desk/graph-repositories";
import { DomainAdapterRegistry } from "../../registry";
import type { OperationBridge } from "../../operations/dispatch";
import type { OperationJournalStore } from "../../operations/journal";
import { confirmationAuthority, lifecycleRig, openJournal } from "./lifecycle-rig";
import { createWorkGraphNodeBinding, createWorkGraphNodeFacade, workGraphNodeCreateBindings, workGraphNodeCreateDeclaration, type WorkGraphNodeBinding, type WorkGraphNodeFacade, type WorkGraphNodeFields } from "../../work-graph/node-binding";

import { GRAPH_NODE_NOW, GRAPH_NODE_REPOSITORY, syntheticSoma, type SyntheticSoma } from "../../work-graph/fixtures/synthetic-soma";
export { GRAPH_NODE_NOW, GRAPH_NODE_REPOSITORY, syntheticSoma, type SyntheticSoma } from "../../work-graph/fixtures/synthetic-soma";

export const GRAPH_NODE_CONNECTION = "connection-example";
export const GRAPH_NODE_STACK = "test";
export const GRAPH_NODE_SOMA = "/opt/soma/bin/soma";
const CONVERSATION = "conversation-example";

export const graphNodeAuthority: Authority = confirmationAuthority(GRAPH_NODE_NOW);

export const graphNodeFields = (overrides: Partial<WorkGraphNodeFields> = {}): WorkGraphNodeFields => ({ repository: GRAPH_NODE_REPOSITORY, parent: "12", title: "Probe node", checkpoint: "probe-checkpoint", ...overrides });

export const graphNodeOperationId = (name: string): string => `${CONVERSATION}:${name}:1`;

export function graphNodeRequest(fields: WorkGraphNodeFields, operationId = graphNodeOperationId("proposal-example")): Parameters<WorkGraphNodeFacade["create"]>[0] {
  const proposalId = operationId.split(":")[1] ?? "proposal-example";
  return { operationId, type: "graph-node", fields, activation: "none", provenance: { conversationId: CONVERSATION, proposalId, revision: 1, operationId, entryId: null, link: `?desk=conversation&conversation=${CONVERSATION}` }, signal: new AbortController().signal };
}

export interface GraphNodeRig {
  readonly dir: string;
  readonly db: Database;
  readonly soma: SyntheticSoma;
  readonly registry: DomainAdapterRegistry;
  readonly journal: OperationJournalStore;
  readonly bridge: OperationBridge;
  readonly binding: WorkGraphNodeBinding;
  readonly facade: WorkGraphNodeFacade;
  readonly lease: WriterLease;
  lifecycle(): { activate(): Promise<boolean>; dispatch(operationId: string): ReturnType<OperationBridge["dispatch"]> };
  close(): Promise<void>;
}

export async function openGraphNodeRig(options: { ticked?: boolean; somaBin?: string } = {}): Promise<GraphNodeRig> {
  const dir = await mkdtemp(join(tmpdir(), "graph-node-binding-"));
  const db = initDatabase(join(dir, "desk.sqlite"));
  if (options.ticked !== false) setGraphRepositoryEnabled(db, GRAPH_NODE_REPOSITORY, true, GRAPH_NODE_NOW);
  const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], somaBin: options.somaBin ?? GRAPH_NODE_SOMA };
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(workGraphNodeCreateDeclaration(), workGraphNodeCreateBindings());
  if (!registered.ok) throw new Error(registered.error.code);
  const { journal, closeEngine } = await openJournal(dir, registry);
  const soma = syntheticSoma();
  const binding = createWorkGraphNodeBinding({ stack: GRAPH_NODE_STACK, connectionId: GRAPH_NODE_CONNECTION, db, desk: () => desk, journal, run: soma.run, now: () => GRAPH_NODE_NOW });
  const facade = createWorkGraphNodeFacade({ binding, journal, db, now: () => GRAPH_NODE_NOW });
  const { lease, bridge, lifecycle } = lifecycleRig({ journal, live: () => binding, now: GRAPH_NODE_NOW, label: "Graph node" });
  return {
    dir,
    db,
    soma,
    registry,
    journal,
    bridge,
    binding,
    facade,
    lease,
    lifecycle,
    async close() {
      db.close();
      await closeEngine();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
