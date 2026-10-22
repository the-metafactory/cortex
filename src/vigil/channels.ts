import type { Database } from "bun:sqlite";
import { confirmSubjectStack, getVigilSubject, writeVigilSubject, writeVigilTransition, type VigilEventRow } from "./db";
import { STATE_VOCABULARIES, stateDirection, stateHealthy, stateSubjectKey } from "./state-subject";

export type VigilChannel = "dm-channel" | "email-channel";
export type VigilChannelValue = typeof STATE_VOCABULARIES.check[number];

export function channelKey(channel: VigilChannel, stack = "default"): string {
  return stateSubjectKey("check", stack, `vigil:${channel}`);
}

export function channelValue(db: Database, channel: VigilChannel, stack = "default"): VigilChannelValue {
  return getVigilSubject(db, channelKey(channel, stack))?.value === "regressed" ? "regressed" : "ok";
}

export function recordChannel(db: Database, channel: VigilChannel, value: VigilChannelValue, now: number, stack = "default"): VigilEventRow | null {
  return db.transaction(() => {
    const key = channelKey(channel, stack);
    const from = channelValue(db, channel, stack);
    const runId = crypto.randomUUID();
    writeVigilSubject(db, {
      subject_key: key, subject_kind: "state", vocab: "check", ref: `vigil:${channel}`,
      value, healthy: stateHealthy("check", value) ? 1 : 0, goal_id: null,
      producer: "vigil", stack, run_kind: null, last_run_id: runId,
      last_ended_at: now, last_seen_at: now,
    }, now);
    confirmSubjectStack(db, key);
    const direction = stateDirection("check", from, value);
    if (direction === null) return null;
    const event = writeVigilTransition(db, {
      subject_key: key, from_value: from, to_value: value, direction, run_id: runId, occurred_at: now,
    }, now);
    if (channel === "dm-channel" && value === "regressed") {
      db.query("UPDATE vigil_events SET route = 'text' WHERE id = ?").run(event.id);
      event.route = "text";
    }
    return event;
  }).immediate();
}
