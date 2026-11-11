import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../../balance";
import { openOwnerDraftRig, type DraftRigSetup } from "../../drafting-rig";
import type { ModelOutput } from "../../drafting";
import type { OwnerWriter } from "../../../types";
import { createBalanceReadAdapter } from "../read";
import { createBalanceTaskBinding } from "../task-binding";
import { initDatabase } from "../../../../surface/mc/db/init";
import { loadBalanceState, saveBalanceState } from "../../../../surface/mc/desk/balance-store";
import { balanceWriter } from "../../../../surface/mc/desk/balance-conversation-writer";
import type { DeskOptions } from "../../../../surface/mc/desk/compose";
import { DEFAULT_CONFIG } from "../../../../surface/mc/config";
import { startServer } from "../../../../surface/mc/server";
import { deskBalanceDraftEditor, type BalanceDraftEntryOptions, type BalanceDraftSession } from "../../../../surface/mc/desk/balance-draft-entry";
import { balanceDraftDestinations } from "../../../../surface/mc/desk/balance-draft-destinations";

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
  let db: Database | undefined;
  const database = (): Database => {
    if (!db) throw new Error("Synthetic Balance database not opened");
    return db;
  };
  const ownerCalls: string[] = [];
  const areas = [{ id: DRAFT_LAB_AREA, label: "Lab", color: "#2563eb", repos: [], goals: [] }, { id: DRAFT_HOME_AREA, label: "Home", color: "#059669", repos: [], goals: [] }];
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas, sources: [] };
  const rig = await openOwnerDraftRig({
    adapterId: "balance", capabilityId: "balance.task.create", title: "Balance task", now: BALANCE_DRAFT_NOW, connectorId: "synthetic-balance", discussion: BALANCE_DRAFT_DISCUSSION, principal: "local",
    openTarget({ root, connectionId }) {
      db = initDatabase(join(root, "desk.sqlite"));
      saveBalanceState(database(), balanceDraftState());
      const read = createBalanceReadAdapter({ connectionId, state: () => loadBalanceState(database()), areas: () => areas, now: () => new Date(BALANCE_DRAFT_NOW) });
      const base = balanceWriter("task", { db: database(), desk: () => options, now: () => BALANCE_DRAFT_NOW });
      const owner: Pick<OwnerWriter, "create" | "readback"> = { create: request => { ownerCalls.push(request.operationId); return base.create(request); }, readback: operation => base.readback(operation) };
      const setup = (draft: DraftRigSetup) => ({ host: draft.host, deps: draft.deps, options: draft.options as BalanceDraftEntryOptions });
      return {
        read, destinationIds: [DRAFT_LAB_AREA, DRAFT_HOME_AREA], destinationType: "area",
        sessionExtras: (destinations, source) => ({ areas: destinations, destinations: source.destinations }),
        createBinding: journal => createBalanceTaskBinding({ stack: "test", connectionId, db: database(), desk: () => options, areas: () => areas, journal, now: () => BALANCE_DRAFT_NOW, owner }),
        createEditor: draft => { const { host, deps, options: entry } = setup(draft); return deskBalanceDraftEditor(host, deps, entry); },
        serve: (draft, principal, serverOptions) => startServer({ ...DEFAULT_CONFIG, port: 0, governance: { ...DEFAULT_CONFIG.governance, principals: [], localPrincipal: principal } }, database(), { ...serverOptions, balanceDrafts: setup(draft) }),
        close: () => { database().close(); },
      };
    },
    extend: core => {
      const destinations = () => balanceDraftDestinations({ connectionId: core.connectionId, session: async conversationId => await core.session(conversationId) as BalanceDraftSession | null, authority: core.authority });
      const outline = (): OutlineNode => {
        const state = loadBalanceState(database());
        if (!state) throw new Error("Synthetic Balance outline missing");
        return state.outline;
      };
      return {
        db: database(), ownerCalls, areas, read: core.target.read,
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
