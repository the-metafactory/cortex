import { createHash } from "node:crypto";
import type { MyDayMeta } from "./my-day-schema";
import type { DeskItem } from "./types";
import { localDay } from "./time";

export function sourceIdentity(item: DeskItem): string {
  const sourceFacts = [
    item.key,
    item.kind,
    item.source,
    item.sourceRevision ?? null,
    item.dueAt ?? null,
    item.detail.refs,
  ];
  const identity =
    item.kind === "mail"
      ? sourceFacts
      : [...sourceFacts, item.title, item.detail.summary];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export function todo(meta: MyDayMeta, item: DeskItem): string {
  const existing = meta.sources.find(
    (s) => s.fingerprint === sourceIdentity(item),
  );
  if (existing) return existing.taskId;
  const id = `todo:${crypto.randomUUID()}`;
  const url = item.detail.links[0]?.url;
  meta.inbox.push({
    id,
    title: item.title,
    weight: 50,
    ordering: "parallel",
    children: [],
    effort: 1,
    note: `From ${item.source}: ${item.key}${url ? `\n${url}` : ""}`,
    ...(item.dueAt
      ? {
          dueDate: /^\d{4}-\d{2}-\d{2}$/.test(item.dueAt)
            ? item.dueAt
            : localDay(Date.parse(item.dueAt)),
        }
      : {}),
  });
  meta.sources.push({
    taskId: id,
    key: item.key,
    fingerprint: sourceIdentity(item),
    kind: item.kind,
    ...(url ? { url } : {}),
  });
  return id;
}
