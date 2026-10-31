export type DeskUrgency = "now" | "today" | "this-week" | "waiting";

export type DeskItemKind =
  | "goal"
  | "sensor"
  | "agent-failed"
  | "agent-blocked"
  | "decision"
  | "grilling"
  | "escalation"
  | "mail"
  | "reminder"
  | "meeting";

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
  excerpt?: string;
  eventKey?: string;
  since?: number;
  interrupt?: DeskInterrupt;
}

export interface DeskInterrupt {
  delivery: "off" | "pending" | "sending" | "sent" | "failed";
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
  autonomy: DeskAutonomy;
}

export interface DeskAutonomy {
  types: { action: string; label: string; note: string; on: boolean }[];
  done: { key: string; title: string; message: string; at: number; ok: boolean }[];
}
