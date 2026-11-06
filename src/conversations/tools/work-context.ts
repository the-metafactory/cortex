import { z } from "zod/v4";
import { routePolicy, type Policy } from "../types";
import type { ToolDefinition, ToolSession } from "./capabilities";
import { redactToolText } from "./output";

export const WORK_KINDS = ["studio-thread", "balance-task", "balance-project", "desk-item"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const STALE_AFTER_MS = 10 * 60_000;
export const UNSUPPORTED_REASON = "The owning system exposes no read operation for this kind.";

export interface WorkObject {
  kind: WorkKind;
  id: string;
  title: string;
  status: string;
  summary: string;
  policy: Policy;
  area: string | null;
  url: string;
  observedAt: number;
}
export type WorkRead = { state: "available"; object: WorkObject } | { state: "unavailable"; reason: "gone" | "unauthorized" };
export interface WorkReader {
  search: (query: string, limit: number, offset: number) => Promise<{ items: WorkObject[]; more: boolean }>;
  read: (id: string) => Promise<WorkRead>;
  readMany?: (ids: readonly string[]) => Promise<WorkRead[]>;
}
export const readEach = (reader: WorkReader, ids: readonly string[]): Promise<WorkRead[]> =>
  reader.readMany ? reader.readMany(ids) : Promise.all(ids.map(id => reader.read(id)));
export type WorkReaders = Partial<Record<WorkKind, WorkReader>>;
export interface WorkOwner {
  readers: () => WorkReaders;
  now: () => number;
  remember: (session: ToolSession, objects: readonly WorkObject[], signal: AbortSignal) => Promise<boolean>;
}

const SearchInput = z.object({
  query: z.string().trim().max(200).default(""),
  kinds: z.array(z.enum(WORK_KINDS)).min(1).max(WORK_KINDS.length).optional(),
  offset: z.number().int().min(0).max(500).default(0),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();
const ReadInput = z.object({ kind: z.enum(WORK_KINDS), id: z.string().trim().min(1).max(512) }).strict();
const SNIPPET = 300;

export const mayRelease = (session: ToolSession, policy: Policy): boolean => policy === "cloud" || session.transport === "web" && routePolicy(session.route) === "local" && session.policy === "local";
const age = (owner: WorkOwner, object: WorkObject): "fresh" | "stale" => owner.now() - object.observedAt > STALE_AFTER_MS ? "stale" : "fresh";
const project = (owner: WorkOwner, object: WorkObject, snippetOnly: boolean) => ({
  kind: object.kind, id: object.id, title: redactToolText(object.title), status: object.status, area: object.area, url: object.url,
  observedAt: new Date(object.observedAt).toISOString(), freshness: age(owner, object),
  [snippetOnly ? "snippet" : "summary"]: redactToolText(snippetOnly ? object.summary.slice(0, SNIPPET) : object.summary),
});
const unavailable = (): string => JSON.stringify({ status: "unavailable", message: "The related work could not be released. It may have been removed, changed or denied." });

export function workContextTools(owner: WorkOwner): ToolDefinition[] {
  const search: ToolDefinition = {
    name: "work_search", operation: null, input: SearchInput,
    description: "Search or list the principal's related Studio threads, Balance tasks and projects and Desk items through their owning systems. Empty query lists. Cite url, status and observedAt; freshness stale means the snapshot is old. unavailable kinds have no owner read operation. Follow next for more. Memory and identity come from soma_context, not here. This reads only and never grants action authority.",
    run: async (raw, { session, signal }) => {
      const input = raw as z.infer<typeof SearchInput>;
      const readers = owner.readers();
      const wanted = input.kinds ?? WORK_KINDS;
      const kinds = wanted.map(kind => ({ kind, reader: readers[kind] }));
      const unsupported = kinds.filter(entry => !entry.reader).map(entry => ({ kind: entry.kind, reason: UNSUPPORTED_REASON }));
      const found: WorkObject[] = [];
      let more = false;
      for (const { kind, reader } of kinds) {
        if (!reader) continue;
        signal.throwIfAborted();
        const page = await reader.search(input.query, input.limit + 1, input.offset);
        const allowed = page.items.slice(0, input.limit).filter(object => object.kind === kind && mayRelease(session, object.policy));
        more ||= page.more || page.items.length > input.limit;
        found.push(...allowed);
      }
      const items = found.slice(0, input.limit * kinds.length);
      for (const { kind, reader } of kinds) {
        const mine = items.filter(object => object.kind === kind);
        if (!reader || !mine.length) continue;
        signal.throwIfAborted();
        const again = await readEach(reader, mine.map(object => object.id));
        const changed = mine.some((object, at) => {
          const now = again[at];
          return now?.state !== "available" || now.object.policy !== object.policy || !mayRelease(session, now.object.policy);
        });
        if (changed) return unavailable();
      }
      if (!await owner.remember(session, items, signal)) return unavailable();
      const next = more ? { offset: input.offset + input.limit } : null;
      const status = items.length ? "ok" : unsupported.length === kinds.length ? "unavailable" : "empty";
      return JSON.stringify({ status, results: items.map(object => project(owner, object, true)), unavailable: unsupported, next });
    },
  };
  const read: ToolDefinition = {
    name: "work_read", operation: null, input: ReadInput,
    description: "Read one related work object by kind and id through its owning system. status is ok, stale (old snapshot, still shown), gone (source removed), unauthorized (policy or area denies this conversation) or unavailable (owner has no read operation). Cite url and observedAt. This reads only and never grants action authority.",
    run: async (raw, { session, signal }) => {
      const input = raw as z.infer<typeof ReadInput>;
      const reader = owner.readers()[input.kind];
      if (!reader) return JSON.stringify({ status: "unavailable", kind: input.kind, message: UNSUPPORTED_REASON });
      const result = await reader.read(input.id);
      signal.throwIfAborted();
      if (result.state === "unavailable") return JSON.stringify({ status: result.reason, kind: input.kind, id: input.id, message: result.reason === "gone" ? "The source was removed." : "This conversation may not read that object." });
      if (!mayRelease(session, result.object.policy)) return JSON.stringify({ status: "unauthorized", kind: input.kind, id: input.id, message: "This conversation may not read that object." });
      const again = await reader.read(input.id);
      if (again.state !== "available" || again.object.policy !== result.object.policy || !mayRelease(session, again.object.policy)) return unavailable();
      if (!await owner.remember(session, [result.object], signal)) return unavailable();
      const view = project(owner, result.object, false);
      return JSON.stringify({ status: view.freshness === "stale" ? "stale" : "ok", object: view });
    },
  };
  return [search, read];
}
