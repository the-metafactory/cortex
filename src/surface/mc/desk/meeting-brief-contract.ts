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

export const BRIEF_SYNTHESIS_UNAVAILABLE_REASONS = ["not-configured", "no-local-model", "no-evidence", "not-prepared"] as const;
export const BRIEF_SYNTHESIS_FAILED_REASONS = ["model-failed", "invalid-output", "interrupted"] as const;
export type BriefSynthesisUnavailableReason = (typeof BRIEF_SYNTHESIS_UNAVAILABLE_REASONS)[number];
export type BriefSynthesisFailedReason = (typeof BRIEF_SYNTHESIS_FAILED_REASONS)[number];

/** One statement of the summary. `references` are ids of facts in this brief, current or previous meeting, and are never empty. */
export interface BriefClaim {
  text: string;
  references: string[];
}

export type BriefSynthesis =
  | { state: "preparing"; generation: string; startedAt: string; phrase: DeskPhrase; message: string }
  | { state: "ready"; generation: string; completedAt: string; claims: BriefClaim[]; phrase: DeskPhrase; message: string }
  | { state: "unavailable"; reason: BriefSynthesisUnavailableReason; phrase: DeskPhrase; message: string }
  | { state: "failed"; reason: BriefSynthesisFailedReason; generation: string; failedAt: string; phrase: DeskPhrase; message: string };

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

const UNAVAILABLE_WORDING: Record<BriefSynthesisUnavailableReason, { phrase: DeskPhrase; message: string }> = {
  "not-configured": { phrase: { code: "brief.synthesis-not-configured" }, message: "No summary model is configured, so the evidence is shown as it is." },
  "no-local-model": { phrase: { code: "brief.synthesis-no-local-model" }, message: "Some of this material must stay on this machine and no local summary model is configured, so the evidence is shown as it is." },
  "no-evidence": { phrase: { code: "brief.synthesis-no-evidence" }, message: "There is no readable material to summarise." },
  "not-prepared": { phrase: { code: "brief.synthesis-not-prepared" }, message: "No summary is prepared for the current material and model settings. Prepare the brief to start one." },
};

export const synthesisUnavailable = (reason: BriefSynthesisUnavailableReason): BriefSynthesis => ({ state: "unavailable", reason, ...UNAVAILABLE_WORDING[reason] });

export const SYNTHESIS_NOT_CONFIGURED: BriefSynthesis = synthesisUnavailable("not-configured");

const FAILED_WORDING: Record<BriefSynthesisFailedReason, { phrase: DeskPhrase; message: string }> = {
  "model-failed": { phrase: { code: "brief.synthesis-model-failed" }, message: "The summary could not be prepared. The evidence is shown as it is; prepare the brief again to retry." },
  "invalid-output": { phrase: { code: "brief.synthesis-invalid-output" }, message: "The summary was discarded because it did not cite the evidence. The evidence is shown as it is; prepare the brief again to retry." },
  interrupted: { phrase: { code: "brief.synthesis-interrupted" }, message: "The summary was interrupted before it finished. The evidence is shown as it is; prepare the brief again to retry." },
};

export const synthesisFailed = (reason: BriefSynthesisFailedReason, generation: string, failedAt: number): BriefSynthesis => ({ state: "failed", reason, generation, failedAt: new Date(failedAt).toISOString(), ...FAILED_WORDING[reason] });

export const synthesisPreparing = (generation: string, startedAt: number): BriefSynthesis => ({
  state: "preparing", generation, startedAt: new Date(startedAt).toISOString(), phrase: { code: "brief.synthesis-preparing" }, message: "A summary is being prepared. The evidence is ready now.",
});

export const synthesisReady = (generation: string, completedAt: number, claims: BriefClaim[]): BriefSynthesis => ({
  state: "ready", generation, completedAt: new Date(completedAt).toISOString(), claims, phrase: { code: "brief.synthesis-ready" }, message: "The summary cites the evidence below.",
});

const KIND_LABEL: Record<BriefSourceKind, string> = { mail: "mail", task: "task", thread: "Studio thread", note: "note", meeting: "meeting" };

const GAP_WORDING: Record<BriefGapReason, (kind: BriefSourceKind) => { phrase: DeskPhrase; message: string }> = {
  "no-adapter": (kind) => ({ phrase: { code: "brief.gap-no-adapter", params: { kind } }, message: `Nothing is set up to read this ${KIND_LABEL[kind]}.` }),
  "access-denied": (kind) => ({ phrase: { code: "brief.gap-access-denied", params: { kind } }, message: `Reading this ${KIND_LABEL[kind]} is not allowed.` }),
  "read-failed": (kind) => ({ phrase: { code: "brief.gap-read-failed", params: { kind } }, message: `This ${KIND_LABEL[kind]} could not be read.` }),
  "no-linked-material": (kind) => ({ phrase: { code: "brief.gap-no-linked-material", params: { kind } }, message: `No ${KIND_LABEL[kind]} material is linked to this meeting.` }),
};

export const gapWording = (reason: BriefGapReason, kind: BriefSourceKind): { phrase: DeskPhrase; message: string } => GAP_WORDING[reason](kind);
