/**
 * The Desk's view model: what one principal sees on Mission Control's landing page.
 *
 * Every item reaching the principal is a plain sentence, a reason why it matters now,
 * and at most three actions. Raw identifiers live only in `detail.refs`.
 */

export type DeskUrgency = "now" | "today" | "this-week" | "waiting";

export type DeskItemKind =
  | "goal"
  | "sensor"
  | "agent-failed"
  | "agent-blocked"
  | "decision"
  | "grilling"
  | "escalation";

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
}

export interface DeskLink {
  label: string;
  url: string;
}

export interface DeskItemDetail {
  summary: string;
  history: string[];
  refs: string[];
  links: DeskLink[];
}

export interface DeskItem {
  key: string;
  kind: DeskItemKind;
  area: string | null;
  urgency: DeskUrgency;
  title: string;
  why: string;
  score: number;
  actions: DeskAction[];
  detail: DeskItemDetail;
  eventKey?: string;
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
  kind: "agent" | "meeting" | "block" | "personal";
}

export interface DeskGoal {
  id: string;
  text: string;
  state: "on-track" | "at-risk" | "off-track" | "stale" | "unknown";
}

export interface DeskView {
  generatedAt: number;
  principal: string | null;
  topN: number;
  areas: DeskArea[];
  items: DeskItem[];
  today: DeskEvent[];
  agents: { line: string; working: { title: string; note: string; since: number }[]; waiting: number };
  goals: DeskGoal[];
  systems: string[];
  sources: { id: string; ok: boolean; error?: string }[];
}
