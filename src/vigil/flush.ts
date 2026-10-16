import type { Database } from "bun:sqlite";
import type { NotifyResult } from "../adapters/types";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { budgetDay, canSendVigilText, inQuietHours } from "./budget";
import { getVigilSubject, markVigilTextSent, type VigilEventRow, type VigilSubjectRow } from "./db";
import type { GoalWordingResolver } from "./goal-wording";
import { createVigilRenderer } from "./render";

export interface VigilFallbackText {
  event: VigilEventRow;
  text: string;
}

export interface FlushTextsOptions {
  db: Database;
  now: number;
  send: ((text: string) => Promise<NotifyResult>) | null;
  resolveGoalWording?: GoalWordingResolver;
  publish?: MyelinRuntime["publish"];
  render?: (event: VigilEventRow, subject: VigilSubjectRow) => string | Promise<string>;
  readChannelHealth?: () => "ok" | "regressed";
  fallback?: (batch: readonly VigilFallbackText[]) => Promise<void>;
}

const activeFlushes = new WeakMap<Database, Promise<void>>();

export function flushTexts(options: FlushTextsOptions): Promise<void> {
  const active = activeFlushes.get(options.db);
  if (active) return active;
  const flushing = flushPendingTexts(options).finally(() => { activeFlushes.delete(options.db); });
  activeFlushes.set(options.db, flushing);
  return flushing;
}

async function flushPendingTexts(options: FlushTextsOptions): Promise<void> {
  const { db, now, send } = options;
  const render = options.render ?? createVigilRenderer({ resolveGoalWording: options.resolveGoalWording });
  const batch: VigilFallbackText[] = [];
  const events = db.query<VigilEventRow, []>(`SELECT * FROM vigil_events
    WHERE route = 'text' AND delivery = 'pending' ORDER BY occurred_at, rowid`).all();
  for (const event of events) {
    if (!canSendVigilText(db, now)) {
      db.query("UPDATE vigil_events SET delivery = 'held', held_reason = ? WHERE id = ? AND delivery = 'pending'")
        .run(inQuietHours(now) ? "quiet" : "budget", event.id);
      continue;
    }
    const subject = getVigilSubject(db, event.subject_key);
    if (!subject) throw new Error(`Vigil text has no subject: ${event.subject_key}`);
    const text = await render(event, subject);
    db.query("UPDATE vigil_events SET attempts = attempts + 1 WHERE id = ?").run(event.id);
    const result: NotifyResult = send === null
      ? { delivered: false, kind: "permanent", code: "no-adapter" }
      : await send(text);
    if (result.delivered) {
      markVigilTextSent(db, event.id, "dm", now, budgetDay(now));
      continue;
    }
    const transientFailures = result.kind === "transient" ? event.transient_failures + 1 : 0;
    db.query("UPDATE vigil_events SET last_error = ?, transient_failures = ? WHERE id = ?")
      .run(result.code, transientFailures, event.id);
    if (result.kind === "permanent" || transientFailures >= 3 || options.readChannelHealth?.() === "regressed") {
      batch.push({ event: { ...event, attempts: event.attempts + 1, last_error: result.code, transient_failures: transientFailures }, text });
    }
  }
  if (batch.length > 0 && options.fallback) await options.fallback(batch);
}
