import { adapterRowRef, readAdapterAttention, type AdapterAttentionAccess, type AdapterAttentionInput } from "./adapter-items";
import { STUDIO_OWNER_KIND } from "../../../common/desk-owner";
import { STUDIO_RESPOND_ACTION } from "./adapter-actions";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import type { OutlineNode } from "../../../balance";
import { buildWeeklyMirror, mirrorWeek, type MirrorSchedule } from "./mirror";
import { readMailMirror, type MailMirrorConfig, type MailMirrorUnsubscribe } from "./mail-mirror";
import { loadBalanceState } from "./balance-store";
import { withoutClosedTasks, type WaitingTask, type WaitingTasks } from "./sources/waiting";
import { mailYesFilter, readMailDecision } from "./mail-yes-filter";
import { calendarsOnly, invitationDecisions, invitationView, withoutAnsweredRead, type InvitationsConfig, type InvitationView } from "./mail-invitation";
import { withSyncedBalance } from "./studio-my-day";
import { movedKeys, readMyDay, sourceIdentity } from "./my-day";
import { calendarName, calendarSetting, discoverCalendars, type ReturnedCalendars } from "./calendars";
import { calendarAvailability } from "./calendar-availability";
import type { Database } from "bun:sqlite";
import type { GoalWordingResolver } from "../../../vigil/goal-wording";
import type { VigilCadence } from "../../../vigil/staleness";
import { listVigilSubjects, type VigilSubjectView } from "../../../vigil/subjects-view";
import { ago, areaFor, goalShort, isRegressedGoalCheck, mailItems, parsedOr, rankItems, repoIsCloud, repoName, type AreaRule, type GoalActionsInput } from "./rank";
import { DAY_MS, startOfDay } from "./time";
import { SourceCache, type DeskSourceConfig, type SourceEvent, type SourceMail, type SourceReading } from "./sources/command";
import { listSenders, listVips } from "./vips";
import type { MailActionsConfig, MailReportConfig } from "./mail-actions";
import { suspicionContext } from "./mail-suspicion";
import { TRUST_DONE, trustedViews } from "./mail-trust";
import { listKey, offerContext, unsubscribeOffers, unsubscribeView, type UnsubscribeConfig, type UnsubscribeOffer } from "./mail-unsubscribe";
import { movedTarget } from "./mail-move";
import { historySentence, mailLogFor, queryMailLog, type MailLogEntry } from "./mail-log";
import { DEFAULT_MAIL_RULES, digestedIds, heldItems, listRules, pendingRuleMail, proposalItems, proposeRules, ruleViews, rulesOfRuns, type MailRuleLoop, type MailRulesConfig } from "./mail-rules";
import { TIMELINE_DAYS, type EvidenceLinks } from "./mail-triage";
import { dmarcItems, dmarcWeek, type DmarcConfig, type DmarcLoop } from "./mail-dmarc";
import { DEFAULT_WAITING, recordWaitingOnce, waitingItems, type WaitingClassifier, type WaitingConfig } from "./mail-waiting";
import { bundledKeys, sweepView, type SweepMailView } from "./mail-sweep";
import { backSnoozes, snoozedIds, snoozeFacts, wakeSnoozes, withSnoozeBack } from "./mail-snooze";
import { handoffItems, handoffsByMail, openHandoffs, withHandoff, type HandoffLanes, type MailHandoffWorker } from "./mail-handoff";
import type { BalanceDayAccess } from "./balance-day";
import type { PiSettings } from "../../../conversations/pi";
import { digestTopics, digestView, listMailGroups, readDigestFlags, type DigestConfig, type DigestFlagger } from "./mail-digest";
import { rangerItemKey, readRangerState, type RangerFetch, type RangerState } from "./sources/ranger";
import type { DeskEvent, DeskGoal, DeskItem, DeskView, StudioOptions } from "./types";
import { rangerActionsReady, withoutHandled, type HandledLedger, type RangerCli } from "./actions";
import type { RulingExplainLoop, RulingLedger } from "./ruling";
import type { ParserPermissions } from "../../../common/types/desk-parser";
import type { AskMap } from "./ask";
import { writableKinds, type DeskWriterOwners, type DeskWriters, type RecentCalendarWrites } from "./create";
import { listOpenNotes, type DeskNote } from "./notes";
import { markInterrupts, meetingItems, NO_INTERRUPTIONS, readDeliveries, type InterruptLoop, type InterruptRules } from "./interrupt";
import { listGrants, PROMOTABLE, PROMOTABLE_LABELS, readDone, type DoneEntry } from "./autonomy";
import { applyCorrections, readCorrections } from "./corrections";
import { classifierStatus, MAX_CORRECTIONS, readApiKey, readClassifications, type ClassifierConfig, type ClassifierCorrection, type MailClassifier, type ModelConfig } from "./classify";
import { voiceView, type VoiceOptions } from "./voice";
import { learnedAction, WOULD, type EmbedderConfig } from "./mail-similar";
import { readRoutines } from "./routines";
import type { RoutineOptions, RoutineRunner } from "./routine-command";
import type { FlowOptions } from "../../../common/types/config";
import type { WorkerHandoffOptions } from "../../../common/types/desk-workers";
import type { RoutineReadLoop } from "./routine-read";
import { goalListed, SOMA_GOAL_ID, type DeskGoalOptions, type GoalChecks, type GoalStatuses } from "./goals";

