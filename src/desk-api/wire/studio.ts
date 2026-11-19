import type { AreaPolicy, DeskArea } from "./types";

export const THREAD_TYPES = ["question", "topic", "making"] as const;

export const THREAD_STATES = ["active", "parked", "closed"] as const;

export const THREAD_OUTCOMES = ["decided", "shipped", "dropped"] as const;

export const NOTE_KINDS = ["note", "stand", "idea", "relation"] as const;

export const NOTE_STATUSES = ["open", "kept", "dismissed"] as const;

export type ThreadType = (typeof THREAD_TYPES)[number];

export type ThreadState = (typeof THREAD_STATES)[number];

export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number];

export type NoteKind = (typeof NOTE_KINDS)[number];

export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface AssistantNote {
  at: string;
  trigger: string;
  model: string;
  mode?: string;
  run?: string;
  kind: NoteKind;
  status: NoteStatus;
  sample: boolean;
  because?: string;
  relates?: MaterialLink;
  text: string;
}

export interface StudioResponse {
  at: string;
  re?: string;
  text: string;
}

export interface MaterialLink {
  kind: string;
  label: string;
  href?: string;
  text?: string;
  textTruncated?: true;
  also?: { slug: string; question: string }[];
}

export interface LogEntry {
  at?: string;
  text: string;
}

export interface StudioThread {
  id?: string;
  slug: string;
  path: string;
  type: ThreadType;
  areas: string[];
  state: ThreadState;
  opened: string;
  closed?: string;
  thinkTonight: boolean;
  outcome?: ThreadOutcome;
  expect?: string;
  reviewOn?: string;
  question: string;
  stand: string;
  notes: AssistantNote[];
  responses: StudioResponse[];
  material: MaterialLink[];
  log: LogEntry[];
  outcomeText: string;
}

export interface SparPersona {
  name: string;
  from: "config" | "thread";
}

export type ThinkingBudget = "open" | "spent" | "off";

export type ThreadThinking =
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; budget: ThinkingBudget; reason: string | null; runs: { id: string; mode: string; status: "pending" | "failed"; reason: string }[] };

export interface StudioThreadView extends StudioThread {
  policy: AreaPolicy;
  place?: number;
  overCap: boolean;
  personas: SparPersona[];
  thinking?: ThreadThinking;
}

/** A Studio thread's outline row with its thread's state; `state` and `openNotes` are null when the Studio is off or this request could not read it. */
export interface StudioProjectLink { id: string; slug: string; state: ThreadState | null; openNotes: number | null }

export type StudioThreadOutcome =
  | { open: true; text: string }
  | { open: false; outcome: ThreadOutcome; closed: string | null; expect: string | null; reviewOn: string | null; text: string };

export interface StudioThreadDerived {
  waitsOnYou: boolean;
  needsResponse: boolean;
  notes: { open: AssistantNote[]; kept: AssistantNote[] };
  standProposal: AssistantNote | null;
  ideas: AssistantNote[];
  outcome: StudioThreadOutcome;
  where: { state: ThreadState; place: number | null; maxActive: number; opened: string };
}

export interface DeskStudioThread extends StudioThreadView {
  derived: StudioThreadDerived;
}

export interface StudioTarget {
  thread?: string;
  place?: "new";
  area?: string;
  reason: string;
}

export interface StudioCapture {
  id: string;
  path: string;
  at: string;
  via: string;
  text: string;
  target?: StudioTarget;
}

export interface StudioProposal {
  id: string;
  path: string;
  type: ThreadType;
  areas: string[];
  proposed: string;
  question: string;
  why: string;
  target: StudioTarget;
}

export interface StudioProposalView extends StudioProposal {
  policy: AreaPolicy;
}

export interface StudioProblem {
  path: string;
  reason: string;
}

export interface YesFilter {
  questions: string[];
  fromConfig: boolean;
}

export type StudioThinking =
  | { kind: "unavailable"; reason: string }
  | {
    kind: "ready";
    dailyRuns: { local: number; cloud: number };
    runs: {
      runUuid: string;
      id?: number;
      queuedAt?: string;
      finishedAt?: string | null;
      substrate?: string | null;
      result?: string | null;
      params: { thread: string; mode?: string; requestId?: string };
      status: "queued" | "running" | "succeeded" | "failed";
      reason: string | null;
      startedAt: string | null;
      policy: AreaPolicy | null;
    }[];
  };

export interface StudioView {
  personas?: string[];
  thinking?: StudioThinking;
  maxActive: number;
  yesFilter: YesFilter;
  areas: (DeskArea & { policy: AreaPolicy })[];
  active: StudioThreadView[];
  parked: StudioThreadView[];
  closed: StudioThreadView[];
  inbox: StudioCapture[];
  proposals: StudioProposalView[];
  problems: StudioProblem[];
}

export interface DeskStudioView extends StudioView {
  active: DeskStudioThread[];
  parked: DeskStudioThread[];
  closed: DeskStudioThread[];
}

export type DeskStudioResponse = { studio: null } | { directory: string; studio: DeskStudioView; materialText: "untrusted" };

export interface DeskStudioDraft {
  text: string;
  revision: string;
  editable: boolean;
}

export interface DeskStudioDraftWrite {
  text: string;
  revision: string;
  requestId: string;
}

export type DeskStudioDraftResponse = DeskStudioDraft | { error: string } | (DeskStudioDraft & { error: string });
