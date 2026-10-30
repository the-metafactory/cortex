import type { Database } from "bun:sqlite";
import type { GoalWordingResolver } from "../../../vigil/goal-wording";
import type { VigilCadence } from "../../../vigil/staleness";
import { listVigilSubjects, type VigilSubjectView } from "../../../vigil/subjects-view";
import { ago, areaFor, goalShort, isRegressedGoalCheck, mailItems, parsedOr, rankItems, repoName, type AreaRule } from "./rank";
import { DAY_MS, startOfDay } from "./time";
import { SourceCache, type DeskSourceConfig, type SourceEvent } from "./sources/command";
import { listVips } from "./vips";
import { rangerItemKey, readRangerState, type RangerFetch, type RangerState } from "./sources/ranger";
import type { DeskEvent, DeskGoal, DeskItem, DeskView } from "./types";
import { withoutHandled, type HandledLedger, type RangerCli } from "./actions";

export interface DeskOptions {
  enabled: boolean;
  displayName: string;
  topN: number;
  rangerUrl: string;
  rangerCli?: RangerCli;
  areas: AreaRule[];
  sources: DeskSourceConfig[];
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
  sourceCache?: SourceCache;
  handled?: HandledLedger;
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
  const commandRead = (deps.sourceCache ?? new SourceCache()).read(desk.sources, now);
  const [vigilSubjects, rangerResult, readings] = await Promise.all([vigilRead, rangerRead, commandRead]);

  const subjects: VigilSubjectView[] = vigilSubjects ?? [];
  if (vigilSubjects) sources.push({ id: "vigil", ok: true });
  const ranger: RangerState | null = rangerResult?.state && deps.handled ? withoutHandled(rangerResult.state, deps.handled) : rangerResult?.state ?? null;
  if (rangerResult) sources.push(rangerResult.error === null ? { id: "ranger", ok: true } : { id: "ranger", ok: false, error: rangerResult.error });

  for (const r of readings) sources.push(r.error === null ? { id: r.id, ok: true } : { id: r.id, ok: false, error: r.error });
  const unreadable = readings.filter((r) => r.dropped > 0).map((r) => `The ${r.id} source sent ${r.dropped} ${r.dropped === 1 ? "entry" : "entries"} the Desk could not read.`);
  const events = readings.flatMap((r) => r.events.map((e) => ({ ...e, area: r.area, sourceId: r.id })));
  const mail = readings.flatMap((r) => r.mail.map((m) => ({ ...m, area: r.area })));
  const vips = listVips(db);

  const items = [
    ...rankItems({ now, subjects, ranger, areas: desk.areas, rangerActions: Boolean(desk.rangerCli?.bin) }),
    ...mailItems({ now, mail, events, vips: new Set(vips.map((v) => v.address)) }),
  ].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  return {
    generatedAt: now,
    displayName: desk.displayName || null,
    topN: desk.topN,
    areas: desk.areas.map(({ id, label, color }) => ({ id, label, color })),
    items,
    today: [...buildToday(ranger, items, desk.areas, now), ...calendarEvents(events, startOfDay(now), startOfDay(now) + DAY_MS)].sort((a, b) => a.at - b.at),
    ahead: calendarEvents(events, startOfDay(now) + DAY_MS, startOfDay(now) + 5 * DAY_MS),
    vips: vips.map(({ address, label }) => ({ address, label })),
    agents: buildAgents(ranger, items, now),
    goals: buildGoals(subjects),
    systems: [...buildSystems(db, subjects, sources, ranger, now), ...unreadable],
    sources,
  };
}

type CalendarEvent = SourceEvent & { area: string | null; sourceId: string };

function calendarEvents(events: CalendarEvent[], from: number, to: number): DeskEvent[] {
  return events
    .filter((e) => { const at = Date.parse(e.start); return at >= from && at < to; })
    .map((e): DeskEvent => ({
      key: `cal:${e.sourceId}:${e.id}`,
      at: Date.parse(e.start),
      ...(e.end ? { end: Date.parse(e.end) } : {}),
      title: e.title,
      ...(e.location && !e.online ? { note: e.location } : {}),
      area: e.area,
      kind: e.allDay ? "all-day" : "meeting",
      ...(e.url ? { url: e.url } : {}),
      ...(e.online ? { online: true } : {}),
    }))
    .sort((a, b) => a.at - b.at);
}

const isAgentStop = (item: DeskItem): boolean => item.kind === "agent-failed" || item.kind === "agent-blocked";

function buildToday(ranger: RangerState | null, items: DeskItem[], areas: AreaRule[], now: number): DeskEvent[] {
  const today: DeskEvent[] = [];
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
    const n = ranger?.needsYou.find((x) => item.key === rangerItemKey(`${x.repo}#${x.nodeId}`));
    const at = parsedOr(n?.endedAt, NaN);
    if (!Number.isFinite(at) || at < startOfDay(now)) continue;
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
    if (s.vocab === "check" && s.goalId === null && s.value === "regressed") systems.push(`The ${s.ref.replace(/[:._-]+/g, " ")} check is failing since ${ago(now, s.lastEndedAt)}.`);
  }
  const failedDispatches = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open' AND kind = 'failed_dispatch'",
  ).get()?.n ?? 0;
  if (failedDispatches > 0) systems.push(`${failedDispatches} agent dispatch${failedDispatches === 1 ? "" : "es"} failed to start.`);
  if (ranger?.refreshError) systems.push(`Ranger could not refresh: ${ranger.refreshError}`);
  for (const s of sources) if (!s.ok) systems.push(`The ${s.id} source is unreachable.`);
  return systems;
}

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
