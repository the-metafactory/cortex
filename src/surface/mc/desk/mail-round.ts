import type { Database } from "bun:sqlite";
import { DEFAULT_MAIL_ROUND_SLOTS } from "../../../common/types/desk-mail-rounds";
import type { CalendarAvailability } from "./calendar-availability";
import type { SweepGroup } from "./mail-sweep";
import type { MoveTarget } from "./mail-move";
import type { SourceMail } from "./sources/command";

export const MAIL_ROUND_INTERRUPT_REASONS = ["mail.meeting-today", "mail.deadline-today", "mail.vip"] as const;
export const MAIL_ROUND_GROUP_KINDS = ["bundle", "sweep", "digest"] as const;

type MailRoundGroupKind = (typeof MAIL_ROUND_GROUP_KINDS)[number];

interface MailRoundGroupView {
  id: string;
  kind: MailRoundGroupKind;
  label: string;
  title: string;
  target: MoveTarget;
  area: string | null;
  mails: string[];
}

interface MailRoundMailView {
  key: string;
  subject: string;
  from: string;
  at: string;
  unread: boolean;
  area: string | null;
  url?: string;
  groupId?: string;
}

interface MailRoundUnavailable {
  mail: string[];
  calendar: string[];
}

export interface MailRoundView {
  id: string | null;
  revision: number;
  due: boolean;
  scheduledFor: string | null;
  nextScheduledAt: string;
  waiting: number;
  groups: MailRoundGroupView[];
  mails: MailRoundMailView[];
  unavailable: MailRoundUnavailable;
}

type MailRoundSourceMail = SourceMail & { sourceId: string; area: string | null };

interface MailRoundInput {
  now: number;
  slots?: readonly string[];
  availability: CalendarAvailability;
  mail: readonly MailRoundSourceMail[];
  sweeps: readonly SweepGroup[];
  digests: readonly SweepGroup[];
  interrupting: ReadonlySet<string>;
  readings: readonly { id: string; error: string | null }[];
}

interface EffectiveSlot {
  scheduled: number;
  effective: number;
  unavailable: string[];
}

interface RoundSchedule {
  past: EffectiveSlot[];
  next: EffectiveSlot;
  dueAt: number | undefined;
}

interface FinishedRound {
  openedAt: number;
  finishedAt: number;
}

interface StoredGroup {
  id: string;
  kind: MailRoundGroupKind;
  label: string;
  title: string;
  target: MoveTarget;
  area: string | null;
  memberKeys: string[];
}

interface StoredMember {
  key: string;
  sourceId: string;
  messageId: string;
  account: string | null;
  area: string | null;
  mail: SourceMail;
  groupId?: string;
}

interface StoredRound {
  id: string;
  revision: number;
  openedAt: number;
  scheduledFor: number;
  groups: StoredGroup[];
  members: StoredMember[];
}

interface RoundRow {
  id: string;
  revision: number;
  opened_at: number;
  scheduled_for: number;
  groups: string;
  members: string;
}

interface QueueRow {
  mail_key: string;
  source_id: string;
  account: string | null;
  message_id: string;
  mail: string;
  queued_at: number;
  position: number;
}

interface Candidate {
  key: string;
  sourceId: string;
  mail: SourceMail;
  area: string | null;
}

interface Candidates {
  ordered: Candidate[];
  byKey: Map<string, Candidate>;
  bySource: Map<string, Set<string>>;
}

interface ReconcileResult {
  open: StoredRound | null;
  finished: FinishedRound | null;
}

const MAX_SHIFT_STEPS = 64;
const DAYS_BEFORE = 3;
const DAYS_AFTER = 8;
const DAY_MS = 86_400_000;
const MAIL_ROUND_RETENTION_MS = 7 * DAY_MS;

const mailKey = (id: string): string => `mail:${id}`;

function localSlot(now: number, dayOffset: number, at: string): number {
  const day = new Date(now);
  const [hh, mm] = at.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hh ?? 0, mm ?? 0, 0, 0).getTime();
}

function shiftPastMeetings(scheduled: number, availability: CalendarAvailability): EffectiveSlot {
  let at = scheduled;
  const calendars = new Map(availability.sources.flatMap(source => source.kind === "calendar" ? [[source.id, source]] : []));
  const events = availability.events.filter(event => calendars.get(event.source)?.calendars.includes(event.calendarId));
  for (let step = 0; step <= MAX_SHIFT_STEPS; step += 1) {
    const unavailable = availability.sources.flatMap(source => source.kind === "unknown" || (source.kind === "calendar" && (source.from > scheduled || source.to <= at)) ? [source.id] : []);
    if (unavailable.length > 0) return { scheduled, effective: at, unavailable };
    const incomplete = events.filter(event => event.availability.status !== "free" && event.at <= at && (event.end === undefined || event.end <= event.at));
    if (incomplete.length > 0) return { scheduled, effective: at, unavailable: [...new Set(incomplete.map(event => event.source))] };
    const overlapping = events.filter((event) => (event.availability.status === "busy" || event.availability.status === "unknown") && event.end !== undefined && event.end > event.at && event.at <= at && at < event.end);
    if (overlapping.length === 0) return { scheduled, effective: at, unavailable: [] };
    if (step === MAX_SHIFT_STEPS) break;
    const next = Math.max(...overlapping.map((event) => event.end ?? at));
    at = next;
  }
  return { scheduled, effective: at, unavailable: [...calendars.keys()] };
}