import { studioBriefing } from "./studio/overseer";
import { routeOf, sourceBoundary } from "./source-boundary";

export interface AdapterCapabilityRequest {
  adapterId: string;
  connectionId: string;
  capabilityId: string;
  destinations: ObjectReference[];
}

export type AdapterCapabilityAdmission = { kind: "allowed" } | { kind: "denied"; reason: string };

export interface DeskRuntime {
  conversations?: () => boolean;
  adapterDay?: BalanceDayAccess;
  adapterAttention?: AdapterAttentionAccess;
  adapterCapability?: (request: AdapterCapabilityRequest) => Promise<AdapterCapabilityAdmission>;
  waitingTasks?: Pick<WaitingTasks, "read">;
  routineCapabilities?: import("./routine-providers").RoutineCapabilities;
  routineRead?: RoutineReadLoop;
  options?: DeskOptions;
  ledger: HandledLedger;
  sourceCache?: SourceCache;
  recentWrites?: RecentCalendarWrites;
  autonomy?: InterruptLoop | null;
  goalChecks?: GoalChecks;
  goalStatuses?: GoalStatuses;
  mailClassifier?: MailClassifier;
  localMailClassifier?: MailClassifier;
  rulingExplain?: RulingExplainLoop;
  rulings?: RulingLedger;
  mailRules?: MailRuleLoop;
  dmarc?: DmarcLoop;
  digestFlagger?: DigestFlagger;
  waitingClassifier?: WaitingClassifier;
  mailHandoff?: MailHandoffWorker;
}

export interface DeskAskOptions {
  parser: string[];
  routing?: ParserPermissions;
  timeoutSeconds: number;
  writers: DeskWriters;
  writerOwners?: DeskWriterOwners;
  taskMaps: AskMap[];
  taskCloser?: string[];
}

export interface DeskOptions {
  routineScope?: { principal: string; stack: string };
  routines?: RoutineOptions;
  workers?: WorkerHandoffOptions;
  flows?: FlowOptions;
  enabled: boolean;
  displayName: string;
  topN: number;
  myDay?: { cap: number };
  mirror?: MirrorSchedule;
  rangerUrl: string;
  rangerCli?: RangerCli;
  somaBin?: string;
  areas: AreaRule[];
  studio?: StudioOptions;
  sources: DeskSourceConfig[];
  ask?: DeskAskOptions;
  interruptions?: InterruptRules;
  goals?: DeskGoalOptions;
  mailClassifier?: ClassifierConfig & { local?: ClassifierConfig };
  rulingExplainer?: ModelConfig;
  mailActions?: MailActionsConfig;
  mailLog?: { retentionDays: number };
  mailEmbedder?: EmbedderConfig;
  mailRules?: MailRulesConfig;
  mailDmarc?: DmarcConfig;
  mailReport?: MailReportConfig;
  mailDigest?: DigestConfig;
  mailUnsubscribe?: UnsubscribeConfig;
  mailMirror?: MailMirrorConfig;
  mailWaiting?: WaitingConfig;
  mailInvitations?: InvitationsConfig;
  mailHandoff?: { lanes: HandoffLanes; pi: PiSettings };
  mailOwnDomains?: string[];
  mailLinks?: EvidenceLinks;
  voice?: VoiceOptions;
}

export interface DeskVigilSource {
  enabled: boolean;
  resolveGoalWording?: GoalWordingResolver;
  cadence?: VigilCadence;
}

