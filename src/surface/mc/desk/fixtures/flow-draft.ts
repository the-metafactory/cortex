import type { ModelOutput } from "../../../../conversations/domain-adapters/drafting";
import { FLOW_DESTINATIONS_CAPABILITY, flowDestinationsPage } from "../../../../conversations/domain-adapters/flow/destinations";
import { createFlowSaveBinding, flowSaveDeclaration } from "../../../../conversations/domain-adapters/flow/save-binding";
import { deskFlowDraftEditor, type FlowDraftSetup } from "../flow-draft-entry";
import { flowDraftDestinations } from "../flow-draft-destinations";
import { openFlowPulseRig } from "./flow-pulse";
import { openOwnerDraftRig } from "./owner-draft";

export const FLOW_DRAFT_NOW = Date.parse("2026-11-10T09:00:00.000Z");
export const FLOW_DRAFT_STACK = "test";
export const FLOW_DRAFT_NAME = "F_DESK_PREFILL";
export const FLOW_DRAFT_DISCUSSION = "We agreed to save a Flow that takes the workshop brief, checks the lab calendar and posts the plan. Call it F_DESK_PREFILL and keep those steps in that order. Do not schedule it.";
export const flowDraftDefinition = (name = FLOW_DRAFT_NAME): string => `name: ${name}\ninput:\n  text: example\nactions:\n  - A_EXAMPLE\n`;
export const flowDraftInvalidDefinition = (name = FLOW_DRAFT_NAME): string => `name: ${name}\nactions: []\n`;

export async function openFlowDraftRig(fixture: { discussion?: string } = {}) {
  const pulse = await openFlowPulseRig("desk-flow-draft-");
  const rig = await openOwnerDraftRig({
    adapterId: "flow", capabilityId: "flow.saved.create", title: "Flow", now: FLOW_DRAFT_NOW, connectorId: "synthetic-flow", discussion: FLOW_DRAFT_DISCUSSION, principal: "local",
    openTarget({ connectionId }) {
      const destinations = () => flowDestinationsPage(connectionId, FLOW_DRAFT_STACK, new Date(FLOW_DRAFT_NOW).toISOString());
      return {
        read: {
          declaration: flowSaveDeclaration(),
          bindings: { handlers: { [FLOW_DESTINATIONS_CAPABILITY]: destinations }, observations: {} },
          readBindings: [],
          query: () => Promise.reject(new Error("The Flow draft fixture declares no owner query.")),
          destinations,
        },
        destinationIds: [FLOW_DRAFT_STACK], destinationType: "stack",
        session: base => base,
        createBinding: journal => createFlowSaveBinding({ stack: FLOW_DRAFT_STACK, connectionId, flows: () => ({ pulse: pulse.pulse }), journal, run: (argv, stdin, timeout) => pulse.run(argv, stdin, timeout), now: () => FLOW_DRAFT_NOW }),
        createEditor: ({ host, deps, options }: FlowDraftSetup) => deskFlowDraftEditor(host, deps, { ...options, stack: FLOW_DRAFT_STACK }),
        serverOptions: draft => ({ flowDrafts: { ...draft, options: { ...draft.options, stack: FLOW_DRAFT_STACK } } }),
      };
    },
    extend: core => {
      const close = core.close.bind(core);
      const destinations = () => flowDraftDestinations({ connectionId: core.connectionId, stack: FLOW_DRAFT_STACK, authority: core.authority });
      return {
        pulse,
        resolve: (label: string, objectType = "stack") => destinations().resolve({ capabilityId: FLOW_DESTINATIONS_CAPABILITY, connectionId: core.connectionId, conversationId: core.makeInput.conversationId, objectType, label }),
        savedCount: () => pulse.savedCount(),
        savedNames: async (): Promise<string[]> => ((JSON.parse((await pulse.command(["list", "--saved"])).stdout) as { flows: { name: string }[] }).flows).map(flow => flow.name),
        localStack: () => core.restrict(FLOW_DRAFT_STACK, { egress: "local" }),
        revokeStack: () => core.restrict(FLOW_DRAFT_STACK, { status: "revoked" }),
        async close() { await close(); await pulse.close(); },
      };
    },
  }, fixture);
  return rig;
}

export function advanceDiscussion(rig: { state: { head: string; items: { id: string; kind: "turn" | "outcome" | "linked" | "selected"; revision: string; digest: string; restriction: "local" | "cloud"; text: string; at: string }[] } }, text: string): void {
  rig.state.head = "2";
  rig.state.items.push({ id: "outcome-example", revision: "2", digest: "outcome-2", kind: "outcome", restriction: "cloud", text, at: new Date(FLOW_DRAFT_NOW + 3_600_000).toISOString() });
}

const SOURCE = ["turn-example"];
export const flowDiscussionOutput = (definition = flowDraftDefinition()): ModelOutput => ({ fields: [
  { pointer: "/definition", value: definition, citations: SOURCE },
] });

export const flowNamedOutput = (name: string, definition = flowDraftDefinition()): ModelOutput => ({ fields: [
  { pointer: "/definition", value: definition, citations: SOURCE },
  { pointer: "/name", value: name, citations: SOURCE },
] });
