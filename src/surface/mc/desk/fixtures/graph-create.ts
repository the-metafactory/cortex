import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openOwnerDraftRig, type DraftRigSetup } from "../../../../conversations/domain-adapters/drafting-rig";
import type { ModelOutput } from "../../../../conversations/domain-adapters/drafting";
import { createWorkGraphReadAdapter } from "../../../../conversations/domain-adapters/work-graph/read";
import { createWorkGraphNodeBinding } from "../../../../conversations/domain-adapters/work-graph/node-binding";
import { initDatabase } from "../../db/init";
import { setGraphRepositoryEnabled } from "../graph-repositories";
import { DEFAULT_CONFIG } from "../../config";
import { startServer } from "../../server";
import { deskGraphDraftEditor, type GraphDraftEntryOptions, type GraphDraftSession } from "../graph-draft-entry";
import { graphDraftDestinations } from "../graph-draft-destinations";
import { GRAPH_NODE_REPOSITORY, GRAPH_NODE_NOW, syntheticSoma } from "./synthetic-soma";

export const CREATE_REPOSITORY = GRAPH_NODE_REPOSITORY;
export const CREATE_OTHER_REPOSITORY = "github:github.com/other/desk";
export const CREATE_PARENT = "example/desk#12";
export const CREATE_MAP = `${CREATE_REPOSITORY}#10`;
const NODES: Record<string, { repository: string; id: string; title: string; link?: "graph-map" | "graph-node"; linkId?: string }> = {
  [CREATE_MAP]: { repository: CREATE_REPOSITORY, id: "10", title: "Lifecycle map", link: "graph-map" },
  [`${CREATE_REPOSITORY}#12`]: { repository: CREATE_REPOSITORY, id: "12", title: "Shared title", link: "graph-node", linkId: CREATE_PARENT },
  [`${CREATE_OTHER_REPOSITORY}#13`]: { repository: CREATE_OTHER_REPOSITORY, id: "13", title: "Shared title", link: "graph-node" },
  [`${CREATE_REPOSITORY}#14`]: { repository: CREATE_REPOSITORY, id: "14", title: "Exact unlinked node" },
};
const AT = new Date(GRAPH_NODE_NOW).toISOString();
const CAPABILITY = "work-graph.node.create";
export const GRAPH_DRAFT_DISCUSSION = "The importer can lose acceptance receipts on restart. Compare persisted receipts with canonical lookup, document crash cases and propose a regression test. File a research node under the lifecycle map; use checkpoint receipt-restart-evidence. Keep unknown dependencies absent and do not activate a writer.";

export async function openGraphCreateRig(fixture: { discussion?: string } = {}) {
  const soma = syntheticSoma();
  const reads: string[][] = [];
  let db: Database | undefined;
  const database = (): Database => {
    if (!db) throw new Error("Synthetic graph database not opened");
    return db;
  };
  const rig = await openOwnerDraftRig({
    adapterId: "work-graph", capabilityId: CAPABILITY, title: "Graph creation", now: GRAPH_NODE_NOW, connectorId: "synthetic-graph", discussion: GRAPH_DRAFT_DISCUSSION, principal: "local",
    openTarget({ root, connectionId }) {
      db = initDatabase(join(root, "desk.sqlite"));
      const repositories = [CREATE_REPOSITORY, CREATE_OTHER_REPOSITORY];
      for (const repository of repositories) setGraphRepositoryEnabled(database(), repository, true, GRAPH_NODE_NOW);
      const read = createWorkGraphReadAdapter({ connectionId, repositories: () => repositories, links: () => Object.values(NODES).flatMap(node => node.link ? [{ owner: node.link, id: node.linkId ?? `${node.repository}#${node.id}`, title: node.title }] : []), now: () => new Date(AT), run: argv => {
        reads.push(argv);
        const target = argv[3];
        const data = target ? NODES[target] ?? null : null;
        return Promise.resolve(data ? { code: 0, signal: null, stderr: "", stdout: JSON.stringify({ repo: data.repository, ref: { id: data.id }, status: "open", node: { title: data.title }, parent: null }) } : { code: 1, signal: null, stderr: "not found", stdout: "" });
      } });
      const setup = (draft: DraftRigSetup) => ({ host: draft.host, deps: draft.deps, options: draft.options as GraphDraftEntryOptions });
      return {
        read, destinationIds: repositories, destinationType: "repository",
        sessionExtras: (destinations, source) => ({ repositories: destinations, destinations: source.destinations }),
        createBinding: journal => createWorkGraphNodeBinding({ stack: "test", connectionId, db: database(), desk: () => ({ enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], somaBin: "/synthetic/soma" }), journal, run: soma.run, now: () => GRAPH_NODE_NOW }),
        createEditor: draft => { const { host, deps, options } = setup(draft); return deskGraphDraftEditor(host, deps, options); },
        serve: (draft, principal, serverOptions) => startServer({ ...DEFAULT_CONFIG, port: 0, governance: { ...DEFAULT_CONFIG.governance, principals: [], localPrincipal: principal } }, database(), { ...serverOptions, graphDrafts: setup(draft) }),
        close: () => { database().close(); },
      };
    },
    extend: core => {
      const destinations = () => graphDraftDestinations({ connectionId: core.connectionId, session: async conversationId => await core.session(conversationId) as GraphDraftSession | null, authority: core.authority });
      return {
      db: database(), soma, reads, read: core.target.read, get destinations() { return destinations(); },
      resolve: (label: string, objectType = "node") => destinations().resolve({ capabilityId: "work-graph.destinations", connectionId: core.connectionId, conversationId: core.makeInput.conversationId, objectType, label }),
      localRepository: (repository: string) => core.restrict(repository, { egress: "local" }),
      async untick(repository: string) {
        const repositories = core.target.destinationIds;
        const index = repositories.indexOf(repository);
        if (index < 0) throw new Error("Synthetic repository missing");
        await core.restrict(repository, { status: "revoked" });
        repositories.splice(index, 1);
        setGraphRepositoryEnabled(database(), repository, false, GRAPH_NODE_NOW);
      },
      };
    },
  }, fixture);
  return rig;
}

export const graphCreateOutput = (parent = "Lifecycle map"): ModelOutput => ({ fields: [
  { pointer: "/repository", labels: [CREATE_REPOSITORY], citations: ["turn-example"] },
  { pointer: "/parent", labels: [parent], citations: ["turn-example"] },
  { pointer: "/title", value: "Verify graph creation", citations: ["turn-example"] },
  { pointer: "/checkpoint", value: "graph-create-probe", citations: ["turn-example"] },
] });

export const graphDiscussionOutput = (includeAcceptanceCrash = false): ModelOutput => ({ fields: [
  ...graphCreateOutput().fields.filter(field => field.pointer !== "/title" && field.pointer !== "/checkpoint"),
  { pointer: "/title", value: "Investigate receipt preservation across restart", citations: ["turn-example"] },
  { pointer: "/body", value: `Problem: the importer can lose acceptance receipts on restart. Intended result: compare persisted receipts with canonical lookup, document crash cases and propose a regression test. Evidence: the discussion reports receipt loss; the crash cases still need investigation. Constraints: retain canonical operation identity, leave unknown dependencies absent and keep writer activation gated.${includeAcceptanceCrash ? " Include a crash immediately after acceptance." : ""}`, citations: ["turn-example", ...(includeAcceptanceCrash ? ["outcome-example"] : [])] },
  { pointer: "/checkpoint", value: "receipt-restart-evidence", citations: ["turn-example"] },
  { pointer: "/kind", value: "research", citations: ["turn-example"] },
] });
