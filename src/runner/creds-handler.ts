/**
 * cortex#67 prep — creds-handler stub.
 *
 * The full creds-handler will mint per-agent NATS JWTs scoped to each agent's
 * declared `runtime.capabilities`, using an operator account signing key
 * (landed in cortex#67 prereq B). The handler watches the agent registry,
 * mints/refreshes credentials when an agent's capability set or trust closure
 * changes, and tears them down on shutdown.
 *
 * This file is the minimum surface so the upcoming cortex#67 PR has a target:
 *   - `CredsHandlerOpts` carries the bus runtime + the agent registry. The
 *     `accountSigningKey: KeyPair` field arrives in cortex#67 once prereq A+B
 *     have landed — adding it here today would force an early dep on the JWT
 *     primitive that hasn't shipped.
 *   - `CredsHandler` is the lifecycle handle cortex.ts wires alongside the
 *     other subsystems (runtime, router, listener) — same `start/stop` shape
 *     so the existing shutdown drain doesn't need a special-case.
 *
 * The stub's `start` and `stop` are idempotent no-ops. They satisfy the type
 * so cortex.ts can conditionally construct + log a "creds handler ready
 * (stub)" line behind the same gates the real handler will require:
 *   - `runtime.enabled` (no point minting NATS creds without a NATS link)
 *   - `registry.size > 0`  (no point minting creds for zero agents)
 *   - (future) account signing key present in config
 *
 * When cortex#67 lands, replace the stub body — the public interface stays.
 */

import type { AgentRegistry } from "../common/agents/registry";
import type { MyelinRuntime } from "../bus/myelin/runtime";

/**
 * Construction options for the creds handler. The runtime + registry pair is
 * enough surface to scope the handler today; the account signing key arrives
 * with cortex#67 once the prereq-A/B PRs land.
 */
export interface CredsHandlerOpts {
  /** Bus runtime — the handler will eventually publish minted creds via this. */
  runtime: MyelinRuntime;
  /**
   * Agent registry — the handler reads `agent.runtime.capabilities` per
   * registered agent to bound each minted JWT's NATS user permissions.
   */
  registry: AgentRegistry;
  // accountSigningKey: KeyPair — added in cortex#67 once prereq A+B land.
}

/**
 * Lifecycle handle for the creds handler. Same `start/stop` shape as other
 * cortex subsystems so the shutdown drain treats it uniformly.
 */
export interface CredsHandler {
  /**
   * Start the handler. Idempotent — calling twice is safe and the second
   * call is a no-op. The stub never throws; the real implementation will
   * surface configuration errors (missing signing key, registry empty)
   * here rather than at construction.
   */
  start(): Promise<void>;
  /**
   * Stop the handler. Idempotent — calling twice (or before `start`) is
   * safe. The stub never throws; the real implementation will revoke
   * minted creds + cancel refresh timers here.
   */
  stop(): Promise<void>;
}

/**
 * Build the creds handler. Pure factory — does not start anything; the
 * caller invokes `handle.start()` once it's ready to hand the registry +
 * runtime over to the credential minting loop.
 *
 * STUB — full implementation lands in cortex#67. The current body returns a
 * handle whose `start` and `stop` are no-ops; this satisfies the type so
 * cortex.ts can wire the handler conditionally today and the real behaviour
 * can swap in without touching call sites.
 */
export function createCredsHandler(_opts: CredsHandlerOpts): CredsHandler {
  // STUB — full implementation in cortex#67.
  // The opts are accepted but unused at this stage; once the JWT mint loop
  // lands, the closure below captures `_opts.runtime` and `_opts.registry`
  // to drive credential issuance per agent.
  return {
    async start() {
      // No-op — real handler will: scan registry, mint per-agent JWTs
      // scoped to each agent's runtime.capabilities, publish creds via
      // runtime, and start a refresh timer keyed on JWT TTL.
    },
    async stop() {
      // No-op — real handler will: cancel refresh timer, revoke minted
      // creds, drain in-flight publishes.
    },
  };
}
