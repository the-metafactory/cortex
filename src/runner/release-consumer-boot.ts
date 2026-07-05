/**
 * S8 lane 3 (epic #1514, plan §2, cortex#1522) — boot wiring for the
 * per-agent release-consumer construction, extracted from the per-agent body
 * of the `if (releaseCapableAgents.length > 0) { … for (const agent of
 * releaseCapableAgents) { … } }` inline block that used to live in
 * `src/cortex.ts` (F-4.1, cortex#835).
 *
 * **Different shape than `wireBrainConsumers`/`wireReviewConsumers` — and
 * why.** Both siblings extract a NAMED closure called from TWO sites (a boot
 * loop AND an `agents.d/` hot-reload path). The release lane has no
 * hot-reload path (cortex#835's F-4.1 never wired one for `release.cut` —
 * "PRINCIPAL-GATED, ALWAYS-HUMAN" work is dispatched, not hot-swapped) and
 * only ONE call site: the boot-time `for (const agent of
 * releaseCapableAgents)` loop, itself gated behind
 * `releaseCapableAgents.length > 0` (the "HARD CONTRACT — byte-identical boot
 * when no agent declares the capability" the block's original header
 * documents). This module extracts ONLY the per-agent
 * construct+provision+start+log body — the surrounding gate, the
 * `releaseCapableAgents` filter, the `RELEASE` stream provisioning, and the
 * `releaseJsm` resolution all STAY in `cortex.ts`, unchanged, because they
 * run once per boot (not once per agent) and nothing here needs to
 * unit-test them in isolation.
 *
 * **PRESERVE THE ASYMMETRY.** Do not add a hot-reload call site for this
 * lane — that would be new behaviour, not a refactor. If release ever needs
 * hot-reload, that is a separate, deliberate change with its own review, not
 * a side effect of this extraction.
 *
 * **`opts.releaseConsumers` is a shared, NOT owned, array.** `cortex.ts`
 * still declares `const releaseConsumers: ReleaseConsumer[] = []` and reads
 * it for the shutdown drain (outside this slice's scope). `startForAgent`
 * pushes onto the SAME array reference (passed once as an opts field), so
 * that call site keeps seeing every consumer this module wires, unchanged.
 *
 * **Free-variable capture — no mutable-capture threading needed.** Every
 * value `WireReleaseConsumersOpts` carries is a plain snapshot: `runtime`
 * (a `let`, elsewhere in `cortex.ts`) settles once at boot — well before the
 * release block runs — and is never reassigned again; every other captured
 * value (`principalId`, `systemEventSource`, `makeOfferAdmission`,
 * `releaseJsm`, `releaseStream`, `releaseConsumerMaxDeliver`,
 * `releaseOfferingPatterns`, `releaseSubjectPattern`) is a `const` assigned
 * exactly once, in the `if (releaseCapableAgents.length > 0)` setup that
 * remains in `cortex.ts` immediately before the (former) per-agent loop body
 * this module now is. The old loop body only ever READ these — it never
 * reassigned any of them — so a plain value capture at construction time is
 * behaviourally identical to the inline loop's live-binding read.
 */

import {
  ReleaseConsumer,
  type ReleaseConsumerAgent,
} from "./release-consumer";
import { provisionReviewConsumer, type ProvisionJsm } from "../bus/jetstream/provision";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { GateFloorDecision } from "../bus/gate-floor";

// ---------------------------------------------------------------------------
// The narrow agent shape the boot wiring consumes
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a cortex.yaml `Agent` the release boot wiring
 * needs — structural (not the full Zod `Agent`) so `cortex.ts` passes
 * `releaseCapableAgents` without a cast, mirroring `ReviewBootAgent`/
 * `DevBootAgent`/`BrainBootAgent`.
 */
export interface ReleaseBootAgent {
  id: string;
  runtime?: {
    capabilities?: readonly string[];
    maxConcurrent?: number;
  };
}

