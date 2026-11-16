import type { AreaPolicy } from "./types";

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
