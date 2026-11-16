import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ServerContext } from "../../server";
import { startServer } from "../../server";
import { initDatabase } from "../../db/init";
import { DEFAULT_CONFIG } from "../../config";
import type { DeskOptions } from "../../desk/compose";
import type { DeskView } from "../../desk/types";
import type { SourceEvent, SourceMail } from "../../desk/sources/command";

export interface RoundState {
  mail: SourceMail[];
  events?: SourceEvent[];
  fail?: boolean;
}

export interface MailRoundRig {
  dir: string;
  database: () => Database;
  baseUrl: () => string;
  setNow: (now: number) => void;
  setState: (state: RoundState) => void;
  get: () => Promise<DeskView>;
  refresh: () => Promise<DeskView>;
  post: (body: unknown) => Promise<Response>;
  postRound: (body: unknown) => Promise<Response>;
  defer: (body: unknown) => Promise<Response>;
  reopen: () => void;
  close: () => Promise<void>;
}

const DAY_MS = 86_400_000;

export const roundAt = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();

export const roundMail = (id: string, received: number, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail",
  id,
  from: { name: id, address: `${id}@example.org` },
  subject: `Subject ${id}`,
  receivedAt: new Date(received).toISOString(),
  unread: true,
  account: "work",
  ...over,
});

export const roundEvent = (id: string, start: number, end: number, status: "busy" | "unknown" = "busy"): SourceEvent => ({
  id,
  title: `Meeting ${id}`,
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  calendar: "Work",
  calendarId: "primary",
  availability: { status, provenance: "mail round fixture" },
});

interface QueuedMail {
  mail_key: string;
  put_back: number;
  position: number;
}

export const queuedMails = (db: Database): QueuedMail[] =>
  db.query<QueuedMail, []>("SELECT mail_key, put_back, position FROM desk_mail_round_queue ORDER BY put_back DESC, position").all();

export const roundStatuses = (db: Database): { id: string | null; status: string }[] =>
  db.query<{ id: string; status: string }, []>("SELECT id, status FROM desk_mail_rounds ORDER BY opened_at").all();

const SIDE_EFFECT_TABLES = ["desk_mail_moves", "desk_mail_snoozes", "desk_links", "desk_done", "desk_mail_log"] as const;

interface RoundAnswer {
  ok: boolean;
  message?: string;
  messagePhrase?: { code: string; params?: Record<string, unknown> };
  undo?: string;
  outcome?: string;
  error?: string;
  mailRound?: DeskView["mailRound"];
}

export const readAnswer = async (response: Response): Promise<RoundAnswer> => (await response.json()) as RoundAnswer;

export const putBackPayload = (round: { id: string | null; revision: number }, key: string, requestId: string): Record<string, unknown> => ({
  action: "put-back",
  roundId: round.id,
  revision: round.revision,
  key,
  requestId,
});

export function roundSideEffects(db: Database): Record<string, number> {
  return Object.fromEntries(SIDE_EFFECT_TABLES.map((table) => [table, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1]));
}

export const roundKeys = (view: { mailRound?: { mails: { key: string }[] } }): string[] => (view.mailRound?.mails ?? []).map((member) => member.key);

export async function openMailRoundRig(now: number, overrides: Partial<DeskOptions> = {}): Promise<MailRoundRig> {
  const dir = mkdtempSync(join(tmpdir(), "mail-round-"));
  const dbPath = join(dir, "round.db");
  const statePath = join(dir, "state.json");
  const sourcePath = join(dir, "source");
  const readsPath = join(dir, "reads");
  writeFileSync(readsPath, "");
  writeFileSync(sourcePath, "#!/bin/sh\ncat \"$1\"; printf x >> \"$2\"\n", { mode: 0o755 });
  let clock = now;
  let state: RoundState = { mail: [] };
  const desk: DeskOptions = {
    enabled: true,
    displayName: "",
    assistantName: "Assistant",
    topN: 5,
    rangerUrl: "",
    areas: [],
    sources: [{ id: "round-source", command: [sourcePath, statePath, readsPath], everySeconds: 30, timeoutSeconds: 5 }],
    interruptions: { transport: "none", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: false, notifications: false, holdDuringMeetings: true },
    mailActions: { move: ["fixture-move"], timeoutSeconds: 5 },
    mailDigest: { at: "07:00" },
    mailInvitations: { command: ["fixture-invite"], timeoutSeconds: 5, addToCalendar: [], slots: { days: 5, dayStart: "09:00", dayEnd: "18:00", max: 5 } },
    mailRounds: { slots: ["08:30", "13:30", "16:30"] },
    ...overrides,
  };
  const writeState = (): void => {
    writeFileSync(statePath, state.fail ? "not json" : JSON.stringify({
      capabilities: ["calendar", "attention"],
      calendarCoverage: { from: new Date(clock - 30 * DAY_MS).toISOString(), to: new Date(clock + 30 * DAY_MS).toISOString(), calendars: [{ id: "primary", name: "Work" }], status: "complete", provenance: "mail round fixture" },
      events: state.events ?? [],
      items: state.mail,
    }));
  };
  const reads = (): number => readFileSync(readsPath, "utf8").length;
  let db = initDatabase(dbPath);
  let ctx: ServerContext = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { deskNow: () => clock, desk });
  const rig: MailRoundRig = {
    dir,
    database: () => db,
    baseUrl: () => `http://localhost:${ctx.port}`,
    setNow: (at) => { clock = at; },
    setState: (next) => { state = next; writeState(); },
    get: async () => (await (await fetch(`${rig.baseUrl()}/api/desk`)).json()) as DeskView,
    refresh: async () => {
      const before = reads();
      await fetch(`${rig.baseUrl()}/api/desk`);
      const started = Date.now();
      while (reads() === before && Date.now() - started < 2000) await Bun.sleep(10);
      const read = async (): Promise<string> => (await fetch(`${rig.baseUrl()}/api/desk`)).text();
      let previous = "";
      let stable = 0;
      const settling = Date.now();
      while (stable < 3 && Date.now() - settling < 3000) {
        await Bun.sleep(25);
        const current = await read();
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
      return JSON.parse(previous) as DeskView;
    },
    post: async (body) => fetch(`${rig.baseUrl()}/api/desk/mail`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) }),
    postRound: async (body) => fetch(`${rig.baseUrl()}/api/desk/mail/round`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) }),
    defer: async (body) => fetch(`${rig.baseUrl()}/api/desk/items/defer`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) }),
    reopen: () => {
      ctx.stop(true);
      db.close();
      db = initDatabase(dbPath);
      ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { deskNow: () => clock, desk });
    },
    close: async () => {
      ctx.stop(true);
      await Bun.sleep(150);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}
