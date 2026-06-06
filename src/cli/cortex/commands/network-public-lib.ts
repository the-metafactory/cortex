/**
 * S5 (Network Join Control Plane, #739, spec F5) — `join/leave public`
 * orchestration, pure over {@link PublicScopePorts}.
 *
 * The PUBLIC scope is the open square of the Internet of Agentic Work (design
 * §3): unrestricted reach, and — uniquely — it carries NO `{principal}.{stack}`
 * segment on the wire (`public.{domain}.{entity}.{action}`, CONTEXT.md §Scope).
 * A stack opts in EXPLICITLY with `cortex network join public`.
 *
 * ## What opting in does (bounded — F5)
 *
 *   (a) announce the stack's declared capabilities to the registry's PUBLIC
 *       capability index (so peers can discover them),
 *   (b) subscribe `public.>` (add it to `nats.subjects[]`),
 *   (c) write the `policy.public` opt-in block — the INBOUND allowlist gate,
 *   (d) restart the daemon so the subscription takes effect.
 *
 * ## OQ1 — the safe-by-default gate (the deferred abuse story)
 *
 * Spec OQ1 leaves the public-scope abuse model OPEN: anonymous offer/claim on
 * `public.>` needs a spam/abuse story before it can be enabled beyond an
 * allowlist. So step (c) is DENY-BY-DEFAULT:
 *
 *   - no `--allow` → `policy.public.enabled = false`. The stack ANNOUNCES and
 *     can DISCOVER on the public index, but the surface-router DROPS all
 *     inbound `public.*` — announcing is not a trust grant.
 *   - `--allow jc,joel` → `enabled = true`, `allow_principals = [jc, joel]`.
 *     Inbound public traffic is admitted ONLY from those signing principals.
 *
 * There is NO open-claim / anonymous path: a non-allowlisted public sender is
 * NEVER auto-trusted. Open anonymous claim on `public.>` is OUT OF SCOPE for S5
 * — a later decision on the security ramp (DD-7), gated on the OQ1 abuse story.
 *
 * ## Trust tier — public is NOT a federated peer
 *
 * This flow touches NO federated state (`policy.federated.networks[]`, peers,
 * leaf links). Public is a separate trust tier; the inbound gate
 * (`evaluatePublicGate`, surface-router) keys on the SENDER's source principal
 * against the public allowlist, never on a federated network/peer resolution.
 * Keeping the orchestration disjoint here is the lib-side half of that
 * guarantee (the gate-side half is in `surface-router.ts`).
 *
 * Never throws — every failure becomes a `{ ok: false, reason }`.
 */

import type { PolicyPublic } from "../../../common/types/cortex-config";
import type { PublicScopePorts } from "./network-public-ports";

// =============================================================================
// Inputs + results
// =============================================================================

/** What `cortex network join public` supplies to the orchestration. */
export interface PublicJoinInputs {
  /**
   * Capability ids to announce to the public index (`<domain>.<entity>` grammar,
   * validated by the CLI). Empty = "discoverable presence, no advertised
   * capabilities".
   */
  capabilities: readonly string[];
  /**
   * Allowlist of public-scope SENDER principal ids (`--allow`). When EMPTY, the
   * opt-in is written deny-by-default (`enabled: false`) — the OQ1 safe
   * posture. When non-empty, inbound public is enabled but admits ONLY these
   * principals.
   */
  allowPrincipals: readonly string[];
}

export interface PublicJoinResult {
  ok: boolean;
  /** Ordered, human-readable step log. Rendered by the CLI. */
  steps: string[];
  reason?: string;
  /** The `policy.public` block that was written (on success). */
  written?: PolicyPublic;
}

export interface PublicLeaveResult {
  ok: boolean;
  steps: string[];
  reason?: string;
  /** True when the stack was never opted into public (clean no-op leave). */
  notJoined?: boolean;
}

// =============================================================================
// join public
// =============================================================================

export async function joinPublic(
  inputs: PublicJoinInputs,
  ports: PublicScopePorts,
): Promise<PublicJoinResult> {
  const steps: string[] = [];

  // (a) Announce capabilities to the public index. A failure here is fatal:
  // without a successful announce the stack is not discoverable, and we must
  // NOT proceed to flip the local bus open (no half-join).
  const announce = await ports.registry.announceCapabilities(inputs.capabilities);
  if (!announce.ok) {
    return { ok: false, steps, reason: `public capability announce failed: ${announce.reason}` };
  }
  steps.push(
    inputs.capabilities.length > 0
      ? `announced ${inputs.capabilities.length.toString()} capability(ies) to the public index (${announce.note})`
      : `registered a public presence with no advertised capabilities (${announce.note})`,
  );

  // (b) Subscribe public.> (idempotent — never double-bind the same pattern,
  // the cortex#491 double-message footgun).
  if (ports.subscribe.hasPublicSubscription()) {
    steps.push("public.> already subscribed — no change");
  } else {
    ports.subscribe.addPublicSubscription();
    steps.push("subscribed public.> (added to nats.subjects[])");
  }

  // (c) Write the policy.public opt-in — the INBOUND allowlist gate. OQ1 SAFE
  // DEFAULT: no --allow ⇒ enabled:false (announce/discover only, inbound stays
  // closed); --allow ⇒ enabled:true gated to the named principals ONLY. Never
  // an open-claim posture.
  const enabled = inputs.allowPrincipals.length > 0;
  const written: PolicyPublic = {
    enabled,
    allow_principals: [...inputs.allowPrincipals],
    announce_capabilities: [...inputs.capabilities],
  };
  ports.policy.writePublic(written);
  steps.push(
    enabled
      ? `wrote policy.public — inbound ENABLED, allowlist-gated to [${written.allow_principals.join(", ")}] (no open claim)`
      : "wrote policy.public — inbound DISABLED (OQ1 safe default: announce/discover only; inbound public stays closed)",
  );

  // (d) Restart so the new public.> subscription takes effect.
  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `opt-in written but daemon restart failed: ${restart.reason}`,
      written,
    };
  }
  steps.push("restarted stack daemon");

  return { ok: true, steps, written };
}

// =============================================================================
// leave public
// =============================================================================

export async function leavePublic(
  ports: PublicScopePorts,
): Promise<PublicLeaveResult> {
  const steps: string[] = [];
  const wasSubscribed = ports.subscribe.hasPublicSubscription();
  const wasOptedIn = ports.policy.readPublic() !== undefined;

  if (!wasSubscribed && !wasOptedIn) {
    return {
      ok: true,
      steps: ["not opted into the public scope — nothing to do"],
      notJoined: true,
    };
  }

  // Deregister from the public index (register with empty capabilities). A
  // deregister failure is fatal — we must not leave the stack advertised on
  // the public index while tearing down the local subscription (no half-leave).
  const dereg = await ports.registry.deregisterCapabilities();
  if (!dereg.ok) {
    return { ok: false, steps, reason: `public deregister failed: ${dereg.reason}` };
  }
  steps.push(`deregistered from the public index (${dereg.note})`);

  // Unsubscribe public.> (idempotent).
  ports.subscribe.removePublicSubscription();
  steps.push("unsubscribed public.> (removed from nats.subjects[])");

  // Clear the policy.public opt-in (reverts the surface-router to deny-all).
  ports.policy.writePublic(undefined);
  steps.push("removed policy.public — surface-router reverts to deny-all-public");

  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `opt-in removed but daemon restart failed: ${restart.reason}`,
    };
  }
  steps.push("restarted stack daemon");

  return { ok: true, steps };
}
