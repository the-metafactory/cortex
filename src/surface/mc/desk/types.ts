import type { ClassifierConfig } from "./classify";
import type { AREA_POLICIES } from "../../../common/types/config";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { Expect, SameShape } from "../../../common/types/same-shape";
import type { AreaPolicy as WireAreaPolicy, DeskItem } from "../../../desk-api/wire/types";
import type { ObjectReference as WireObjectReference } from "../../../desk-api/wire/object-reference";

export { INTERRUPT_REASON_CODES } from "../../../desk-sdk/interrupt-reason";
export { DESK_ITEM_KINDS, DESK_OUTCOMES } from "../../../desk-api/wire/types";
export type { DeskItemKind, DeskOutcome, DeskArea, DeskAction, DeskLink, DeskMention, JunkReviewMail, DeskEvidence, DeskPrecedent, DeskCorrectionMode, DeskCorrection, DeskWhyContent, DeskItem, InterruptReasonCode, DeskInterruptReason, InterruptFeedback, MeetingHold, DeskInterrupt, InterruptReasonView, DeskFoldedGroup, DeskEvent, DeskGoal, DeskView, DeferredItem, DeskMailClassifier } from "../../../desk-api/wire/types";

export type AreaPolicy = (typeof AREA_POLICIES)[number];

export interface StudioOptions {
  dir: string;
  filer?: ClassifierConfig & { local?: ClassifierConfig };
  maxActive: number;
  yesFilter?: string[];
  personas?: string[];
}

const FRESHNESS_LABEL: Record<NonNullable<DeskItem["freshness"]>, string | null> = {
  fresh: null,
  stale: "Stale observation",
  conflicted: "Conflicting observation",
  unavailable: "Observation unavailable",
};

/** The freshness label is deprecated in favour of the item's `freshness` code. This helper remains through 1.x and is removed in 2.0. */
export function freshnessLabel(status: DeskItem["freshness"]): string | null {
  return status ? FRESHNESS_LABEL[status] : null;
}

type _WireAreaPolicy = Expect<SameShape<AreaPolicy, WireAreaPolicy>>;
type _WireObjectReference = Expect<SameShape<ObjectReference, WireObjectReference>>;