export interface ComposeDeps {
  adapterAttention?: AdapterAttentionInput;
  adapterDay?: BalanceDayAccess;
  conversations?: boolean;
  waitingTasks?: Pick<WaitingTasks, "read">;
  routineRead?: RoutineReadLoop;
  runRoutine?: RoutineRunner;
  now?: number;
  fetchImpl?: RangerFetch;
  sourceCache?: SourceCache;
  handled?: HandledLedger;
  recentWrites?: RecentCalendarWrites;
  goalChecks?: GoalChecks;
  goalStatuses?: GoalStatuses;
  mailClassifier?: MailClassifier;
  localMailClassifier?: MailClassifier;
  rulingExplain?: RulingExplainLoop;
  digestFlagger?: DigestFlagger;
  waitingClassifier?: WaitingClassifier;
  mailHandoff?: MailHandoffWorker;
}

const localRouteCovers = (config: NonNullable<DeskOptions["mailClassifier"]>): boolean => routeOf(config.local ?? config) === "local";

export const CORRECTIONS_UNREADABLE = "The Desk could not read your ranking corrections, so it ranks by its base rules alone.";

const GOAL_STATES = new Set<DeskGoal["state"]>(["on-track", "at-risk", "off-track", "stale"]);

export async function currentDayItems(db: Database, runtime: DeskRuntime, vigil: DeskVigilSource | undefined, now = Date.now()): Promise<DeskItem[]> {
  const desk = runtime.options;
  if (!desk?.enabled) return [];
  return (await composeDesk(db, desk, vigil, { waitingTasks: runtime.waitingTasks, handled: runtime.ledger, sourceCache: runtime.sourceCache, now })).items;
}

export function composeCurrentDay(db: Database, runtime: DeskRuntime, desk: DeskOptions, vigil: DeskVigilSource | undefined, now = Date.now()): Promise<DeskView> {
  return composeDesk(db, desk, vigil, { waitingTasks: runtime.waitingTasks, handled: runtime.ledger, sourceCache: runtime.sourceCache, now, ...(runtime.adapterDay ? { adapterDay: runtime.adapterDay } : {}) });
}

