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
 * The derivation:
 *   - augments each explicit entry's `provided_by[]` with every agent that
 *     declares the capability (union, dedup, stable order: explicit providers
 *     first in their declared order, then newly-derived providers in agent
 *     declaration order);
 *   - synthesizes a catalog entry for any capability id that ONLY exists via
 *     agent declaration (no explicit entry) — id + derived `provided_by[]` +
 *     empty description + empty tags, no rate/cost.
 *
 * Backwards compatibility: a config whose explicit `capabilities[]` already
 * lists every provider derives an IDENTICAL catalog (the derived providers are
 * already present, so the union is a no-op). Existing configs stay valid and
 * equivalent.
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
 *          (in their declared order, each with an augmented `provided_by[]`),
 *          then synthesized entries for capabilities that exist only via agent
 *          declaration (in first-seen agent-declaration order).
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

  // 1. Augment each explicit entry with derived providers (union, stable).
  const augmented: Capability[] = explicit.map((cap) => {
    const derived = derivedProvidersByCap.get(cap.id) ?? [];
    const merged = unionPreserveOrder(cap.provided_by, derived);
    // Only allocate a new object when the provider list actually changed —
    // keeps the no-op (already-complete) config byte-identical.
    if (merged.length === cap.provided_by.length) {
      return cap;
    }
    return { ...cap, provided_by: merged };
  });

  // 2. Synthesize entries for declaration-only capabilities.
  const synthesized: Capability[] = [];
  for (const capId of declaredCapOrder) {
    if (explicitIds.has(capId)) continue;
    const providers = derivedProvidersByCap.get(capId) ?? [];
    synthesized.push({
      id: capId,
      // Synthesized entries carry an empty description (design §11 B-0). The
      // catalog is still queryable by id + providers; a principal who wants a
      // human-readable description authors an explicit entry, which then wins
      // for description/tags while still being augmented with derived providers.
      description: "",
      tags: [],
      provided_by: providers,
    });
  }

  return [...augmented, ...synthesized];
}

/**
 * Union two ordered string lists, preserving order: every element of `first`
 * in its order, then every element of `second` not already present, in its
 * order. De-duplicates within and across both lists.
 */
function unionPreserveOrder(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of first) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  for (const x of second) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
