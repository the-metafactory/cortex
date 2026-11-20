import type { Database } from "bun:sqlite";
import { DEFAULT_MAIL_ROUND_SLOTS } from "../../../common/types/desk-mail-rounds";
import type { CalendarAvailability } from "./calendar-availability";
import type { SweepGroup } from "./mail-sweep";
import type { MoveTarget } from "./mail-move";
import type { SourceMail } from "./sources/command";
import { MAIL_ROUND_GROUP_KINDS } from "../../../desk-api/wire/mail-round";
import type { MailRoundGroupKind, MailRoundUnavailable, MailRoundView } from "../../../desk-api/wire/mail-round";
import { sweepText } from "./wording";
export { MAIL_ROUND_GROUP_KINDS };
export type { MailRoundView };

export const MAIL_ROUND_INTERRUPT_REASONS = ["mail.meeting-today", "mail.deadline-today", "mail.vip"] as const;
export const MAIL_ROUND_ACTIONS = ["put-back", "undo"] as const;
export const MAIL_ROUND_UNDO_OUTCOMES = ["restored", "next-round"] as const;

export type MailRoundUndoOutcome = (typeof MAIL_ROUND_UNDO_OUTCOMES)[number];

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
  put_back: number;
}

interface RoundOperationRow {
  request_id: string;
  binding: string;
  kind: string;
  token: string;
  state: string;
  result: string;
  undone_by: string | null;
}

interface PutBackState {
  roundId: string;
  index: number;
  groupAt: number;
  groupIndex: number;
  member: StoredMember;
  group: StoredGroup | null;
}

interface RoundFailure {
  ok: false;
  status: number;
  error: string;
}

type MailRoundPutBackResult = { ok: true; message: string; undo: string } | RoundFailure;
type MailRoundUndoResult = { ok: true; message: string; outcome: MailRoundUndoOutcome } | RoundFailure;

interface MailRoundPutBackRequest {
  roundId: string;
  revision: number;
  key: string;
  requestId: string;
  now: number;
}

interface MailRoundUndoRequest {
  token: string;
  requestId: string;
  now: number;
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
  justFinished: StoredRound | null;
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

function shiftPastMeetings(scheduled: number, events: CalendarAvailability["events"]): number {
  let at = scheduled;
  for (let step = 0; step < MAX_SHIFT_STEPS; step += 1) {
    const overlapping = events.filter((event) => (event.availability.status === "busy" || event.availability.status === "unknown") && event.end !== undefined && event.end > event.at && event.at <= at && at < event.end);
    if (overlapping.length === 0) return at;
    const next = Math.max(...overlapping.map((event) => event.end ?? at));
    if (next <= at) return at;
    at = next;
  }
  return at;
}

function effectiveSlots(now: number, slots: readonly string[], availability: CalendarAvailability, from: number, to: number): EffectiveSlot[] {
  const out: EffectiveSlot[] = [];
  for (let offset = from; offset <= to; offset += 1) {
    for (const at of slots) {
      const scheduled = localSlot(now, offset, at);
      out.push({ scheduled, effective: shiftPastMeetings(scheduled, availability.events) });
    }
  }
  return out.sort((a, b) => a.effective - b.effective || a.scheduled - b.scheduled);
}

const configuredSlots = (slots: readonly string[] | undefined): readonly string[] =>
  slots && slots.length > 0 ? slots : DEFAULT_MAIL_ROUND_SLOTS;

function latestEffectiveSlot(now: number, slots: readonly string[], availability: CalendarAvailability): number | undefined {
  return effectiveSlots(now, slots, availability, -DAYS_BEFORE, 0)
    .filter((slot) => slot.effective <= now)
    .at(-1)?.effective;
}

function nextEffectiveSlot(now: number, slots: readonly string[], availability: CalendarAvailability): number {
  const next = effectiveSlots(now, slots, availability, 0, DAYS_AFTER).find((slot) => slot.effective > now);
  return next?.effective ?? now;
}

function slotPassed(from: number, now: number, slots: readonly string[], availability: CalendarAvailability): boolean {
  return effectiveSlots(now, slots, availability, -DAYS_BEFORE, 0).some((slot) => slot.effective > from && slot.effective <= now);
}

function parseStored<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (_err) {
    return fallback;
  }
}

function groupMeta(group: SweepGroup): Omit<StoredGroup, "memberKeys"> {
  return { id: group.id, kind: group.kind, label: sweepText(group), title: group.title, target: group.target, area: group.area };
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
  return db.query<QueueRow, []>("SELECT mail_key, source_id, account, message_id, mail, queued_at, position, put_back FROM desk_mail_round_queue ORDER BY put_back DESC, position, queued_at, mail_key").all();
}

