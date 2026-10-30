import { fold, FOLDED_LABELS } from "./rank";
export { clock } from "./time";
import type { DeskFoldedGroup, DeskItem, DeskItemKind, DeskView } from "./types";

/** The area filter value that shows every item. */
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

/** One folded group opened in the main list: its label and every item of its kind that did not make the top N. */
export function openGroup(selection: DeskSelection, kind: DeskItemKind): { label: string; items: DeskItem[] } {
  return { label: FOLDED_LABELS[kind], items: selection.rest.filter((i) => i.kind === kind) };
}

/** True when at least one source answered, so an empty list means "nothing" and not "cannot see". */
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

/** The written briefing: greeting, what needs you, what agents do, what is left. Follows the area filter. */
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
