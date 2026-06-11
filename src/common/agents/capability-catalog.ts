/**
 * B-0 (cortex#1021, design-bot-packs §7 + §11) — effective capability catalog.
 *
 * Today a principal who adds an agent declaring `runtime.capabilities: [X]`
 * must ALSO hand-edit the top-level `capabilities[]` block to add an entry for
 * `X` listing that agent in `provided_by[]`. That manual cross-edit is the
 * "step 3" the bot-packs design kills: an agent declaring a capability IS, by
 * declaration, a provider of it.
 *
 * This module derives the EFFECTIVE catalog from two inputs:
 *
 *   1. the explicit top-level `capabilities[]` entries (authored for their
 *      description / tags / rate / cost / explicit provider lists), and
 *   2. the per-agent `runtime.capabilities[]` declarations (each declaring
 *      its owning agent as a provider of that capability id).
 *
 * The derivation (Sage cortex#1027 — explicit `provided_by[]` is AUTHORITATIVE):
 *   - an EXPLICIT catalog entry's `provided_by[]` is the authoritative grant
 *     list and is passed through UNCHANGED. A config that catalogues a
 *     capability has deliberately scoped who may provide it; an agents.d
 *     fragment MUST NOT self-grant itself into that list by merely declaring
 *     `runtime.capabilities: [X]`. Letting it would turn `provided_by[]` from an
 *     explicit allow-list into a self-asserted union before dispatch selects a
 *     provider — a capability-authorization bypass. So derivation only ever
 *     ADDS providers where the principal expressed NO explicit grant list:
 *   - synthesizes a catalog entry for any capability id that ONLY exists via
 *     agent declaration (NO explicit entry) — id + derived `provided_by[]` +
 *     empty description + empty tags, no rate/cost. This is the "step 3"
 *     convenience: a brand-new capability nobody catalogued is provided by the
 *     agents that declare it, because there is no explicit grant to honor.
 *
 * Conservative rule, stated once: explicit entry present → derived agents are
 * IGNORED for that capability (the catalog wins, full stop). Explicit entry
 * absent → derived agents synthesize the entry. There is no middle "augment an
 * explicit entry" path — that was the bypass.
 *
 * Backwards compatibility: a config whose explicit `capabilities[]` already
 * lists every provider derives an IDENTICAL catalog (explicit entries pass
 * through unchanged; only declaration-only capabilities synthesize). Existing
 * configs stay valid and equivalent.
 *
 * This is pure derivation over already-parsed structures — it performs NO
 * validation. The cross-validator on `CortexConfigSchema` still rejects an
 * EXPLICIT `provided_by[]` entry that names a nonexistent agent (a typo guard);
 * derived providers can only ever be real agent ids because they come from the
 * agent list itself.
 */

import type { Agent } from "../types/cortex-config";
import type { Capability } from "../types/capability";

/**
 * Derive the effective capability catalog from the explicit catalog plus the
 * agents' `runtime.capabilities[]` declarations.
 *
 * @param explicit  the top-level `capabilities[]` block (may be empty).
 * @param agents    the merged agent set (inline + fragments).
 * @returns a new array; inputs are not mutated. Order: explicit entries first
 *          (in their declared order, each with its authoritative `provided_by[]`
 *          passed through UNCHANGED — Sage cortex#1027), then synthesized
 *          entries for capabilities that exist only via agent declaration (in
 *          first-seen agent-declaration order).
 */
export function deriveEffectiveCapabilityCatalog(
  explicit: readonly Capability[],
  agents: readonly Agent[],
): Capability[] {
  // capability id -> ordered, de-duplicated list of agent ids that declare it
  // via runtime.capabilities[]. First-seen order across the agent list.
  const derivedProvidersByCap = new Map<string, string[]>();
  // Track first-seen order of capability ids that appear ONLY via declaration
  // (used to order synthesized entries deterministically).
  const declaredCapOrder: string[] = [];

  for (const agent of agents) {
    const caps = agent.runtime?.capabilities ?? [];
    for (const capId of caps) {
      let providers = derivedProvidersByCap.get(capId);
      if (providers === undefined) {
        providers = [];
        derivedProvidersByCap.set(capId, providers);
        declaredCapOrder.push(capId);
      }
      if (!providers.includes(agent.id)) {
        providers.push(agent.id);
      }
    }
  }

  const explicitIds = new Set(explicit.map((c) => c.id));

  // 1. Explicit entries pass through UNCHANGED (Sage cortex#1027 — authorization
  //    fix). An explicit `provided_by[]` is the principal's authoritative grant
  //    list; an agents.d fragment must NOT self-grant into it by declaring the
  //    capability. We deliberately do NOT union derived providers here — doing so
  //    let a fragment widen an explicit allow-list it was never granted into.
  //    The explicit catalog is the source of truth for catalogued capabilities;
  //    derivation only synthesizes entries for UNCATALOGUED ones (step 2 below).
  const authoritative: Capability[] = [...explicit];

  // 2. Synthesize entries for declaration-only capabilities.
  const synthesized: Capability[] = [];
  for (const capId of declaredCapOrder) {
    if (explicitIds.has(capId)) continue;
    const providers = derivedProvidersByCap.get(capId) ?? [];
    synthesized.push({
      id: capId,
      // Synthesized entries carry an empty description (design §11 B-0). The
      // catalog is still queryable by id + providers; a principal who wants a
      // human-readable description authors an explicit entry,       // for description/tags while still being augmented with derived providers.
      description: "",
      tags: [],
      provided_by: providers,
    });
  }

  return [...authoritative, ...synthesized];
}