function effectiveSlots(now: number, slots: readonly string[], availability: CalendarAvailability, from: number, to: number): EffectiveSlot[] {
  const out: EffectiveSlot[] = [];
  for (let offset = from; offset <= to; offset += 1) {
    for (const at of slots) {
      const scheduled = localSlot(now, offset, at);
      out.push(shiftPastMeetings(scheduled, availability));
    }
  }
  return out.sort((a, b) => a.effective - b.effective || a.scheduled - b.scheduled);
}

const configuredSlots = (slots: readonly string[] | undefined): readonly string[] =>
  slots && slots.length > 0 ? slots : DEFAULT_MAIL_ROUND_SLOTS;

function roundSchedule(now: number, slots: readonly string[], availability: CalendarAvailability): RoundSchedule {
  const next = effectiveSlots(now, slots, availability, 0, DAYS_AFTER).find((slot) => slot.effective > now);
  const past = effectiveSlots(now, slots, availability, -DAYS_BEFORE, 0).filter(slot => slot.effective <= now);
  return { past, next: next ?? { scheduled: now, effective: now, unavailable: [] }, dueAt: past.filter(slot => slot.unavailable.length === 0).at(-1)?.effective };
}

function slotPassed(finished: FinishedRound, schedule: RoundSchedule): boolean {
  return schedule.past.some(slot => slot.unavailable.length === 0 && slot.effective > finished.openedAt && slot.effective <= finished.finishedAt);
}

function parseStored<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (_err) {
    return fallback;
  }
}

function groupMeta(group: SweepGroup): Omit<StoredGroup, "memberKeys"> {
  return { id: group.id, kind: group.kind, label: group.label, title: group.title, target: group.target, area: group.area };
}

function candidatesOf(input: MailRoundInput): Candidates {
  const ordered: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  const bySource = new Map<string, Set<string>>();
  const add = (candidate: Candidate): void => {
    if (byKey.has(candidate.key)) return;
    byKey.set(candidate.key, candidate);
    ordered.push(candidate);
    const keys = bySource.get(candidate.sourceId) ?? new Set<string>();
    keys.add(candidate.key);
    bySource.set(candidate.sourceId, keys);
  };
  for (const group of [...input.sweeps, ...input.digests]) {
    for (const member of group.members) add({ key: mailKey(member.id), sourceId: member.sourceId, mail: member, area: member.area });
  }
  for (const mail of input.mail) add({ key: mailKey(mail.id), sourceId: mail.sourceId, mail, area: mail.area });
  return { ordered, byKey, bySource };
}

function readQueue(db: Database): QueueRow[] {
  return db.query<QueueRow, []>("SELECT mail_key, source_id, account, message_id, mail, queued_at, position FROM desk_mail_round_queue ORDER BY position, queued_at, mail_key").all();
}

function readOpenRow(db: Database): RoundRow | undefined {
  return db.query<RoundRow, []>("SELECT id, revision, opened_at, scheduled_for, groups, members FROM desk_mail_rounds WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1").get() ?? undefined;
}

function readFinishedRound(db: Database): FinishedRound | null {
  return db.query<FinishedRound, []>("SELECT opened_at AS openedAt, finished_at AS finishedAt FROM desk_mail_rounds WHERE status = 'finished' ORDER BY finished_at DESC, opened_at DESC LIMIT 1").get();
}

function storedRound(row: RoundRow): StoredRound {
  return {
    id: row.id,
    revision: row.revision,
    openedAt: row.opened_at,
    scheduledFor: row.scheduled_for,
    groups: parseStored<StoredGroup[]>(row.groups, []),
    members: parseStored<StoredMember[]>(row.members, []),
  };
}

function filterGroups(groups: readonly StoredGroup[], members: readonly StoredMember[]): StoredGroup[] {
  const keys = new Set(members.map((member) => member.key));
  return groups.map((group) => ({ ...group, memberKeys: group.memberKeys.filter((key) => keys.has(key)) })).filter((group) => group.memberKeys.length > 0);
}

function sameJson<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeRound(db: Database, round: StoredRound): void {
  db.query("UPDATE desk_mail_rounds SET revision = ?, groups = ?, members = ? WHERE id = ?").run(round.revision, JSON.stringify(round.groups), JSON.stringify(round.members), round.id);
}

