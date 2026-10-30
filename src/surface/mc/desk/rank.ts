import type { VigilSubjectView } from "../api/vigil";
import type { RangerState } from "./sources/ranger";
import { rangerTitles } from "./sources/ranger";
import type { DeskAction, DeskArea, DeskFoldedGroup, DeskItem, DeskItemKind } from "./types";

export interface AreaRule extends DeskArea {
  repos: string[];
  goals: string[];
}

export interface RankInput {
  now: number;
  subjects: VigilSubjectView[];
  ranger: RangerState | null;
  areas: AreaRule[];
}

const DAY_MS = 86_400_000;

const action = (id: string, label: string, role: DeskAction["role"], wired: boolean): DeskAction => ({ id, label, role, wired });
const LOOK = action("detail", "Look first", "secondary", true);
const LATER = action("snooze", "Not now", "secondary", true);

export const FOLDED_LABELS: Record<DeskItemKind, string> = {
  sensor: "Goal checks that stopped working",
  goal: "Goals that need a look",
  "agent-blocked": "Agent tasks waiting for your ruling",
  "agent-failed": "Agent tasks parked after a failure",
  decision: "Decisions agents are waiting for",
  grilling: "Questions agents want to grill you on",
  escalation: "Older escalations",
};

export function areaFor(areas: AreaRule[], repo: string | null, goalId: string | null): string | null {
  for (const a of areas) {
    if (goalId && a.goals.includes(goalId)) return a.id;
    if (repo && a.repos.some((r) => repo === r || repo.startsWith(r.endsWith("/") ? r : `${r}/`))) return a.id;
  }
  return null;
}

/** "Make my know-how visible: publish…" → "Make my know-how visible". */
export function goalShort(wording: string | null, goalId: string): string {
  if (!wording) return `Goal ${goalId}`;
  const head = (wording.split(/[:.;]/)[0] ?? wording).trim();
  const clause = (head.split(/,| (?:on|by|so|for|from|to the) /)[0] ?? head).trim();
  const short = clause.length >= 20 ? clause : head;
  if (short.length <= 48) return short;
  const cut = short.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ")).trimEnd()}…`;
}

export function ago(now: number, at: number): string {
  const diff = now - at;
  if (diff < 0) return "soon";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const hhmm = new Date(at).toTimeString().slice(0, 5);
  if (at >= startOfToday.getTime()) return `today at ${hhmm}`;
  if (at >= startOfToday.getTime() - DAY_MS) return `yesterday at ${hhmm}`;
  return `${Math.round(diff / DAY_MS)} days ago`;
}

const repoName = (repo: string): string => repo.split("/").pop() ?? repo;

/**
 * Rule-based ranking: turns Vigil subjects and Ranger state into Desk items, best first.
 * Each rule names the item in plain words, gives one reason why it matters now, and scores it.
 */
