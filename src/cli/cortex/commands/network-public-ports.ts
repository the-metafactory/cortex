/**
 * S5 (Network Join Control Plane, #739, spec F5) — the injected-dependency
 * seams for `cortex network join/leave public` (the public-scope opt-in, the
 * open square of the Internet of Agentic Work).
 *
 * Same ports discipline as S4 (`network-ports.ts`): the orchestration
 * (`network-public-lib.ts`) is pure over these interfaces; the LIVE adapters
 * (in `network-adapters.ts`) mutate the deployment and are only built on a real
 * invocation; the DRY-RUN adapters (the S5 default-safe posture) record intent
 * without touching disk, registry, or daemons.
 *
 * ## What `join public` actually does (bounded — F5)
 *
 *   1. ANNOUNCE the stack's declared capabilities to the registry's PUBLIC
 *      capability index (the `/capabilities` search surface, fed by the
 *      principal-register `capabilities` claim) — {@link PublicRegistryPort}.
 *   2. SUBSCRIBE `public.>` so the stack receives public-scope traffic — by
 *      adding `public.>` to the stack's `nats.subjects[]` — {@link PublicSubscribePort}.
 *   3. WRITE the `policy.public` opt-in block (the allowlist gate) so the
 *      surface-router admits inbound public traffic ONLY from allowlisted
 *      senders — {@link PublicPolicyPort}.
 *   4. RESTART the daemon so the new subscription takes effect ({@link DaemonPort},
 *      shared with S4).
 *
 * ## OQ1 safe default (the deferred abuse story)
 *
 * Step 3 is DENY-BY-DEFAULT. With no `--allow`, the written block is
 * `enabled: false` — announcing/discovering capabilities does NOT open the
 * local bus to public senders. There is NO open-claim/anonymous seam here:
 * open anonymous claim on `public.>` is out of scope for S5 and deferred to the
 * security ramp (DD-7), gated on the OQ1 abuse story.
 */

import type { PolicyPublic } from "../../../common/types/cortex-config";
import type { DaemonPort } from "./network-ports";

// =============================================================================
// Ports
// =============================================================================

/**
 * The registry control-plane seam for the PUBLIC capability index. Announcing
 * = upserting the stack's principal record with its declared `capabilities`
 * (the registry's `/capabilities` route searches over these). Deregistering =
 * re-registering with an EMPTY capability list, so the stack is no longer
 * discoverable on the public index. Both are idempotent proof-of-possession
 * registrations (same trust model as S4's `registerStack`).
 */
export interface PublicRegistryPort {
  /** Announce these capability ids to the public index (register w/ caps). */
  announceCapabilities(
    capabilities: readonly string[],
  ): Promise<{ ok: true; note: string } | { ok: false; reason: string }>;
  /** Remove the stack from the public index (register w/ empty caps). */
  deregisterCapabilities(): Promise<
    { ok: true; note: string } | { ok: false; reason: string }
  >;
}

/**
 * The `public.>` subscription seam. `join public` adds `public.>` to the
 * stack's `nats.subjects[]` (the runtime's boot-time subscribe list); `leave
 * public` removes it. `hasPublicSubscription` makes the add idempotent (a
 * re-join when already subscribed is a no-op — never double-bind the same
 * pattern, the cortex#491 double-message footgun).
 */
export interface PublicSubscribePort {
  /** True when `public.>` is already in the stack's `nats.subjects[]`. */
  hasPublicSubscription(): boolean;
  /** Add `public.>` to `nats.subjects[]` (idempotent — caller guards). */
  addPublicSubscription(): void;
  /** Remove `public.>` from `nats.subjects[]` (idempotent — absent is a no-op). */
  removePublicSubscription(): void;
}

/**
 * The `policy.public` opt-in seam — reads + writes the inbound allowlist block
 * for the stack. `writePublic(undefined)` REMOVES the block (the `leave`
 * teardown), reverting the surface-router to its deny-all-public default.
 */
export interface PublicPolicyPort {
  /** Current `policy.public` for the stack (undefined when not opted in). */
  readPublic(): PolicyPublic | undefined;
  /** Persist `policy.public`; `undefined` removes the block (leave teardown). */
  writePublic(next: PolicyPublic | undefined): void;
}

/** The full public-scope port bundle. Reuses S4's {@link DaemonPort}. */
export interface PublicScopePorts {
  registry: PublicRegistryPort;
  subscribe: PublicSubscribePort;
  policy: PublicPolicyPort;
  daemon: DaemonPort;
}
