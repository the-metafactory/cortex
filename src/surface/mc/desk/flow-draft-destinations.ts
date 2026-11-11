import type { AuthorityMediator } from "../../../conversations/authority";
import type { DraftDestinations } from "../../../conversations/domain-adapters/drafting";
import { FLOW_DESTINATIONS_CAPABILITY, flowStackRef } from "../../../conversations/domain-adapters/flow/destinations";
import { activeRestriction } from "./work-released";

export interface FlowDraftDestinations extends DraftDestinations {
  batch(): FlowDraftDestinations;
}

export interface FlowDraftDestinationOptions {
  readonly connectionId: string;
  readonly stack: string;
  readonly authority: Pick<AuthorityMediator, "inspectHostRecords">;
}

export function flowDraftDestinations(options: FlowDraftDestinationOptions): FlowDraftDestinations {
  function batch(): FlowDraftDestinations {
    const ref = flowStackRef(options.connectionId, options.stack);
    let available: Promise<boolean> | undefined;
    const current = (): Promise<boolean> => (available ??= options.authority.inspectHostRecords().then(state => activeRestriction(state, ref) !== undefined));
    return {
      batch,
      async resolve(request) {
        if (request.connectionId !== options.connectionId || request.capabilityId !== FLOW_DESTINATIONS_CAPABILITY || request.objectType !== "stack") return { kind: "unavailable" };
        const label = request.label.trim();
        if (!label) return { kind: "none" };
        if (label !== options.stack && label.toLocaleLowerCase() !== options.stack.toLocaleLowerCase()) return { kind: "none" };
        return await current() ? { kind: "unique", ref } : { kind: "unavailable" };
      },
    };
  }
  return { batch, resolve: request => batch().resolve(request) };
}
