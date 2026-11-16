import type { DeskPhrase } from "./phrases";

export const DESK_MEETING_BRIEF_PATH = "/api/desk/meeting-brief";
export const DESK_MEETING_PREVIOUS_PATH = "/api/desk/meeting-brief/previous";

export type BriefSourceKind = "mail" | "task" | "thread" | "note" | "meeting";

export const BRIEF_GAP_REASONS = ["no-adapter", "access-denied", "read-failed", "no-linked-material"] as const;
export type BriefGapReason = (typeof BRIEF_GAP_REASONS)[number];

export const BRIEF_SYNTHESIS_STATES = ["preparing", "ready", "unavailable", "failed"] as const;
export const BRIEF_PREVIOUS_MEETING_STATES = ["identified", "unidentified", "unavailable"] as const;

export interface BriefSourceIdentity {
  kind: BriefSourceKind;
  adapter: string | null;
  owner?: string;
  connection?: string;
  item: string;
}

export type BriefSourceRef = BriefSourceIdentity & ({ excerpt: string; link?: string } | { excerpt?: string; link: string });

export interface BriefFact {
  id: string;
  text: string;
  sources: BriefSourceRef[];
}

export interface BriefGap {
  id: string;
  reason: BriefGapReason;
  source: BriefSourceIdentity;
  phrase: DeskPhrase;
  message: string;
}

export interface BriefPreviousMeeting {
  state: (typeof BRIEF_PREVIOUS_MEETING_STATES)[number];
  phrase: DeskPhrase;
  message: string;
  event?: string;
  relation?: "explicit";
  facts?: BriefFact[];
  gaps?: BriefGap[];
}

export interface PreviousMeetingRelationship {
  ok: true;
  event: string;
  previousEvent: string | null;
  relation: "explicit" | null;
  message: string;
  messagePhrase: DeskPhrase;
}

export interface BriefSynthesis {
  state: (typeof BRIEF_SYNTHESIS_STATES)[number];
  reason?: "not-configured";
  phrase: DeskPhrase;
  message: string;
}

export interface MeetingBrief {
  event: string;
  revision: string;
  preparedAt: string;
  facts: BriefFact[];
  gaps: BriefGap[];
  previousMeeting: BriefPreviousMeeting;
  synthesis: BriefSynthesis;
}

export const REFRESH_REQUIRED = "refresh-required";

export interface BriefRefreshRequired {
  ok: false;
  error: string;
  code: typeof REFRESH_REQUIRED;
}

export const PREVIOUS_MEETING_UNIDENTIFIED: BriefPreviousMeeting = {
  state: "unidentified",
  phrase: { code: "brief.previous-unidentified" },
  message: "No previous meeting identified.",
};

export const previousIdentified = (event: string, facts: BriefFact[], gaps: BriefGap[]): BriefPreviousMeeting => ({
  state: "identified", phrase: { code: "brief.previous-identified" }, message: "The previous meeting was set explicitly.", event, relation: "explicit", facts, gaps,
});

export const previousUnavailable = (event: string): BriefPreviousMeeting => ({
  state: "unavailable", phrase: { code: "brief.previous-unavailable" }, message: "The previous meeting that was set can no longer be read.", event, relation: "explicit",
});

export const SYNTHESIS_NOT_CONFIGURED: BriefSynthesis = {
  state: "unavailable",
  reason: "not-configured",
  phrase: { code: "brief.synthesis-not-configured" },
  message: "No summary model is configured, so the evidence is shown as it is.",
};

const KIND_LABEL: Record<BriefSourceKind, string> = { mail: "mail", task: "task", thread: "Studio thread", note: "note", meeting: "meeting" };

const GAP_WORDING: Record<BriefGapReason, (kind: BriefSourceKind) => { phrase: DeskPhrase; message: string }> = {
  "no-adapter": (kind) => ({ phrase: { code: "brief.gap-no-adapter", params: { kind } }, message: `Nothing is set up to read this ${KIND_LABEL[kind]}.` }),
  "access-denied": (kind) => ({ phrase: { code: "brief.gap-access-denied", params: { kind } }, message: `Reading this ${KIND_LABEL[kind]} is not allowed.` }),
  "read-failed": (kind) => ({ phrase: { code: "brief.gap-read-failed", params: { kind } }, message: `This ${KIND_LABEL[kind]} could not be read.` }),
  "no-linked-material": (kind) => ({ phrase: { code: "brief.gap-no-linked-material", params: { kind } }, message: `No ${KIND_LABEL[kind]} material is linked to this meeting.` }),
};

export const gapWording = (reason: BriefGapReason, kind: BriefSourceKind): { phrase: DeskPhrase; message: string } => GAP_WORDING[reason](kind);
