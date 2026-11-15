import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "./compose";
import { linksToMeeting, type LinkRow } from "./links";
import { readingEvents } from "./mail-snooze";
import { listOpenNotes, type DeskNote } from "./notes";
import { STUDIO_OWNER_KIND } from "../../../common/desk-owner";
import { oneLine } from "./studio/edit";
import type { StudioView } from "./studio/view";
import { readBalanceNode } from "./work-readers";
import { withSyncedBalance } from "./studio-my-day";
import type { SourceReading } from "./sources/command";
import {
  gapWording, PREVIOUS_MEETING_UNIDENTIFIED, SYNTHESIS_NOT_CONFIGURED,
  type BriefFact, type BriefGap, type BriefGapReason, type BriefSourceIdentity, type BriefSourceRef, type MeetingBrief,
} from "./meeting-brief-contract";

const currentReadings = (runtime: DeskRuntime): SourceReading[] => {
  const configured = new Set(runtime.options?.sources.map(source => source.id) ?? []);
  return (runtime.sourceCache?.cached() ?? []).filter(reading => configured.has(reading.id));
};

const BALANCE_OWNER = "balance";
const NOTES_OWNER = "desk-notes";

const EXCERPT_CHARS = 400;
const REVISION_VERSION = 1;

type UnreadableReason = Exclude<BriefGapReason, "no-linked-material">;

export type BriefRead =
  | { ok: true; identity: BriefSourceIdentity; text: string; excerpt: string; link?: string; fingerprint: string }
  | { ok: false; reason: UnreadableReason; identity: BriefSourceIdentity; needsRelink?: true };

type BriefReader = (row: LinkRow) => BriefRead | Promise<BriefRead>;

export type BriefReaders = Record<LinkRow["fromKind"], BriefReader>;

