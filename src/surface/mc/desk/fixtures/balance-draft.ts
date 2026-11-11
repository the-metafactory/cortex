import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../../balance";
import { openOwnerDraftRig } from "./owner-draft";
import type { ModelOutput } from "../../../../conversations/domain-adapters/drafting";
import type { OwnerWriter } from "../../../../conversations/types";
import { createBalanceReadAdapter } from "../../../../conversations/domain-adapters/balance/read";
import { createBalanceTaskBinding } from "../../../../conversations/domain-adapters/balance/task-binding";
import { loadBalanceState, saveBalanceState } from "../balance-store";
import { balanceWriter } from "../balance-conversation-writer";
import type { DeskOptions } from "../compose";
import { deskBalanceDraftEditor, type BalanceDraftSetup } from "../balance-draft-entry";
import { balanceDraftDestinations } from "../balance-draft-destinations";

export const BALANCE_DRAFT_NOW = Date.parse("2026-11-09T09:00:00.000Z");
export const DRAFT_LAB_AREA = "area-example";
export const DRAFT_HOME_AREA = "area-home";
export const DRAFT_GLIDER_PROJECT = "studio-thread:glider";
export const DRAFT_HOME_GLIDER_PROJECT = "studio-thread:home-glider";
export const BALANCE_DRAFT_DISCUSSION = "We should get the glider wing cut before the workshop. The paper is already in the lab, and the shop closes on Friday 2026-11-13. Draft a task for the Lab area under the Glider project.";

const leaf = (id: string, title: string): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children: [], effort: 1 });
const project = (id: string, title: string, children: OutlineNode[] = [leaf(`${id}:task`, `Existing ${title} task`)]): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children });

export function balanceDraftState(): AppState {
  const children: OutlineNode[] = [
    { id: `area:${DRAFT_LAB_AREA}`, title: "Lab", weight: 60, ordering: "parallel", children: [project(DRAFT_GLIDER_PROJECT, "Glider"), project("studio-thread:kite", "Kite"), project("studio-thread:shared-a", "Shared"), project("studio-thread:shared-b", "Shared")] },
    { id: `area:${DRAFT_HOME_AREA}`, title: "Home", weight: 40, ordering: "parallel", children: [project(DRAFT_HOME_GLIDER_PROJECT, "Glider")] },
  ];
  return { outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children }, log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} } };
}

const countTasks = (node: OutlineNode): number => (node.children.length === 0 ? 1 : 0) + node.children.reduce((sum, child) => sum + countTasks(child), 0);

export async function openBalanceDraftRig(fixture: { discussion?: string } = {}) {
  const ownerCalls: string[] = [];
  const areas = [{ id: DRAFT_LAB_AREA, label: "Lab", color: "#2563eb", repos: [], goals: [] }, { id: DRAFT_HOME_AREA, label: "Home", color: "#059669", repos: [], goals: [] }];
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas, sources: [] };
  const rig = await openOwnerDraftRig({
    adapterId: "balance", capabilityId: "balance.task.create", title: "Balance task", now: BALANCE_DRAFT_NOW, connectorId: "synthetic-balance", discussion: BALANCE_DRAFT_DISCUSSION, principal: "local",
    openTarget({ db, connectionId }) {
      saveBalanceState(db, balanceDraftState());
      const read = createBalanceReadAdapter({ connectionId, state: () => loadBalanceState(db), areas: () => areas, now: () => new Date(BALANCE_DRAFT_NOW) });
      const base = balanceWriter("task", { db, desk: () => options, now: () => BALANCE_DRAFT_NOW });
      const owner: Pick<OwnerWriter, "create" | "readback"> = { create: request => { ownerCalls.push(request.operationId); return base.create(request); }, readback: operation => base.readback(operation) };
      return {
        read, destinationIds: [DRAFT_LAB_AREA, DRAFT_HOME_AREA], destinationType: "area",
        session: (base, destinations, source) => ({ ...base, areas: destinations, destinations: source.destinations }),
        createBinding: journal => createBalanceTaskBinding({ stack: "test", connectionId, db, desk: () => options, areas: () => areas, journal, now: () => BALANCE_DRAFT_NOW, owner }),
        createEditor: ({ host, deps, options: entry }: BalanceDraftSetup) => deskBalanceDraftEditor(host, deps, entry),
        serverOptions: draft => ({ balanceDrafts: draft }),
      };
    },
    extend: core => {
      const db = core.db;
      const destinations = () => balanceDraftDestinations({ connectionId: core.connectionId, session: core.session, authority: core.authority });
      const outline = (): OutlineNode => {
        const state = loadBalanceState(db);
        if (!state) throw new Error("Synthetic Balance outline missing");
        return state.outline;
      };
      return {
        db, ownerCalls, areas, read: core.target.read,
        resolve: (label: string, objectType = "project") => destinations().resolve({ capabilityId: "balance.destinations", connectionId: core.connectionId, conversationId: core.makeInput.conversationId, objectType, label }),
        taskCount: () => countTasks(outline()),
        outlineSnapshot: () => JSON.stringify(outline()),
        localArea: (area: string) => core.restrict(area, { egress: "local" }),
      };
    },
  }, fixture);
  return rig;
}

const SOURCE = ["turn-example"];
export const balanceDiscussionOutput = (includeLater = false): ModelOutput => ({ fields: [
  { pointer: "/area", labels: ["Lab"], citations: SOURCE },
  { pointer: "/project", labels: ["Lab / Glider"], citations: SOURCE },
  { pointer: "/title", value: "Cut the glider wing before the workshop", citations: SOURCE },
  { pointer: "/note", value: `What: cut the glider wing from the paper that is already in the lab. Why: the workshop needs it and the shop closes on Friday. Constraints: finish before the shop closes. Open question: none recorded.${includeLater ? " Later: the discussion added a fitting check after cutting." : ""}`, citations: includeLater ? [...SOURCE, "outcome-example"] : SOURCE },
  { pointer: "/due", value: "2026-11-13", citations: SOURCE },
] });

export const conflictingDueOutput = (): ModelOutput => ({ fields: [
  ...balanceDiscussionOutput().fields.filter(field => field.pointer !== "/due"),
  { pointer: "/due", alternatives: [{ value: "2026-11-13", citations: SOURCE }, { value: "2026-11-20", citations: SOURCE }], citations: SOURCE },
] });
