/**
 * CO-7 M3 (epic cortex#939) — the **public-offering ⇒ non-local execution
 * backend** FAIL-CLOSED GATE.
 *
 * ## The threat (design §6 attack #1 / #6, M3, ADR-0008 DD-CO-6)
 *
 * A public review must NEVER execute the PR's code on the principal's own
 * machine — a hijacked-into-tool-use public reviewer running PR code locally is
 * remote code execution. The design's M3 mitigation reframes the F-5b remote
 * sandbox (`ExecutionBackend` `cloudflare`/`e2b`, cortex#868/#927) as THE
 * isolation boundary for untrusted public work: a public offering should REQUIRE
 * a non-local `ExecutionBackend`.
 *
 * ## The honest scope (deferred infra → a safety gate NOW)
 *
 * The non-local backend itself is **deferred infra** (F-5b / cortex#927; the
 * CO-7 follow-up tracking the backend is **cortex#978** — only `LocalBackend`
 * is implemented today). CO-7 does NOT build the backend. What it
 * DOES build — now — is the **fail-closed gate that enforces the requirement**:
 * a config that offers a capability at `public` scope while the resolved
 * execution backend is `local` (or unset → defaults to `local`) is REJECTED at
 * config-validation / boot time. This turns the deferred dependency into a
 * safety gate rather than a hole: you cannot stand up a public offering on a
 * local backend, full stop. When F-5b lands and the stack sets
 * `execution.default` to a non-local backend, the gate passes.
 *
 * This is the prevent-side: a public offering with a local backend refuses to
 * boot, instead of silently running untrusted PR code on the principal's host.
 *
 * ## Why config-time (not runtime)
 *
 * The check is purely a function of static config (`policy.offerings[].scopes`
 * × `execution.default`/`execution.backends[]`), so it belongs at
 * config-validation — surfaced as a Zod issue alongside the other offering
 * cross-block checks (`CortexConfigSchema.superRefine`). A boot that fails this
 * gate never reaches the consumer wiring, so no public consumer is ever bound on
 * a local-backed stack. Pure + total so it is unit-testable in isolation.
 *
 * Anchors: docs/design-capability-offering.md §6 (M3) · ADR-0008 DD-CO-6 ·
 *          src/runner/execution-backend.ts (the backend abstraction) ·
 *          cortex#927 (the F-5b backend — DEFERRED).
 */

import type { OfferScope } from "./offering";

/** The narrow execution-config projection the gate reads. Mirrors
 *  `ExecutionConfigSchema` (`default` + `backends[]`) without importing the Zod
 *  schema, so the gate stays decoupled + cheaply testable. */
export interface ExecutionConfigView {
  /** The default backend name (`ExecutionConfigSchema.default`, defaults `"local"`). */
  default: string;
  /** Declared backends — each carries a `type`. */
  backends: readonly { name: string; type: string }[];
}

/** The narrow offering projection the gate reads — capability + its scopes. */
export interface OfferingScopesView {
  capability: string;
  scopes: readonly OfferScope[];
}

/** A single gate violation — a public offering on a local-resolved backend. */
export interface PublicBackendGateViolation {
  /** Index into the offerings array (for the Zod issue path). */
  offeringIndex: number;
  /** The capability offered public. */
  capability: string;
  /** The resolved backend name that is (impermissibly) local. */
  resolvedBackend: string;
  /** The human-readable refusal message. */
  message: string;
}

/** The local backend name — the only backend implemented today
 *  (`LocalBackend.name`). A public offering on THIS backend is the hole the
 *  gate closes. */
export const LOCAL_BACKEND_NAME = "local";

/**
 * Resolve whether the stack's DEFAULT execution backend is non-local (i.e. a
 * real F-5b sandbox), given the execution config.
 *
 * A backend is "non-local" when `execution.default` names a declared backend
 * whose `type` is one of the remote sandbox types (`cloudflare`/`e2b`/`ssh`/
 * `custom`) — NOT the built-in `local`. An unset/`"local"` default, or a default
 * naming a backend that isn't declared (which `BackendRegistry.get` would throw
 * on at runtime, but we treat as "not a usable non-local backend" here), is
 * local-or-unusable ⇒ NOT satisfied.
 *
 * Pure + total.
 */
export function resolvesToNonLocalBackend(exec: ExecutionConfigView | undefined): boolean {
  if (exec === undefined) return false; // no execution config ⇒ local default.
  const name = exec.default;
  if (name === LOCAL_BACKEND_NAME || name.length === 0) return false;
  const declared = exec.backends.find((b) => b.name === name);
  if (declared === undefined) {
    // Default names an UNDECLARED backend — not a usable non-local backend
    // (it would throw at registry lookup). Fail closed: treat as local-or-worse.
    return false;
  }
  // A declared backend whose type is the local built-in is still local.
  return declared.type !== LOCAL_BACKEND_NAME;
}

/**
 * The M3 gate: for every offering that includes `public` scope, REQUIRE the
 * stack's resolved execution backend to be non-local. Returns the list of
 * violations (empty ⇒ the gate passes).
 *
 * Byte-identical / no-op when:
 *   - there are no offerings, or none is `public`-scoped (the default-deny case —
 *     every live stack today), OR
 *   - the resolved backend is non-local (F-5b configured).
 *
 * Pure + total: no I/O, no throw. Batch-emits all violations so a config with
 * several public offerings surfaces them in one pass.
 */
export function checkPublicOfferingBackendGate(
  offerings: readonly OfferingScopesView[] | undefined,
  exec: ExecutionConfigView | undefined,
): PublicBackendGateViolation[] {
  if (offerings === undefined || offerings.length === 0) return [];
  // Resolve ONCE — the backend is a stack-wide property.
  if (resolvesToNonLocalBackend(exec)) return []; // gate satisfied.

  const resolvedBackend = exec?.default ?? LOCAL_BACKEND_NAME;
  const violations: PublicBackendGateViolation[] = [];
  offerings.forEach((offering, offeringIndex) => {
    if (!offering.scopes.includes("public")) return;
    violations.push({
      offeringIndex,
      capability: offering.capability,
      resolvedBackend,
      message:
        `policy.offerings[${offeringIndex}] offers capability "${offering.capability}" at ` +
        `'public' scope, but the stack's execution backend resolves to ` +
        `"${resolvedBackend}" (local). A public offering runs UNTRUSTED, ` +
        `attacker-controlled PR content and MUST be isolated on a non-local ` +
        `ExecutionBackend (F-5b sandbox: cloudflare/e2b — cortex#927) so PR code ` +
        `never executes on the principal's host (design §6 M3, ADR-0008 DD-CO-6). ` +
        `Set execution.default to a declared non-local backend before offering ` +
        `"${offering.capability}" publicly, or narrow its offer-scope.`,
    });
  });
  return violations;
}
