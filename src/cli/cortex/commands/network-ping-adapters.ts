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

import type { AgentConfig } from "../../../common/types/config";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { MyelinRuntime, BusEnvelopeSigner } from "../../../bus/myelin/runtime";
import { startMyelinRuntime } from "../../../bus/myelin/runtime";
import type {
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
