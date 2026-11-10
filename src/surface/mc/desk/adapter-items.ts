import { z } from "zod";
import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { ReadBindings } from "../../../conversations/domain-adapters/reads/bindings";
import type { ObservationStore } from "../../../conversations/domain-adapters/reads/observations";
import type { ObservationView } from "../../../conversations/domain-adapters/reads/observation-types";
import type { QuerySource } from "../../../conversations/domain-adapters/reads/query-types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { ReadBinding } from "../../../conversations/domain-adapters/reads/types";
import { ObjectReferenceSchema } from "../../../conversations/domain-adapters/types";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import { redactToolText } from "../../../conversations/tools/output";
import { localDay } from "./time";
import { freshnessLabel, type DeskItem, type DeskView } from "./types";

export interface AdapterAttention {
  enabled: boolean;
  store: ObservationStore;
  bindings: Pick<ReadBindings, "lookup">;
  context: HostContext;
  sink: ReleaseSink;
  sources: readonly QuerySource[];
}

const text = z.string().trim().min(1).max(4000).transform(redactToolText);
const dueDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable();
const link = z.url({ protocol: /^https?$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && redactToolText(value) === value;
}).nullable();
const area = ObjectReferenceSchema.nullable();
const MAPPING_PROBLEM = "An adapter attention mapping could not be displayed safely.";

function hostRank(due: string | null, now: number): Pick<DeskItem, "urgency" | "score"> {
  const day = due === null ? null : due.length === 10 ? due : localDay(Date.parse(due));
  if (day !== null && day <= localDay(now)) return { urgency: "today", score: 55 };
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  return day !== null && day <= localDay(week.getTime()) ? { urgency: "this-week", score: 45 } : { urgency: "waiting", score: 25 };
}

function mappedItem(row: ObservationView, binding: ReadBinding, now: number): DeskItem | null {
  if (row.kind !== "present" || row.value === undefined || !binding.attention) return null;
  const value = row.value;
  const title = text.safeParse(readPointer(value, binding.display.title));
  const why = text.safeParse(readPointer(value, binding.attention.pointer));
  const due = dueDate.safeParse(binding.display.due ? readPointer(value, binding.display.due) : null);
  const destination = area.safeParse(binding.display.area ? readPointer(value, binding.display.area) : null);
  const url = link.safeParse(binding.display.url ? readPointer(value, binding.display.url) : null);
  if (!title.success || !why.success || !due.success || !destination.success || !url.success) return null;
  const key = `adapter:${canonicalWire(row.ref)}`;
  const status = row.status;
  return {
    key, kind: "adapter", source: redactToolText(binding.adapterId),
    title: title.data, why: why.data,
    area: destination.data ? redactToolText(destination.data.canonicalId) : null,
    ...(due.data === null ? {} : { dueAt: due.data }),
    ...hostRank(due.data, now), actions: [],
    freshness: status, readOnly: true,
    detail: {
      summary: why.data,
      history: [`${freshnessLabel(status) ?? "Observed"}: last success ${new Date(row.lastSuccessAt).toISOString()}; last attempt ${row.lastAttemptAt === null ? "unavailable" : new Date(row.lastAttemptAt).toISOString()}.`],
      refs: [key], links: url.data === null ? [] : [{ label: "Open source", url: url.data }],
    },
  };
}

export async function adapterItems(feature: AdapterAttention | undefined, now: number): Promise<{ items: DeskItem[]; sources: DeskView["sources"] }> {
  const items = new Map<string, DeskItem>();
  const sources: DeskView["sources"] = [];
  if (!feature?.enabled) return { items: [], sources };
  const releasedSources = await Promise.all(feature.sources.map(async source => {
    const found = feature.bindings.lookup(source.adapterId, source.connectionId, source.capabilityId);
    if (found.state !== "available" || !found.binding.attention) return null;
    const released = await feature.store.read(feature.context, source, feature.sink);
    if (released.kind !== "released") return null;
    const rows = (released.value as unknown as { objects: ObservationView[] }).objects;
    const mapped: DeskItem[] = [];
    let invalid = false;
    for (const row of rows) {
      if (row.kind !== "present") continue;
      const item = mappedItem(row, found.binding, now);
      if (item) mapped.push(item);
      else invalid = true;
    }
    return { items: mapped, source: { id: `adapter:${redactToolText(source.adapterId)}`, ok: !invalid, ...(invalid ? { error: MAPPING_PROBLEM } : {}) } };
  }));
  for (const released of releasedSources) {
    if (!released) continue;
    for (const item of released.items) items.set(item.key, item);
    sources.push(released.source);
  }
  return { items: [...items.values()], sources };
}
