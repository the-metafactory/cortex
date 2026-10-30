import type { Database } from "bun:sqlite";
import { listVigilSubjects, type VigilSubjectsOptions, type VigilSubjectView } from "../api/vigil";
import { ago, goalShort, rankItems, type AreaRule } from "./rank";
import { readRangerState, type RangerFetch, type RangerState } from "./sources/ranger";
import type { DeskEvent, DeskGoal, DeskView } from "./types";

export interface DeskOptions {
  enabled: boolean;
  principal: string;
  topN: number;
  rangerUrl: string;
  areas: AreaRule[];
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
  vigil: VigilSubjectsOptions | undefined,
  deps: ComposeDeps = {},
): Promise<DeskView> {
  const now = deps.now ?? Date.now();
  const sources: DeskView["sources"] = [];

  let subjects: VigilSubjectView[] = [];
  if (vigil?.enabled) {
    subjects = await listVigilSubjects(db, vigil.resolveGoalWording, vigil.cadence);
    sources.push({ id: "vigil", ok: true });
  }

  let ranger: RangerState | null = null;
  if (desk.rangerUrl) {
    try {
      ranger = await readRangerState(desk.rangerUrl, deps.fetchImpl);
      sources.push({ id: "ranger", ok: true });
    } catch (err) {
      sources.push({ id: "ranger", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const items = rankItems({ now, subjects, ranger, areas: desk.areas });

  const today: DeskEvent[] = [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  for (const c of ranger?.current ?? []) {
    const at = c.startedAt ? Date.parse(c.startedAt) : now;
    today.push({
      key: `ranger:run:${c.repo}#${c.nodeId}`,
      at,
      title: c.title ? `An agent is working on "${c.title}"` : "An agent is working",
      note: [c.phase ? `in ${c.phase}` : null, c.reviewRound ? `round ${c.reviewRound}` : null, c.prLabel ?? null].filter(Boolean).join(", "),
      area: items.find((i) => i.key === `ranger:${c.repo}#${c.nodeId}`)?.area ?? null,
      kind: "agent",
    });
  }
  for (const item of items) {
    if (item.kind !== "agent-failed" && item.kind !== "agent-blocked") continue;
    const n = ranger?.needsYou.find((x) => item.key === `ranger:${x.repo}#${x.nodeId}`);
    const at = n?.endedAt ? Date.parse(n.endedAt) : NaN;
    if (!Number.isFinite(at) || at < startOfToday.getTime()) continue;
    const key = `event:${item.key}`;
    today.push({ key, at, title: item.kind === "agent-blocked" ? "An agent stopped to wait for your ruling" : "An agent stopped", note: item.title, area: item.area, kind: "agent" });
    item.eventKey = key;
  }
  today.sort((a, b) => a.at - b.at);

  const waiting = items.filter((i) => i.kind === "agent-failed" || i.kind === "agent-blocked").length;
  const working = (ranger?.current ?? []).map((c) => ({
    title: c.title || `${c.repo}#${c.nodeId}`,
    note: [c.phase, c.prLabel].filter(Boolean).join(" · "),
    since: c.startedAt ? Date.parse(c.startedAt) : now,
  }));
  const agentLine = ranger
    ? `${working.length === 1 ? "1 agent" : `${working.length} agents`} working, ${waiting} waiting on you`
    : "Agents: not connected";

  const goals: DeskGoal[] = [];
  for (const s of subjects.filter((x) => x.vocab === "goal")) {
    const id = s.goalId ?? s.ref;
    const sensorDown = subjects.some((c) => c.vocab === "check" && c.goalId === id && c.value === "regressed");
    const state = GOAL_STATES.has(s.value as DeskGoal["state"]) ? (s.value as DeskGoal["state"]) : "unknown";
    goals.push({ id, text: goalShort(s.goalWording, id), state: state === "on-track" && sensorDown ? "at-risk" : state });
  }
  const checkedGoals = subjects.flatMap((c) => (c.vocab === "check" && c.goalId ? [c.goalId] : []));
  for (const id of new Set(checkedGoals)) {
    if (goals.some((g) => g.id === id)) continue;
    const sensorDown = subjects.some((c) => c.vocab === "check" && c.goalId === id && c.value === "regressed");
    const wording = subjects.find((c) => c.goalId === id)?.goalWording ?? null;
    goals.push({ id, text: goalShort(wording, id), state: sensorDown ? "at-risk" : "on-track" });
  }
  goals.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const systems: string[] = [];
  for (const s of subjects) {
    if (s.vocab === "check" && !s.goalId && s.value === "regressed") systems.push(`The ${s.ref} check is failing since ${ago(now, s.lastEndedAt)}.`);
  }
  const failedDispatches = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open' AND kind = 'failed_dispatch'",
  ).get()?.n ?? 0;
  if (failedDispatches > 0) systems.push(`${failedDispatches} agent dispatch${failedDispatches === 1 ? "" : "es"} failed to start.`);
  if (ranger?.refreshError) systems.push(`Ranger could not refresh: ${ranger.refreshError}`);
  for (const s of sources) if (!s.ok) systems.push(`The ${s.id} source is unreachable.`);

  return {
    generatedAt: now,
    principal: desk.principal || null,
    topN: desk.topN,
    areas: desk.areas.map(({ id, label, color }) => ({ id, label, color })),
    items,
    today,
    agents: { line: agentLine, working, waiting },
    goals,
    systems,
    sources,
  };
}
