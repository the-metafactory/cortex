/**
 * `cortex network ping` — LIVE bus adapter (signal#113 P-11 /
 * `docs/design-network-ping.md`, issue #56).
 *
 * Wires the real {@link MyelinRuntime} into the {@link ProbeBusPort} the pure
 * orchestrator (`network-ping-lib.ts`) depends on. Constructed only on a real
 * `cortex network ping` invocation; tests inject a fake bus and never reach
 * this file.
 *
 * Per probe: subscribe OUR OWN `federated.{us}.{stack}.probe.reply.>`, register
 * an `onEnvelope` matcher keyed on `correlation_id`, publish the request on the
 * explicit federated subject (`publishOnSubject`), and resolve with the first
 * matching reply (+ RTT measured single-clock on the requester) or a timeout.
 *
 * The runtime is started ONCE for the whole `ping` run and stopped on exit, so
 * `--count N` reuses one NATS connection.
 */

import { existsSync, readFileSync } from "node:fs";

import type { AgentConfig } from "../../../common/types/config";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { LoadedConfig } from "../../../common/config/loader";
import { expandTilde } from "../../../common/config/loader";
import { natsConfigMonitorUrl } from "../../../common/nats/leaf-remote-renderer";
import type { MyelinRuntime, BusEnvelopeSigner } from "../../../bus/myelin/runtime";
import { startMyelinRuntime } from "../../../bus/myelin/runtime";
import type {
  LeafzCounters,
  LeafzSamplerPort,
  ProbeBusPort,
  ProbeFireInputs,
  ProbeRoundTripResult,
} from "./network-ping-ports";

/**
 * A live probe bus bound to a running runtime. Build via {@link createLiveProbeBus}
 * (which starts the runtime); call {@link stop} when the ping run finishes.
 */
export interface LiveProbeBus extends ProbeBusPort {
  /** Whether the underlying runtime actually connected (NATS configured). */
  readonly enabled: boolean;
  stop(): Promise<void>;
}

/**
 * Start a runtime from the stack's `AgentConfig` and return a live probe bus.
 *
 * `signer` is the stack's envelope signer (when a seed loaded under
 * `permissive`/`enforce`) so the request is signed exactly like every other
 * federated dispatch; omit under `signing: off` (publishes unsigned, identical
 * to today). The runtime stays the single owner of the NATS connection.
 */
export async function createLiveProbeBus(
  config: AgentConfig,
  signer?: BusEnvelopeSigner,
): Promise<LiveProbeBus> {
  const runtime: MyelinRuntime = await startMyelinRuntime(
    config,
    signer !== undefined ? { signer } : undefined,
  );
  return wrapRuntimeAsProbeBus(runtime);
}

/**
 * Wrap an already-started runtime as a probe bus. Exported separately so an
 * integration test (or a future caller that already holds a runtime) can reuse
 * the fire/await logic without re-starting NATS.
 */
export function wrapRuntimeAsProbeBus(runtime: MyelinRuntime): LiveProbeBus {
  return {
    enabled: runtime.enabled,

    async fireProbe(fired: ProbeFireInputs): Promise<ProbeRoundTripResult> {
      if (!runtime.enabled || typeof runtime.publishOnSubject !== "function") {
        // No bus / no explicit-subject publish — nothing can go on the wire.
        return {
          kind: "publish-failed",
          reason: "runtime disabled or lacks publishOnSubject (no NATS configured)",
        };
      }

      // Subscribe our OWN reply scope + register a correlation-id matcher
      // BEFORE publishing, so a fast echo can't race ahead of our listener.
      let resolveReply: ((env: Envelope) => void) | undefined;
      const replyPromise = new Promise<Envelope>((resolve) => {
        resolveReply = resolve;
      });
      const registration = runtime.onEnvelope((env, subject) => {
        // Match on correlation_id (subject-agnostic — mirrors pilot --wait).
        if (env.correlation_id !== fired.correlationId) return;
        // Defensive: only accept on our own reply scope.
        if (!subject.startsWith(replyScopePrefix(fired.replySubjectPattern))) {
          return;
        }
        resolveReply?.(env);
      });

      // Declare interest on the reply pattern (push subscription). May be null
      // when the runtime is disabled — but we checked `enabled` above.
      const sub = runtime.subscribe
        ? await runtime.subscribe(fired.replySubjectPattern)
        : null;

      const startMs = Date.now();
      try {
        await runtime.publishOnSubject(fired.request, fired.requestSubject);
      } catch (err) {
        registration.unregister();
        if (sub) await sub.stop();
        return {
          kind: "publish-failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // Await the matching reply or the per-probe timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, fired.timeoutMs);
      });

      try {
        const outcome = await Promise.race([replyPromise, timeoutPromise]);
        if (outcome === "timeout") {
          return { kind: "timeout" };
        }
        const rttMs = Date.now() - startMs;
        return { kind: "reply", rttMs, reply: outcome };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        registration.unregister();
        if (sub) await sub.stop();
      }
    },

    async stop() {
      await runtime.stop();
    },
  };
}

