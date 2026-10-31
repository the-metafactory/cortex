import { createHash } from "node:crypto";
import type { DeskEvent } from "../types";
import { normaliseLabel } from "./board";
import { relatesTo } from "./relates";
import type { StudioCapture, StudioThread } from "./format";
import type { StudioView } from "./view";

export interface ThinkSelection { thread: string; trigger: string }
export interface ThemeProposal { id: string; question: string; area: string; reason: string; captures: string[] }

export function selectThinking(input: { studio: StudioView; now: number; staleDays?: number; changedAt: ReadonlyMap<string, number>; newMaterial: ReadonlySet<string>; events: DeskEvent[] }): ThinkSelection[] {
  const { studio, now } = input;
  const today = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${today}T00:00:00Z`);
  const selected: ThinkSelection[] = [];
  for (const thread of [...studio.active, ...studio.closed]) {
    if (thread.notes.some(note => !note.sample && Date.parse(note.at) >= dayStart && Date.parse(note.at) < dayStart + 86_400_000)) continue;
    const dueReview = thread.outcome === "decided" && thread.reviewOn !== undefined && thread.reviewOn <= today;
    if (thread.state === "closed" && !dueReview) continue;
    const triggers: string[] = [];
    if (dueReview) triggers.push(`Decision review due ${thread.reviewOn}`);
    if (thread.state === "active") {
      if (thread.thinkTonight) triggers.push("Asked to think tonight");
      if (input.newMaterial.has(thread.slug)) triggers.push("New Material committed");
      const meeting = relatesTo(thread, studio, { now, events: input.events, goals: [] }).events.find(event => event.at !== undefined && event.at >= now && event.at <= now + 86_400_000);
      if (meeting) triggers.push(`Related meeting in the next 24 hours: ${meeting.title}`);
      const changed = input.changedAt.get(thread.slug);
      if (changed !== undefined && now - changed >= (input.staleDays ?? 6) * 86_400_000) triggers.push(`Unchanged for ${input.staleDays ?? 6} days`);
    }
    if (triggers.length) selected.push({ thread: thread.slug, trigger: triggers.join("; ").slice(0, 2000) });
  }
  return selected;
}

const STOP_WORDS = new Set("about after again also and are been before being but can could for from have into its more need new our should some than that the their them then there these they this those through tonight want was were what when where which will with would you your".split(" "));
const words = (text: string): string[] => [...new Set(normaliseLabel(text).split(" ").filter(word => word.length >= 4 && !STOP_WORDS.has(word)))].sort();

export function recurringThemes(captures: readonly StudioCapture[], areas: StudioView["areas"]): ThemeProposal[] {
  const groups = new Map<string, StudioCapture[]>();
  for (const capture of captures) {
    const terms = words(capture.text).slice(0, 40);
    for (let i = 0; i < terms.length; i++) for (const other of terms.slice(i + 1)) {
      const key = `${terms[i]} ${other}`;
      groups.set(key, [...(groups.get(key) ?? []), capture]);
    }
  }
  const used = new Set<string>();
  const out: ThemeProposal[] = [];
  for (const [theme, group] of [...groups].filter(([, group]) => group.length >= 3).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const fresh = group.filter(capture => !used.has(capture.id));
    if (fresh.length < 3) continue;
    const area = areas.find(area => fresh.every(capture => capture.target?.area === area.id)) ?? areas.find(area => words(`${area.id} ${area.label}`).some(word => theme.includes(word))) ?? areas[0];
    if (!area) continue;
    const ids = fresh.map(capture => capture.id).sort();
    const id = `theme-${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 20)}`;
    out.push({ id, question: `What could we make of ${theme}?`, area: area.id, reason: `${fresh.length} inbox captures share “${theme}”. Proposed in ${area.label}; please confirm the theme and area.`, captures: ids });
    ids.forEach(id => used.add(id));
  }
  return out;
}

export function studioBriefing(threads: readonly StudioThread[], now: number): string | null {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const names = threads.filter(thread => thread.notes.some(note => !note.sample && Date.parse(note.at) >= start.getTime() && Date.parse(note.at) <= now)).map(thread => thread.question.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, ""));
  return names.length ? `Studio: Ivy thought about ${names.join("; ")}.` : null;
}
