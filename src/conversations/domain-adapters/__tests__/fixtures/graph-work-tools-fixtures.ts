import { CORTEX, CORTEX_MAP, CORTEX_NODE, CRISIS, UNTICKED, type GraphReadRig } from "./graph-read-fixtures";
import type { GraphConversationLink } from "../../work-graph/read";
import { graphWorkQuery, graphWorkReaders, type GraphWorkRepository } from "../../../../surface/mc/desk/graph-work-reader";
import type { ToolSession } from "../../../tools/capabilities";
import { mayRelease, workContextTools, type WorkObject, type WorkOwner } from "../../../tools/work-context";

interface CallOptions {
  readonly links?: readonly GraphConversationLink[];
  readonly repositories?: readonly GraphWorkRepository[];
  readonly sessionPolicy?: "local" | "cloud";
  readonly enabled?: boolean;
}
const LINKS: readonly GraphConversationLink[] = [{ owner: "graph-map", id: CORTEX_MAP }, { owner: "graph-node", id: CORTEX_NODE }, { owner: "graph-node", id: `${UNTICKED}#7` }];
const TICKED: readonly GraphWorkRepository[] = [{ id: CORTEX, policy: "cloud" }, { id: CRISIS, policy: "cloud" }];

export async function callGraphWorkTool(rig: GraphReadRig, name: "work_search" | "work_read", input: object, options: CallOptions = {}) {
  const { links = LINKS, repositories = TICKED, sessionPolicy = "cloud", enabled = true } = options;
  const remembered: WorkObject[] = [];
  const query = graphWorkQuery({ connectionId: rig.connectionId, repositories: () => repositories, links: () => links, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink });
  const owner: WorkOwner = {
    readers: () => ({}),
    ...(enabled ? { queries: session => graphWorkReaders(query, object => mayRelease(session, object.policy)) } : {}),
    now: () => Date.now(),
    remember: async (_session, objects) => { remembered.push(...objects); return true; },
  };
  const session: ToolSession = { principal: "principal-example", conversationId: rig.rig.approval.snapshot.provenance.conversationId, transport: "web", route: "local", policy: sessionPolicy, scope: [] };
  const tool = workContextTools(owner).find(candidate => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const text = await tool.run(input, { project: null, graph: null, projects: [], session, signal: new AbortController().signal });
  return { json: JSON.parse(typeof text === "string" ? text : text.text) as Record<string, any>, remembered };
}
