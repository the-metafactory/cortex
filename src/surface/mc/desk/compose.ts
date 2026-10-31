import type { Database } from "bun:sqlite";
import type { GoalWordingResolver } from "../../../vigil/goal-wording";
import type { VigilCadence } from "../../../vigil/staleness";
import { listVigilSubjects, type VigilSubjectView } from "../../../vigil/subjects-view";
import { ago, areaFor, goalShort, isRegressedGoalCheck, mailItems, parsedOr, rankItems, repoName, type AreaRule, type GoalActionsInput } from "./rank";
import { DAY_MS, startOfDay } from "./time";
import { SourceCache, type DeskSourceConfig, type SourceEvent } from "./sources/command";
import { listSenders, listVips } from "./vips";
import { trashKey, type MailActionsConfig } from "./mail-actions";
import { TIMELINE_DAYS, type EvidenceLinks } from "./mail-triage";
import { rangerItemKey, readRangerState, type RangerFetch, type RangerState } from "./sources/ranger";
import type { DeskCorrection, DeskEvent, DeskGoal, DeskItem, DeskView, StudioOptions } from "./types";
import { rangerActionsReady, withoutHandled, type HandledLedger, type RangerCli } from "./actions";
import type { AskMap } from "./ask";
import { writableKinds, type DeskWriters, type RecentCalendarWrites } from "./create";
import { listOpenNotes, type DeskNote } from "./notes";
import { markInterrupts, meetingItems, NO_INTERRUPTIONS, readDeliveries, type InterruptLoop, type InterruptRules } from "./interrupt";
import { listGrants, PROMOTABLE, PROMOTABLE_LABELS, readDone, type DoneEntry } from "./autonomy";
import { applyCorrections, readCorrections } from "./corrections";
import { classifierStatus, readApiKey, readClassifications, type ClassifierConfig, type ClassifierCorrection, type MailClassifier } from "./classify";
import { goalListed, SOMA_GOAL_ID, type DeskGoalOptions, type GoalChecks, type GoalStatuses } from "./goals";

export interface DeskRuntime {
  options?: DeskOptions;
  ledger: HandledLedger;
  sourceCache?: SourceCache;
  recentWrites?: RecentCalendarWrites;
  autonomy?: InterruptLoop | null;
  goalChecks?: GoalChecks;
  goalStatuses?: GoalStatuses;
  mailClassifier?: MailClassifier;
}

export interface DeskAskOptions {
  parser: string[];
  timeoutSeconds: number;
  writers: DeskWriters;
  taskMaps: AskMap[];
}

export interface DeskOptions {
  enabled: boolean;
  displayName: string;
  topN: number;
  rangerUrl: string;
  rangerCli?: RangerCli;
  areas: AreaRule[];
  studio?: StudioOptions;
  sources: DeskSourceConfig[];
  ask?: DeskAskOptions;
  interruptions?: InterruptRules;
  goals?: DeskGoalOptions;
  mailClassifier?: ClassifierConfig;
  mailActions?: MailActionsConfig;
  mailLinks?: EvidenceLinks;
}

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
  recentWrites?: RecentCalendarWrites;
  goalChecks?: GoalChecks;
  goalStatuses?: GoalStatuses;
  mailClassifier?: MailClassifier;
}

export const CORRECTIONS_UNREADABLE = "The Desk could not read your ranking corrections, so it ranks by its base rules alone.";

