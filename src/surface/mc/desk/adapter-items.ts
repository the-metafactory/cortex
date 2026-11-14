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
import { ADAPTER_CAPABILITY_ACTION } from "./adapter-actions";
import { STUDIO_OWNER_KIND } from "../../../common/desk-owner";

export interface AdapterAttention {
  enabled: boolean;
  store: ObservationStore;
  bindings: Pick<ReadBindings, "lookup">;
  context: HostContext;
  sink: ReleaseSink;
  sources: readonly QuerySource[];
  ownerKinds?: ReadonlySet<string>;
}

const text = z.string().trim().min(1).max(4000).transform(redactToolText);
const badge = z.string().trim().min(1).max(80).nullable().transform(value => value === null ? null : redactToolText(value));
const owner = z.enum([STUDIO_OWNER_KIND]).nullable();
const dueDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable();
const link = z.url({ protocol: /^https?$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && redactToolText(value) === value;
}).nullable();
const area = ObjectReferenceSchema.nullable();
const MAX_ADAPTER_RANK = 999;
const adapterRank = z.int().min(0).max(MAX_ADAPTER_RANK).nullable();
const interruptRequest = z.boolean().nullable();
const MAPPING_PROBLEM = "An adapter attention mapping could not be displayed safely.";
const INCOMPLETE_OBSERVATIONS = "Adapter observations are incomplete. Some items may be missing.";

function rankWithin(base: Pick<DeskItem, "urgency" | "score">, rank: number | null): Pick<DeskItem, "urgency" | "score"> {
  return rank === null ? base : { urgency: base.urgency, score: base.score - rank / (MAX_ADAPTER_RANK + 1) };
}

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
  return (binding.capabilities ?? []).map(capability => ({ id: `${ADAPTER_CAPABILITY_ACTION}${capability.capabilityId}`, label: redactToolText(capability.label), role: "secondary" as const, wired: true, target: capability.capabilityId }));
}

function mappedItem(row: ObservationView, binding: ReadBinding, now: number, ownerKinds?: ReadonlySet<string>): MappedRow {
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
  const ownRank = adapterRank.safeParse(binding.attention.rank ? (readPointer(value, binding.attention.rank) ?? null) : null);
  const wantsInterrupt = interruptRequest.safeParse(binding.attention.interrupt ? (readPointer(value, binding.attention.interrupt) ?? null) : null);
  if (!ownRank.success || !wantsInterrupt.success) return { kind: "invalid" };
  if (!title.success || !why.success || !rowBadge.success || !markedOwner.success || !due.success || !destination.success || !url.success) return { kind: "invalid" };
  if (markedOwner.data !== null && !ownerKinds?.has(markedOwner.data)) return { kind: "invalid" };
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
      ...rankWithin(hostRank(due.data, now), ownRank.data), ...(wantsInterrupt.data === true ? { interruptRequested: true } : {}), actions: rowCapabilityActions(binding, markedOwner.data),
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

export type AdapterAttentionInput = AdapterAttention | AdapterAttentionAccess | readonly (AdapterAttention | AdapterAttentionAccess)[];

export function mergeAdapterRows(parts: readonly AdapterRows[]): AdapterRows {
  const items = new Map<string, DeskItem>();
  const owners = new Map<string, string>();
  const sources: DeskView["sources"] = [];
  for (const part of parts) {
    for (const item of part.items) items.set(item.key, item);
    for (const [key, owner] of part.owners) owners.set(key, owner);
    sources.push(...part.sources);
  }
  return { items: [...items.values()], owners, sources };
}

export async function readAdapterAttention(access: AdapterAttentionInput | undefined, now: number): Promise<AdapterRows> {
  if (access === undefined) return mergeAdapterRows([]);
  const entries: readonly (AdapterAttention | AdapterAttentionAccess)[] = typeof access === "function" || "store" in access ? [access] : access;
  const parts: AdapterRows[] = [];
  for (const entry of entries) {
    if (typeof entry !== "function") { parts.push(await adapterItems(entry, now)); continue; }
    const session = await entry();
    if (!session) continue;
    try { parts.push(await adapterItems(session.feature, now)); }
    finally { session.close(); }
  }
  return mergeAdapterRows(parts);
}

export async function adapterItems(feature: AdapterAttention | undefined, now: number): Promise<AdapterRows> {
  if (!feature?.enabled) return mergeAdapterRows([]);
  const releasedSources = await Promise.all(feature.sources.map(async source => {
    const found = feature.bindings.lookup(source.adapterId, source.connectionId, source.capabilityId);
    if (found.state !== "available" || !found.binding.attention) return null;
    const released = await feature.store.read(feature.context, source, feature.sink);
    if (released.kind !== "released") return null;
    const incomplete = await feature.store.needsResync(feature.context, source, feature.sink);
    const rows = (released.value as unknown as { objects: ObservationView[] }).objects;
    const mapped: DeskItem[] = [];
    const marked: [string, string][] = [];
    let invalid = false;
    for (const row of rows) {
      if (row.kind !== "present") continue;
      const result = mappedItem(row, found.binding, now, feature.ownerKinds);
      if (result.kind === "invalid") invalid = true;
      if (result.kind !== "item") continue;
      mapped.push(result.item);
      if (result.owner !== null) marked.push([result.item.key, result.owner]);
    }
    const error = invalid ? MAPPING_PROBLEM : incomplete ? INCOMPLETE_OBSERVATIONS : undefined;
    return { items: mapped, owners: marked, source: { id: `adapter:${redactToolText(source.adapterId)}`, ok: error === undefined, ...(error === undefined ? {} : { error }) } };
  }));
  return mergeAdapterRows(releasedSources.flatMap(released => released ? [{ items: released.items, owners: new Map(released.owners), sources: [released.source] }] : []));
}
