import { randomUUID } from "node:crypto";
import type { AuthorityMediator, HostContext } from "../../authority";
import type { ReleaseSink } from "../../authority-records";
import { authorityHash } from "../../authority-records";
import { canonicalSchema } from "../schema-validation";
import { QueryRequestSchema, QUERY_LIMITS, queryError, type QueryGroup, type QueryRequest, type QueryResult, type QuerySource } from "./query-types";
import { QueryStore } from "./query-store";

export interface QueryClock { now(): number; setTimer(callback: () => void, ms: number, background?: boolean): () => void }
const systemClock: QueryClock = { now: Date.now, setTimer: (callback, ms, background) => { const timer = setTimeout(callback, ms); if (background) timer.unref(); return () => { clearTimeout(timer); }; } };
interface Invocation { started: number; used: number; reserved: number; active: number }
declare const invocationBrand: unique symbol;
export interface QueryInvocation { readonly [invocationBrand]: true }
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  let removeAbort = () => undefined;
  const abort = new Promise<null>(resolve => {
    const done = () => { resolve(null); };
    signal.addEventListener("abort", done, { once: true });
    removeAbort = () => { signal.removeEventListener("abort", done); return undefined; };
    if (signal.aborted) done();
  });
  try { return await Promise.race([work, abort]); }
  finally { removeAbort(); }
}
const sourceIdentity = ({ adapterId, connectionId, capabilityId }: QuerySource) => ({ adapterId, connectionId, capabilityId });
const restart = (queryId: string): QueryResult => ({ readVersion: "1.0.0", queryId, status: "unavailable", groups: [], restricted: false, noMatch: false, restartRequired: true, reason: queryError("restart_required") });

export class QueryRunner {
  private readonly invocations = new WeakMap<QueryInvocation, Invocation>();
  private readonly active = new Map<string, AbortController>();
  private maintenanceTimer: (() => void) | undefined;
  private closed = false;
  constructor(private readonly authority: Pick<AuthorityMediator, "queryHead" | "admitQueryPage">, private readonly store: QueryStore, private readonly clock: QueryClock = systemClock) {}

  private isClosed(): boolean { return this.closed; }

  close(): void { this.closed = true; this.maintenanceTimer?.(); for (const controller of this.active.values()) controller.abort(); }

  private async maintain(): Promise<void> {
    if (this.closed) return;
    this.maintenanceTimer?.();
    const next = await this.store.change(queries => Math.min(...Object.values(queries).map(query => query.expiresAt)));
    this.maintenanceTimer?.();
    if (!this.isClosed() && Number.isFinite(next)) this.maintenanceTimer = this.clock.setTimer(() => {
      void this.maintain().catch(() => { console.error("Query continuation expiry maintenance failed."); });
    }, Math.max(1, next - this.clock.now()), true);
  }

  invocation(): QueryInvocation {
    const handle = Object.freeze({}) as QueryInvocation;
    this.invocations.set(handle, { started: this.clock.now(), used: 0, reserved: 0, active: 0 });
    return handle;
  }

  async create(context: HostContext, sources: QuerySource[], sink: ReleaseSink): Promise<QueryRequest> {
    const request = QueryRequestSchema.parse({ readVersion: "1.0.0", queryId: randomUUID(), sources });
    canonicalSchema(request);
    if (new Set(sources.map(source => authorityHash(source))).size !== sources.length) throw new Error("Duplicate query source.");
    const heads = await Promise.all(request.sources.map(source => this.authority.queryHead(context, source, sink)));
    await this.store.create(request, heads.map(head => head?.head ?? null));
    await this.maintain();
    return request;
  }

  async cancel(queryId: string): Promise<QueryResult> {
    this.active.get(queryId)?.abort();
    await this.store.change(queries => { const query = queries[queryId]; if (query) { query.cancelled = true; query.token = null; for (const state of query.states) delete state.cursor; } });
    return { readVersion: "1.0.0", queryId, status: "cancelled", groups: [], restricted: false, noMatch: false };
  }

