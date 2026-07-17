/**
 * Capability dual-accept WINDOW (cortex#2020 — RFC-0008 §4 follow-ups, Wave 3
 * of epic myelin#286).
 *
 * RFC-0008 converged the capability-identifier grammar (§4.1) and ratified a
 * directional SEGMENT-PREFIX match rule (§4.2), both codified in
 * `@the-metafactory/myelin/wire/capability` (myelin PR #293 — the adversarially
 * reviewed codec). This module is the cortex-side ADDITIVE window that routes
 * acceptance and matching through that codec WITHOUT a flag-day break:
 *
 *   - {@link capabilityIdAcceptedInWindow} — an id is accepted iff the ratified
 *     ./wire grammar admits it OR the legacy cortex `CAPABILITY_ID_REGEX`
 *     (underscore-permissive) admits it. The ratified grammar is a strict
 *     SUBSET of the legacy regex, so this disjunction equals today's acceptance
 *     set EXACTLY — an underscore id (`code_review`) keeps being accepted
 *     because the legacy disjunct still admits it. The value is the seam: at
 *     flag-day R the legacy disjunct is dropped and acceptance narrows to the
 *     ratified grammar in one edit.
 *
 *   - {@link capabilitySegmentPrefixMatches} — the ratified §4.2 matcher,
 *     surfaced as a boolean. Callers OR it ALONGSIDE their existing
 *     exact-membership check so a segment-prefix request is ACCEPTED without
 *     removing any match that lands today (dual-accept). A malformed id — e.g.
 *     an underscore id the ratified grammar rejects — yields `false` here, so
 *     the caller's existing exact-string path is what keeps those matching
 *     during the window.
 *
 * WINDOW SEMANTICS (the invariant every caller relies on): this module only
 * ever WIDENS. It never rejects an id today's code accepts, and never removes a
 * match today's code makes. The regex TIGHTEN (dropping the legacy disjunct)
 * and the emitter-side underscore→hyphen migration are FLAG-DAY work — NOT done
 * here; see the `TODO(#2020/flag-day)` markers at the grammar-validation sites.
 */

import {
  parseCapabilityId,
  matchCapabilityId,
} from "@the-metafactory/myelin/wire/capability";

import { CAPABILITY_ID_REGEX } from "./capability";

/**
 * Grammar acceptance under the dual-accept window (RFC-0008 §4.1).
 *
 * Accept iff the ratified ./wire grammar admits `id` OR the legacy
 * underscore-permissive `CAPABILITY_ID_REGEX` admits it. Because the ratified
 * grammar is a subset of the legacy regex, the result equals the legacy regex
 * ALONE for every input — the window changes nothing an input is accepted or
 * rejected on today. Kept as an explicit disjunction (rather than just calling
 * the legacy regex) so the ./wire routing is in place and flag-day R is a
 * one-line deletion of the legacy disjunct.
 */
export function capabilityIdAcceptedInWindow(id: string): boolean {
  // TODO(#2020/flag-day): at flag-day R drop the ` || CAPABILITY_ID_REGEX.test(id)`
  // disjunct so acceptance narrows to the ratified ./wire grammar (underscore
  // ids stop being accepted — they migrate emitter-side first).
  return parseCapabilityId(id).ok || CAPABILITY_ID_REGEX.test(id);
}

/**
 * The ratified RFC-0008 §4.2 directional segment-prefix match, as a boolean.
 *
 * Returns true iff `required`'s segments are a WHOLE-SEGMENT prefix of
 * `advertised`'s (`code-review` matches `code-review.typescript`; the reverse
 * does not). Either id failing the ratified grammar is a hard non-match — an
 * underscore id yields `false`, so callers MUST keep their existing
 * exact-string membership check to preserve today's behavior for such ids
 * during the window.
 */
export function capabilitySegmentPrefixMatches(
  required: string,
  advertised: string,
): boolean {
  const result = matchCapabilityId({ required, advertised });
  return result.ok && result.value.match;
}

/**
 * Convenience for the consumer accept path: does ANY entry in an agent's
 * advertised capability set satisfy the ratified §4.2 match for `required`?
 *
 * This is purely the ADDED disjunct — a caller ORs it with its existing
 * `capabilities.includes(...)` exact-membership (and any bespoke generic-parent
 * fallback), so today's matches are untouched and segment-prefix matches are
 * added on top.
 */
export function anyAdvertisedSegmentPrefixMatches(
  required: string,
  advertised: readonly string[],
): boolean {
  return advertised.some((cap) => capabilitySegmentPrefixMatches(required, cap));
}
