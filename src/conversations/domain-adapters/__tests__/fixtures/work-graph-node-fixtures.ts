// glossary-ignore: node, host
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { WriterLease } from "../../../authority";
import type { Authority } from "../../operations/types";
import { initDatabase } from "../../../../surface/mc/db/init";
import type { DeskOptions } from "../../../../surface/mc/desk/compose";
import type { WriterResult, WriterRunner } from "../../../../surface/mc/desk/create";
import { setGraphRepositoryEnabled } from "../../../../surface/mc/desk/graph-repositories";
import { DomainAdapterRegistry } from "../../registry";
import type { OperationBridge } from "../../operations/dispatch";
import type { OperationJournalStore } from "../../operations/journal";
import { confirmationAuthority, lifecycleRig, openJournal } from "./lifecycle-rig";
import { createWorkGraphNodeBinding, createWorkGraphNodeFacade, workGraphNodeCreateBindings, workGraphNodeCreateDeclaration, type WorkGraphNodeBinding, type WorkGraphNodeFacade, type WorkGraphNodeFields } from "../../work-graph/node-binding";

export const GRAPH_NODE_CONNECTION = "connection-example";
export const GRAPH_NODE_STACK = "test";
export const GRAPH_NODE_NOW = Date.parse("2026-11-01T12:00:00.000Z");
export const GRAPH_NODE_SOMA = "/opt/soma/bin/soma";
export const GRAPH_NODE_REPOSITORY = "github:github.com/example/desk";
const CONVERSATION = "conversation-example";

export const graphNodeAuthority: Authority = confirmationAuthority(GRAPH_NODE_NOW);

export const graphNodeFields = (overrides: Partial<WorkGraphNodeFields> = {}): WorkGraphNodeFields => ({ repository: GRAPH_NODE_REPOSITORY, parent: "12", title: "Probe node", checkpoint: "probe-checkpoint", ...overrides });

export const graphNodeOperationId = (name: string): string => `${CONVERSATION}:${name}:1`;

export function graphNodeRequest(fields: WorkGraphNodeFields, operationId = graphNodeOperationId("proposal-example")): Parameters<WorkGraphNodeFacade["create"]>[0] {
  const proposalId = operationId.split(":")[1] ?? "proposal-example";
  return { operationId, type: "graph-node", fields, activation: "none", provenance: { conversationId: CONVERSATION, proposalId, revision: 1, operationId, entryId: null, link: `?desk=conversation&conversation=${CONVERSATION}` }, signal: new AbortController().signal };
}

export interface FiledNode { node: string; repo: string; parent: string | null; argv: string[] }

export interface SyntheticSoma {
  readonly run: WriterRunner;
  readonly calls: string[][];
  readonly nodes: Map<string, FiledNode>;
  mode: "normal" | "exit-after-file" | "unattached" | "exit-no-file" | "file-under-other-parent";
}

const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
const ok = (data: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });

export function syntheticSoma(): SyntheticSoma {
  const nodes = new Map<string, FiledNode>();
  const calls: string[][] = [];
  let next = 40;
  const soma: SyntheticSoma = {
    calls,
    nodes,
    mode: "normal",
    run: argv => {
      calls.push(argv);
      const marker = flag(argv, "--once");
      const shown = (repo: string): string => repo.replace(/^github:github\.com\//, "");
      if (argv.includes("--dry-run")) {
        const hit = nodes.get(marker);
        return Promise.resolve(ok(hit ? { found: true, repo: hit.repo, node: hit.node, parent: hit.parent } : { found: false }));
      }
      readFileSync(flag(argv, "--body-file"), "utf8");
      const prior = nodes.get(marker);
      if (prior) return Promise.resolve(ok({ repo: prior.repo, node: prior.node, parent: prior.parent, existing: true }));
      if (soma.mode === "exit-no-file") return Promise.resolve({ code: 2, stdout: "", stderr: "soma: graph unavailable\n" });
      const node = String(next++);
      const repo = shown(flag(argv, "--repo"));
      const parent = soma.mode === "file-under-other-parent" ? "999" : argv[3] ?? "";
      nodes.set(marker, { node, repo, parent, argv });
      if (soma.mode === "unattached") return Promise.resolve({ code: 1, stdout: "", stderr: JSON.stringify({ node, attached: false }) });
      if (soma.mode === "exit-after-file" || soma.mode === "file-under-other-parent") return Promise.resolve({ code: 3, stdout: "", stderr: "soma: lost the connection\n" });
      return Promise.resolve(ok({ repo, node, parent, existing: false }));
    },
  };
  return soma;
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