  async run(context: HostContext, raw: unknown, sink: ReleaseSink, invocation: QueryInvocation = this.invocation(), signal?: AbortSignal): Promise<QueryResult> {
    let request: QueryRequest;
    try { canonicalSchema(raw); request = QueryRequestSchema.parse(raw); }
    catch { return restart(""); }
    const budget = this.invocations.get(invocation);
    if (!budget || this.closed || this.active.has(request.queryId)) return restart(request.queryId);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.active.set(request.queryId, controller);
    const query = await this.store.change(queries => {
      const held = queries[request.queryId];
      const { continuation: _continuation, ...base } = request;
      if (held && !held.busy && held.token === request.continuation && authorityHash(base) !== authorityHash(held.request)) { held.cancelled = true; held.token = null; for (const state of held.states) delete state.cursor; return null; }
      if (!held || held.cancelled || held.busy || authorityHash(base) !== authorityHash(held.request) || held.started && held.token !== request.continuation || !held.started && request.continuation !== undefined) return null;
      held.busy = true;
      held.started = true;
      held.token = null;
      return held;
    });
    if (!query) { this.active.delete(request.queryId); return restart(request.queryId); }
    const groups: (QueryGroup | undefined)[] = [];
    const progress = { failed: false, restricted: query.states.some(state => state.head === null) };
    const stopped = () => combined.aborted || this.clock.now() - budget.started >= QUERY_LIMITS.invocationMs;
    const deadline = { timedOut: false };
    const remainingMs = QUERY_LIMITS.invocationMs - (this.clock.now() - budget.started);
    const clearDeadline = remainingMs > 0 ? this.clock.setTimer(() => { deadline.timedOut = true; controller.abort(); }, remainingMs) : () => undefined;
    if (remainingMs <= 0) { deadline.timedOut = true; controller.abort(); }
    try {
      await this.maintain();
      const heads = await untilAbort(Promise.all(request.sources.map(source => this.authority.queryHead(context, source, sink))), combined);
      if (!heads) { await this.cancel(request.queryId); return { readVersion: "1.0.0", queryId: request.queryId, status: deadline.timedOut ? "partial" : "cancelled", groups: deadline.timedOut ? request.sources.flatMap((source, index) => query.states[index]?.head ? [{ source: sourceIdentity(source), status: "not-attempted" as const, coverage: "budget-exhausted" as const, reason: queryError("budget_exhausted") }] : []) : [], restricted: progress.restricted, noMatch: false, ...(deadline.timedOut ? { reason: queryError("deadline_exceeded"), restartRequired: true as const } : {}) }; }
      if (heads.some((head, index) => (head?.head ?? null) !== query.states[index]?.head)) return await this.invalidate(request.queryId);
      let next = 0;
      const worker = async () => {
        while (next < request.sources.length) {
          const index = next++;
          const source = request.sources[index];
          const state = query.states[index];
          if (!source || !state) throw new Error("Query source state is incomplete.");
          const current = heads[index];
          if (!current || state.head === null) continue;
          if (!current.binding) { groups[index] = { source: sourceIdentity(source), status: "unsupported", coverage: "incomplete", reason: queryError("unsupported") }; progress.failed = true; continue; }
          if (state.exhausted) { groups[index] = { source: sourceIdentity(source), status: "ok", coverage: "exhausted" }; continue; }
          const group: QueryGroup = { source: sourceIdentity(source), status: "not-attempted", coverage: "budget-exhausted", reason: queryError("budget_exhausted") };
          groups[index] = group;
          const limit = Math.min(current.binding.query?.limits?.items ?? QUERY_LIMITS.pageItems, QUERY_LIMITS.items - budget.used - budget.reserved);
          if (stopped() || limit <= 0 || budget.active >= QUERY_LIMITS.concurrent) continue;
          budget.reserved += limit;
          budget.active++;
          const pageController = new AbortController();
          const pageSignal = AbortSignal.any([combined, pageController.signal]);
          const waitMs = Math.min(current.binding.query?.limits?.pageMs ?? QUERY_LIMITS.pageMs, QUERY_LIMITS.invocationMs - (this.clock.now() - budget.started));
          const clearTimer = this.clock.setTimer(() => { pageController.abort(); }, waitMs);
          let charge = limit;
          try {
            const outcome = await untilAbort(this.authority.admitQueryPage(context, { queryId: request.queryId, source, head: state.head, limit, seen: state.seen, ...(state.cursor === undefined ? {} : { cursor: state.cursor }), ...(state.snapshotId === undefined ? {} : { snapshotId: state.snapshotId }) }, sink, pageSignal), pageSignal);
            if (combined.aborted && !deadline.timedOut) { group.status = "cancelled"; group.coverage = "incomplete"; continue; }
            if (!outcome || pageSignal.aborted || stopped()) { group.status = "partial"; group.coverage = "incomplete"; group.reason = queryError("deadline_exceeded"); progress.failed = true; continue; }
            if (outcome.projection.kind !== "released" || !outcome.protectedPage) {
              if (!outcome.failure) { progress.restricted = true; progress.failed = true; groups[index] = undefined; continue; }
              group.status = "unavailable"; group.coverage = "incomplete"; group.reason = queryError("source_unavailable"); progress.failed = true; continue;
            }
            const { protectedPage } = outcome;
            charge = protectedPage.itemCount;
            state.seen = protectedPage.seen;
            state.position++;
            state.cursor = protectedPage.page.cursor;
            state.snapshotId = protectedPage.page.snapshot.kind === "stable" ? protectedPage.page.snapshot.id : undefined;
            state.exhausted = state.cursor === undefined;
            state.incomplete ||= protectedPage.page.snapshot.kind === "live";
            group.status = "ok";
            group.coverage = state.exhausted ? "exhausted" : "more";
            delete group.reason;
          } finally { clearTimer(); budget.reserved -= limit; budget.used += charge; budget.active--; }
        }
      };
      await Promise.all([worker(), worker()]);
      const cancelled = combined.aborted && !deadline.timedOut;
      const token = await this.store.change(queries => {
        const held = queries[request.queryId];
          if (!held || held.cancelled || cancelled) { if (held) { held.cancelled = true; held.busy = false; held.token = null; } return null; }
        held.busy = false;
        held.states = query.states;
        held.token = !progress.failed && held.states.some(state => state.head !== null && !state.exhausted) ? randomUUID() : null;
        return held.token;
      });
      const restricted = progress.restricted;
      const visible = groups.filter(group => group !== undefined);
      const incomplete = progress.failed || restricted || query.states.some(state => !state.exhausted || state.incomplete);
      const noMatch = !cancelled && !incomplete && token === null && query.states.every(state => Object.keys(state.seen).length === 0);
      return { readVersion: "1.0.0", queryId: request.queryId, status: cancelled ? "cancelled" : restricted && visible.length === 0 ? "denied" : visible.length > 0 && visible.every(group => group.status === "unsupported") ? "unsupported" : visible.length > 0 && visible.every(group => group.status === "unavailable") ? "unavailable" : incomplete ? "partial" : "ok", groups: visible, restricted, noMatch, ...(token ? { continuation: token } : {}), ...(progress.failed ? { restartRequired: true as const } : {}) };
    } catch { await this.cancel(request.queryId); return restart(request.queryId); }
    finally {
      clearDeadline();
      this.active.delete(request.queryId);
    }
  }

  private async invalidate(queryId: string): Promise<QueryResult> { await this.cancel(queryId); return restart(queryId); }
}
