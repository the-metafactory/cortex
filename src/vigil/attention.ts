import type { Database } from "bun:sqlite";
import type { AttentionDelta } from "../surface/mc/attention-notify";
import type { AttentionItem } from "../surface/mc/types";
import { getAttentionItem, upsertAttentionItem } from "../surface/mc/db/attention";
import { getVigilSubject, type VigilEventRow } from "./db";
import { subjectClass, vigilSeverity } from "./policy";
import { resolveVigilAttention } from "./resolution";

export function applyVigilAttention(
  db: Database,
  event: Pick<VigilEventRow, "id" | "subject_key" | "to_value" | "direction">,
  stackId: string,
  options: { replay?: boolean; now?: number } = {},
): AttentionDelta {
  return db.transaction(() => {
    const delta: AttentionDelta = { opened: [], resolved: [] };
    const id = `att:vigil:${event.subject_key}`;
    const prior = getAttentionItem(db, id);
    if (event.direction === "better" && prior?.status !== "open") return delta;
    const subject = getVigilSubject(db, event.subject_key);
    if (!subject) throw new Error(`Vigil transition has no subject: ${event.subject_key}`);
    const severity = vigilSeverity(subjectClass(subject), event.to_value, event.direction);
    if (severity !== null) {
      const item: AttentionItem = {
        id, stackId, workItemId: null, sessionId: null,
        kind: "state_change", severity, status: "open",
      };
      upsertAttentionItem(db, item);
      if (prior?.status !== "open") delta.opened.push(item);
    } else if (prior) {
      resolveVigilAttention(db, id, "archived", options);
      delta.resolved.push({ ...prior, status: "resolved", resolution: "archived" });
    }
    db.query("UPDATE vigil_events SET severity = ?, attention_id = ? WHERE id = ?").run(severity, id, event.id);
    return delta;
  })();
}

export function applyVigilTransitions(db: Database, events: VigilEventRow[], stackId: string): AttentionDelta {
  const delta: AttentionDelta = { opened: [], resolved: [] };
  for (const event of events) {
    const change = applyVigilAttention(db, event, stackId);
    delta.opened.push(...change.opened);
    delta.resolved.push(...change.resolved);
  }
  return delta;
}