const GOAL_STATES = new Set<DeskGoal["state"]>(["on-track", "at-risk", "off-track", "stale"]);

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
  const statusRead = deps.goalStatuses?.read(desk.goals?.somaBin ?? "", now) ?? Promise.resolve(new Map<string, string>());
  const [vigilSubjects, rangerResult, readings, goalStatuses] = await Promise.all([vigilRead, rangerRead, commandRead, statusRead]);

  const subjects: VigilSubjectView[] = vigilSubjects ?? [];
  if (vigilSubjects) sources.push({ id: "vigil", ok: true });
  const done = readDone(db, now);
  const doneKeys = new Set(done.filter((d) => d.status === "done").map((d) => d.attemptKey));
  const handled = deps.handled;
  const filtered = rangerResult?.state ? withoutHandled(rangerResult.state, { has: (k) => doneKeys.has(k) || (handled?.has(k) ?? false) }) : null;
  const ranger: RangerState | null = filtered?.state ?? rangerResult?.state ?? null;
  if (rangerResult) sources.push(rangerResult.error === null ? { id: "ranger", ok: true } : { id: "ranger", ok: false, error: rangerResult.error });

  for (const r of readings) sources.push(r.error === null ? { id: r.id, ok: true } : { id: r.id, ok: false, error: r.error });
  const unreadable = readings.filter((r) => r.dropped > 0).map((r) => `The ${r.id} source sent ${r.dropped} ${r.dropped === 1 ? "entry" : "entries"} the Desk could not read.`);
  const events = readings.flatMap((r) => r.events.map((e) => ({ ...e, area: r.area, sourceId: r.id })));
  const mail = readings.flatMap((r) => r.mail.filter((m) => !(deps.handled?.has(trashKey(m.id)) ?? false)).map((m) => ({ ...m, area: r.area, sourceId: r.id })));
  const vips = listVips(db);
  const unimportant = listSenders(db, "unimportant").map((s) => s.address);
  const corrections = readCorrections(db);
  const activeCorrections = corrections.ok ? corrections.corrections : [];
  const classifier = desk.mailClassifier ? deps.mailClassifier : undefined;
  if (classifier) void classifier.kick(db, { now, mail, events, vips: vips.map((v) => v.address), unimportant, corrections: mailCorrections(activeCorrections) });
  const classified = classifier ? readClassifications(db, mail.filter((m) => m.unread).map((m) => m.id)) : undefined;
  const mailClassifier = desk.mailClassifier ? classifierStatus(desk.mailClassifier, (await readApiKey(desk.mailClassifier)) !== null) : null;
  const notes = listOpenNotes(db);
  const reminders = notes.filter((n) => n.kind === "reminder" && n.dueAt !== null);
  const written = (deps.recentWrites?.pending(now, events.map((e) => ({ title: e.title, start: Date.parse(e.start) }))) ?? []).map((w, i): CalendarEvent => ({
    id: `desk-write-${i}-${w.at}`,
    start: new Date(w.at).toISOString(),
    ...(w.end !== undefined ? { end: new Date(w.end).toISOString() } : {}),
    ...(w.allDay ? { allDay: true } : {}),
    title: w.title,
    area: null,
    sourceId: "desk",
  }));
  const calendar = [...events, ...written];
  const sod = startOfDay(now);
  const todayCalendar = calendarEvents(calendar, sod, sod + DAY_MS);
  const aheadCalendar = calendarEvents(calendar, sod + DAY_MS, sod + TIMELINE_DAYS * DAY_MS);
  const rules = desk.interruptions ?? NO_INTERRUPTIONS;

  const rangerActions = rangerActionsReady(desk);
  const goalActions = goalActionsFor(desk.goals, subjects, deps.goalChecks, now);
  const ranked = rankItems({ now, subjects, ranger, areas: desk.areas, rangerActions, hidden: filtered?.hidden, goalActions })
    .filter((item) => goalListed(goalStatuses, item.goal));
  const items = applyCorrections(markInterrupts([
    ...withAutonomyNotes(ranked, done, now),
    ...mailItems({ now, mail, events, vips: new Set(vips.map((v) => v.address)), unimportant: new Set(unimportant), trash: Boolean(desk.mailActions?.trash?.length), ...(classified ? { classified } : {}), ...(desk.mailLinks ? { links: desk.mailLinks } : {}), onDesk: new Set([...todayCalendar, ...aheadCalendar].map((e) => e.key)) }),
    ...reminderItems(reminders, now),
    ...meetingItems([...todayCalendar, ...aheadCalendar], now, rules.meetingMinutes),
  ], rules, readDeliveries(db), now), activeCorrections);

  return {
    generatedAt: now,
    displayName: desk.displayName || null,
    topN: desk.topN,
    areas: desk.areas.map(({ id, label, color }) => ({ id, label, color })),
    items,
    today: [
      ...buildToday(ranger, items, desk.areas, now),
      ...todayCalendar,
      ...reminderEvents(reminders, sod, sod + DAY_MS),
    ].sort((a, b) => a.at - b.at),
    ahead: [
      ...aheadCalendar,
      ...reminderEvents(reminders, sod + DAY_MS, sod + TIMELINE_DAYS * DAY_MS),
    ].sort((a, b) => a.at - b.at),
    vips: vips.map(({ address, label }) => ({ address, label })),
    agents: buildAgents(ranger, items, now),
    goals: buildGoals(subjects),
    notes: notes.filter((n) => n.kind === "note").map(({ id, text, createdAt }) => ({ id, text, createdAt })),
    ask: { kinds: [...writableKinds(desk.ask?.writers ?? {})], maps: desk.ask?.taskMaps ?? [] },
    systems: [...buildSystems(db, subjects, sources, ranger, now), ...unreadable, ...(corrections.ok ? [] : [CORRECTIONS_UNREADABLE])],
    sources,
    chime: rules.chime,
    notifications: rules.notifications,
    autonomy: buildAutonomy(db, done, rangerActions),
    corrections: activeCorrections,
    mailClassifier,
  };
}