export interface BriefDeps {
  now?: () => number;
  readers?: Partial<BriefReaders>;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const identityKey = (identity: BriefSourceIdentity): unknown => [identity.kind, identity.adapter, identity.owner ?? null, identity.connection ?? null, identity.item];

const clip = (text: string): string => oneLine(text).slice(0, EXCERPT_CHARS);

const unreadable = (reason: UnreadableReason, identity: BriefSourceIdentity): BriefRead => ({ ok: false, reason, identity });

const mailIdentity = (item: string, connection?: string): BriefSourceIdentity => ({ kind: "mail", adapter: null, owner: "desk-source-command", item, ...(connection ? { connection } : {}) });

function readMail(row: LinkRow, readings: readonly SourceReading[], configured: readonly string[]): BriefRead {
  const account = row.mail?.account ?? null;
  const item = row.fromKey;
  const connection = row.mail?.sourceId;
  if (configured.length === 0 || connection !== undefined && !configured.includes(connection)) return unreadable("no-adapter", mailIdentity(item, connection));
  if (connection === undefined) return { ok: false, reason: "read-failed", identity: mailIdentity(item), needsRelink: true };
  const hits = readings.filter(reading => reading.id === connection).flatMap((reading) =>
    reading.mail.filter((m) => `mail:${m.id}` === item && (account === null || (m.account ?? null) === account)).map((mail) => ({ reading, mail })),
  );
  const [hit] = hits;
  if (hits.length === 1 && hit?.reading.error === null) {
    const { mail, reading } = hit;
    const excerpt = clip(mail.firstParagraph ?? mail.subject);
    return {
      ok: true, identity: mailIdentity(item, reading.id), text: `Mail from ${mail.from.name ?? mail.from.address}: ${clip(mail.subject)}`, excerpt,
      ...(mail.url ? { link: mail.url } : {}), fingerprint: digest([mail.subject, mail.from.address, mail.receivedAt, mail.firstParagraph ?? null, mail.url ?? null]),
    };
  }
  return unreadable("read-failed", mailIdentity(item, connection));
}

const taskIdentity = (item: string): BriefSourceIdentity => ({ kind: "task", adapter: null, owner: BALANCE_OWNER, item });
const threadIdentity = (item: string): BriefSourceIdentity => ({ kind: "thread", adapter: null, owner: STUDIO_OWNER_KIND, item });
const noteIdentity = (item: string): BriefSourceIdentity => ({ kind: "note", adapter: null, owner: NOTES_OWNER, item });

type Studio = StudioView | null;

async function loadStudio(db: Database, runtime: DeskRuntime, now: number): Promise<{ studio: Studio } | null> {
  const desk = runtime.options;
  if (!desk) return null;
  return withSyncedBalance(db, desk, now, (_source, studio) => ({ studio }), true).catch((err: unknown) => {
    process.stderr.write(`[meeting-brief] the outline could not be read: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  });
}

function readTask(db: Database, runtime: DeskRuntime, row: LinkRow, loaded: { studio: Studio } | null): BriefRead {
  const identity = taskIdentity(row.fromKey);
  if (!loaded) return unreadable("read-failed", identity);
  const read = readBalanceNode(db, runtime.options, "balance-task", row.fromKey.slice("task:".length));
  if (read.state === "unavailable") return unreadable(read.reason === "unauthorized" ? "access-denied" : "read-failed", identity);
  const node = read.node;
  const note = node.note ? clip(node.note) : "";
  return {
    ok: true, identity, text: `Task${node.done ? " (done)" : ""}: ${clip(node.title)}`, excerpt: note || clip(node.title),
    ...(node.external?.url ? { link: node.external.url } : {}), fingerprint: digest([node.title, node.note ?? null, node.done ?? false, node.dueDate ?? null, node.external?.url ?? null]),
  };
}

function readThread(row: LinkRow, loaded: { studio: Studio } | null, studioConfigured: boolean): BriefRead {
  const identity = threadIdentity(row.fromKey);
  if (!studioConfigured) return unreadable("no-adapter", identity);
  const slug = row.fromKey.slice("thread:".length);
  const thread = loaded?.studio ? [...loaded.studio.active, ...loaded.studio.parked, ...loaded.studio.closed].find((t) => t.slug === slug) : undefined;
  if (!thread) return unreadable("read-failed", identity);
  return {
    ok: true, identity, text: `Studio thread: ${clip(thread.question)}`, excerpt: clip(thread.stand || thread.question),
    fingerprint: digest([thread.question, thread.stand, thread.state, thread.outcomeText, thread.policy]),
  };
}

function readNote(openNotes: Map<string, DeskNote>, row: LinkRow): BriefRead {
  const identity = noteIdentity(row.fromKey);
  const note = openNotes.get(row.fromKey);
  if (!note) return unreadable("read-failed", identity);
  return { ok: true, identity, text: `Note: ${clip(note.text)}`, excerpt: clip(note.text), fingerprint: digest([note.text, note.kind, note.dueAt]) };
}

async function defaultReaders(db: Database, runtime: DeskRuntime, now: number): Promise<BriefReaders> {
  const desk = runtime.options;
  const readings = currentReadings(runtime);
  const loaded = await loadStudio(db, runtime, now);
  const openNotes = new Map(listOpenNotes(db).map((n) => [`note:${n.id}`, n]));
  return {
    mail: (row) => readMail(row, readings, desk?.sources.map(source => source.id) ?? []),
    task: (row) => readTask(db, runtime, row, loaded),
    thread: (row) => readThread(row, loaded, desk?.studio !== undefined),
    note: (row) => readNote(openNotes, row),
  };
}

const gapOf = (reason: BriefGapReason, source: BriefSourceIdentity, needsRelink = false): BriefGap => ({
  id: `gap-${digest([reason, identityKey(source)]).slice(0, 16)}`, reason, source,
  ...(needsRelink ? { phrase: { code: "brief.gap-relink-required" as const }, message: "This older Mail link has no recorded source connection. Relink the Mail to read it." } : gapWording(reason, source.kind)),
});

const refOf = (read: Extract<BriefRead, { ok: true }>): BriefSourceRef => ({ ...read.identity, excerpt: read.excerpt, ...(read.link ? { link: read.link } : {}) });

const factOf = (read: Extract<BriefRead, { ok: true }>): BriefFact => ({ id: `fact-${digest(identityKey(read.identity)).slice(0, 16)}`, text: read.text, sources: [refOf(read)] });

interface MeetingFacts {
  title: string;
  at: number;
  end: number;
  connection: string | null;
  fingerprint: string;
}

export function resolveMeeting(runtime: DeskRuntime, eventKey: string): MeetingFacts | null {
  const readings = currentReadings(runtime);
  const readable = readings.filter(reading => reading.error === null);
  const event = readingEvents(readable).get(eventKey);
  if (!event) return null;
  const source = readable.find((r) => r.events.some((e) => `cal:${r.id}:${e.id}` === eventKey));
  const config = runtime.options?.sources.find(candidate => candidate.id === source?.id);
  return { title: event.title, at: event.at, end: event.end, connection: source?.id ?? null, fingerprint: digest([source?.events.find(e => `cal:${source.id}:${e.id}` === eventKey), config]) };
}

interface BriefEvidence {
  facts: BriefFact[];
  gaps: BriefGap[];
  revision: string;
}

const emptyMeetingGap = (eventKey: string, meeting: MeetingFacts): BriefGap =>
  gapOf("no-linked-material", { kind: "meeting", adapter: null, owner: "desk-source-command", ...(meeting.connection ? { connection: meeting.connection } : {}), item: eventKey });

export async function gatherEvidence(db: Database, runtime: DeskRuntime, eventKey: string, meeting: MeetingFacts, deps: BriefDeps = {}): Promise<BriefEvidence> {
  const rows = linksToMeeting(db, eventKey);
  const facts = new Map<string, BriefFact>();
  const gaps = new Map<string, BriefGap>();
  const fingerprints = new Map<string, string>();
  if (rows.length === 0) {
    const gap = emptyMeetingGap(eventKey, meeting);
    gaps.set(gap.id, gap);
  } else {
    const readers: BriefReaders = { ...(await defaultReaders(db, runtime, (deps.now ?? Date.now)())), ...deps.readers };
    for (const row of rows) {
      const read = await readRow(readers, row);
      if (!read.ok || read.excerpt.trim() === "") {
        const gap = gapOf(read.ok ? "no-linked-material" : read.reason, read.identity, !read.ok && read.needsRelink === true);
        gaps.set(gap.id, gap);
      } else {
        const fact = factOf(read);
        facts.set(fact.id, fact);
        fingerprints.set(fact.id, read.fingerprint);
      }
    }
  }
  const revision = digest([
    REVISION_VERSION, eventKey, meeting.title, meeting.at, meeting.end, meeting.connection, meeting.fingerprint,
    runtime.options?.sources,
    currentReadings(runtime).map(reading => [reading.id, reading.error !== null, reading.dropped, reading.problems, reading.capabilities, reading.calendarCoverage]),
    [...facts.values()].map((f) => [f.id, fingerprints.get(f.id)]).sort(),
    [...gaps.values()].map((g) => [g.id, g.reason]).sort(),
  ]);
  return { facts: [...facts.values()], gaps: [...gaps.values()], revision };
}

const readRow = async (readers: BriefReaders, row: LinkRow): Promise<BriefRead> => {
  try {
    return await readers[row.fromKind](row);
  } catch (err) {
    process.stderr.write(`[meeting-brief] a ${row.fromKind} read threw: ${err instanceof Error ? err.name : "error"}\n`);
    return unreadable("read-failed", row.fromKind === "mail" ? mailIdentity(row.fromKey, row.mail?.sourceId) : row.fromKind === "task" ? taskIdentity(row.fromKey) : row.fromKind === "thread" ? threadIdentity(row.fromKey) : noteIdentity(row.fromKey));
  }
};

export const briefOf = (eventKey: string, evidence: BriefEvidence, preparedAt: number): MeetingBrief => ({
  event: eventKey,
  revision: evidence.revision,
  preparedAt: new Date(preparedAt).toISOString(),
  facts: evidence.facts,
  gaps: evidence.gaps,
  previousMeeting: PREVIOUS_MEETING_UNIDENTIFIED,
  synthesis: SYNTHESIS_NOT_CONFIGURED,
});

interface StoredRow {
  revision: string;
  body: string;
}

export const readPrepared = (db: Database, eventKey: string): MeetingBrief | null => {
  const row = db.query<StoredRow, [string]>("SELECT revision, body FROM desk_meeting_briefs WHERE event = ?").get(eventKey);
  return row ? (JSON.parse(row.body) as MeetingBrief) : null;
};

export const storePrepared = (db: Database, brief: MeetingBrief, preparedAt: number): void => {
  db.query("INSERT INTO desk_meeting_briefs (event, revision, prepared_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(event) DO UPDATE SET revision = excluded.revision, prepared_at = excluded.prepared_at, body = excluded.body")
    .run(brief.event, brief.revision, preparedAt, JSON.stringify(brief));
};

export const dropPrepared = (db: Database, eventKey: string): void => {
  db.query("DELETE FROM desk_meeting_briefs WHERE event = ?").run(eventKey);
};