function finishRound(db: Database, id: string, now: number): void {
  db.query("UPDATE desk_mail_rounds SET status = 'finished', finished_at = ? WHERE id = ? AND status = 'open'").run(now, id);
}

function pruneFinishedRounds(db: Database, now: number): void {
  db.query("DELETE FROM desk_mail_rounds WHERE status = 'finished' AND finished_at < ?").run(now - MAIL_ROUND_RETENTION_MS);
}

function queueSnapshot(row: QueueRow): SourceMail {
  return parseStored<SourceMail>(row.mail, { kind: "mail", id: row.message_id, from: { address: "unknown@example.invalid" }, subject: "", receivedAt: new Date(row.queued_at).toISOString(), unread: true });
}

function groupAssignment(groups: readonly SweepGroup[], members: readonly StoredMember[]): { groups: StoredGroup[]; byKey: Map<string, string> } {
  const memberKeys = new Set(members.map((member) => member.key));
  const byKey = new Map<string, string>();
  const assigned: StoredGroup[] = [];
  for (const group of groups) {
    const keys = group.members.map((member) => mailKey(member.id)).filter((key) => memberKeys.has(key));
    if (keys.length === 0) continue;
    for (const key of keys) if (!byKey.has(key)) byKey.set(key, group.id);
    assigned.push({ ...groupMeta(group), memberKeys: keys });
  }
  return { groups: assigned, byKey };
}

function createRound(db: Database, rows: readonly QueueRow[], input: MailRoundInput, candidates: Candidates, capturedAt: number): StoredRound | null {
  const order = new Map(candidates.ordered.map((candidate, index) => [candidate.key, index]));
  const ordered = [...rows].sort((left, right) => (order.get(left.mail_key) ?? 1_000_000_000 + left.position) - (order.get(right.mail_key) ?? 1_000_000_000 + right.position));
  if (ordered.length === 0) return null;
  const members: StoredMember[] = ordered.map((row) => {
    const candidate = candidates.byKey.get(row.mail_key);
    const live = candidate?.sourceId === row.source_id ? candidate.mail : queueSnapshot(row);
    return { key: row.mail_key, sourceId: row.source_id, messageId: row.message_id, account: row.account, area: candidate?.area ?? null, mail: live };
  });
  const assignment = groupAssignment([...input.sweeps, ...input.digests], members);
  const grouped = members.map((member) => {
    const groupId = assignment.byKey.get(member.key);
    return groupId ? { ...member, groupId } : member;
  });
  const round: StoredRound = { id: crypto.randomUUID(), revision: 1, openedAt: input.now, scheduledFor: capturedAt, groups: assignment.groups, members: grouped };
  db.query("INSERT INTO desk_mail_rounds (id, revision, opened_at, scheduled_for, status, groups, members) VALUES (?, ?, ?, ?, 'open', ?, ?)").run(round.id, round.revision, round.openedAt, round.scheduledFor, JSON.stringify(round.groups), JSON.stringify(round.members));
  for (const row of ordered) db.query("DELETE FROM desk_mail_round_queue WHERE mail_key = ?").run(row.mail_key);
  return round;
}

function viewOf(round: StoredRound | null, waiting: number, nextScheduledAt: number, unavailable: MailRoundUnavailable): MailRoundView {
  return {
    id: round?.id ?? null,
    revision: round?.revision ?? 0,
    due: round !== null,
    scheduledFor: round ? new Date(round.scheduledFor).toISOString() : null,
    nextScheduledAt: new Date(nextScheduledAt).toISOString(),
    waiting,
    groups: (round?.groups ?? []).map((group) => ({ ...group, mails: group.memberKeys })),
    mails: (round?.members ?? []).map((member) => ({
      key: member.key,
      subject: member.mail.subject,
      from: member.mail.from.name ?? member.mail.from.address,
      at: member.mail.receivedAt,
      unread: member.mail.unread,
      area: member.area,
      ...(member.mail.url ? { url: member.mail.url } : {}),
      ...(member.groupId ? { groupId: member.groupId } : {}),
    })),
    unavailable,
  };
}

function reconcileOpen(db: Database, open: StoredRound, candidates: Candidates, succeeded: ReadonlySet<string>, now: number): ReconcileResult {
  const surviving = open.members.filter((member) => !succeeded.has(member.sourceId) || candidates.bySource.get(member.sourceId)?.has(member.key) === true);
  const refreshed = surviving.map((member) => {
    const candidate = candidates.byKey.get(member.key);
    return candidate?.sourceId === member.sourceId ? { ...member, mail: candidate.mail, area: candidate.area } : member;
  });
  if (refreshed.length === 0) {
    finishRound(db, open.id, now);
    return { open: null, finished: { openedAt: open.openedAt, finishedAt: now } };
  }
  const groups = filterGroups(open.groups, refreshed);
  const changed = refreshed.length !== open.members.length || !sameJson(open.groups, groups);
  const next: StoredRound = { ...open, revision: changed ? open.revision + 1 : open.revision, groups, members: refreshed };
  if (changed || !sameJson(open.members, refreshed)) writeRound(db, next);
  return { open: next, finished: null };
}

