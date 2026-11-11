import { randomUUID } from "node:crypto";
import { defineDocFamily, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { AuthorityMediator, HostContext, ReleaseProjection } from "../../authority";
import { authorityHash, type ReleaseSink } from "../../authority-records";
import type { ObjectReference } from "../types";
import type { Json } from "../operations/types";
import type { QuerySource } from "./query-types";
import { OBSERVATION_LIMITS, type ObservationBasis, type ObservationConnector, type ObservationEvent, type ObservationEvidence, type ObservationMode, type ObservationRow, type ObservationSourceState, type ObservationState, type ObservationView, type validateObservationBatch } from "./observation-types";
import type { QueryClock } from "./query";
import { DEFAULT_OBSERVATION_RETENTION } from "./observation-policy";

const ObservationDoc = defineDocFamily<{ state: JsonObject }, string>({ kind: "cortex.read-observations", version: 1, scope: "session", family: true, initial: () => ({ state: { retention: { ...DEFAULT_OBSERVATION_RETENTION }, rows: {}, evidence: [], sources: {}, oldestEvidenceAt: null } }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= OBSERVATION_LIMITS.checkpointDeltas });
const sourceKey = (source: QuerySource): string => authorityHash(source);
const detached = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
export interface ObservationCheck { status: "ok" | "denied" | "unavailable"; changed: number; quarantined: number }
export const UNAVAILABLE_CHECK: Readonly<ObservationCheck> = Object.freeze({ status: "unavailable", changed: 0, quarantined: 0 });
export const DENIED_CHECK: Readonly<ObservationCheck> = Object.freeze({ status: "denied", changed: 0, quarantined: 0 });
type Authority = Pick<AuthorityMediator, "observationHead" | "admitObservation" | "releaseObservations">;
type ValidatedObservationPage = ReturnType<typeof validateObservationBatch>;
interface ObservationPages {
  readonly batches: ValidatedObservationPage[];
  readonly cursors: Set<string>;
  readonly references: Set<string>;
  events: number;
  bytes: number;
}
const systemClock: QueryClock = { now: Date.now, setTimer(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return () => { clearTimeout(timer); }; } };

export class ObservationStore {
  private closed = false;
  private readonly inFlight = new Map<string, Promise<ObservationCheck>>();
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly authority: Authority, private readonly clock: QueryClock = systemClock, private readonly context: Context = BACKGROUND_CONTEXT) {}

  close(): void { this.closed = true; for (const controller of this.controllers) controller.abort(); }

  private async change<T>(source: QuerySource, run: (state: ObservationState) => T): Promise<T> {
    if (this.closed) throw new Error("Observation store is closed.");
    return this.engine.commit(async tx => {
      const doc = await tx.doc(ObservationDoc, authorityHash(source.connectionId), source.connectionId);
      return detached(run(doc.state as unknown as ObservationState));
    }, this.context);
  }

  private source(state: ObservationState, source: QuerySource): ObservationSourceState {
    if (!state.sources[sourceKey(source)] && Object.keys(state.sources).length >= OBSERVATION_LIMITS.objects) throw new Error("Observation source capacity exhausted.");
    return state.sources[sourceKey(source)] ??= { source: structuredClone(source), lastAttemptAt: null, lastSuccessAt: null, status: "stale", gap: false, generation: 0, checkpoint: null };
  }

  private rowsFor(state: ObservationState, source: QuerySource): ObservationRow[] {
    const key = sourceKey(source);
    return Object.values(state.rows).filter(row => row.sourceKey === key);
  }

  private recordEvidence(state: ObservationState, entry: ObservationEvidence): void {
    state.evidence.push(entry);
    state.oldestEvidenceAt = state.oldestEvidenceAt === null ? entry.at : Math.min(state.oldestEvidenceAt, entry.at);
  }

  private oldestEvidence(entries: ObservationEvidence[]): number | null {
    let oldest: number | null = null;
    for (const entry of entries) if (oldest === null || entry.at < oldest) oldest = entry.at;
    return oldest;
  }

  private markGap(state: ObservationState, source: QuerySource, unavailable = false): void {
    for (const row of this.rowsFor(state, source)) row.needsVerification = true;
    const current = this.source(state, source);
    current.gap = true;
    current.status = unavailable ? "unavailable" : "stale";
  }

  private invalidate(state: ObservationState): void {
    for (const row of Object.values(state.rows)) row.needsVerification = true;
    for (const source of Object.values(state.sources)) { source.generation++; source.checkpoint = null; source.gap = true; source.status = "stale"; }
  }

  private maintain(state: ObservationState, basis: ObservationBasis): void {
    const policy = basis.binding.observation?.retention ?? OBSERVATION_LIMITS;
    const limits = state.retention;
    for (const key of ["objects", "contentMs", "evidence", "evidenceMs"] as const) limits[key] = Math.min(limits[key], policy[key]);
    const now = this.clock.now();
    if (state.oldestEvidenceAt !== null && now - state.oldestEvidenceAt >= limits.evidenceMs) {
      const live = state.evidence.filter(entry => now - entry.at < limits.evidenceMs);
      if (live.length !== state.evidence.length) { state.evidence = live; this.invalidate(state); }
      state.oldestEvidenceAt = this.oldestEvidence(live);
    }
    if (state.evidence.length > limits.evidence) {
      while (state.evidence.length > limits.evidence) state.evidence.shift();
      state.oldestEvidenceAt = this.oldestEvidence(state.evidence);
      this.invalidate(state);
    }
    for (const [key, row] of Object.entries(state.rows)) {
      if (row.value !== undefined && now - row.lastSuccessAt >= limits.contentMs) delete row.value;
      if (row.kind === "deleted" && row.links.length === 0) { Reflect.deleteProperty(state.rows, key); this.invalidate(state); }
    }
  }

  private async basis(context: HostContext, source: QuerySource, sink: ReleaseSink): Promise<ObservationBasis | null> {
    return this.closed ? null : this.authority.observationHead(context, source, sink);
  }

  async checkpoint(context: HostContext, source: QuerySource, sink: ReleaseSink): Promise<string | undefined> {
    const basis = await this.basis(context, source, sink);
    if (!basis) return undefined;
    return this.change(source, state => {
      this.maintain(state, basis);
      const current = this.source(state, source);
      const checkpoint = current.checkpoint;
      if (!basis.binding.observation?.resumable || checkpoint?.head !== basis.head || checkpoint.generation !== current.generation || checkpoint.expiresAt <= this.clock.now()) {
        current.checkpoint = null;
        this.markGap(state, source);
        return undefined;
      }
      return checkpoint.cursor;
    });
  }

  async needsResync(context: HostContext, source: QuerySource, sink: ReleaseSink): Promise<boolean> {
    const basis = await this.basis(context, source, sink);
    if (!basis) return true;
    return this.change(source, state => { this.maintain(state, basis); return this.source(state, source).gap; });
  }

  async gap(source: QuerySource, unavailable = false): Promise<void> {
    await this.change(source, state => { this.markGap(state, source, unavailable); });
  }

  check(context: HostContext, source: QuerySource, sink: ReleaseSink, mode: ObservationMode = "poll", signal?: AbortSignal): Promise<ObservationCheck> {
    const key = sourceKey(source);
    const held = this.inFlight.get(key);
    if (held) return held.then(async result => await this.basis(context, source, sink) ? result : DENIED_CHECK);
    const pending = this.run(context, structuredClone(source), sink, mode, signal).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async run(context: HostContext, source: QuerySource, sink: ReleaseSink, mode: ObservationMode, signal?: AbortSignal): Promise<ObservationCheck> {
    const basis = await this.basis(context, source, sink);
    if (!basis) return DENIED_CHECK;
    const checkpoint = mode === "subscription" ? await this.checkpoint(context, source, sink) : undefined;
    await this.change(source, state => { this.maintain(state, basis); this.source(state, source).lastAttemptAt = this.clock.now(); });
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = this.clock.setTimer(() => { controller.abort(); }, OBSERVATION_LIMITS.fetchMs);
    try {
      const aborted = new Promise<never>((_resolve, reject) => { combined.addEventListener("abort", () => { reject(new Error("Observation fetch aborted.")); }, { once: true }); });
      if (combined.aborted) return UNAVAILABLE_CHECK;
      return await Promise.race([aborted, this.fetchPages(context, source, sink, basis, combined, mode, checkpoint)]);
    } catch (error) {
      if (!this.closed) await this.change(source, state => { this.source(state, source).status = "stale"; });
      if (error instanceof ObservationRetryAfter) throw error;
      return UNAVAILABLE_CHECK;
    } finally { timeout(); this.controllers.delete(controller); }
  }

  private async fetchPages(context: HostContext, source: QuerySource, sink: ReleaseSink, basis: ObservationBasis, signal: AbortSignal, mode: ObservationMode, checkpoint?: string): Promise<ObservationCheck> {
    const pages: ObservationPages = { batches: [], cursors: new Set(), references: new Set(), events: 0, bytes: 0 };
    let continuation: string | undefined;
    try {
      for (;;) {
        if (signal.aborted) return UNAVAILABLE_CHECK;
        const outcome = await this.authority.admitObservation(context, { source, mode, limit: Math.min(OBSERVATION_LIMITS.batchItems, OBSERVATION_LIMITS.objects - pages.events), ...(checkpoint === undefined ? {} : { checkpoint }), ...(continuation === undefined ? {} : { continuation }) }, sink, basis, signal, async (validated, current, connector) => {
          if (signal.aborted) throw new Error("Observation fetch aborted.");
          const accounted = this.accountPage(pages, validated, mode);
          if (accounted.next !== undefined) return { next: accounted.next, result: null };
          const result = await this.commitPages(source, current, pages, accounted.incomplete, mode, connector, signal);
          return { next: undefined, result };
        });
        if (outcome.kind !== "accepted" || !await this.basis(context, source, sink)) return DENIED_CHECK;
        if (outcome.value.result) return outcome.value.result;
        continuation = outcome.value.next;
      }
    } catch (error) {
      if (pages.batches.length > 0 && !this.closed) await this.gap(source);
      throw error;
    }
  }

  private accountPage(pages: ObservationPages, validated: ValidatedObservationPage, mode: ObservationMode): { next: string | undefined; incomplete: boolean } {
    pages.events += validated.events.length;
    pages.bytes += Buffer.byteLength(JSON.stringify(validated.batch));
    if (pages.events > OBSERVATION_LIMITS.objects || pages.bytes > OBSERVATION_LIMITS.bytes) throw new Error("Observation page budget exceeded.");
    for (const event of validated.events) {
      const key = authorityHash(event.ref);
      if (pages.references.has(key)) throw new Error("Observation pages repeated an object.");
      pages.references.add(key);
    }
    pages.batches.push(validated);
    const next = validated.batch.continuation;
    if (next !== undefined && (mode === "subscription" || pages.cursors.has(next))) throw new Error("Invalid observation continuation.");
    if (next !== undefined) pages.cursors.add(next);
    const bounded = next !== undefined && (pages.events >= OBSERVATION_LIMITS.objects || pages.batches.length >= Math.ceil(OBSERVATION_LIMITS.objects / OBSERVATION_LIMITS.batchItems));
    return { next: bounded ? undefined : next, incomplete: bounded || pages.batches.some(page => page.batch.gap) };
  }

  private commitPages(source: QuerySource, basis: ObservationBasis, pages: ObservationPages, incomplete: boolean, mode: ObservationMode, connector: ObservationConnector, signal: AbortSignal): Promise<ObservationCheck> {
    return this.change(source, state => {
      if (signal.aborted) throw new Error("Observation fetch aborted.");
      if (!incomplete && (pages.batches.length > 1 || mode === "reconcile" || mode === "resync")) this.source(state, source).gap = false;
      const total: ObservationCheck = { status: "ok", changed: 0, quarantined: 0 };
      for (const page of pages.batches) {
        const checked = this.apply(state, source, basis, { ...page, batch: { ...page.batch, gap: incomplete } }, mode, connector);
        if (checked.status !== "ok") total.status = checked.status;
        total.changed += checked.changed;
        total.quarantined += checked.quarantined;
      }
      return total;
    });
  }

  private apply(state: ObservationState, source: QuerySource, basis: ObservationBasis, validated: ReturnType<typeof validateObservationBatch>, mode: ObservationMode, connector: ObservationConnector): ObservationCheck {
    const now = this.clock.now();
    const rowSourceKey = sourceKey(source);
    const current = this.source(state, source);
    const generation = current.generation;
    const result: ObservationCheck = { status: "ok", changed: 0, quarantined: 0 };
    if (validated.batch.gap) { current.checkpoint = null; this.markGap(state, source); }
    const blockedReplay = mode === "subscription" && current.gap;
    for (const event of validated.events) {
      const key = authorityHash(event.ref);
      const held = state.rows[key];
      if (held && held.identity !== basis.identity) { this.invalidate(state); result.status = "unavailable"; continue; }
      const digest = authorityHash({ kind: event.kind, ref: event.ref, destination: event.destination, schemaRef: event.schemaRef, value: event.value ?? null, revision: event.revision ?? null });
      const evidenceKey = event.evidenceId ? authorityHash([source.adapterId, source.connectionId, event.evidenceId]) : held?.digest === digest ? undefined : randomUUID();
      const evidence = evidenceKey ? state.evidence.find(entry => entry.key === evidenceKey) : undefined;
      if (evidence && mode !== "reconcile" && mode !== "resync" || evidence?.quarantined || evidence && evidence.digest !== digest) {
        if (evidence.digest !== digest) {
          evidence.quarantined = true;
          const prior = state.rows[evidence.objectKey];
          if (prior) prior.conflicted = true;
          if (held) held.conflicted = true;
          const conflictKey = authorityHash([evidence.key, digest]);
          if (!state.evidence.some(entry => entry.key === conflictKey)) this.recordEvidence(state, { key: conflictKey, objectKey: evidence.objectKey, digest, at: now, quarantined: true });
          current.status = "conflicted";
          result.quarantined++;
          this.invalidate(state);
        } else if (!blockedReplay && !evidence.quarantined && held?.digest === digest && !held.conflicted) {
          held.lastSuccessAt = now;
          if (event.kind === "present") held.value = event.value;
        }
        continue;
      }
      if (evidenceKey && !evidence) this.recordEvidence(state, { key: evidenceKey, objectKey: key, digest, at: now, quarantined: false });
      if (blockedReplay) continue;
      const relation = this.relation(held, event, digest, connector);
      if (relation === "older") continue;
      const boundedRead = mode === "reconcile" || mode === "resync";
      if (held && relation === "incomparable" && !boundedRead && event.kind !== "deleted") { held.conflicted = true; current.status = "conflicted"; continue; }
      if (held?.kind === "deleted" && event.kind === "present" && !boundedRead) continue;
      const limit = state.retention.objects;
      if (!held && Object.keys(state.rows).length >= limit) {
        const oldest = Object.entries(state.rows).filter(([, row]) => row.links.length === 0).sort(([, a], [, b]) => a.lastSuccessAt - b.lastSuccessAt)[0];
        if (!oldest) { result.status = "unavailable"; this.invalidate(state); continue; }
        Reflect.deleteProperty(state.rows, oldest[0]);
        this.invalidate(state);
      }
      const unchanged = held?.digest === digest;
      const row: ObservationRow = { ref: event.ref, schemaRef: event.schemaRef, destination: event.destination, sourceKey: rowSourceKey, identity: basis.identity, kind: event.kind, digest, observedAt: event.observedAt, receivedAt: now, lastSuccessAt: now, conflicted: false, needsVerification: false, links: held?.links ?? [], ...(event.revision === undefined ? {} : { revision: event.revision }), ...(event.evidenceId === undefined ? {} : { evidenceId: event.evidenceId }), ...(event.kind === "present" ? { value: event.value } : {}) };
      state.rows[key] = row;
      if (!unchanged) result.changed++;
    }
    if ((mode === "resync" || mode === "reconcile") && !validated.batch.gap) current.gap = false;
    if (mode !== "subscription" || validated.batch.coverage === "watermark" && basis.binding.observation?.watermark) {
      current.lastSuccessAt = now;
      if (validated.batch.coverage === "watermark") for (const row of this.rowsFor(state, source)) if (!row.conflicted) row.lastSuccessAt = now;
    }
    current.status = this.rowsFor(state, source).some(row => row.conflicted) ? "conflicted" : current.gap ? "stale" : "fresh";
    this.maintain(state, basis);
    if (validated.batch.checkpoint && basis.binding.observation?.resumable && !current.gap && generation === current.generation && result.quarantined === 0 && result.status === "ok") current.checkpoint = { ...validated.batch.checkpoint, head: basis.head, generation: current.generation };
    return result;
  }

  private relation(existing: ObservationRow | undefined, event: ObservationEvent, digest: string, connector: ObservationConnector): "same" | "older" | "newer" | "incomparable" {
    if (!existing || existing.digest === digest) return "same";
    if (existing.revision !== undefined && event.revision !== undefined && connector.ordering) { const relation = connector.ordering.compare(event.revision, existing.revision); return relation === "same" ? "incomparable" : relation; }
    return "incomparable";
  }

  async link(source: QuerySource, ref: ObjectReference, link: string, linked = true): Promise<void> {
    await this.change(source, state => {
      const row = state.rows[authorityHash(ref)];
      if (!row) throw new Error("Observation link requires an existing object.");
      row.links = [...new Set(linked ? [...row.links, link] : row.links.filter(item => item !== link))];
      if (!linked && row.kind === "deleted" && row.links.length === 0) { Reflect.deleteProperty(state.rows, authorityHash(ref)); this.invalidate(state); }
    });
  }

  async read(context: HostContext, source: QuerySource, sink: ReleaseSink, history = false): Promise<ReleaseProjection<Json>> {
    const basis = await this.basis(context, source, sink);
    if (!basis) return { kind: "withheld", reason: { code: "observation_denied", message: "The requested observations are unavailable." }, recovery: "reauthorize" };
    return this.authority.releaseObservations(context, source, sink, () => this.change(source, state => {
      this.maintain(state, basis);
      const current = this.source(state, source);
      const staleMs = basis.binding.observation?.staleMs ?? OBSERVATION_LIMITS.staleMs;
      const counts = new Map<string, { evidenceCount: number; quarantinedEvidence: number }>();
      for (const entry of state.evidence) {
        const count = counts.get(entry.objectKey) ?? { evidenceCount: 0, quarantinedEvidence: 0 };
        if (entry.quarantined) count.quarantinedEvidence++;
        else count.evidenceCount++;
        counts.set(entry.objectKey, count);
      }
      return this.rowsFor(state, source).filter(row => row.kind === "deleted" ? history : row.value !== undefined).map(row => {
        const status = row.conflicted ? "conflicted" : current.status === "unavailable" ? "unavailable" : current.gap || row.needsVerification || current.status === "stale" || this.clock.now() - row.lastSuccessAt >= staleMs ? "stale" : "fresh";
        const evidence = counts.get(authorityHash(row.ref)) ?? { evidenceCount: 0, quarantinedEvidence: 0 };
        const view: ObservationView = { receivedAt: row.receivedAt, ...(row.revision === undefined ? {} : { revision: row.revision }), ...evidence, ref: row.ref, kind: row.kind, ...(row.kind === "present" ? { value: row.value } : {}), ...(row.evidenceId === undefined ? {} : { evidenceId: row.evidenceId }), observedAt: row.observedAt, lastSuccessAt: row.lastSuccessAt, lastAttemptAt: current.lastAttemptAt, status };
        return { row, view, expiresAt: row.lastSuccessAt + state.retention.contentMs };
      });
    }), () => this.clock.now());
  }
}

export class ObservationRetryAfter extends Error { constructor(readonly retryAfterMs: number) { super("Observation provider requested backoff."); } }
