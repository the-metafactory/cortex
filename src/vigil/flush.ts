import type { Database } from "bun:sqlite";
import type { NotifyResult } from "../adapters/types";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { budgetDay, canSendVigilText, inQuietHours, VIGIL_DAILY_TEXT_LIMIT } from "./budget";
import { channelKey, channelValue, recordChannel } from "./channels";
import { getVigilSubject, getVigilTextsSpent, markVigilTextSent, type VigilEventRow, type VigilSubjectRow } from "./db";
import type { GoalWordingResolver } from "./goal-wording";
import type { VigilFallback } from "./fallback-email";
import { createVigilRenderer } from "./render";
import { publishTextSentReceipt } from "./delivery-receipt";

interface VigilFallbackText {
  event: VigilEventRow;
  text: string;
}

export interface FlushTextsOptions {
  db: Database;
  principal: string;
  now: number;
  send: ((text: string) => Promise<NotifyResult>) | null;
  resolveGoalWording?: GoalWordingResolver;
  publish: MyelinRuntime["publish"];
  render?: (event: VigilEventRow, subject: VigilSubjectRow) => string | Promise<string>;
  fallback?: VigilFallback | null;
}

const activeFlushes = new WeakMap<Database, Promise<void>>();
export const TRANSIENT_FALLBACK_THRESHOLD = 3;

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
  const settled: VigilEventRow[] = [];
  const events = db.query<VigilEventRow, [string]>(`SELECT * FROM vigil_events
    WHERE route = 'text' AND delivery = 'pending' AND subject_key != ? ORDER BY occurred_at, rowid`)
    .all(channelKey("dm-channel"));
  try {
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
        recordChannel(db, "dm-channel", "ok", now);
        if (markVigilTextSent(db, event.id, "dm", now, budgetDay(now))) {
          settled.push(event);
        }
        continue;
      }
      const transientFailures = result.kind === "transient" ? event.transient_failures + 1 : 0;
      db.query("UPDATE vigil_events SET last_error = ?, transient_failures = ? WHERE id = ?")
        .run(result.code, transientFailures, event.id);
      if (result.kind === "permanent" || transientFailures >= TRANSIENT_FALLBACK_THRESHOLD || channelValue(db, "dm-channel") === "regressed") {
        recordChannel(db, "dm-channel", "regressed", now);
        batch.push({ event, text });
      }
    }
  } finally {
    try {
      await flushFallbackBatch(options, batch, settled);
    } finally {
      await publishReceipts(options, settled);
    }
  }
}

async function flushFallbackBatch(options: FlushTextsOptions, batch: readonly VigilFallbackText[], settled: VigilEventRow[]): Promise<void> {
  if (batch.length === 0) return;
  const { db, now } = options;
  const day = budgetDay(now);
  const remaining = Math.max(0, VIGIL_DAILY_TEXT_LIMIT - getVigilTextsSpent(db, day));
  const eligible = batch.slice(0, remaining);
  for (const { event } of batch.slice(remaining)) {
    db.query("UPDATE vigil_events SET delivery = 'held', held_reason = 'budget' WHERE id = ? AND delivery = 'pending'")
      .run(event.id);
  }
  if (eligible.length === 0) return;
  const notices = db.query<VigilEventRow, [string]>(`SELECT * FROM vigil_events
    WHERE subject_key = ? AND route = 'text' AND to_value = 'regressed' AND delivery = 'pending'
    ORDER BY occurred_at, rowid`).all(channelKey("dm-channel"));
  const renderNotice = createVigilRenderer();
  const noticeSubject = getVigilSubject(db, channelKey("dm-channel"));
  const noticeTexts = noticeSubject ? await Promise.all(notices.map((event) => renderNotice(event, noticeSubject))) : [];
  const body = [...noticeTexts, ...eligible.map(({ text }) => text)].join("\n");
  let result: Awaited<ReturnType<VigilFallback>>;
  try {
    result = options.fallback
      ? await options.fallback(`[Vigil] ${eligible.length} text(s)`, body)
      : { ok: false, error: "no-fallback" };
  } catch {
    result = { ok: false, error: "exception" };
  }
  if (options.fallback) recordChannel(db, "email-channel", result.ok ? "ok" : "regressed", now);
  if (!result.ok) {
    for (const { event } of eligible) {
      db.query("UPDATE vigil_events SET last_error = ? WHERE id = ? AND delivery = 'pending'")
        .run(result.error ?? "fallback-failed", event.id);
    }
    return;
  }
  const sent = db.transaction(() => {
    const settled = eligible.filter(({ event }) => markVigilTextSent(db, event.id, "email", now, day));
    for (const notice of notices) {
      db.query("UPDATE vigil_events SET delivery = 'sent', via = 'email', sent_at = ?, last_error = NULL WHERE id = ? AND delivery = 'pending'")
        .run(now, notice.id);
    }
    return settled.map(({ event }) => event);
  })();
  settled.push(...sent);
}

async function publishReceipts(options: FlushTextsOptions, events: readonly VigilEventRow[]): Promise<void> {
  const publish = options.publish;
  const results = await Promise.allSettled(events.map((event) => publishTextSentReceipt({
    event_id: event.id, subject_key: event.subject_key, budget_day: budgetDay(options.now),
  }, options.principal, publish)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(failures.map((result): unknown => result.reason), "Vigil text-sent publication failed after delivery settlement");
}
