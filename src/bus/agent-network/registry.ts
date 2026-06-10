/**
 * G-1114.B.3 — stack-local runtime agent-presence registry (subscriber).
 * G-1114.C.3 — + liveness FSM / 5-min TTL reaper (this module's reaper methods).
 *
 * The consumer half of the Phase B end-to-end wiring. It subscribes to the
 * stack's own `local.{principal}.{stack}.agent.>` subtree (STACK-LOCAL ONLY —
 * NO `federated.` namespace yet; that is Phase E / G-1114.E) and folds the
 * inbound `agent.*` presence stream into an in-memory, observable map keyed by
 * agent identity.
 *
 * ## What it records (B.3 scope)
 *
 *   - `agent.online`               → upsert a record, `state: "online"`, store
 *                                    the initial capability set + `startedAt`.
 *   - `agent.heartbeat`            → bump `lastHeartbeatAt` (+ refresh `lastSeenAt`);
 *                                    an unknown agent is upserted as `online`
 *                                    (a heartbeat is itself a liveness signal —
 *                                    we never want a heartbeat from an agent we
 *                                    missed the `online` for to be dropped).
 *   - `agent.offline`              → mark the record `state: "offline"`, store
 *                                    the reason.
 *   - `agent.capabilities-changed` → store the latest full capability set
 *                                    (B records the LATEST set only; the full
 *                                    diff/reconcile handling is Phase C).
 *
 * ## Liveness FSM / TTL reaper (G-1114.C.3 — ADDED on top of the B.3 fold)
 *
 *   - The reaper is the OPT-IN second half of the FSM. B.3 records
 *     `lastHeartbeatAt` + the last explicit state; C.3 adds the
 *     `online`→`offline` transition when heartbeats STOP (a record going stale
 *     with no `agent.offline` envelope — there was no agent left to send one).
 *     {@link AgentPresenceRegistry.startReaper} schedules a periodic
 *     {@link AgentPresenceRegistry.reapStale} sweep; any `online` record whose
 *     last heartbeat is older than {@link PRESENCE_LIVENESS_TTL_MS} (5 min)
 *     transitions to `offline` with reason {@link TTL_LAPSE_OFFLINE_REASON} and
 *     fires `onChange` (so the WS push → panel update lands on the transition).
 *   - The reaper stays OPT-IN so a bare registry that only folds envelopes
 *     (tests, the cap-consistency harness) keeps the pure B.3 "no FSM" behaviour
 *     until `startReaper()` is called. The wired path calls it.
 *   - A graceful `agent.offline` before the TTL still wins (already handled by
 *     `applyOffline`); a heartbeat AFTER a TTL-lapse offline REVIVES the record
 *     to `online` (already handled by `applyHeartbeat`'s online upsert).
 *
 * ## Boundary — what it STILL does NOT do (deferred to later Phase C / E)
 *
 *   - **No capability diffing.** B stores the latest set; the delta/reconcile
 *     (C.2) computes it against the prior record.
 *   - **No federation.** It subscribes to `local.` only. The `federated.`
 *     subtree is Phase E.
 *
 * ## Observability seam (for B.4 + the MC API)
 *
 * The registry is queryable via {@link AgentPresenceRegistry.getAgents} (a
 * snapshot copy — callers can't mutate internal state) and exposes a
 * change-notification seam via {@link AgentPresenceRegistry.onChange} so the
 * B.4 panel (and the MC projection) can subscribe to live updates rather than
 * poll. Every applied envelope that mutates a record fires the change callbacks
 * AFTER the mutation, with the affected agent key + the new snapshot.
 *
 * ## Wiring
 *
 * `startAgentPresenceRegistry` self-subscribes via `runtime.subscribe(pattern)`
 * (the cortex#477 push-mode seam — same model the dispatch-listener uses) and
 * registers a `runtime.onEnvelope` fan-out handler that filters by subject
 * against the stack-local pattern. On `runtime.enabled === false` (no NATS) the
 * registry stays dormant but constructed — `getAgents()` returns `[]` and the
 * boot/shutdown wiring behaves identically whether or not the bus is up
 * (matching every other capability-side boot feature).
 */

