import type { Database } from "bun:sqlite";
import type { GoalWordingResolver } from "../../../vigil/goal-wording";
import type { VigilCadence } from "../../../vigil/staleness";
import { listVigilSubjects, type VigilSubjectView } from "../../../vigil/subjects-view";
import { ago, areaFor, goalShort, parsedOr, rankItems, repoName, type AreaRule } from "./rank";
import { readRangerState, type RangerFetch, type RangerState } from "./sources/ranger";
import type { DeskEvent, DeskGoal, DeskItem, DeskView } from "./types";

export interface DeskOptions {
  enabled: boolean;
  displayName: string;
  topN: number;
  rangerUrl: string;
  areas: AreaRule[];
}

/** The Vigil side of Mission Control's options that the Desk reads. */
export interface DeskVigilSource {
  enabled: boolean;
  resolveGoalWording?: GoalWordingResolver;
  cadence?: VigilCadence;
}

export interface ComposeDeps {
  now?: number;
  fetchImpl?: RangerFetch;
}

const GOAL_STATES = new Set<DeskGoal["state"]>(["on-track", "at-risk", "off-track", "stale"]);

/** Composes the Desk view from Cortex-native sources: Vigil (MC db) and, when configured, Ranger. */
export async function composeDesk(
  db: Database,
  desk: DeskOptions,
  vigil: DeskVigilSource | undefined,
  deps: ComposeDeps = {},
): Promise<DeskView> {
  const now = deps.now ?? Date.now();
  const sources: DeskView["sources"] = [];

  const vigilRead = vigil?.enabled ? listVigilSubjects(db, vigil.resolveGoalWording, vigil.cadence) : Promise.resolve(null);
  const rangerRead = desk.rangerUrl
    ? readRangerState(desk.rangerUrl, deps.fetchImpl).then(
        (state) => ({ state, error: null }),
        (err: unknown) => ({ state: null, error: err instanceof Error ? err.message : String(err) }),
      )
    : Promise.resolve(null);
  const [vigilSubjects, rangerResult] = await Promise.all([vigilRead, rangerRead]);

  const subjects: VigilSubjectView[] = vigilSubjects ?? [];
  if (vigilSubjects) sources.push({ id: "vigil", ok: true });
  const ranger: RangerState | null = rangerResult?.state ?? null;
  if (rangerResult) sources.push(rangerResult.error === null ? { id: "ranger", ok: true } : { id: "ranger", ok: false, error: rangerResult.error });

  const items = rankItems({ now, subjects, ranger, areas: desk.areas });

  return {
    generatedAt: now,
    displayName: desk.displayName || null,
    topN: desk.topN,
    areas: desk.areas.map(({ id, label, color }) => ({ id, label, color })),
    items,
    today: buildToday(ranger, items, desk.areas, now),
    agents: buildAgents(ranger, items, now),
    goals: buildGoals(subjects),
    systems: buildSystems(db, subjects, sources, ranger, now),
    sources,
  };
}

const isAgentStop = (item: DeskItem): boolean => item.kind === "agent-failed" || item.kind === "agent-blocked";

function buildToday(ranger: RangerState | null, items: DeskItem[], areas: AreaRule[], now: number): DeskEvent[] {
  const today: DeskEvent[] = [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  for (const c of ranger?.current ?? []) {
    today.push({
      key: `ranger:run:${c.repo}#${c.nodeId}`,
      at: parsedOr(c.startedAt, now),
      title: c.title ? `An agent is working on "${c.title}"` : `An agent is working in ${repoName(c.repo)}`,
      note: [c.phase ? `in ${c.phase}` : null, c.reviewRound ? `round ${c.reviewRound}` : null, c.prLabel ?? null].filter(Boolean).join(", "),
      area: areaFor(areas, c.repo, null),
      kind: "agent",
    });
  }
  for (const item of items.filter(isAgentStop)) {
    const n = ranger?.needsYou.find((x) => item.key === `ranger:${x.repo}#${x.nodeId}`);
    const at = parsedOr(n?.endedAt, NaN);
    if (!Number.isFinite(at) || at < startOfToday.getTime()) continue;
    const key = `stop:${item.key}`;
    today.push({ key, at, title: item.kind === "agent-blocked" ? "An agent stopped to wait for your ruling" : "An agent stopped", note: item.title, area: item.area, kind: "agent-stop" });
    item.eventKey = key;
  }
  return today.sort((a, b) => a.at - b.at);
}

function buildAgents(ranger: RangerState | null, items: DeskItem[], now: number): DeskView["agents"] {
  const waiting = items.filter(isAgentStop).length;
  const working = (ranger?.current ?? []).map((c) => ({
    title: c.title || `An untitled task in ${repoName(c.repo)}`,
    note: [c.phase, c.prLabel].filter(Boolean).join(" · "),
    since: parsedOr(c.startedAt, now),
  }));
  const line = ranger
    ? `${working.length === 1 ? "1 agent" : `${working.length} agents`} working, ${waiting} waiting on you`
    : "Agents: not connected";
  return { line, working, waiting };
}

function buildSystems(db: Database, subjects: VigilSubjectView[], sources: DeskView["sources"], ranger: RangerState | null, now: number): string[] {
  const systems: string[] = [];
  if (sources.length === 0) systems.push("No source is connected, so the Desk cannot see anything yet. Turn on Vigil or set mc.desk.ranger.url.");
  for (const s of subjects) {
    if (s.vocab === "check" && !s.goalId && s.value === "regressed") systems.push(`The ${s.ref.replace(/[:._-]+/g, " ")} check is failing since ${ago(now, s.lastEndedAt)}.`);
  }
  const failedDispatches = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open' AND kind = 'failed_dispatch'",
  ).get()?.n ?? 0;
  if (failedDispatches > 0) systems.push(`${failedDispatches} agent dispatch${failedDispatches === 1 ? "" : "es"} failed to start.`);
  if (ranger?.refreshError) systems.push(`Ranger could not refresh: ${ranger.refreshError}`);
  for (const s of sources) if (!s.ok) systems.push(`The ${s.id} source is unreachable.`);
  return systems;
}

const isRegressedGoalCheck = (c: VigilSubjectView): boolean => c.vocab === "check" && c.goalId !== null && c.value === "regressed";

function buildGoals(subjects: VigilSubjectView[]): DeskGoal[] {
  const sensorDown = new Set(subjects.filter(isRegressedGoalCheck).map((c) => c.goalId));
  const ids = new Set(subjects.flatMap((s) => (s.vocab === "goal" ? [s.goalId ?? s.ref] : s.vocab === "check" && s.goalId ? [s.goalId] : [])));
  const goals = [...ids].map((id): DeskGoal => {
    const reported = subjects.find((s) => s.vocab === "goal" && (s.goalId ?? s.ref) === id);
    const wording = reported?.goalWording ?? subjects.find((s) => s.goalId === id)?.goalWording ?? null;
    const value = reported?.value ?? "on-track";
    const state = GOAL_STATES.has(value as DeskGoal["state"]) ? (value as DeskGoal["state"]) : "unknown";
    return { id, text: goalShort(wording), state: state === "on-track" && sensorDown.has(id) ? "at-risk" : state };
  });
  return goals.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
