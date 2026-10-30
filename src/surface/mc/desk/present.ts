import { fold } from "./rank";
import type { DeskFoldedGroup, DeskItem, DeskView } from "./types";

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
  const greeting = `${partOfDay(view.generatedAt)}${view.principal ? `, ${view.principal}` : ""}.`;
  const lines: string[] = [];
  const scope = areaLabel ? ` in ${areaLabel}` : "";
  const top = selection.needsYou[0];
  const today = selection.needsYou.filter((i) => i.urgency === "now" || i.urgency === "today").length;
  if (!top) lines.push(`Nothing needs you${scope} right now.`);
  else if (today > 0) lines.push(`${count(today, "thing needs", "things need")} you today${scope}. First: ${lowerFirst(top.title)}`);
  else lines.push(`${count(selection.needsYou.length, "thing needs", "things need")} you${scope}, none of it due today. First: ${lowerFirst(top.title)}`);
  if (!areaLabel) lines.push(`${view.agents.line.charAt(0).toUpperCase()}${view.agents.line.slice(1)}.`);
  if (selection.rest.length > 0) lines.push(`${selection.rest.length} more can wait.`);
  return { greeting, lines };
}

const lowerFirst = (s: string): string => (/^(A|An|The) /.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

export const URGENCY_LABEL: Record<DeskItem["urgency"], string> = {
  now: "Now",
  today: "Today",
  "this-week": "This week",
  waiting: "Waiting on you",
};