import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime, EnvelopeHandler } from "../myelin/runtime";
import type { MyelinSubscriber } from "../myelin/subscriber";
import { subjectMatches } from "../surface-router";
import {
  AGENT_ONLINE_TYPE,
  AGENT_HEARTBEAT_TYPE,
  AGENT_OFFLINE_TYPE,
  AGENT_CAPABILITIES_CHANGED_TYPE,
  AgentOnlinePayloadSchema,
  AgentHeartbeatPayloadSchema,
  AgentOfflinePayloadSchema,
  AgentCapabilitiesChangedPayloadSchema,
  type AgentOfflineReason,
} from "./envelopes";

/**
 * The liveness TTL — the maximum age (epoch-ms span) a record's
 * `lastHeartbeatAt` may reach before the Phase C reaper times it out to
 * `offline`. ADR-0007 §Consequences + design §7: **5 minutes**. The presence
 * heartbeat fires every 60s (`DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS`), so a
 * 5-minute window tolerates losing 4 consecutive beats before declaring an
 * agent stale (the 5th missed beat trips the reaper).
 */
export const PRESENCE_LIVENESS_TTL_MS = 5 * 60_000;

/**
 * Default reaper tick cadence (epoch-ms). The reaper sweeps for stale records
 * on this interval; it is independent of (and finer than) the TTL so a lapse is
 * detected within ~one tick of crossing the 5-minute line rather than only on
 * the next inbound envelope. 30s gives ≤30s detection latency on a 5-min TTL.
 * Injectable via {@link AgentPresenceRegistryOptions.scheduler} for tests.
 */
export const DEFAULT_PRESENCE_REAPER_INTERVAL_MS = 30_000;

/**
 * Reason an agent is `offline`. A SUPERSET of the on-the-wire
 * {@link AgentOfflineReason} (`shutdown`/`restart`/`error`, all carried by an
 * explicit `agent.offline` envelope) plus the subscriber-INFERRED `ttl_lapse` —
 * the record went stale because heartbeats STOPPED, with no `agent.offline`
 * envelope (there was no agent left to send one). The distinct value lets the
 * panel (Phase C.4 / D) render a timed-out agent differently from a gracefully
 * shut-down one. `ttl_lapse` never rides the wire — it is only ever stamped by
 * the reaper here.
 */
export type PresenceOfflineReason = AgentOfflineReason | "ttl_lapse";

/**
 * G-1114.E.2 — provenance of a {@link AgentPresenceRecord}. `"local"` for the
 * stack's own agents (the B.3 path); a `foreign` struct carrying the peer's
 * `{principal}/{stack}` for a trust-verified federated peer agent (the E.2
 * path). The view groups + styles foreign agents by this; a downstream consumer
 * distinguishes "my agent" from "someone else's agent" without re-parsing the
 * envelope source.
 */
export type AgentRecordOrigin =
  | "local"
  | { kind: "foreign"; principal: string; stack: string };

/**
 * True when a record came from a federated peer (not this stack). A thin
 * type-guard so view code reads `isForeign(record.origin)` rather than
 * re-checking the discriminant shape.
 */
export function isForeignOrigin(
  origin: AgentRecordOrigin,
): origin is { kind: "foreign"; principal: string; stack: string } {
  return origin !== "local";
}

/**
 * The {@link PresenceOfflineReason} the reaper stamps on a TTL-lapse offline.
 * Exported so downstream renderers (and tests) compare against the constant
 * rather than re-typing the literal.
 */
export const TTL_LAPSE_OFFLINE_REASON = "ttl_lapse" as const;

/**
 * The observable presence state for one agent. Keyed in the registry by
 * {@link AgentPresenceRecord.key} (`{principal}/{stack}/{agent_id}` — see
 * {@link recordKey}).
 *
 * `state` is `online` after `agent.online` / `agent.heartbeat`, and `offline`
 * after either an explicit `agent.offline` envelope OR a Phase C TTL lapse
 * (heartbeats stopped for longer than {@link PRESENCE_LIVENESS_TTL_MS}). The
 * two offline paths are distinguished by {@link AgentPresenceRecord.offlineReason}
 * (`ttl_lapse` = inferred; `shutdown`/`restart`/`error` = announced).
 */