function readOpenRow(db: Database): RoundRow | undefined {
  return db.query<RoundRow, []>("SELECT id, revision, opened_at, scheduled_for, groups, members FROM desk_mail_rounds WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1").get() ?? undefined;
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

function pruneFinishedRounds(db: Database, now: number): string[] {
  return db.query<{ id: string }, [number]>("DELETE FROM desk_mail_rounds WHERE status = 'finished' AND finished_at < ? RETURNING id").all(now - MAIL_ROUND_RETENTION_MS).map((row) => row.id);
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
  const rank = (row: QueueRow): number => order.get(row.mail_key) ?? 1_000_000_000 + row.position;
  const ordered = [...rows].sort((left, right) =>
    left.put_back === right.put_back ? (left.put_back === 1 ? left.position - right.position : rank(left) - rank(right)) : right.put_back - left.put_back,
  );
  if (ordered.length === 0) return null;
  const members: StoredMember[] = ordered.map((row) => {
    const candidate = candidates.byKey.get(row.mail_key);
    const live = candidate?.sourceId === row.source_id ? candidate.mail : queueSnapshot(row);
    return { key: row.mail_key, sourceId: row.source_id, messageId: row.message_id, account: row.account, area: candidate?.area ?? null, mail: live };
  });
  const leading = new Set(ordered.filter((row) => row.put_back === 1).map((row) => row.mail_key));
  const assignment = groupAssignment([...input.sweeps, ...input.digests], members.filter((member) => !leading.has(member.key)));
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
    return { open: null, justFinished: open };
  }
  const groups = filterGroups(open.groups, refreshed);
  const changed = refreshed.length !== open.members.length || !sameJson(open.groups, groups);
  const next: StoredRound = { ...open, revision: changed ? open.revision + 1 : open.revision, groups, members: refreshed };
  if (changed || !sameJson(open.members, refreshed)) writeRound(db, next);
  return { open: next, justFinished: null };
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

function successorRows(queued: readonly QueueRow[], justFinished: StoredRound | null, dueAt: number | undefined, input: MailRoundInput, slots: readonly string[]): QueueRow[] {
  if (!justFinished) return queued.filter((row) => dueAt !== undefined && row.queued_at <= dueAt);
  return slotPassed(justFinished.openedAt, input.now, slots, input.availability) ? [...queued] : [];
}

function openSuccessor(db: Database, input: MailRoundInput, slots: readonly string[], candidates: Candidates, queued: readonly QueueRow[], justFinished: StoredRound | null): StoredRound | null {
  const dueAt = latestEffectiveSlot(input.now, slots, input.availability);
  const rows = successorRows(queued, justFinished, dueAt, input, slots).filter((row) => !input.interrupting.has(row.mail_key));
  return rows.length === 0 ? null : createRound(db, rows, input, candidates, dueAt ?? input.now);
}

const quotedSubject = (subject: string): string => `“${subject}”`;
const ROUND_REQUEST_REUSED = "That request id was already used for a different mail round action.";
const ROUND_STALE = "This mail round changed since you loaded it. Refresh the Desk and try again.";
const ROUND_NOT_OPEN = "No mail round is open on this Desk. Refresh the Desk.";
const ROUND_NOT_MEMBER = "That mail is not in this mail round any more. Refresh the Desk.";
const ROUND_TOKEN_UNKNOWN = "The Desk has no record of that put-back.";
const ROUND_ALREADY_UNDONE = "That put-back is already undone.";

const refuseRound = (status: number, error: string): RoundFailure => ({ ok: false, status, error });

function readOperation(db: Database, requestId: string): RoundOperationRow | null {
  return db.query<RoundOperationRow, [string]>("SELECT request_id, binding, kind, token, state, result, undone_by FROM desk_mail_round_operations WHERE request_id = ?").get(requestId) ?? null;
}

function readTokenOperation(db: Database, token: string): RoundOperationRow | null {
  return db.query<RoundOperationRow, [string]>("SELECT request_id, binding, kind, token, state, result, undone_by FROM desk_mail_round_operations WHERE token = ? AND kind = 'put-back'").get(token) ?? null;
}

interface RecordedOperation {
  requestId: string;
  binding: string;
  roundId: string;
  kind: "put-back" | "undo";
  token: string;
  state: string;
  result: string;
  now: number;
}

function rememberOperation(db: Database, operation: RecordedOperation): void {
  db.query("INSERT INTO desk_mail_round_operations (request_id, binding, round_id, kind, token, state, result, undone_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)").run(operation.requestId, operation.binding, operation.roundId, operation.kind, operation.token, operation.state, operation.result, operation.now);
}

function replayable(db: Database, requestId: string, binding: string): RoundOperationRow | RoundFailure | null {
  const prior = readOperation(db, requestId);
  if (!prior) return null;
  return prior.binding === binding ? prior : refuseRound(409, ROUND_REQUEST_REUSED);
}

function putBackPosition(db: Database, except: string): number {
  const low = db.query<{ low: number | null }, [string]>("SELECT MIN(position) AS low FROM desk_mail_round_queue WHERE put_back = 1 AND mail_key != ?").get(except)?.low;
  return low === null || low === undefined ? 0 : low - 1;
}

function queuePutBack(db: Database, member: StoredMember, now: number): void {
  db.query("DELETE FROM desk_mail_round_queue WHERE mail_key = ?").run(member.key);
  db.query("INSERT INTO desk_mail_round_queue (mail_key, source_id, account, message_id, mail, queued_at, position, put_back) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(member.key, member.sourceId, member.account, member.messageId, JSON.stringify(member.mail), now, putBackPosition(db, member.key));
}

function groupWithMember(groups: readonly StoredGroup[], state: PutBackState): StoredGroup[] {
  const group = state.group;
  if (!group) return [...groups];
  const existing = groups.find((row) => row.id === group.id);
  if (!existing) {
    const at = Math.min(state.groupAt, groups.length);
    return [...groups.slice(0, at), { ...group, memberKeys: [state.member.key] }, ...groups.slice(at)];
  }
  if (existing.memberKeys.includes(state.member.key)) return groups.map((row) => (row.id === group.id ? { ...row } : row));
  const at = Math.min(state.groupIndex, existing.memberKeys.length);
  const memberKeys = [...existing.memberKeys.slice(0, at), state.member.key, ...existing.memberKeys.slice(at)];
  return groups.map((row) => (row.id === group.id ? { ...row, memberKeys } : row));
}

function restoreMember(db: Database, round: StoredRound, state: PutBackState): MailRoundUndoResult {
  db.query("DELETE FROM desk_mail_round_queue WHERE mail_key = ?").run(state.member.key);
  const already = round.members.some((member) => member.key === state.member.key);
  if (!already) {
    const at = Math.min(state.index, round.members.length);
    const members = [...round.members.slice(0, at), state.member, ...round.members.slice(at)];
    writeRound(db, { ...round, revision: round.revision + 1, members, groups: groupWithMember(round.groups, state) });
  }
  return { ok: true, outcome: "restored", message: `${quotedSubject(state.member.mail.subject)} is back where it was in this mail round.` };
}

function leaveFirstForNextRound(db: Database, open: StoredRound | null, state: PutBackState, now: number): MailRoundUndoResult {
  const subject = quotedSubject(state.member.mail.subject);
  if (open?.members.some((member) => member.key === state.member.key)) return { ok: true, outcome: "next-round", message: `That mail round is finished. ${subject} is in your next mail round.` };
  const message = `That mail round is finished, so ${subject} leads your next mail round.`;
  if (readQueue(db).some((row) => row.mail_key === state.member.key)) {
    db.query("UPDATE desk_mail_round_queue SET put_back = 1, position = ? WHERE mail_key = ?").run(putBackPosition(db, state.member.key), state.member.key);
  } else {
    queuePutBack(db, state.member, now);
  }
  return { ok: true, outcome: "next-round", message };
}

export function putBackMailRound(db: Database, request: MailRoundPutBackRequest): MailRoundPutBackResult {
  const binding = JSON.stringify({ action: "put-back", roundId: request.roundId, revision: request.revision, key: request.key });
  const prior = replayable(db, request.requestId, binding);
  if (prior) return "request_id" in prior ? parseStored<MailRoundPutBackResult>(prior.result, refuseRound(409, ROUND_STALE)) : prior;
  return db.transaction((): MailRoundPutBackResult => {
    const row = readOpenRow(db);
    if (!row) return refuseRound(409, ROUND_NOT_OPEN);
    const round = storedRound(row);
    if (round.id !== request.roundId || round.revision !== request.revision) return refuseRound(409, ROUND_STALE);
    const index = round.members.findIndex((member) => member.key === request.key);
    const member = round.members[index];
    if (index < 0 || !member) return refuseRound(409, ROUND_NOT_MEMBER);
    const group = round.groups.find((entry) => entry.memberKeys.includes(request.key)) ?? null;
    const state: PutBackState = { roundId: round.id, index, groupAt: group ? round.groups.indexOf(group) : 0, groupIndex: group ? group.memberKeys.indexOf(request.key) : 0, member, group };
    const members = round.members.filter((_, at) => at !== index);
    writeRound(db, { ...round, revision: round.revision + 1, members, groups: filterGroups(round.groups, members) });
    if (members.length === 0) finishRound(db, round.id, request.now);
    queuePutBack(db, member, request.now);
    const result: MailRoundPutBackResult = { ok: true, message: `Put ${quotedSubject(member.mail.subject)} back. It leads your next mail round.`, undo: crypto.randomUUID() };
    rememberOperation(db, { requestId: request.requestId, binding, roundId: round.id, kind: "put-back", token: result.undo, state: JSON.stringify(state), result: JSON.stringify(result), now: request.now });
    return result;
  }).immediate();
}

export function undoMailRoundPutBack(db: Database, request: MailRoundUndoRequest): MailRoundUndoResult {
  const binding = JSON.stringify({ action: "undo", token: request.token });
  const prior = replayable(db, request.requestId, binding);
  if (prior) return "request_id" in prior ? parseStored<MailRoundUndoResult>(prior.result, refuseRound(409, ROUND_STALE)) : prior;
  return db.transaction((): MailRoundUndoResult => {
    const operation = readTokenOperation(db, request.token);
    const state = operation ? parseStored<PutBackState | null>(operation.state, null) : null;
    if (!operation || !state) return refuseRound(404, ROUND_TOKEN_UNKNOWN);
    if (operation.undone_by !== null) return refuseRound(409, ROUND_ALREADY_UNDONE);
    const row = readOpenRow(db);
    const open = row ? storedRound(row) : null;
    const result = open?.id === state.roundId ? restoreMember(db, open, state) : leaveFirstForNextRound(db, open, state, request.now);
    db.query("UPDATE desk_mail_round_operations SET undone_by = ? WHERE request_id = ?").run(request.requestId, operation.request_id);
    rememberOperation(db, { requestId: request.requestId, binding, roundId: state.roundId, kind: "undo", token: request.token, state: operation.state, result: JSON.stringify(result), now: request.now });
    return result;
  }).immediate();
}

function pruneRoundOperations(db: Database, roundIds: readonly string[]): void {
  for (const roundId of roundIds) db.query("DELETE FROM desk_mail_round_operations WHERE round_id = ?").run(roundId);
}

export function mailRoundAnswerView(db: Database, args: { now: number; slots?: readonly string[]; availability: CalendarAvailability; readings: readonly { id: string; error: string | null }[] }): MailRoundView {
  const row = readOpenRow(db);
  const slots = configuredSlots(args.slots);
  const unavailable: MailRoundUnavailable = {
    mail: args.readings.filter((reading) => reading.error !== null).map((reading) => reading.id),
    calendar: args.availability.sources.filter((source) => source.kind === "unknown").map((source) => source.id),
  };
  return viewOf(row ? storedRound(row) : null, readQueue(db).length, nextEffectiveSlot(args.now, slots, args.availability), unavailable);
}

export function readMailRound(db: Database, input: MailRoundInput): MailRoundView {
  return db.transaction(() => {
    const slots = configuredSlots(input.slots);
    const candidates = candidatesOf(input);
    const succeeded = new Set(input.readings.filter((reading) => reading.error === null).map((reading) => reading.id));
    const pruned = pruneFinishedRounds(db, input.now);
    if (pruned.length > 0) pruneRoundOperations(db, pruned);
    const row = readOpenRow(db);
    const reconciled = row ? reconcileOpen(db, storedRound(row), candidates, succeeded, input.now) : { open: null, justFinished: null };
    pruneQueue(db, reconciled.open, candidates, succeeded);
    const queued = enqueueCandidates(db, reconciled.open, candidates, succeeded, input.now);
    const open = reconciled.open ?? openSuccessor(db, input, slots, candidates, queued, reconciled.justFinished);
    const unavailable: MailRoundUnavailable = {
      mail: input.readings.filter((reading) => reading.error !== null).map((reading) => reading.id),
      calendar: input.availability.sources.filter((source) => source.kind === "unknown").map((source) => source.id),
    };
    return viewOf(open, readQueue(db).length, nextEffectiveSlot(input.now, slots, input.availability), unavailable);
  })();
}
