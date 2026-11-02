import type { z } from "zod";
import type { DeskMailWaitingSchema } from "../../../common/types/config";

export const WAITING_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_waiting (
    message_id TEXT PRIMARY KEY,
    account TEXT,
    source_id TEXT,
    sender TEXT NOT NULL,
    recipients TEXT NOT NULL,
    subject TEXT NOT NULL,
    url TEXT,
    sent_at INTEGER NOT NULL,
    asks INTEGER NOT NULL,
    topic TEXT,
    ask TEXT,
    detected_by TEXT NOT NULL,
    state TEXT NOT NULL,
    closed_at INTEGER,
    closed_by TEXT,
    snoozed_until INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_waiting_open ON desk_mail_waiting (state, sent_at)",
  `CREATE TABLE IF NOT EXISTS desk_mail_thread (
    parent_id TEXT NOT NULL,
    reply_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, reply_id)
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_thread_at ON desk_mail_thread (at)",
];

export type WaitingConfig = z.infer<typeof DeskMailWaitingSchema>;
export type WaitingModel = NonNullable<WaitingConfig["model"]>;

export const WAITING_STATES = ["open", "answered", "superseded", "no-answer", "done"] as const;
export type WaitingState = (typeof WAITING_STATES)[number];

export const WAITING_OPS = ["snooze", "done", "no-answer", "expect"] as const;
export type WaitingOp = (typeof WAITING_OPS)[number];