export interface AgentPresenceRecord {
  /** Stable map key — `{principal}/{stack}/{agent_id}`. */
  key: string;
  /**
   * G-1114.E.2 — record PROVENANCE: where this presence came from.
   *
   *   - `"local"`   — folded from the stack's OWN `local.{principal}.{stack}.agent.*`
   *     subtree (the B.3 path). The default for every record `apply()` creates,
   *     so a bare registry that only ever sees local envelopes is byte-identical
   *     to pre-E behaviour.
   *   - `{ kind: "foreign"; principal; stack }` — folded from a TRUST-VERIFIED
   *     peer's `federated.{principal}.{stack}.agent.*` envelope (the E.2 path,
   *     via {@link AgentPresenceRegistry.applyForeign}). Carries the peer's
   *     `{principal}/{stack}` so the view (E.3) + detail-join (#909) can group
   *     foreign agents under their origin stack and render them distinctly.
   *
   * The origin (and the record's key + principal + stack) is derived from the
   * CHAIN-VERIFIED `source` of the envelope — NOT the attacker-controlled
   * `payload.scope` (PR #914 review BLOCKER fix). A foreign record's
   * `{principal}/{stack}` is the peer's VERIFIED identity, so the key space is
   * partitioned by real origin: a foreign record can never collide with /
   * overwrite a local one, and an accept-listed peer can only announce agents
   * under its OWN verified `{principal}/{stack}` (a `payload.scope` that
   * disagrees with the source is dropped as a spoof — see {@link
   * AgentPresenceRegistry.applyForeign}).
   */
  origin: AgentRecordOrigin;
  /** Logical agent id (`luna`, `echo`, …). */
  agentId: string;
  /**
   * The agent's NKey public key (stable cross-restart identity).
   *
   * For a FOREIGN record this is the PEER's declared agent key, namespaced under
   * the chain-verified `{principal}/{stack}` (which owns the map key). It is the
   * peer's own agent's key — the peer is authoritative for it within its own
   * namespace — and it can NOT be used to impersonate a LOCAL agent, because the
   * record's KEY is source-bound (`{verified-principal}/{verified-stack}/...`),
   * so a foreign nkey always lands on a foreign-keyed record, never a local one
   * (PR #914 review BLOCKER fix).
   */
  nkeyPublicKey: string;
  /** Soma-layer assistant name the agent hosts, or `null` when none. */
  assistantName: string | null;
  /** `{principal}` the agent lives in. */
  principal: string;
  /** `{stack}` the agent lives in. */
  stack: string;
  /** Latest known declared capability set. */
  capabilities: readonly string[];
  /** Last liveness state — explicit (envelope) or inferred (TTL reaper). */
  state: "online" | "offline";
  /**
   * Why the record is offline, when `state === "offline"`: an announced
   * {@link AgentOfflineReason} from the last `agent.offline`, or the
   * reaper-inferred `ttl_lapse`. Undefined while online.
   */
  offlineReason?: PresenceOfflineReason;
  /** Boot time from the last `agent.online` (ISO-8601), when known. */
  startedAt?: string;
  /**
   * Timestamp of the last `agent.heartbeat` observed (epoch ms, receiver
   * clock). Phase C's TTL reaper reads this; B only records it. Undefined
   * until the first heartbeat arrives.
   */
  lastHeartbeatAt?: number;
  /** Timestamp any presence envelope was last applied for this agent (epoch ms). */
  lastSeenAt: number;
}

/** A change callback — invoked AFTER a record mutates, with the new snapshot. */
export type AgentPresenceChangeListener = (
  key: string,
  record: AgentPresenceRecord,
) => void;

/** Unregister handle returned by {@link AgentPresenceRegistry.onChange}. */
export interface AgentPresenceChangeSubscription {
  unsubscribe(): void;
}

/**
 * Compute the stable registry key for an identity+scope pair.
 * `{principal}/{stack}/{agent_id}` — the same agent in two stacks is two
 * records; the same agent_id across restarts is one record (state converges).
 */
function recordKey(principal: string, stack: string, agentId: string): string {
  return `${principal}/${stack}/${agentId}`;
}

/**
 * Pluggable interval scheduler — the reaper schedules its sweep through this so
 * tests can drive ticks deterministically (a fake scheduler invokes the
 * callback on demand) instead of waiting real wall-clock time. Production
 * defaults to `setInterval`/`clearInterval`. Mirrors the heartbeat-ticker's
 * injectable-timer pattern.
 */