export async function composeDesk(
  db: Database,
  desk: DeskOptions,
  vigil: DeskVigilSource | undefined,
  deps: ComposeDeps = {},
): Promise<DeskView> {
  const now = deps.now ?? Date.now();
  const routineRead = desk.routines ? deps.routineRead ? Promise.resolve(deps.routineRead.read(db, desk.routines, now)) : readRoutines(db, desk.routines, deps.runRoutine) : Promise.resolve(undefined);
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
  const [vigilSubjects, rangerResult, readings, goalStatuses, routines] = await Promise.all([vigilRead, rangerRead, commandRead, statusRead, routineRead]);

  const subjects: VigilSubjectView[] = vigilSubjects ?? [];
  if (vigilSubjects) sources.push({ id: "vigil", ok: true });
  const done = readDone(db, now);
  const doneKeys = new Set(done.filter((d) => d.status === "done").map((d) => d.attemptKey));
  const handled = deps.handled;
  const filtered = rangerResult?.state ? withoutHandled(rangerResult.state, { has: (k) => doneKeys.has(k) || (handled?.has(k) ?? false) }) : null;
  const reportedRanger = filtered?.state ?? rangerResult?.state ?? null;
  const taskRefs = [
    ...subjects.filter(s => s.vocab === "escalation" && (s.value === "needs-principal" || s.value === "overdue")).map(s => s.ref),
    ...(reportedRanger?.needsYou ?? []).map(n => `${n.repo}#${n.nodeId}`),
    ...(reportedRanger?.maps ?? []).flatMap(m => [...(m.decisions ?? []), ...(m.grillings ?? [])].map(n => `${m.repo}#${n.id}`)),
  ];
  const waitingTasks = await deps.waitingTasks?.read(taskRefs) ?? new Map<string, WaitingTask>();
  const ranger = reportedRanger ? withoutClosedTasks(reportedRanger, waitingTasks) : null;
  if (rangerResult) sources.push(rangerResult.error === null ? { id: "ranger", ok: true } : { id: "ranger", ok: false, error: rangerResult.error });

  for (const r of readings) sources.push(r.error === null ? { id: r.id, ok: true } : { id: r.id, ok: false, error: r.error });
  const unreadable = readings.filter((r) => r.problems.length > 0).map(unreadableLine);
  const reportedEvents = readings.flatMap((r) => r.events.map((e) => ({ ...e, area: r.area, sourceId: r.id })));
  const calendarNames = readings.flatMap(reading => reading.calendarCoverage?.calendars.map(calendar => ({ sourceId: reading.id, calendar: calendar.name, calendarId: calendar.id })) ?? []);
  const calendars = discoverCalendars(db, [...reportedEvents, ...calendarNames], readings.flatMap(returnedCalendars), now);
  const events = reportedEvents.flatMap((e) => {
    const setting = calendarSetting(calendars, e);
    return setting?.enabled ? [{ ...e, calendar: setting.name, color: setting.color }] : [];
  });
  const availability = calendarAvailability({ sources: desk.sources, readings, calendars: [...calendars.values()], now });
  const waitingConfig = desk.mailWaiting ?? DEFAULT_WAITING;
  recordWaitingOnce(db, readings, now, waitingConfig);
  wakeSnoozes(db, snoozeFacts(db, readings, availability), now);
  const snoozed = snoozedIds(db);
  const snoozeBack = backSnoozes(db, now);
  const digested = digestedIds(db, readings.flatMap((r) => r.mail.map((m) => m.id)));
  const canMove = Boolean(desk.mailActions?.move?.length);
  const mailGroups = canMove ? listMailGroups(db, readings, desk, deps.handled, now) : null;
  const held = mailGroups?.digests.held ?? new Set<string>();
  const mail = readings.flatMap((r) => r.mail.filter((m) => !snoozed.has(m.id) && !digested.has(m.id) && !held.has(m.id) && (!deps.handled || movedTarget(deps.handled, m.id) === undefined)).map((m) => ({ ...m, area: r.area, sourceId: r.id })));
  const vips = listVips(db);
  const vipSet = new Set(vips.map((v) => v.address));
  const suspicion = suspicionContext(db, desk.mailOwnDomains);
  const ruleBound = pendingRuleMail(db, mail, suspicion);
  const unimportant = listSenders(db, "unimportant").map((s) => s.address);
  const corrections = readCorrections(db);
  const activeCorrections = corrections.ok ? corrections.corrections : [];
  const classifier = desk.mailClassifier ? deps.mailClassifier : undefined;
  const localClassifier = desk.mailClassifier?.local ? deps.localMailClassifier : undefined;
  const { myDay, studio } = await withSyncedBalance(db, desk, now, async (source, studio) => {
    const projection = deps.adapterDay ? await deps.adapterDay()?.projection() ?? null : null;
    return { myDay: readMyDay(db, desk, now, source, projection ?? undefined), studio };
  });
  const adapters = await readAdapterAttention(deps.adapterAttention, now);
  const cloudAreas = new Set(desk.areas.filter((a) => a.policy === "cloud").map((a) => a.id));
  const boundary = sourceBoundary(desk);
  const cloudSources = new Set(readings.filter((r) => !boundary.has(r.id)).map((r) => r.id));
  const localSources = boundary;
  if (localClassifier) {
    const sourceIds = new Set(readings.filter((r) => boundary.has(r.id)).map((r) => r.id));
    void localClassifier.kick(db, {
      now, sourceIds, localSources,
      mail: mail.filter((m) => sourceIds.has(m.sourceId) && !ruleBound.has(m.id)),
      events: events.filter((event) => sourceIds.has(event.sourceId)),
      vips: vips.map((v) => v.address),
      unimportant,
      corrections: mailCorrections(db, sourceIds),
    });
  }
  if (classifier) {
    const sourceIds = desk.mailClassifier?.sourcePolicy === "local" ? new Set(readings.map((r) => r.id)) : cloudSources;
    const permittedMail = mail.filter((m) => sourceIds.has(m.sourceId));
    const senders = new Set(permittedMail.map((m) => m.from.address.toLowerCase()));
    const permittedSender = (address: string): boolean => { const lower = address.toLowerCase(); return senders.has(lower) || (lower.startsWith("@") && [...senders].some(sender => sender.endsWith(lower))); };
    void classifier.kick(db, {
      now, sourceIds, localSources,
      notes: (studio?.active ?? []).filter((thread) => thread.policy === "cloud").flatMap((thread) => thread.notes.filter((note) => note.status !== "dismissed").map((note) => ({ sourcePolicy: "cloud" as const, areas: thread.areas, id: `studio:${thread.slug}:${note.at}`, name: thread.question, text: note.text.slice(0, 600) }))).slice(0, 30),
      mail: permittedMail.filter((m) => !ruleBound.has(m.id)),
      events: events.filter((event) => sourceIds.has(event.sourceId)),
      vips: vips.filter((v) => permittedSender(v.address)).map((v) => v.address),
      unimportant: unimportant.filter(permittedSender),
      corrections: mailCorrections(db, sourceIds),
    });
  }
  const classified = classifier || localClassifier ? readClassifications(db, mail.map((m) => m.id)) : undefined;
  const offerable = [...mail.filter((m) => m.unread), ...(mailGroups?.digests.groups ?? []).flatMap((g) => g.members)];
  const flagged = new Set([...readClassifications(db, offerable.map((m) => m.id))].filter(([, c]) => c.suspicious === true).map(([id]) => id));
  const unsubscribe = unsubscribeOffers(db, offerable, offerContext(db, desk.mailUnsubscribe, suspicion, flagged));
  const mailClassifier = desk.mailClassifier ? classifierStatus(desk.mailClassifier, (await readApiKey(desk.mailClassifier)) !== null, localRouteCovers(desk.mailClassifier) ? 0 : mail.filter((item) => !cloudSources.has(item.sourceId)).length, desk.mailClassifier.local, localClassifier?.problem) : null;
  const yesFilter = await mailYesFilter(db, desk, now);
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
  const deskCalendar = calendarEvents(calendar, sod, sod + TIMELINE_DAYS * DAY_MS);
  const rules = desk.interruptions ?? NO_INTERRUPTIONS;

  const rangerActions = rangerActionsReady(desk);
  const rulingActions = rangerActions && Boolean(desk.somaBin);
  const goalActions = goalActionsFor(desk.goals, subjects, deps.goalChecks, now);
  const explanations = ranger && deps.rulingExplain ? await deps.rulingExplain.explain(desk.rulingExplainer?.sourcePolicy === "cloud" ? ranger.needsYou.filter(entry => repoIsCloud(desk.areas, entry.repo)) : ranger.needsYou) : undefined;
  const ranked = rankItems({ now, subjects, ranger, waitingTasks, areas: desk.areas, conversations: deps.conversations, rangerActions, rulingActions, hidden: filtered?.hidden, goalActions, ...(explanations ? { explanations } : {}) })
    .filter((item) => goalListed(goalStatuses, item.goal));
  const rulesConfig = desk.mailRules ?? DEFAULT_MAIL_RULES;
  const ruleCards = canMove ? [...heldItems(listRules(db), rulesConfig), ...proposalItems(proposeRules(db, now, rulesConfig, vipSet), now)] : [];
  const dmarc = desk.mailDmarc ? dmarcWeek(db, now, desk.mailDmarc) : null;
  const areaOf = (id: string | null): string | null => readings.find((r) => r.id === id)?.area ?? null;
  const dmarcCards = desk.mailDmarc ? dmarcItems(db, now, desk.mailDmarc, areaOf) : [];
  if (deps.waitingClassifier) void deps.waitingClassifier.kick(db, readings, localSources, now, waitingConfig.maxPerPass);
  const waitingCards = waitingItems(db, now, { config: waitingConfig, draft: Boolean(desk.mailActions?.draft?.length), areaOf });
  const handing = desk.mailHandoff && deps.mailHandoff ? deps.mailHandoff : undefined;
  if (handing) void handing.kick(db);
  const handoffRows = handing ? openHandoffs(db) : [];
  const handoffOf = handoffsByMail(handoffRows);
  const invited = mail.filter((m) => m.invitation);
  const answers = invitationDecisions(db, invited.map((m) => m.id));
  const invitations = new Map(invited.flatMap((m): [string, InvitationView][] => {
    const view = invitationView(m, calendarsOnly(availability, readings), desk.mailInvitations, answers.get(m.id));
    return view ? [[m.id, view]] : [];
  }));
  const studioSlugs = new Map([...myDay.studioTasks, ...myDay.studioProjects].map(link => [link.id, link.slug]));
  const adapterRows = adapters.items.map(item => withOwnerRespond(item, adapters.owners.get(item.key), studioSlugs, myDay.outline));
  sources.push(...adapters.sources);
  const corrected = applyCorrections([...markInterrupts([
    ...withAutonomyNotes(ranked, done, now),
    ...mailItems({ now, mail: withoutAnsweredRead(mail, answers), yesFilter, events, vips: new Set(vips.map((v) => v.address)), unimportant: new Set(unimportant), trash: canMove || Boolean(desk.mailActions?.trash?.length), archive: canMove, spam: canMove, draft: Boolean(desk.mailActions?.draft?.length), ...(classified ? { classified } : {}), ...(desk.mailLinks ? { links: desk.mailLinks } : {}), onDesk: new Set(deskCalendar.map((e) => e.key)), suspicion, report: Boolean(desk.mailReport), studio: Boolean(desk.studio), ivy: handoffReady(desk, handing), unsubscribe, invitations }).map((item) => withSnoozeBack(withHandoff(item, handoffOf.get(mailIdOf(item.key)), now), snoozeBack.get(mailIdOf(item.key)))),
    ...reminderItems(reminders, now),
    ...meetingItems(deskCalendar, now, rules.meetingMinutes),
    ...ruleCards,
    ...dmarcCards,
    ...waitingCards,
    ...handoffItems(handoffRows, new Set(mail.map((m) => m.id)), now),
    ...adapterRows,
  ], rules, readDeliveries(db), now)], activeCorrections);
  const sweeps = mailGroups?.sweeps ?? [];
  const bundled = bundledKeys(sweeps);
  const unbundled = corrected.filter((i) => !bundled.has(i.key));
  const mailLog = mailLogFor(db, unbundled.filter(i => i.kind === "mail").map(i => mailIdOf(i.key)));
  const items = unbundled.map(item => item.kind === "mail" ? withMailLog({ ...item, mailDecision: readMailDecision(db, item.source, mailIdOf(item.key)) }, mailLog, now) : item);

  const digests = mailGroups?.digests.groups ?? [];
  if (deps.digestFlagger && digests.length > 0) void deps.digestFlagger.kick(db, digests, digestTopics(studio, () => loadBalanceState(db), buildGoals(subjects).map((goal) => { const areas = desk.areas.filter((area) => area.goals.includes(goal.id)); return { ...goal, local: areas.length === 0 || areas.some((area) => area.policy !== "cloud") }; }), now, cloudAreas), localSources, now);
  const digestFlags = readDigestFlags(db, digests.map((g) => g.id));
  const moved = movedKeys(db);
  const dayItems = items.filter(i => !moved.has(sourceIdentity(i))).map(i => ({ ...i, todoFingerprint: sourceIdentity(i) }));
  return {
    ...(routines ? { routines } : {}),
    calendarAvailability: availability,
    myDay,
    mirror: buildWeeklyMirror({ now, desk, state: loadBalanceState(db), studio, readings, events, calendarSources: [...calendars.values()].map(c => c.source), dmarc, mail: readMailMirror(db, mirrorWeek(now), { ...(desk.mailMirror ? { config: desk.mailMirror } : {}), offers: mirrorOffers(offerable, unsubscribe) }) }),
    calendars: [...calendars.values()],
    studioBriefing: studio ? studioBriefing([...studio.active, ...studio.parked, ...studio.closed], now) : null,
    generatedAt: now,
    displayName: desk.displayName || null,
    topN: myDay.topN,
    areas: desk.areas.map(({ id, label, color }) => ({ id, label, color })),
    items: dayItems,
    today: [
      ...buildToday(ranger, dayItems, desk.areas, now),
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
    ask: { kinds: [...writableKinds(desk.ask?.writers ?? {}, Boolean(desk.studio)), ...(desk.routines ? ["routine"] : [])], maps: desk.ask?.taskMaps ?? [] },
    systems: [...buildSystems(db, subjects, sources, ranger, now), ...unreadable, ...(corrections.ok ? [] : [CORRECTIONS_UNREADABLE]), ...activeCorrections.filter((c) => c.kind === "mail").map((c) => staleMailCorrection(c.source))],
    sources,
    voice: voiceView(desk.voice),
    chime: rules.chime,
    notifications: rules.notifications,
    autonomy: buildAutonomy(db, done, rangerActions, Boolean(desk.studio), canMove, Boolean(desk.routines?.capabilityBuild?.install)),
    ...(canMove ? { mailRules: ruleViews(db), mailSweeps: sweeps.map(sweepView) } : {}),
    mailTrusted: trustedViews(db),
    ...(desk.mailDigest && canMove ? { mailDigests: digests.map((g) => withUnsubscribe(digestView(g, desk.mailDigest?.model ? digestFlags.get(g.id) : null), unsubscribe)) } : {}),
    ...(dmarc ? { dmarc } : {}),
    corrections: activeCorrections,
    mailClassifier,
  };
}

function withOwnerRespond(item: DeskItem, owner: string | undefined, slugs: ReadonlyMap<string, string>, outline: OutlineNode): DeskItem {
  if (owner !== STUDIO_OWNER_KIND) return item;
  const slug = studioSlugOf(outline, adapterRowRef(item.key)?.canonicalId ?? "", slugs);
  return { ...item, actions: [{ id: STUDIO_RESPOND_ACTION, label: "Respond in Studio", role: "primary", wired: slug !== undefined, ...(slug === undefined ? {} : { target: slug }) }] };
}

function studioSlugOf(outline: OutlineNode, id: string, slugs: ReadonlyMap<string, string>): string | undefined {
  const visit = (node: OutlineNode, inherited: string | undefined): string | undefined => {
    const slug = slugs.get(node.id) ?? inherited;
    if (node.id === id) return slug;
    for (const child of node.children) {
      const found = visit(child, slug);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(outline, undefined);
}

function unreadableLine(r: SourceReading): string {
  const what = r.dropped > 0 ? `${r.dropped} ${r.dropped === 1 ? "entry" : "entries"} the Desk could not read` : "output the Desk could not read";
  const more = r.problems.length > 1 ? ` (and ${r.problems.length - 1} more)` : "";
  return `The ${r.id} source sent ${what}: ${r.problems[0] ?? ""}${more}.`;
}

const CORRECTED_SAYING: Partial<Record<string, string>> = { "not bulk": "; it is not bulk", matters: "; it matters" };

function mailCorrections(db: Database, sourceIds: ReadonlySet<string>): ClassifierCorrection[] {
  return queryMailLog(db, { where: "correction", limit: MAX_CORRECTIONS, sourceIds }).map((e) => {
    const action = learnedAction(e.action);
    return { kind: "mail", source: e.sender, mode: action ?? e.action, label: `“${e.subject ?? "(no subject)"}” from ${e.sender}: the person ${action ? WOULD[action] : `chose ${e.action}`}${CORRECTED_SAYING[e.category ?? ""] ?? ""}` };
  });
}

export const staleMailCorrection = (source: string): string =>
  `Your earlier ranking correction for mail from ${source} no longer applies: mail is corrected one mail at a time now, from the card's menu. Remove it under Ranking in the margin.`;

function goalActionsFor(goals: DeskGoalOptions | undefined, subjects: VigilSubjectView[], checks: GoalChecks | undefined, now: number): GoalActionsInput {
  const check = new Set(goals ? Object.keys(goals.check) : []);
  const checking = new Set<string>();
  if (checks) {
    for (const s of subjects) if (s.vocab === "goal") checks.settle(s.goalId ?? s.ref, s.lastEndedAt);
    for (const goal of check) if (checks.pending(goal, now)) checking.add(goal);
  }
  return { check: checks ? check : new Set(), checking, pause: Boolean(goals?.somaBin), pausable: (goal) => SOMA_GOAL_ID.test(goal) };
}

const mailIdOf = (key: string): string => key.slice("mail:".length);

/** "Hand to Ivy" needs the task writer and a task map to file on, the draft command for Approve, a model lane and the worker. */
export function handoffReady(desk: DeskOptions, worker: MailHandoffWorker | undefined): boolean {
  const lanes = desk.mailHandoff?.lanes;
  return Boolean(worker && (lanes?.local ?? lanes?.cloud) && desk.ask?.writers.task?.length && desk.ask.taskMaps.length > 0 && desk.mailActions?.draft?.length);
}

function mirrorOffers(mails: readonly SourceMail[], offers: ReadonlyMap<string, UnsubscribeOffer>): Map<string, MailMirrorUnsubscribe> {
  const out = new Map<string, MailMirrorUnsubscribe>();
  for (const m of mails) {
    const offer = offers.get(m.id);
    if (offer && offer.kind !== "rule" && !out.has(listKey(m))) out.set(listKey(m), { key: `mail:${m.id}`, view: unsubscribeView(offer) });
  }
  return out;
}

function withUnsubscribe<V extends { mails: SweepMailView[] }>(view: V, offers: ReadonlyMap<string, UnsubscribeOffer>): V {
  return {
    ...view,
    mails: view.mails.map((m) => {
      const offer = offers.get(mailIdOf(m.key));
      return offer ? { ...m, unsubscribe: unsubscribeView(offer) } : m;
    }),
  };
}

function withMailLog(item: DeskItem, log: Map<string, MailLogEntry[]>, now: number): DeskItem {
  const entries = (log.get(mailIdOf(item.key)) ?? []).filter(e => !(item.invitation?.decision && (e.action === "accept" || e.action === "decline")));
  return entries.length ? { ...item, detail: { ...item.detail, history: [...item.detail.history, ...entries.map(e => historySentence(e, now))] } } : item;
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

const OWN_LINE = ["studio.capture", "mail.move", "mail.rule", "mail.sweep", TRUST_DONE, "capability.install"];

function buildAutonomy(db: Database, done: DoneEntry[], rangerActions: boolean, studio: boolean, canMove: boolean, canInstall: boolean): DeskView["autonomy"] {
  const grants = listGrants(db);
  const shown = done.filter((d) => d.status !== "running").slice(0, 10);
  const ruleOf = rulesOfRuns(db, shown.filter((d) => d.action.startsWith("mail.rule")).map((d) => d.itemKey));
  const on = new Set(listRules(db).filter((r) => r.on).map((r) => r.id));
  const ready = (a: string): boolean => a === "capability.install" ? canInstall : a === "studio.capture" ? studio : a === "mail.rules" ? canMove && (grants.has(a) || on.size > 0) : rangerActions;
  return {
    types: PROMOTABLE.filter(ready).map((action) => ({ action, ...PROMOTABLE_LABELS[action], on: grants.has(action) })),
    done: shown.map((d) => {
      const rule = ruleOf.get(d.itemKey);
      return {
        key: d.attemptKey,
        ...(OWN_LINE.some((a) => d.action.startsWith(a)) ? { action: d.action, ...(OWN_LINE.includes(d.action) && (d.action !== "capability.install" || d.status === "done") ? { undo: d.itemKey } : {}) } : {}),
        ...(rule && on.has(rule) ? { stop: rule } : {}),
        title: d.title, message: d.message ?? "", at: d.createdAt, ok: d.status === "done",
      };
    }),
  };
}

function returnedCalendars(reading: SourceReading): ReturnedCalendars[] {
  const coverage = reading.calendarCoverage;
  const trustworthy = reading.error === null && reading.problems.length === 0 && reading.dropped === 0 && coverage?.status === "complete" && coverage.calendars.length > 0;
  if (!trustworthy) return [];
  const withIds = reading.events.flatMap(event => event.calendarId ? [event.calendarId] : []);
  const namedOnly = reading.events.flatMap(event => event.calendarId ? [] : [calendarName({ ...event, sourceId: reading.id })]);
  return [{ source: reading.id, calendarIds: [...coverage.calendars.map(calendar => calendar.id), ...withIds], names: namedOnly }];
}

type CalendarEvent = SourceEvent & { area: string | null; sourceId: string; color?: string };

function calendarEvents(events: CalendarEvent[], from: number, to: number): DeskEvent[] {
  return events
    .filter((e) => { const at = Date.parse(e.start); return at < to && (e.end ? Date.parse(e.end) > from : at >= from); })
    .map((e): DeskEvent => ({
      key: `cal:${e.sourceId}:${e.id}`,
      at: Date.parse(e.start),
      ...(e.availability ? { availability: e.availability } : {}),
      ...(e.calendarId ? { calendarId: e.calendarId } : {}),
      ...(e.end ? { end: Date.parse(e.end) } : {}),
      title: e.title,
      ...(e.location && !e.online ? { note: e.location } : {}),
      area: e.area,
      kind: e.allDay ? "all-day" : "meeting",
      source: e.sourceId,
      ...(e.calendar ? { calendar: e.calendar } : {}),
      ...(e.color ? { color: e.color } : {}),
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
  return reminders.filter((r): r is DeskNote & { dueAt: number } => r.dueAt !== null && r.dueAt <= now).map((r): DeskItem => ({
    key: `reminder:${r.id}`,
    dueAt: new Date(r.dueAt).toISOString(),
    kind: "reminder",
    source: "desk",
    area: null,
    urgency: "now",
    title: r.text,
    why: `You asked to be reminded ${ago(now, r.dueAt)}.`,
    score: 90,
    actions: [
      { id: "reminder.done", label: "Done", role: "primary", wired: true, target: String(r.id) },
      { id: "snooze", label: "Not now", role: "secondary", wired: true },
    ],
    detail: { summary: r.text, history: [`Set ${ago(now, r.createdAt)}`], refs: [`desk note ${r.id}`], links: [] },
    eventKey: `reminder:${r.id}`,
    since: r.dueAt,
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
  const waiting = items.filter(item => isAgentStop(item) || item.kind === "escalation").length;
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
  for (const s of sources) if (!s.ok) systems.push(s.id.startsWith("adapter:") && s.error ? `${s.id}: ${s.error}` : `The ${s.id} source is unreachable.`);
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