export function rankItems(input: RankInput): DeskItem[] {
  const { now, subjects, ranger, areas } = input;
  const items = new Map<string, DeskItem>();
  const add = (item: DeskItem): void => {
    if (!items.has(item.key)) items.set(item.key, item);
  };
  const titles = ranger ? rangerTitles(ranger) : new Map<string, { title: string; url?: string }>();

  for (const n of ranger?.needsYou ?? []) {
    const ref = `${n.repo}#${n.nodeId}`;
    const endedAt = n.endedAt ? Date.parse(n.endedAt) : now;
    const ageDays = Math.max(0, (now - endedAt) / DAY_MS);
    const blocked = n.reason?.class === "blocked";
    const failed = n.status === "failed";
    const links = n.url ? [{ label: "Issue", url: n.url }] : [];
    const detail = {
      summary: n.reason?.detail ? `${n.reason.class ?? "Stopped"}: ${n.reason.detail}` : `The agent stopped (${n.status}).`,
      history: [`Stopped ${ago(now, endedAt)}`],
      refs: [ref, n.key],
      links,
    };
    if (blocked) {
      add({
        key: `ranger:${ref}`, kind: "agent-blocked", area: areaFor(areas, n.repo, null), urgency: "waiting",
        title: `"${n.title}" waits for your ruling.`,
        why: `The agent in ${repoName(n.repo)} cannot go on without a decision from you.`,
        score: 65 - ageDays * 2,
        actions: [{ ...action("open", "Give your ruling", "primary", links.length > 0), ...(n.url ? { url: n.url } : {}) }, LOOK, LATER],
        detail,
      });
    } else {
      add({
        key: `ranger:${ref}`, kind: "agent-failed", area: areaFor(areas, n.repo, null), urgency: "waiting",
        title: failed ? `An agent failed on "${n.title}".` : `An agent stopped on "${n.title}".`,
        why: `It stopped ${ago(now, endedAt)} in ${repoName(n.repo)}${failed ? ", and nothing moves until it is retried or parked" : ""}.`,
        score: (failed ? 60 : 40) - ageDays * 5,
        actions: [action("ranger.retry", "Let it retry", "primary", false), LOOK, action("ranger.park", "Park it", "secondary", false)],
        detail,
      });
    }
  }

  const goalWording = new Map<string, string | null>();
  for (const s of subjects) if (s.goalId) goalWording.set(s.goalId, s.goalWording ?? goalWording.get(s.goalId) ?? null);

  for (const s of subjects) {
    if (s.healthy) continue;
    const refs = [s.subjectKey];
    if (s.vocab === "check" && s.goalId && s.value === "regressed") {
      const part = s.ref.split(".").pop() ?? "check";
      const short = goalShort(goalWording.get(s.goalId) ?? null, s.goalId);
      add({
        key: `vigil:${s.subjectKey}`, kind: "sensor", area: areaFor(areas, null, s.goalId), urgency: "today",
        title: `The ${part} check for "${short}" stopped working.`,
        why: `Without it, nobody can tell whether goal ${s.goalId} is on track. It last ran ${ago(now, s.lastEndedAt)}.`,
        score: 85,
        actions: [action("check.run", "Run the check now", "primary", false), LOOK, LATER],
        detail: { summary: s.goalWording ?? `Goal ${s.goalId}`, history: [`Last run ${ago(now, s.lastEndedAt)}`], refs, links: [] },
      });
    } else if (s.vocab === "goal" && ["off-track", "at-risk", "stale"].includes(s.value)) {
      const goalId = s.goalId ?? s.ref;
      const short = goalShort(s.goalWording, goalId);
      const state = s.value === "stale" ? "has had no news for too long" : s.value === "at-risk" ? "is at risk" : "is off track";
      add({
        key: `vigil:${s.subjectKey}`, kind: "goal", area: areaFor(areas, null, goalId), urgency: "this-week",
        title: `"${short}" ${state}.`,
        why: s.goalWording ?? `Goal ${goalId}.`,
        score: s.value === "off-track" ? 75 : s.value === "at-risk" ? 70 : 55,
        actions: [action("detail", "Look first", "primary", true), LATER],
        detail: { summary: s.goalWording ?? `Goal ${goalId}`, history: [`Last report ${ago(now, s.lastEndedAt)}`], refs, links: [] },
      });
    } else if (s.vocab === "escalation" && (s.value === "needs-principal" || s.value === "overdue")) {
      const known = titles.get(s.ref);
      if (items.has(`ranger:${s.ref}`)) continue;
      const repo = s.ref.split("#")[0] ?? s.ref;
      add({
        key: `vigil:${s.subjectKey}`, kind: "escalation", area: areaFor(areas, repo, null), urgency: "waiting",
        title: known ? `"${known.title}" needs you.` : `A task in ${repoName(repo)} needs you.`,
        why: s.value === "overdue" ? `It has waited past its deadline, since ${ago(now, s.lastEndedAt)}.` : `An agent asked for you ${ago(now, s.lastEndedAt)}.`,
        score: s.value === "needs-principal" ? 50 : 35,
        actions: [action("detail", "Look first", "primary", true), LATER],
        detail: { summary: known?.title ?? s.ref, history: [`Escalated ${ago(now, s.lastEndedAt)}`], refs: [s.ref, ...refs], links: known?.url ? [{ label: "Issue", url: known.url }] : [] },
      });
    }
  }

  for (const map of ranger?.maps ?? []) {
    for (const d of map.decisions ?? []) {
      const ref = `${map.repo}#${d.id}`;
      if (items.has(`ranger:${ref}`)) continue;
      add({
        key: `ranger:${ref}`, kind: "decision", area: areaFor(areas, map.repo, null), urgency: "this-week",
        title: `"${d.title}" waits for your go-ahead.`,
        why: `Agents in ${repoName(map.repo)} will not start it without you.`,
        score: 45,
        actions: [action("ranger.approve", "Approve", "primary", false), LOOK, LATER],
        detail: { summary: d.title, history: [], refs: [ref, map.key], links: d.url ? [{ label: "Issue", url: d.url }] : [] },
      });
    }
    for (const g of map.grillings ?? []) {
      const ref = `${map.repo}#${g.id}`;
      if (items.has(`ranger:${ref}`)) continue;
      add({
        key: `ranger:${ref}`, kind: "grilling", area: areaFor(areas, map.repo, null), urgency: "waiting",
        title: `An agent wants to settle a question with you: "${g.title}"`,
        why: `It blocks work in ${repoName(map.repo)} until you have talked it through.`,
        score: 25,
        actions: [action("ranger.grill", "Start the grilling", "primary", false), LOOK, LATER],
        detail: { summary: g.title, history: [], refs: [ref, map.key], links: g.url ? [{ label: "Issue", url: g.url }] : [] },
      });
    }
  }

  return [...items.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export function fold(rest: DeskItem[]): DeskFoldedGroup[] {
  const groups = new Map<DeskItemKind, DeskFoldedGroup>();
  for (const item of rest) {
    const g = groups.get(item.kind) ?? { kind: item.kind, label: FOLDED_LABELS[item.kind], count: 0, example: item.title };
    g.count += 1;
    groups.set(item.kind, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
