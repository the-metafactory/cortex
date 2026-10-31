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

function reactiveBriefing(view: DeskView, selection: DeskSelection, areaLabel: string | null): { greeting: string; lines: string[] } {
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
  if (view.studioBriefing) lines.push(view.studioBriefing);
  return { greeting, lines };
}

function myDayBriefing(view: DeskView): string[] {
  const day = view.myDay;
  if (!day) return [];
  if (day.phase === "closed") return [day.wins.length ? `Wins today: ${day.wins.map(w => w.title).join("; ")}. Your day is done.` : "Your day is done. You made room for what matters."];
  const titles = day.items.map(i => i.task.title).join("; ");
  if (day.phase === "proposed") return [titles ? `Your proposed My day: ${titles}. Choose Start the day to confirm, Swap for an alternate, or Just one thing.` : "Your proposed My day is clear. Add a task to your outline, or choose Start the day to keep that space."];
  return [titles ? `Your My day: ${titles}.` : "Your My day list is complete."];
}

export function briefing(view: DeskView, selection: DeskSelection, areaLabel: string | null): { greeting: string; lines: string[] } {
  const brief = reactiveBriefing(view, selection, areaLabel);
  const intention = myDayBriefing(view);
  return { greeting: brief.greeting, lines: view.myDay?.phase === "closed" ? [...intention, ...brief.lines] : [...brief.lines, ...intention] };
}

const lowerFirst = (s: string): string => (/^(A|An|The) /.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export const URGENCY_LABEL: Record<DeskItem["urgency"], string> = {
  now: "Now",
  today: "Today",
  "this-week": "This week",
  waiting: "Waiting on you",
};

const BRIEFING_ASK =
  /^(?:(?:hey |ok |so )?ivy,? )?(?:(?:what (?:needs|wants) (?:me|my attention))|(?:what(?:'s| is) (?:up|next)(?: for me)?(?: today)?)|(?:(?:please )?(?:give me |read me )?(?:a |the |my )?brief(?:ing| me))|(?:anything (?:for me|urgent)))(?: (?:now|today|right now))?[?.!]*$/;

export function isBriefingRequest(text: string): boolean {
  const said = text.toLowerCase().replace(/[’`]/g, "'").trim();
  return BRIEFING_ASK.test(said);
}

const SPOKEN_ITEMS = 3;

const sentence = (s: string): string => {
  const t = s.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
};

export function spokenBriefing(view: DeskView, selection: DeskSelection, areaLabel: string | null): string {
  const brief = reactiveBriefing(view, selection, areaLabel);
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
  const intention = myDayBriefing(view).map(sentence);
  if (view.myDay?.phase === "closed") parts.splice(1, 0, ...intention);
  else parts.push(...intention);
  return parts.filter((p) => p !== "").join(" ");
}

const ORDINAL = ["First", "Second", "Third"];