export interface PresenceReaperScheduler {
  /** Schedule `fn` every `intervalMs`; returns an opaque cancel handle. */
  setInterval(fn: () => void, intervalMs: number): unknown;
  /** Cancel a handle from {@link PresenceReaperScheduler.setInterval}. */
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: PresenceReaperScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** Optional injection points — tests pass a clock + scheduler; production omits. */
export interface AgentPresenceRegistryOptions {
  /** Receiver clock for `lastHeartbeatAt` / `lastSeenAt` + TTL math. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Liveness TTL in epoch-ms — a record whose `lastHeartbeatAt` is older than
   * `now() - ttlMs` is reaped to `offline`. Defaults to
   * {@link PRESENCE_LIVENESS_TTL_MS} (5 min). Injectable for tests.
   */
  ttlMs?: number;
  /** Interval scheduler for the reaper. Defaults to {@link DEFAULT_SCHEDULER}. */
  scheduler?: PresenceReaperScheduler;
  /**
   * Reaper sweep cadence in epoch-ms. Defaults to
   * {@link DEFAULT_PRESENCE_REAPER_INTERVAL_MS} (30s). Only used once
   * {@link AgentPresenceRegistry.startReaper} is called.
   */
  reaperIntervalMs?: number;
}

/**
 * In-memory observable agent-presence registry. Pure state + a fold over the
 * `agent.*` envelope stream — no bus wiring of its own (that is
 * {@link startAgentPresenceRegistry}'s job). Unit-testable by feeding
 * envelopes to {@link apply} directly.
 */
export class AgentPresenceRegistry {
  private readonly records = new Map<string, AgentPresenceRecord>();
  private readonly listeners = new Set<AgentPresenceChangeListener>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly scheduler: PresenceReaperScheduler;
  private readonly reaperIntervalMs: number;
  /** Active reaper interval handle, or `null` when the reaper is not running. */
  private reaperHandle: unknown = null;

  constructor(opts: AgentPresenceRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PRESENCE_LIVENESS_TTL_MS;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
    this.reaperIntervalMs =
      opts.reaperIntervalMs ?? DEFAULT_PRESENCE_REAPER_INTERVAL_MS;
  }

  /**
   * Apply one presence envelope to the registry. Best-effort: an envelope
   * whose payload fails the Phase A schema is logged + dropped (a malformed
   * presence envelope must never throw into the bus fan-out path). Returns the
   * mutated record, or `null` when the envelope was dropped (bad payload /
   * non-presence type).
   */
  apply(envelope: Envelope): AgentPresenceRecord | null {
    return this.applyWithOrigin(envelope, "local");
  }

  /**
   * G-1114.E.2 — fold a TRUST-VERIFIED foreign presence envelope, tagging the
   * resulting record with its `{principal}/{stack}` provenance.
   *
   * **Trust is the CALLER's job, not this method's.** This is the in-memory
   * fold ONLY — it assumes the envelope has ALREADY passed the federation
   * accept-list gate AND `signed_by[]` chain verification (the federated
   * subscriber does both before calling here, mirroring the dispatch-listener's
   * Option-D gate→verify→handle order). Folding an unverified foreign envelope
   * here would be a trust hole; the subscriber is the single place that decides
   * "this foreign presence is admissible." See
   * {@link startFederatedAgentPresenceSubscriber}.
   *
   * **SOURCE-BOUND IDENTITY (PR #914 review BLOCKER fix).** `verifiedScope`
   * carries the `{principal}/{stack}` derived from the envelope's CHAIN-VERIFIED
   * `source` — the only trustworthy identity. The record's principal, stack, AND
   * THE MAP KEY are built from THIS, **never** from the attacker-controlled
   * `payload.scope`. So an accept-listed peer can announce only agents under ITS
   * OWN verified `{principal}/{stack}` — it can NOT paint a record that claims a
   * different (e.g. local-looking) principal/stack, and a foreign record can
   * NEVER collide with / overwrite a local one (the principal/stack segments of
   * the key differ by construction).
   *
   * **Spoof drop.** When `payload.scope` DISAGREES with the verified source
   * (`payload.scope.principal/stack ≠ verifiedScope`), the envelope is DROPPED
   * with a logged spoof signal rather than folded — a mismatch is an
   * impersonation attempt worth surfacing, not silently coercing. The
   * non-identity payload (capabilities, liveness state) is what the record
   * carries; identity comes from the source.
   *
   * Same best-effort contract as {@link apply}: a malformed payload is logged +
   * dropped, never thrown.
   */
  applyForeign(
    envelope: Envelope,
    verifiedScope: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    return this.applyWithOrigin(
      envelope,
      {
        kind: "foreign",
        principal: verifiedScope.principal,
        stack: verifiedScope.stack,
      },
      verifiedScope,
    );
  }

