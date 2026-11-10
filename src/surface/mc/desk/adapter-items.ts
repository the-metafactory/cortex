import { z } from "zod";
import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { ReadBindings } from "../../../conversations/domain-adapters/reads/bindings";
import type { ObservationStore } from "../../../conversations/domain-adapters/reads/observations";
import type { ObservationView } from "../../../conversations/domain-adapters/reads/observation-types";
import type { QuerySource } from "../../../conversations/domain-adapters/reads/query-types";
import { readPointer } from "../../../conversations/domain-adapters/reads/query-validation";
import type { ReadBinding } from "../../../conversations/domain-adapters/reads/types";
import { ObjectReferenceSchema, type ObjectReference } from "../../../conversations/domain-adapters/types";
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
const badge = z.string().trim().min(1).max(80).nullable().transform(value => value === null ? null : redactToolText(value));
const owner = z.string().trim().min(1).max(80).nullable().transform(value => value === null ? null : redactToolText(value));
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

type MappedRow = { kind: "item"; item: DeskItem; owner: string | null } | { kind: "unmapped" } | { kind: "invalid" };

function rowCapabilityActions(binding: ReadBinding, owner: string | null): DeskItem["actions"] {
  if (owner !== null) return [];
  return (binding.capabilities ?? []).map(capability => ({ id: `adapter.capability:${capability.capabilityId}`, label: redactToolText(capability.label), role: "secondary" as const, wired: true, target: capability.capabilityId }));
}

function mappedItem(row: ObservationView, binding: ReadBinding, now: number): MappedRow {
  if (row.kind !== "present" || row.value === undefined || !binding.attention) return { kind: "unmapped" };
  const value = row.value;
  const rawWhy = readPointer(value, binding.attention.pointer);
  if (rawWhy === null) return { kind: "unmapped" };
  const title = text.safeParse(readPointer(value, binding.display.title));
  const why = text.safeParse(rawWhy);
  const rowBadge = badge.safeParse(binding.attention.badge ? readPointer(value, binding.attention.badge) : null);
  const markedOwner = owner.safeParse(binding.attention.owner ? readPointer(value, binding.attention.owner) : null);
  const due = dueDate.safeParse(binding.display.due ? readPointer(value, binding.display.due) : null);
  const destination = area.safeParse(binding.display.area ? readPointer(value, binding.display.area) : null);
  const url = link.safeParse(binding.display.url ? readPointer(value, binding.display.url) : null);
  if (!title.success || !why.success || !rowBadge.success || !markedOwner.success || !due.success || !destination.success || !url.success) return { kind: "invalid" };
  const key = `adapter:${canonicalWire(row.ref)}`;
  const status = row.status;
  return {
    kind: "item", owner: markedOwner.data,
    item: {
      key, kind: "adapter", source: redactToolText(binding.adapterId),
      title: title.data, why: why.data,
      area: destination.data ? redactToolText(destination.data.canonicalId) : null,
      ...(destination.data ? { destination: destination.data } : {}),
      ...(rowBadge.data === null ? {} : { badge: rowBadge.data }),
      ...(due.data === null ? {} : { dueAt: due.data }),
      ...hostRank(due.data, now), actions: rowCapabilityActions(binding, markedOwner.data),
      freshness: status, readOnly: true,
      detail: {
        summary: why.data,
        history: [`${freshnessLabel(status) ?? "Observed"}: last success ${new Date(row.lastSuccessAt).toISOString()}; last attempt ${row.lastAttemptAt === null ? "unavailable" : new Date(row.lastAttemptAt).toISOString()}.`],
        refs: [key], links: url.data === null ? [] : [{ label: "Open source", url: url.data }],
      },
    },
  };
}

export function adapterRowRef(key: string): ObjectReference | null {
  if (!key.startsWith("adapter:")) return null;
  try {
    const parsed = ObjectReferenceSchema.safeParse(JSON.parse(key.slice("adapter:".length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface AdapterAttentionSession { feature: AdapterAttention; close(): void }
export type AdapterAttentionAccess = () => Promise<AdapterAttentionSession | null>;

export interface AdapterRows { items: DeskItem[]; owners: ReadonlyMap<string, string>; sources: DeskView["sources"] }

export async function adapterItems(feature: AdapterAttention | undefined, now: number): Promise<AdapterRows> {
  const items = new Map<string, DeskItem>();
  const owners = new Map<string, string>();
  const sources: DeskView["sources"] = [];
  if (!feature?.enabled) return { items: [], owners, sources };
  const releasedSources = await Promise.all(feature.sources.map(async source => {
    const found = feature.bindings.lookup(source.adapterId, source.connectionId, source.capabilityId);
    if (found.state !== "available" || !found.binding.attention) return null;
    const released = await feature.store.read(feature.context, source, feature.sink);
    if (released.kind !== "released") return null;
    const rows = (released.value as unknown as { objects: ObservationView[] }).objects;
    const mapped: DeskItem[] = [];
    const marked: [string, string][] = [];
    let invalid = false;
    for (const row of rows) {
      if (row.kind !== "present") continue;
      const result = mappedItem(row, found.binding, now);
      if (result.kind === "invalid") invalid = true;
      if (result.kind !== "item") continue;
      mapped.push(result.item);
      if (result.owner !== null) marked.push([result.item.key, result.owner]);
    }
    return { items: mapped, owners: marked, source: { id: `adapter:${redactToolText(source.adapterId)}`, ok: !invalid, ...(invalid ? { error: MAPPING_PROBLEM } : {}) } };
  }));
  for (const released of releasedSources) {
    if (!released) continue;
    for (const item of released.items) items.set(item.key, item);
    for (const [key, owner] of released.owners) owners.set(key, owner);
    sources.push(released.source);
  }
  return { items: [...items.values()], owners, sources };
}
