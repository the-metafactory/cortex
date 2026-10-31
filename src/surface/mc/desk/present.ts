import { fold, FOLDED_LABELS } from "./rank";
export { clock } from "./time";
import type { DeskFoldedGroup, DeskItem, DeskItemKind, DeskView } from "./types";

export const ALL_AREAS = "all";

export interface DeskSelection {
  needsYou: DeskItem[];
  rest: DeskItem[];
  groups: DeskFoldedGroup[];
}

export function selectItems(view: DeskView, area: string, snoozed: ReadonlySet<string>): DeskSelection {
  const open = view.items.filter((i) => !snoozed.has(i.key) && (area === ALL_AREAS || i.area === area));
  const needsYou = open.slice(0, view.topN);
  const rest = open.slice(view.topN);
  return { needsYou, rest, groups: fold(rest) };
}

export function openGroup(selection: DeskSelection, kind: DeskItemKind): { label: string; items: DeskItem[] } {
  return { label: FOLDED_LABELS[kind], items: selection.rest.filter((i) => i.kind === kind) };
}

export function canSee(view: DeskView): boolean {
  return view.sources.some((s) => s.ok);
}

export function partOfDay(now: number): string {
  const h = new Date(now).getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const count = (n: number, one: string, many: string): string => `${n === 0 ? "No" : n} ${n === 1 ? one : many}`;

export function briefing(view: DeskView, selection: DeskSelection, areaLabel: string | null): { greeting: string; lines: string[] } {
  const greeting = `${partOfDay(view.generatedAt)}${view.displayName ? `, ${view.displayName}` : ""}.`;
  const lines: string[] = [];
  const scope = areaLabel ? ` in ${areaLabel}` : "";
  const top = selection.needsYou[0];
  const today = selection.needsYou.filter((i) => i.urgency === "now" || i.urgency === "today").length;
  if (!canSee(view)) lines.push("The Desk cannot see anything yet: no source is connected.");
  else if (!top) lines.push(`Nothing needs you${scope} right now.`);
  else if (today > 0) lines.push(`${count(today, "thing needs", "things need")} you today${scope}. First: ${lowerFirst(top.title)}`);
  else lines.push(`${count(selection.needsYou.length, "thing needs", "things need")} you${scope}, none of it due today. First: ${lowerFirst(top.title)}`);
  if (!areaLabel) lines.push(`${view.agents.line.charAt(0).toUpperCase()}${view.agents.line.slice(1)}.`);
  if (selection.rest.length > 0) lines.push(`${selection.rest.length} more can wait.`);
  return { greeting, lines };
}

const lowerFirst = (s: string): string => (/^(A|An|The) /.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export const URGENCY_LABEL: Record<DeskItem["urgency"], string> = {
  now: "Now",
  today: "Today",
  "this-week": "This week",
  waiting: "Waiting on you",
};

const BRIEFING_ASKS = [
  /\bwhat (?:needs|wants) (?:me|my attention)\b/,
  /\bwhat(?:'s| is) (?:up|next|on|new)\b/,
  /^(?:(?:please )?(?:give me|read me) (?:a |the |my )?)?brief(?:ing| me)\b/,
  /\bwhat should i (?:do|look at)\b/,
  /\banything (?:for me|urgent)\b/,
];

export function isBriefingRequest(text: string): boolean {
  const said = text.toLowerCase().replace(/[’`]/g, "'").trim();
  return BRIEFING_ASKS.some((re) => re.test(said));
}

const SPOKEN_ITEMS = 3;

const sentence = (s: string): string => {
  const t = s.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
};

export function spokenBriefing(view: DeskView, selection: DeskSelection, areaLabel: string | null): string {
  const brief = briefing(view, selection, areaLabel);
  const rest = brief.lines.slice(1);
  const top = selection.needsYou.slice(0, SPOKEN_ITEMS);
  const parts = [brief.greeting];
  if (top.length === 0) parts.push(...brief.lines.map(sentence));
  else {
    const scope = areaLabel ? ` in ${areaLabel}` : "";
    parts.push(`${count(selection.needsYou.length, "thing needs", "things need")} you${scope}.`);
    top.forEach((item, i) => parts.push(`${ORDINAL[i] ?? "Next"}: ${sentence(lowerFirst(item.title))} ${sentence(item.why)}`.trim()));
    parts.push(...rest.map(sentence));
  }
  return parts.filter((p) => p !== "").join(" ");
}

const ORDINAL = ["First", "Second", "Third"];