  /**
   * @param origin record provenance (local | foreign).
   * @param verifiedScope — for the FOREIGN path, the chain-verified
   *   `{principal}/{stack}` that is AUTHORITATIVE for the record's key +
   *   principal + stack (and against which `payload.scope` is spoof-checked).
   *   `undefined` for the LOCAL path (the stack folds its own envelopes; payload
   *   scope IS the identity, no cross-principal trust boundary).
   */
  private applyWithOrigin(
    envelope: Envelope,
    origin: AgentRecordOrigin,
    verifiedScope?: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    switch (envelope.type) {
      case AGENT_ONLINE_TYPE:
        return this.applyOnline(envelope, origin, verifiedScope);
      case AGENT_HEARTBEAT_TYPE:
        return this.applyHeartbeat(envelope, origin, verifiedScope);
      case AGENT_OFFLINE_TYPE:
        return this.applyOffline(envelope, origin, verifiedScope);
      case AGENT_CAPABILITIES_CHANGED_TYPE:
        return this.applyCapabilitiesChanged(envelope, origin, verifiedScope);
      default:
        // Not a presence envelope — the subject filter should have excluded
        // it, but be defensive (the fan-out delivers every matching envelope).
        return null;
    }
  }

  /**
   * BLOCKER fix — resolve the AUTHORITATIVE `{principal}/{stack}` for a record.
   *
   * For the FOREIGN path (`verifiedScope` supplied): the chain-verified source
   * wins. If `payload.scope` disagrees with it, this is a spoof attempt — return
   * `null` so the caller drops the envelope (logged). Otherwise the verified
   * scope is authoritative for the key + principal + stack.
   *
   * For the LOCAL path (`verifiedScope` undefined): the stack folds its own
   * envelopes; `payload.scope` is the identity (no cross-principal boundary).
   *
   * Returns `null` ONLY on a foreign spoof (scope ≠ source); the caller treats
   * that exactly like a dropped malformed payload.
   */
  private resolveScope(
    envelope: Envelope,
    payloadScope: { principal: string; stack: string },
    verifiedScope: { principal: string; stack: string } | undefined,
  ): { principal: string; stack: string } | null {
    if (verifiedScope === undefined) {
      // Local path — payload scope is the identity.
      return payloadScope;
    }
    // Foreign path — the verified source is authoritative. A payload.scope that
    // disagrees is an impersonation attempt: DROP + log (never fold a record
    // whose claimed identity differs from the signed source).
    if (
      payloadScope.principal !== verifiedScope.principal ||
      payloadScope.stack !== verifiedScope.stack
    ) {
      process.stderr.write(
        `agent-presence-registry: DROPPING foreign ${envelope.type} (id=${envelope.id}) — ` +
          `payload.scope ${payloadScope.principal}/${payloadScope.stack} does not match ` +
          `chain-verified source ${verifiedScope.principal}/${verifiedScope.stack} ` +
          `(spoof attempt — identity must come from the verified source)\n`,
      );
      return null;
    }
    return verifiedScope;
  }