/** Inputs `cortex.ts` threads into the release-consumer boot wiring. */
export interface WireReleaseConsumersOpts {
  /** `{principal}` subject segment — durable names. */
  principalId: string;
  /** Bus-side event source every consumer publishes lifecycle envelopes through. */
  systemEventSource: SystemEventSource;
  /** The (possibly dormant) MyelinRuntime the consumer subscribes against. */
  runtime: MyelinRuntime;
  /** CO-2/CO-4 per-offer-scope admission gate factory, keyed by capability id. */
  makeOfferAdmission: (
    capability: string,
  ) => (envelope: Envelope, subject: string) => GateFloorDecision;
  /**
   * Shared consumer array — the SAME array `cortex.ts` owns for the shutdown
   * drain. This module pushes onto it; it does not own the array's
   * lifecycle.
   */
  releaseConsumers: ReleaseConsumer[];
  /** Resolved JetStream manager, or `null` when the runtime is dormant. */
  releaseJsm: ProvisionJsm | null;
  /** RELEASE stream name. */
  releaseStream: string;
  /** Durable max-deliver, shared with the review/brain lanes. */
  releaseConsumerMaxDeliver: number;
  /** CO-2 offer-scope Offer patterns for `release.cut` (`[releaseSubjectPattern]` for the local-only default). */
  releaseOfferingPatterns: readonly string[];
  /** The primary local subject pattern — the `releaseOfferingPatterns[0]` fallback. */
  releaseSubjectPattern: string;
}

/** The callable `cortex.ts` invokes per agent, inside the preserved `if (releaseCapableAgents.length > 0) { for (…) }` boot block. */
export interface WiredReleaseConsumers {
  startForAgent: (agent: ReleaseBootAgent) => Promise<void>;
}

/**
 * Build the per-agent release-consumer construction. Returns `startForAgent`
 * — the same construction the boot-time `for (const agent of
 * releaseCapableAgents)` loop calls (the lane's ONLY call site; no
 * hot-reload — see the file header). Never throws: a single agent's
 * consumer-init failure is caught and logged so siblings still wire (mirrors
 * the pre-extraction loop body).
 */
