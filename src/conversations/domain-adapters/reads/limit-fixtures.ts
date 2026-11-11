import { canonicalWire } from "../operations/validation";
import type { Json } from "../operations/types";
import { queryRig, syntheticQueryPage } from "./query-fixtures";
import { QUERY_LIMITS, type QueryRequest, type QueryResult, type QuerySource } from "./query-types";

export type QueryLimitEntry = Awaited<ReturnType<typeof queryRig>>;

export const releasedIds = (value: Json | undefined): string[] =>
  ((value as { objects: { ref: { canonicalId: string } }[] }).objects).map(object => object.ref.canonicalId);

export const releasedTotal = (sends: readonly Json[]): number =>
  sends.reduce<number>((sum, value) => sum + releasedIds(value).length, 0);

export const resumedRequest = (request: QueryRequest, continuation: string | undefined): QueryRequest => ({ ...request, continuation });

export function bulkPage(title: string): ReturnType<typeof syntheticQueryPage> {
  const page = syntheticQueryPage(["bulk"]);
  const first = (page.payload as { items: { title: string }[] }).items[0];
  if (!first) throw new Error("Synthetic bulk page is missing its item.");
  first.title = title;
  return page;
}

export function titledSources(source: QuerySource, prefix: string, count = 5): QuerySource[] {
  return Array.from({ length: count }, (_, index) => ({ ...source, input: { ...(source.input as object), title: `${prefix}-${index}` } }));
}

export interface StalledPage { readonly signal: AbortSignal; readonly pending: Promise<QueryResult>; finish(page: unknown): void }

export async function stallPage(entry: QueryLimitEntry): Promise<StalledPage> {
  const entered = Promise.withResolvers<AbortSignal>();
  const stalled = Promise.withResolvers<unknown>();
  entry.rig.hooks.query = (_request, signal) => { entered.resolve(signal); return stalled.promise; };
  const pending = entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink);
  return { signal: await entered.promise, pending, finish: page => { stalled.resolve(page); } };
}

export interface PageSizeScenario {
  readonly oversizedBytes: number;
  readonly sizedBytes: number;
  readonly refused: QueryResult;
  readonly accepted: QueryResult;
  readonly refusedSends: readonly Json[];
  readonly releasedSends: readonly Json[];
}

export async function pageSizeScenario(entry: QueryLimitEntry): Promise<PageSizeScenario> {
  const oversized = bulkPage("x".repeat(QUERY_LIMITS.pageBytes + 1024));
  entry.rig.hooks.query = () => Promise.resolve(oversized);
  const refused = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink);
  const refusedSends = [...entry.rig.calls.sends];
  const sized = bulkPage("y".repeat(QUERY_LIMITS.pageBytes - 4096));
  entry.rig.hooks.query = () => Promise.resolve(sized);
  const accepted = await entry.runner.run(entry.rig.context, await entry.runner.create(entry.rig.context, [entry.source], entry.rig.sink), entry.rig.sink);
  return {
    oversizedBytes: Buffer.byteLength(canonicalWire(oversized)),
    sizedBytes: Buffer.byteLength(canonicalWire(sized)),
    refused,
    accepted,
    refusedSends,
    releasedSends: entry.rig.calls.sends.slice(refusedSends.length),
  };
}

export interface CountedPages { readonly asked: number[]; readonly bytes: number[]; peak(): number }

export function countingConnector(entry: QueryLimitEntry): CountedPages {
  const asked: number[] = [];
  const bytes: number[] = [];
  let active = 0;
  let peak = 0;
  let pages = 0;
  entry.rig.hooks.query = async request => {
    active++;
    peak = Math.max(peak, active);
    asked.push(request.limit);
    await Bun.sleep(20);
    active--;
    const page = syntheticQueryPage(Array.from({ length: request.limit }, (_, index) => `feed-${pages}-${index}`), `feed-cursor-${pages}`);
    pages++;
    bytes.push(Buffer.byteLength(canonicalWire(page)));
    return page;
  };
  return { asked, bytes, peak: () => peak };
}