  private applyOnline(
    envelope: Envelope,
    origin: AgentRecordOrigin,
    verifiedScope?: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    const parsed = AgentOnlinePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const scope = this.resolveScope(envelope, p.scope, verifiedScope);
    if (scope === null) return null; // foreign spoof (scope ≠ verified source)
    const key = recordKey(scope.principal, scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    const record: AgentPresenceRecord = {
      key,
      origin,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: scope.principal,
      stack: scope.stack,
      capabilities: p.capabilities,
      state: "online",
      startedAt: p.started_at,
      // online clears any prior offline reason (an online agent is not
      // offline) but preserves a prior heartbeat timestamp if one exists.
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyHeartbeat(
    envelope: Envelope,
    origin: AgentRecordOrigin,
    verifiedScope?: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    const parsed = AgentHeartbeatPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const scope = this.resolveScope(envelope, p.scope, verifiedScope);
    if (scope === null) return null; // foreign spoof (scope ≠ verified source)
    const key = recordKey(scope.principal, scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    // An unknown agent's heartbeat is itself a liveness signal — upsert it as
    // online rather than drop it (we may have missed the `online`). It carries
    // no capability list, so capabilities default to [] until an online /
    // capabilities-changed fills them.
    const record: AgentPresenceRecord = {
      key,
      origin,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: scope.principal,
      stack: scope.stack,
      capabilities: existing?.capabilities ?? [],
      state: "online",
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      lastHeartbeatAt: ts,
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyOffline(
    envelope: Envelope,
    origin: AgentRecordOrigin,
    verifiedScope?: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    const parsed = AgentOfflinePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const scope = this.resolveScope(envelope, p.scope, verifiedScope);
    if (scope === null) return null; // foreign spoof (scope ≠ verified source)
    const key = recordKey(scope.principal, scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    const record: AgentPresenceRecord = {
      key,
      origin,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: scope.principal,
      stack: scope.stack,
      capabilities: existing?.capabilities ?? [],
      state: "offline",
      offlineReason: p.reason,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private applyCapabilitiesChanged(
    envelope: Envelope,
    origin: AgentRecordOrigin,
    verifiedScope?: { principal: string; stack: string },
  ): AgentPresenceRecord | null {
    const parsed = AgentCapabilitiesChangedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) return this.dropMalformed(envelope, parsed.error);
    const p = parsed.data;
    const scope = this.resolveScope(envelope, p.scope, verifiedScope);
    if (scope === null) return null; // foreign spoof (scope ≠ verified source)
    const key = recordKey(scope.principal, scope.stack, p.identity.agent_id);
    const ts = this.now();
    const existing = this.records.get(key);
    // B stores the LATEST capability set only. The diff/reconcile (against the
    // prior set) is Phase C — here we just converge to the new full set.
    const record: AgentPresenceRecord = {
      key,
      origin,
      agentId: p.identity.agent_id,
      nkeyPublicKey: p.identity.nkey_public_key,
      assistantName: p.identity.assistant_name,
      principal: scope.principal,
      stack: scope.stack,
      capabilities: p.capabilities,
      // capabilities-changed does not assert liveness state; preserve the
      // prior state (default online — an agent emitting it is alive).
      state: existing?.state ?? "online",
      ...(existing?.offlineReason !== undefined && {
        offlineReason: existing.offlineReason,
      }),
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.lastHeartbeatAt !== undefined && {
        lastHeartbeatAt: existing.lastHeartbeatAt,
      }),
      lastSeenAt: ts,
    };
    this.records.set(key, record);
    this.emit(key, record);
    return record;
  }

  private dropMalformed(envelope: Envelope, err: unknown): null {
    // Per CLAUDE.md "no empty catch blocks" — log + drop. A malformed presence
    // payload is an observability gap, never a reason to throw into the bus
    // fan-out (which would take down delivery for every other handler).
    process.stderr.write(
      `agent-presence-registry: dropping malformed ${envelope.type} envelope ` +
        `(id=${envelope.id}): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  private emit(key: string, record: AgentPresenceRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(key, record);
      } catch (err) {
        // A listener throwing must not break sibling listeners or the apply
        // path. Log + continue.
        process.stderr.write(
          `agent-presence-registry: change listener threw (key=${key}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Snapshot of every known agent record. Returns COPIES so callers can't
   * mutate internal state. Order is insertion order (Map semantics).
   */
  getAgents(): AgentPresenceRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  /** Look up a single record by key, or `undefined`. Returns a copy. */
  getAgent(key: string): AgentPresenceRecord | undefined {
    const r = this.records.get(key);
    return r ? { ...r } : undefined;
  }

  /**
   * Register a change listener. Fires AFTER each record mutation with the
   * affected key + the new (post-mutation) record. Returns an unsubscribe
   * handle. B.4 + the MC projection use this to push live updates.
   */
  onChange(listener: AgentPresenceChangeListener): AgentPresenceChangeSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  // --- Liveness FSM / TTL reaper (G-1114.C.3) ------------------------------

  /**
   * Start the periodic liveness reaper. Schedules {@link reapStale} on the
   * injected scheduler's interval (default 30s). Idempotent — a second call
   * while the reaper is running is a no-op (it does NOT stack a second
   * interval). The reaper is OPT-IN: a bare registry never times anything out
   * until `startReaper()` is called, preserving the Phase B "records-only,
   * no FSM" contract for callers that fold envelopes without wiring liveness.
   */
  startReaper(): void {
    if (this.reaperHandle !== null) return;
    this.reaperHandle = this.scheduler.setInterval(() => {
      this.reapStale();
    }, this.reaperIntervalMs);
  }

  /**
   * Stop the reaper interval. Idempotent — safe to call when not running, and
   * safe to call twice (shutdown drain may double-invoke). Clears the handle so
   * a post-stop tick can never fire (the scheduler cancel + the null-guard in
   * {@link startReaper} together guarantee no tick-after-stop).
   */
  stopReaper(): void {
    if (this.reaperHandle === null) return;
    this.scheduler.clearInterval(this.reaperHandle);
    this.reaperHandle = null;
  }

  /** True while the reaper interval is scheduled. (Mostly for tests.) */
  isReaperRunning(): boolean {
    return this.reaperHandle !== null;
  }

  /**
   * Single liveness sweep: for every record currently `online` whose last
   * heartbeat is older than `now() - ttlMs`, transition it to `offline` with
   * reason {@link TTL_LAPSE_OFFLINE_REASON} and fire `onChange` (so the WS push
   * → panel update happens on the transition, not just on the next inbound
   * envelope). Returns the keys reaped this sweep.
   *
   * Idempotency / no repeat-emit: an already-`offline` record is skipped (the
   * reaper only acts on the `online`→`offline` edge), so a record that lapsed
   * on a previous tick does NOT re-emit on subsequent ticks. A record with no
   * `lastHeartbeatAt` yet (online via `agent.online` but never heartbeated) is
   * timed out against `lastSeenAt` as the liveness floor — an agent that
   * announced and then went silent without ever heartbeating is just as stale.
   *
   * Exposed publicly so tests can drive a deterministic sweep, and so a future
   * lazy-on-read path could call it; the wired path uses {@link startReaper}.
   */
  reapStale(): string[] {
    const cutoff = this.now() - this.ttlMs;
    const reaped: string[] = [];
    for (const [key, rec] of this.records) {
      if (rec.state !== "online") continue;
      // Liveness floor: prefer the last heartbeat; fall back to last-seen for a
      // record that announced online but never heartbeated.
      const lastLive = rec.lastHeartbeatAt ?? rec.lastSeenAt;
      // Strict: reap only when STRICTLY older than the TTL (now - lastLive > ttl),
      // matching the design's "older than" wording. At exactly the TTL the agent
      // is still live; the next 30s sweep reaps it (immaterial at sweep grain).
      if (lastLive >= cutoff) continue;
      const next: AgentPresenceRecord = {
        ...rec,
        state: "offline",
        offlineReason: TTL_LAPSE_OFFLINE_REASON,
      };
      this.records.set(key, next);
      reaped.push(key);
      this.emit(key, next);
    }
    return reaped;
  }

  // --- Foreign-record lifecycle (G-1114.E.2) -------------------------------

  /**
   * Drop every FOREIGN record (origin `{kind: "foreign"}`), firing `onChange`
   * for each removal so the view prunes the foreign agents cleanly. Local
   * records are untouched. Returns the keys removed.
   *
   * The acceptance path for "disabling federation cleanly removes foreign
   * agents" (plan §4.5): when the federated subscriber stops (federation turned
   * off / reloaded out), it calls this so the registry no longer shows a peer's
   * agents. A record removal is signalled via `onChange` with a synthesized
   * snapshot carrying `state: "offline"` + `offlineReason: "shutdown"` — the
   * view treats a removed-foreign exactly as a gracefully-departed agent, and
   * since the record is gone from `getAgents()` a subsequent refetch omits it.
   */
  removeForeign(): string[] {
    const removed: string[] = [];
    for (const [key, rec] of this.records) {
      if (!isForeignOrigin(rec.origin)) continue;
      this.records.delete(key);
      removed.push(key);
      // Emit a terminal snapshot so a live listener prunes immediately; the
      // record is already gone from `getAgents()`.
      this.emit(key, { ...rec, state: "offline", offlineReason: "shutdown" });
    }
    return removed;
  }
}

/**
 * Subject pattern the registry subscribes to — STACK-LOCAL ONLY.
 * `local.{principal}.{stack}.agent.>` — the `>` matches every presence action
 * (`online`/`heartbeat`/`offline`/`capabilities-changed`). The `federated.`
 * counterpart is deliberately NOT subscribed (Phase E).
 */
export function agentPresenceSubject(principal: string, stack: string): string {
  return `local.${principal}.${stack}.agent.>`;
}

/** Lifecycle handle for the wired registry. */
export interface AgentPresenceRegistryHandle {
  /** The observable store — `getAgents()` / `onChange()` for downstream. */
  readonly registry: AgentPresenceRegistry;
  /**
   * Stop the subscriber: unregister the fan-out handler + drain the
   * push subscriber. Idempotent. The in-memory store survives stop (a stopped
   * registry just stops receiving updates).
   */
  stop(): Promise<void>;
}

/** Options for {@link startAgentPresenceRegistry}. */
export interface StartAgentPresenceRegistryOptions {
  runtime: MyelinRuntime;
  /** Boot-resolved `{principal}` — the subject's second segment. */
  principal: string;
  /** Resolved `{stack}` — the subject's third segment. */
  stack: string;
  /** Optional pre-constructed registry (tests). Production constructs one. */
  registry?: AgentPresenceRegistry;
  /** Injected clock, forwarded to a freshly-constructed registry (tests). */
  now?: () => number;
  /**
   * Whether to start the liveness reaper (G-1114.C.3). Defaults to `true` — the
   * wired path wants TTL expiry. Tests that supply their own registry + drive
   * `reapStale` manually pass `false` to avoid a real `setInterval`.
   */
  startReaper?: boolean;
}

/**
 * Wire the registry into the running cortex. Self-subscribes to the
 * stack-local `agent.>` subtree (cortex#477 push-mode seam) and registers a
 * fan-out handler that filters matching envelopes into the registry's `apply`.
 *
 * NON-THROWING / best-effort, matching every other capability-side boot
 * feature: a subscribe failure logs + leaves the registry dormant (still
 * constructed + queryable, just not receiving). When `runtime.enabled` is false
 * (no NATS) the subscriber stays dormant.
 */
export async function startAgentPresenceRegistry(
  opts: StartAgentPresenceRegistryOptions,
): Promise<AgentPresenceRegistryHandle> {
  const registry =
    opts.registry ??
    new AgentPresenceRegistry(opts.now !== undefined ? { now: opts.now } : {});
  const pattern = agentPresenceSubject(opts.principal, opts.stack);

  // G-1114.C.3 — start the liveness reaper (TTL expiry). Opt-out for tests that
  // drive `reapStale` deterministically. `startReaper` is idempotent + the
  // handle's `stop()` stops it (registered in the cortex.ts shutdown drain).
  if (opts.startReaper !== false) {
    registry.startReaper();
  }

  const handler: EnvelopeHandler = (envelope, subject) => {
    if (!subjectMatches(pattern, subject)) return;
    registry.apply(envelope);
  };
  const registration = opts.runtime.onEnvelope(handler);

  // cortex#477 push-mode self-subscribe. `subscribe` is optional on the
  // interface; treat undefined as "runtime can't push-subscribe" (dormant).
  let subscriber: MyelinSubscriber | null = null;
  try {
    subscriber = (await opts.runtime.subscribe?.(pattern)) ?? null;
    if (opts.runtime.enabled && subscriber === null) {
      process.stderr.write(
        `agent-presence-registry: runtime.subscribe(${pattern}) returned null — ` +
          `registry will only see envelopes from other static subscriptions\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `agent-presence-registry: subscribe(${pattern}) failed (non-fatal — registry dormant): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  let stopped = false;
  return {
    registry,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // Stop the liveness reaper FIRST so no sweep can fire mid-teardown.
      // Idempotent + a no-op when the reaper was never started.
      registry.stopReaper();
      registration.unregister();
      // The runtime tracks `subscribe()` subscribers and drains them on
      // `runtime.stop()`, but we stop ours explicitly so a listener-scoped
      // teardown (tests, hot-reload) doesn't wait for full runtime shutdown.
      if (subscriber) {
        await subscriber.stop();
      }
    },
  };
}
