import type { DeskVoice } from "./voice";
import type { AREA_POLICIES } from "../../../common/types/config";

export type DeskUrgency = "now" | "today" | "this-week" | "waiting";

export const DESK_ITEM_KINDS = ["goal", "sensor", "agent-failed", "agent-blocked", "decision", "grilling", "escalation", "mail", "reminder", "meeting"] as const;

export type DeskItemKind = (typeof DESK_ITEM_KINDS)[number];

export type AreaPolicy = (typeof AREA_POLICIES)[number];

export interface StudioOptions {
  dir: string;
  maxActive: number;
}

export interface DeskArea {
  id: string;
  label: string;
  color: string;
}

export interface DeskAction {
  id: string;
  label: string;
  role: "primary" | "secondary";
  wired: boolean;
  url?: string;
  target?: string;
}

export interface DeskLink {
  label: string;
  url: string;
}

export interface DeskEvidence {
  kind: "mail" | "event" | "note";
  title: string;
  url?: string;
  eventKey?: string;
}

export interface DeskItemDetail {
  summary: string;
  history: string[];
  refs: string[];
  links: DeskLink[];
  evidence?: DeskEvidence[];
}

export type DeskCorrectionMode = "less" | "always";

export interface DeskCorrection {
  kind: DeskItemKind;
  source: string;
  mode: DeskCorrectionMode;
  label: string;
  createdAt: number;
}

export interface DeskItem {
  key: string;
  kind: DeskItemKind;
  source: string;
  area: string | null;
  urgency: DeskUrgency;
  title: string;
  why: string;
  score: number;
  actions: DeskAction[];
  more?: DeskAction[];
  detail: DeskItemDetail;
  excerpt?: string;
  suggestion?: string;
  eventKey?: string;
  since?: number;
  interrupt?: DeskInterrupt;
  correction?: DeskCorrectionMode;
  goal?: string;
  checking?: boolean;
  question?: { condition: string | null; reason: string };
  reply?: { to: string; subject: string };
}

export interface DeskInterrupt {
  delivery: "off" | "pending" | "sending" | "sent" | "buffered" | "failed";
  error?: string;
}

export interface DeskFoldedGroup {
  kind: DeskItemKind;
  label: string;
  count: number;
  example: string;
}

export interface DeskEvent {
  key: string;
  at: number;
  end?: number;
  title: string;
  note?: string;
  area: string | null;
  kind: "agent" | "agent-stop" | "meeting" | "all-day" | "reminder";
  url?: string;
  online?: boolean;
  source?: string;
}

export interface DeskGoal {
  id: string;
  text: string;
  state: "on-track" | "at-risk" | "off-track" | "stale" | "unknown";
}

export interface DeskView {
  generatedAt: number;
  displayName: string | null;
  topN: number;
  areas: DeskArea[];
  items: DeskItem[];
  today: DeskEvent[];
  ahead: DeskEvent[];
  vips: { address: string; label: string | null }[];
  agents: { line: string; working: { title: string; note: string; since: number }[]; waiting: number };
  goals: DeskGoal[];
  notes: { id: number; text: string; createdAt: number }[];
  ask: { kinds: string[]; maps: { ref: string; label: string }[] };
  systems: string[];
  sources: { id: string; ok: boolean; error?: string }[];
  chime: boolean;
  notifications: boolean;
  voice: DeskVoice;
  autonomy: DeskAutonomy;
  corrections: DeskCorrection[];
  mailClassifier?: DeskMailClassifier | null;
}

export type DeskMailClassifier =
  | { kind: "endpoint"; host: string; model: string; keyNeeded: boolean; keyFound: boolean }
  | { kind: "command"; command: string; keyNeeded: boolean; keyFound: boolean };

export interface DeskAutonomy {
  types: { action: string; label: string; note: string; on: boolean }[];
  done: { key: string; title: string; message: string; at: number; ok: boolean }[];
}