function pruneQueue(db: Database, open: StoredRound | null, candidates: Candidates, succeeded: ReadonlySet<string>): void {
  const openKeys = new Set(open?.members.map((member) => member.key) ?? []);
  for (const row of readQueue(db)) {
    const gone = succeeded.has(row.source_id) && candidates.bySource.get(row.source_id)?.has(row.mail_key) !== true;
    if (gone || openKeys.has(row.mail_key)) db.query("DELETE FROM desk_mail_round_queue WHERE mail_key = ?").run(row.mail_key);
  }
}

function enqueueCandidates(db: Database, open: StoredRound | null, candidates: Candidates, succeeded: ReadonlySet<string>, now: number): QueueRow[] {
  const openKeys = new Set(open?.members.map((member) => member.key) ?? []);
  const queued = readQueue(db);
  const queuedKeys = new Set(queued.map((row) => row.mail_key));
  let position = queued.reduce((max, row) => Math.max(max, row.position), 0);
  for (const candidate of candidates.byKey.values()) {
    if (!candidate.mail.unread || !succeeded.has(candidate.sourceId) || openKeys.has(candidate.key) || queuedKeys.has(candidate.key)) continue;
    position += 1;
    const receivedAt = Date.parse(candidate.mail.receivedAt);
    db.query("INSERT INTO desk_mail_round_queue (mail_key, source_id, account, message_id, mail, queued_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)").run(candidate.key, candidate.sourceId, candidate.mail.account ?? null, candidate.mail.id, JSON.stringify(candidate.mail), Number.isFinite(receivedAt) ? receivedAt : now, position);
    queuedKeys.add(candidate.key);
  }
  return readQueue(db);
}

function successorRows(queued: readonly QueueRow[], finished: FinishedRound | null, schedule: RoundSchedule): QueueRow[] {
  const { dueAt } = schedule;
  const catchUp = finished !== null && slotPassed(finished, schedule);
  return queued.filter(row => (dueAt !== undefined && (!finished || dueAt > finished.finishedAt) && row.queued_at <= dueAt) || (catchUp && row.queued_at <= finished.finishedAt));
}

function openSuccessor(db: Database, input: MailRoundInput, schedule: RoundSchedule, candidates: Candidates, queued: readonly QueueRow[], finished: FinishedRound | null): StoredRound | null {
  const { dueAt } = schedule;
  const rows = successorRows(queued, finished, schedule).filter((row) => !input.interrupting.has(row.mail_key));
  return rows.length === 0 ? null : createRound(db, rows, input, candidates, dueAt ?? input.now);
}

function unavailableCalendar(input: MailRoundInput, schedule: RoundSchedule, queued: readonly QueueRow[], finished: FinishedRound | null): string[] {
  const relevant = schedule.past.filter(slot => queued.some(row => row.queued_at <= slot.effective) || (finished !== null && slot.effective > finished.openedAt && slot.effective <= finished.finishedAt)).at(-1);
  return [...new Set([...input.availability.sources.filter(source => source.kind === "unknown").map(source => source.id), ...schedule.next.unavailable, ...(relevant?.unavailable ?? [])])];
}

export function readMailRound(db: Database, input: MailRoundInput): MailRoundView {
  return db.transaction(() => {
    const slots = configuredSlots(input.slots);
    const schedule = roundSchedule(input.now, slots, input.availability);
    const candidates = candidatesOf(input);
    const succeeded = new Set(input.readings.filter((reading) => reading.error === null).map((reading) => reading.id));
    pruneFinishedRounds(db, input.now);
    const row = readOpenRow(db);
    const reconciled = row ? reconcileOpen(db, storedRound(row), candidates, succeeded, input.now) : { open: null, finished: null };
    const finished = reconciled.finished ?? (reconciled.open ? null : readFinishedRound(db));
    pruneQueue(db, reconciled.open, candidates, succeeded);
    const queued = enqueueCandidates(db, reconciled.open, candidates, succeeded, input.now);
    const open = reconciled.open ?? openSuccessor(db, input, schedule, candidates, queued, finished);
    const unavailable: MailRoundUnavailable = {
      mail: input.readings.filter((reading) => reading.error !== null).map((reading) => reading.id),
      calendar: unavailableCalendar(input, schedule, queued, finished),
    };
    return viewOf(open, readQueue(db).length, schedule.next.effective, unavailable);
  })();
}
