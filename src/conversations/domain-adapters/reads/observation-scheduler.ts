import type { HostContext } from "../../authority";
import type { ReleaseSink } from "../../authority-records";
import type { QuerySource } from "./query-types";
import type { QueryClock } from "./query";
import { OBSERVATION_LIMITS } from "./observation-types";
import { ObservationRetryAfter, type ObservationCheck, type ObservationStore } from "./observations";
import { authorityHash } from "../../authority-records";

export interface ObservationSchedule { context: HostContext; source: QuerySource; sink: ReleaseSink; mode: "poll" | "subscription"; intervalMs?: number; boundedResync?: boolean }
interface Scheduled { config: ObservationSchedule; cancel?: () => void; controller: AbortController; failures: number; retryAfterMs: number; busy?: Promise<ObservationCheck> }
const BACKOFF = [1000, 5000, 30000] as const;
export class ObservationScheduler {
  private readonly schedules = new Map<string, Scheduled>();
  private closed = false;
  constructor(private readonly store: ObservationStore, private readonly clock: QueryClock) {}

  configure(config: ObservationSchedule): void {
    if (this.closed) throw new Error("Observation scheduler is closed.");
    if (config.intervalMs !== undefined && (!Number.isFinite(config.intervalMs) || config.intervalMs < OBSERVATION_LIMITS.minimumIntervalMs)) throw new Error("Observation interval is below the host minimum.");
    const key = authorityHash(config.source.connectionId);
    this.disable(config.source.connectionId);
    const scheduled: Scheduled = { config: { ...config, source: structuredClone(config.source) }, controller: new AbortController(), failures: 0, retryAfterMs: 0 };
    this.schedules.set(key, scheduled);
    this.arm(scheduled, config.intervalMs ?? OBSERVATION_LIMITS.intervalMs);
  }

  disable(connectionId: string): void {
    const key = authorityHash(connectionId);
    const scheduled = this.schedules.get(key);
    if (scheduled) { scheduled.cancel?.(); scheduled.controller.abort(); this.schedules.delete(key); }
  }

  close(): void { this.closed = true; for (const scheduled of this.schedules.values()) this.disable(scheduled.config.source.connectionId); }

  private active(scheduled: Scheduled): boolean { return !this.closed && !scheduled.controller.signal.aborted; }
  private arm(scheduled: Scheduled, delay: number): void {
    if (!this.active(scheduled)) return;
    scheduled.cancel?.();
    scheduled.cancel = this.clock.setTimer(() => { void this.tick(scheduled).catch((error: unknown) => { console.error("Observation scheduler failed:", error); }); }, delay);
  }

  refresh(connectionId: string): Promise<ObservationCheck> {
    const scheduled = this.schedules.get(authorityHash(connectionId));
    if (!scheduled) return Promise.resolve({ status: "unavailable", changed: 0, quarantined: 0 });
    return this.tick(scheduled);
  }

  private tick(scheduled: Scheduled): Promise<ObservationCheck> {
    if (scheduled.busy) return scheduled.busy;
    scheduled.cancel?.();
    const pending = this.run(scheduled).finally(() => { delete scheduled.busy; });
    scheduled.busy = pending;
    return pending;
  }

  private async run(scheduled: Scheduled): Promise<ObservationCheck> {
    const { config } = scheduled;
    const unavailable: ObservationCheck = { status: "unavailable", changed: 0, quarantined: 0 };
    if (!this.active(scheduled)) return unavailable;
    let result: ObservationCheck;
    try {
      const checkpoint = config.mode === "subscription" ? await this.store.checkpoint(config.context, config.source, config.sink) : undefined;
      if (config.mode === "subscription" && (checkpoint === undefined || config.boundedResync && await this.store.needsResync(config.context, config.source, config.sink))) {
        await this.store.gap(config.source);
        if (!config.boundedResync) { await this.store.gap(config.source, true); return unavailable; }
        const resync = await this.store.check(config.context, config.source, config.sink, "resync", scheduled.controller.signal);
        if (resync.status !== "ok") { this.arm(scheduled, config.intervalMs ?? OBSERVATION_LIMITS.intervalMs); return resync; }
      }
      result = await this.store.check(config.context, config.source, config.sink, config.mode, scheduled.controller.signal);
    } catch (error) {
      if (!(error instanceof ObservationRetryAfter)) throw error;
      scheduled.retryAfterMs = Math.max(0, error.retryAfterMs);
      result = unavailable;
    }
    if (!this.active(scheduled)) return unavailable;
    if (result.status === "ok") {
      scheduled.failures = 0;
      scheduled.retryAfterMs = 0;
      this.arm(scheduled, config.intervalMs ?? OBSERVATION_LIMITS.intervalMs);
    } else if (config.mode === "subscription") {
      await this.store.gap(config.source);
      const delay = BACKOFF[scheduled.failures++];
      if (delay === undefined) {
        await this.store.gap(config.source, true);
        if (config.boundedResync) this.arm(scheduled, Math.max(scheduled.retryAfterMs, config.intervalMs ?? OBSERVATION_LIMITS.intervalMs));
      } else this.arm(scheduled, Math.max(delay, scheduled.retryAfterMs));
    } else {
      const delay = BACKOFF[Math.min(scheduled.failures++, BACKOFF.length - 1)] ?? 30000;
      this.arm(scheduled, Math.max(delay, scheduled.retryAfterMs, config.intervalMs ?? OBSERVATION_LIMITS.intervalMs));
    }
    return result;
  }
}
