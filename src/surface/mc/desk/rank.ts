import type { VigilSubjectView } from "../../../vigil/subjects-view";
import type { RangerMap, RangerMapNode, RangerState } from "./sources/ranger";
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
export function goalShort(wording: string | null): string {
  if (!wording) return "A goal without a description";
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

/** "jcfischer/seelite" → "seelite". */
export const repoName = (repo: string): string => repo.split("/").pop() ?? repo;

type Add = (item: DeskItem) => void;
type Titles = Map<string, { title: string; url?: string }>;

/** Parses an ISO time, or returns the fallback when it is missing or garbled. */
export const parsedOr = (iso: string | undefined, fallback: number): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : fallback;
};

const issueLinks = (url: string | undefined) => (url ? [{ label: "Issue", url }] : []);

/**
 * Rule-based ranking: turns Ranger state and Vigil subjects into Desk items, best first.
 * Each rule names the item in plain words, gives one reason why it matters now, and scores it.
 * Ranger items come first, so a Vigil escalation for a node Ranger already lists is not repeated.
 */
export function rankItems(input: RankInput): DeskItem[] {
  const items = new Map<string, DeskItem>();
  const add: Add = (item) => {
    if (!items.has(item.key)) items.set(item.key, item);
  };
  const titles: Titles = input.ranger ? rangerTitles(input.ranger) : new Map<string, { title: string; url?: string }>();
  rangerNeedsYouItems(input, add);
  rangerMapItems(input, add);
  vigilItems(input, titles, (key) => items.has(key), add);
  return [...items.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function rangerNeedsYouItems({ now, ranger, areas }: RankInput, add: Add): void {
  for (const n of ranger?.needsYou ?? []) {
    const ref = `${n.repo}#${n.nodeId}`;
    const endedAt = parsedOr(n.endedAt, now);
    const ageDays = Math.max(0, (now - endedAt) / DAY_MS);
    const failed = n.status === "failed";
    const links = issueLinks(n.url);
    const base = { key: `ranger:${ref}`, area: areaFor(areas, n.repo, null), urgency: "waiting" as const };
    const detail = {
      summary: n.reason?.detail ? `${n.reason.class ?? "Stopped"}: ${n.reason.detail}` : `The agent stopped (${n.status}).`,
      history: [`Stopped ${ago(now, endedAt)}`],
      refs: [ref, n.key],
      links,
    };
    if (n.reason?.class === "blocked") {
      add({
        ...base, kind: "agent-blocked",
        title: `"${n.title}" waits for your ruling.`,
        why: `The agent in ${repoName(n.repo)} cannot go on without a decision from you.`,
        score: 65 - ageDays * 2,
        actions: [{ ...action("open", "Give your ruling", "primary", links.length > 0), ...(n.url ? { url: n.url } : {}) }, LOOK, LATER],
        detail,
      });
    } else {
      add({
        ...base, kind: "agent-failed",
        title: failed ? `An agent failed on "${n.title}".` : `An agent stopped on "${n.title}".`,
        why: `It stopped ${ago(now, endedAt)} in ${repoName(n.repo)}${failed ? ", and nothing moves until it is retried or parked" : ""}.`,
        score: (failed ? 60 : 40) - ageDays * 5,
        actions: [action("ranger.retry", "Let it retry", "primary", false), LOOK, action("ranger.park", "Park it", "secondary", false)],
        detail,
      });
    }
  }
}

interface MapNodeRule {
  kind: "decision" | "grilling";
  urgency: DeskItem["urgency"];
  score: number;
  title: (title: string) => string;
  why: (repo: string) => string;
  primary: DeskAction;
}

const MAP_NODE_RULES: { rule: MapNodeRule; nodes: (m: RangerMap) => RangerMapNode[] }[] = [
  {
    nodes: (m) => m.decisions ?? [],
    rule: {
      kind: "decision", urgency: "this-week", score: 45,
      title: (t) => `"${t}" waits for your go-ahead.`,
      why: (repo) => `Agents in ${repo} will not start it without you.`,
      primary: action("ranger.approve", "Approve", "primary", false),
    },
  },
  {
    nodes: (m) => m.grillings ?? [],
    rule: {
      kind: "grilling", urgency: "waiting", score: 25,
      title: (t) => `An agent wants to settle a question with you: "${t}"`,
      why: (repo) => `It blocks work in ${repo} until you have talked it through.`,
      primary: action("ranger.grill", "Start the grilling", "primary", false),
    },
  },
];

function rangerMapItems({ ranger, areas }: RankInput, add: Add): void {
  for (const map of ranger?.maps ?? []) {
    for (const { rule, nodes } of MAP_NODE_RULES) {
      for (const node of nodes(map)) {
        const ref = `${map.repo}#${node.id}`;
        add({
          key: `ranger:${ref}`, kind: rule.kind, area: areaFor(areas, map.repo, null), urgency: rule.urgency,
          title: rule.title(node.title),
          why: rule.why(repoName(map.repo)),
          score: rule.score,
          actions: [rule.primary, LOOK, LATER],
          detail: { summary: node.title, history: [], refs: [ref, map.key], links: issueLinks(node.url) },
        });
      }
    }
  }
}

function vigilItems({ now, subjects, areas }: RankInput, titles: Titles, listed: (key: string) => boolean, add: Add): void {
  const goalWording = new Map<string, string | null>();
  for (const s of subjects) if (s.goalId) goalWording.set(s.goalId, s.goalWording ?? goalWording.get(s.goalId) ?? null);

  for (const s of subjects) {
    if (s.healthy) continue;
    const refs = [s.subjectKey];
    if (s.vocab === "check" && s.goalId && s.value === "regressed") {
      const part = s.ref.split(".").pop() ?? "check";
      const wording = goalWording.get(s.goalId) ?? null;
      add({
        key: `vigil:${s.subjectKey}`, kind: "sensor", area: areaFor(areas, null, s.goalId), urgency: "today",
        title: `The ${part} check for "${goalShort(wording)}" stopped working.`,
        why: `Without it, nobody can tell whether this goal is on track. It last ran ${ago(now, s.lastEndedAt)}.`,
        score: 85,
        actions: [action("check.run", "Run the check now", "primary", false), LOOK, LATER],
        detail: { summary: wording ?? "This goal has no description.", history: [`Last run ${ago(now, s.lastEndedAt)}`], refs: [s.goalId, ...refs], links: [] },
      });
    } else if (s.vocab === "goal" && ["off-track", "at-risk", "stale"].includes(s.value)) {
      const goalId = s.goalId ?? s.ref;
      const state = s.value === "stale" ? "has had no news for too long" : s.value === "at-risk" ? "is at risk" : "is off track";
      add({
        key: `vigil:${s.subjectKey}`, kind: "goal", area: areaFor(areas, null, goalId), urgency: "this-week",
        title: `"${goalShort(s.goalWording)}" ${state}.`,
        why: s.goalWording ?? "Its description is not available, so open it to see which goal this is.",
        score: s.value === "off-track" ? 75 : s.value === "at-risk" ? 70 : 55,
        actions: [action("detail", "Look first", "primary", true), LATER],
        detail: { summary: s.goalWording ?? "This goal has no description.", history: [`Last report ${ago(now, s.lastEndedAt)}`], refs: [goalId, ...refs], links: [] },
      });
    } else if (s.vocab === "escalation" && (s.value === "needs-principal" || s.value === "overdue")) {
      if (listed(`ranger:${s.ref}`)) continue;
      const known = titles.get(s.ref);
      const repo = s.ref.split("#")[0] ?? s.ref;
      add({
        key: `vigil:${s.subjectKey}`, kind: "escalation", area: areaFor(areas, repo, null), urgency: "waiting",
        title: known ? `"${known.title}" needs you.` : `A task in ${repoName(repo)} needs you.`,
        why: s.value === "overdue" ? `It has waited past its deadline, since ${ago(now, s.lastEndedAt)}.` : `An agent asked for you ${ago(now, s.lastEndedAt)}.`,
        score: s.value === "needs-principal" ? 50 : 35,
        actions: [action("detail", "Look first", "primary", true), LATER],
        detail: { summary: known?.title ?? "A task that needs you.", history: [`Escalated ${ago(now, s.lastEndedAt)}`], refs: [s.ref, ...refs], links: issueLinks(known?.url) },
      });
    }
  }
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