/**
 * Derive the literal subject prefix from a reply pattern
 * `federated.{us}.{stack}.probe.reply.>` → `federated.{us}.{stack}.probe.reply.`
 * so the matcher can confirm a reply landed on OUR scope (never trust a reply
 * that arrived on someone else's subject, even if the correlation_id collides).
 */
function replyScopePrefix(pattern: string): string {
  // Strip a trailing `>` wildcard; keep the dotted literal prefix.
  if (pattern.endsWith(".>")) return pattern.slice(0, -1); // keep trailing dot
  return pattern;
}

// =============================================================================
// cortex#1728 (guard 4) — live `/leafz` sampler
// =============================================================================

/** Upstream-default nats-server HTTP monitor base (the `http_port` default). */
const DEFAULT_MONITOR_BASE = "http://127.0.0.1:8222";

/** Bound the monitor fetch so a hung monitor can't stall the ping. */
const LEAFZ_FETCH_TIMEOUT_MS = 2000;

/**
 * cortex#1728 (guard 4) — resolve the nats-server HTTP monitor base from the
 * loaded config, mirroring `network-adapters.ts`'s `resolveMonitorBase`
 * precedence but from a {@link LoadedConfig}: derive from the stack's nats
 * config file (`http_port`/`monitor_port`/`http`), else the upstream default.
 * Pure/read-only; a missing/unreadable config falls back to the default base.
 */
function resolveMonitorBaseFromLoaded(cfg: LoadedConfig): string {
  const configPath = expandTilde(cfg.stack?.nats_infra?.config_path ?? "");
  if (configPath.length > 0 && existsSync(configPath)) {
    try {
      const derived = natsConfigMonitorUrl(readFileSync(configPath, "utf-8"));
      if (derived !== undefined) return derived.replace(/\/+$/, "");
    } catch {
      // Unreadable nats config — fall back to the default base. Best-effort:
      // the sampler is additive diagnostic context, never a gate (see below).
    }
  }
  return DEFAULT_MONITOR_BASE;
}

/**
 * cortex#1728 (guard 4) — a live {@link LeafzSamplerPort} over the nats-server
 * `/leafz` monitor endpoint. Sums `out_msgs` / `in_msgs` across the reported
 * leaf connections (a federating stack typically carries the network on a single
 * leaf; summing yields the aggregate egress/ingress the delta test needs).
 *
 * BEST-EFFORT by contract: every failure path (monitor unreachable, non-200,
 * malformed body, timeout) resolves `undefined`, so the ping proceeds without a
 * diagnostic line and NEVER fails on account of the sampler.
 */
export function createLiveLeafzSampler(cfg: LoadedConfig): LeafzSamplerPort {
  const base = resolveMonitorBaseFromLoaded(cfg);
  return {
    async sample(): Promise<LeafzCounters | undefined> {
      // Bound the fetch: a monitor that accepts the TCP connection but never
      // responds (hung nats-server) must not hang the ping.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, LEAFZ_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/leafz`, { signal: controller.signal });
        if (!res.ok) return undefined;
        const body = (await res.json()) as {
          leafs?: { in_msgs?: number; out_msgs?: number }[];
        };
        const leafs = body.leafs ?? [];
        if (leafs.length === 0) return undefined;
        let outMsgs = 0;
        let inMsgs = 0;
        for (const leaf of leafs) {
          if (typeof leaf.out_msgs === "number") outMsgs += leaf.out_msgs;
          if (typeof leaf.in_msgs === "number") inMsgs += leaf.in_msgs;
        }
        return { outMsgs, inMsgs };
      } catch {
        // Monitor genuinely unreachable / aborted — degrade to "no sample".
        // The orchestrator omits the diagnostic line; the ping is unaffected.
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