export function wireReleaseConsumers(
  opts: WireReleaseConsumersOpts,
): WiredReleaseConsumers {
  const startForAgent = async (agent: ReleaseBootAgent): Promise<void> => {
    try {
      const caps = agent.runtime?.capabilities ?? [];
      const consumerAgent: ReleaseConsumerAgent = {
        id: agent.id,
        capabilities: caps,
        ...(agent.runtime?.maxConcurrent !== undefined && {
          maxConcurrent: agent.runtime.maxConcurrent,
        }),
      };
      // F-4.1 — no executor wired yet (see block header). The consumer is
      // dormant-but-present: capability declared + gate ladder live.
      const consumer = new ReleaseConsumer({
        agent: consumerAgent,
        source: opts.systemEventSource,
        runtime: opts.runtime,
        // CO-2/CO-4 — per-offer-scope admission gate (inert on `local.`).
        offerAdmission: opts.makeOfferAdmission("release.cut"),
      });
      opts.releaseConsumers.push(consumer);

      const durable = `cortex-release-consumer-${opts.principalId}-${agent.id}`;
      if (opts.releaseJsm !== null) {
        try {
          const outcome = await provisionReviewConsumer({
            jsm: opts.releaseJsm,
            stream: opts.releaseStream,
            durable,
            maxDeliver: opts.releaseConsumerMaxDeliver,
          });
          if (outcome === "created") {
            console.log(
              `cortex: provisioned JetStream durable "${durable}" on stream "${opts.releaseStream}"`,
            );
          } else if (outcome === "updated") {
            console.log(
              `cortex: reconciled JetStream durable "${durable}" on stream "${opts.releaseStream}"`,
            );
          }
        } catch (provisionErr) {
          process.stderr.write(
            `cortex: provisionReviewConsumer failed for "${durable}": ` +
              `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
          );
        }
      }

      // CO-2 (cortex#941) — bind on the offering-admitted scope prefixes.
      // `releaseOfferingPatterns[0]` is byte-identical to
      // `releaseSubjectPattern` for the CO-1 default (`local`-only); the
      // `.slice(1)` loop is empty unless `release.cut` is offered wider.
      const primaryReleasePattern =
        opts.releaseOfferingPatterns[0] ?? opts.releaseSubjectPattern;
      const started = await consumer.start({
        pattern: primaryReleasePattern,
        stream: opts.releaseStream,
        durable,
      });
      // F-4.1 — log line flags `executor=none` so a principal grepping boot
      // can see the lane is declared but the forge seam is not yet wired.
      if (started.subscribed) {
        console.log(
          `cortex: release consumer ready for agent=${agent.id} capability=release.cut executor=none (gated; principal-grant required) — PRINCIPAL-GATED, ALWAYS-HUMAN`,
        );
      } else {
        console.log(
          `cortex: release consumer DORMANT for agent=${agent.id} capability=release.cut executor=none — cortex MyelinRuntime subscriptions disabled (G-1111 pending; tasks.release.cut envelopes will not be claimed by this consumer)`,
        );
      }
      // CO-2 — extra offering scopes (federated/public) beyond the primary
      // local one, each on its own scope-named durable. Empty for the CO-1
      // default ⇒ byte-identical boot.
      for (const extraPattern of opts.releaseOfferingPatterns.slice(1)) {
        const scopeToken = extraPattern.split(".", 1)[0] ?? "scope";
        // A NEW consumer instance per extra scope (one filter per JetStream
        // pull consumer) — same idiom as the review lane + the NIT-fix on the
        // dev lane. The CO-2/CO-4 admission gate is wired here too so the
        // wider-scope release dispatch clears its floor.
        const extraConsumer = new ReleaseConsumer({
          agent: consumerAgent,
          source: opts.systemEventSource,
          runtime: opts.runtime,
          offerAdmission: opts.makeOfferAdmission("release.cut"),
        });
        opts.releaseConsumers.push(extraConsumer);
        const extraDurable = `cortex-release-consumer-offer-${scopeToken}-${opts.principalId}-${agent.id}`;
        if (opts.releaseJsm !== null) {
          try {
            const outcome = await provisionReviewConsumer({
              jsm: opts.releaseJsm,
              stream: opts.releaseStream,
              durable: extraDurable,
              maxDeliver: opts.releaseConsumerMaxDeliver,
            });
            if (outcome === "created") {
              console.log(
                `cortex: provisioned JetStream durable "${extraDurable}" on stream "${opts.releaseStream}"`,
              );
            } else if (outcome === "updated") {
              console.log(
                `cortex: reconciled JetStream durable "${extraDurable}" on stream "${opts.releaseStream}"`,
              );
            }
          } catch (provisionErr) {
            process.stderr.write(
              `cortex: provisionReviewConsumer failed for "${extraDurable}": ` +
                `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
            );
          }
        }
        const extraStarted = await extraConsumer.start({
          pattern: extraPattern,
          stream: opts.releaseStream,
          durable: extraDurable,
        });
        if (extraStarted.subscribed) {
          console.log(
            `cortex: release consumer (offer:${scopeToken}) ready for agent=${agent.id} capability=release.cut executor=none pattern=${extraPattern}`,
          );
        } else {
          console.log(
            `cortex: release consumer (offer:${scopeToken}) DORMANT for agent=${agent.id} capability=release.cut executor=none — cortex MyelinRuntime subscriptions disabled (${extraPattern} envelopes will not be claimed by this consumer)`,
          );
        }
      }
    } catch (err) {
      // Per CLAUDE.md "no empty catch blocks": a single agent's release
      // consumer crash does NOT abort boot — siblings still wire. The
      // consumer stays in `releaseConsumers[]` so the shutdown drain still
      // calls `.stop()` (idempotent — handles the "never subscribed" case).
      process.stderr.write(
        `cortex: release consumer init failed for agent=${agent.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  return { startForAgent };
}