function mailCorrections(corrections: DeskCorrection[]): ClassifierCorrection[] {
  return corrections.filter((c) => c.kind === "mail").map(({ kind, source, mode, label }) => ({ kind, source, mode, label }));
}

function goalActionsFor(goals: DeskGoalOptions | undefined, subjects: VigilSubjectView[], checks: GoalChecks | undefined, now: number): GoalActionsInput {
  const check = new Set(goals ? Object.keys(goals.check) : []);
  const checking = new Set<string>();
  if (checks) {
    for (const s of subjects) if (s.vocab === "goal") checks.settle(s.goalId ?? s.ref, s.lastEndedAt);
    for (const goal of check) if (checks.pending(goal, now)) checking.add(goal);
  }
  return { check: checks ? check : new Set(), checking, pause: Boolean(goals?.somaBin), pausable: (goal) => SOMA_GOAL_ID.test(goal) };
}

function withAutonomyNotes(items: DeskItem[], done: DoneEntry[], now: number): DeskItem[] {
  return items.map((item) => {
    if (item.kind !== "agent-failed") return item;
    const last = done.find((d) => d.itemKey === item.key && d.status !== "running");
    if (!last) return item;
    const why = last.status === "failed"
      ? `The Desk tried to retry it on its own ${ago(now, last.createdAt)}. ${last.message ?? "Ranger gave no reason."}`
      : `The Desk retried it on its own ${ago(now, last.createdAt)}, and it failed again.`;
    return { ...item, urgency: "today", why, detail: { ...item.detail, history: [...item.detail.history, why] } };
  });
}

function buildAutonomy(db: Database, done: DoneEntry[], rangerActions: boolean): DeskView["autonomy"] {
  const grants = listGrants(db);
  return {
    types: rangerActions ? PROMOTABLE.map((action) => ({ action, ...PROMOTABLE_LABELS[action], on: grants.has(action) })) : [],
    done: done.filter((d) => d.status !== "running").slice(0, 10).map((d) => ({ key: d.attemptKey, title: d.title, message: d.message ?? "", at: d.createdAt, ok: d.status === "done" })),
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
      source: e.sourceId,
      ...(e.url ? { url: e.url } : {}),
      ...(e.online ? { online: true } : {}),
    }))
    .sort((a, b) => a.at - b.at);
}

function reminderEvents(reminders: DeskNote[], from: number, to: number): DeskEvent[] {
  return reminders
    .filter((r) => r.dueAt !== null && r.dueAt >= from && r.dueAt < to)
    .map((r): DeskEvent => ({ key: `reminder:${r.id}`, at: r.dueAt ?? 0, title: r.text, note: "Reminder", area: null, kind: "reminder" }));
}

function reminderItems(reminders: DeskNote[], now: number): DeskItem[] {
  return reminders.filter((r) => r.dueAt !== null && r.dueAt <= now).map((r): DeskItem => ({
    key: `reminder:${r.id}`,
    kind: "reminder",
    source: "desk",
    area: null,
    urgency: "now",
    title: r.text,
    why: `You asked to be reminded ${ago(now, r.dueAt ?? now)}.`,
    score: 90,
    actions: [
      { id: "reminder.done", label: "Done", role: "primary", wired: true, target: String(r.id) },
      { id: "snooze", label: "Not now", role: "secondary", wired: true },
    ],
    detail: { summary: r.text, history: [`Set ${ago(now, r.createdAt)}`], refs: [`desk note ${r.id}`], links: [] },
    eventKey: `reminder:${r.id}`,
    since: r.dueAt ?? now,
  }));
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
