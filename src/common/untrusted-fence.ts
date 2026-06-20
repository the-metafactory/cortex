/**
 * Leaf module — the injection-resistant untrusted-content fence primitives.
 *
 * Extracted from `runner/untrusted-content-boundary.ts` (CO-7 M1) so the same
 * delimiter + neutralisation logic can be reused at OTHER network→agent
 * boundaries (e.g. the F-6 reflex activation bridge, which quarantines a
 * webhook-controlled activation payload before it reaches a dispatch prompt)
 * WITHOUT importing the review-specific prompt builder — that would pull a
 * `runner/` value dependency into `bus/` and risk an import cycle.
 *
 * Pure + dependency-free + deterministic.
 */

/** Opening delimiter of an untrusted-content data fence. */
export const UNTRUSTED_OPEN = "<untrusted-content>";
/** Closing delimiter of an untrusted-content data fence. */
export const UNTRUSTED_CLOSE = "</untrusted-content>";

/**
 * Neutralise any attempt to forge the fence delimiter inside requester content
 * so an attacker cannot terminate (or open) the untrusted block early and have
 * subsequent text read as trusted (the classic delimiter-injection escape).
 *
 * The neutralisation is **robust against normalisation**: rather than breaking
 * the delimiter with an invisible (zero-width) character — which reconstructs
 * the literal token the moment any downstream step strips zero-width chars — we
 * escape the ANGLE BRACKETS themselves to their HTML-entity form (`<`→`&lt;`,
 * `>`→`&gt;`). The result can never be the literal `<untrusted-content>` /
 * `</untrusted-content>` token under any whitespace/zero-width normalisation,
 * because the `<`/`>` characters that DEFINE the delimiter are gone. It stays
 * fully legible to a human and to the model (which is told the fence is the
 * literal angle-bracket form), so a forged `&lt;/untrusted-content&gt;` reads as
 * inert escaped text, not a structural delimiter.
 *
 * Because EVERY `<`/`>` in requester content is escaped, this also incidentally
 * neutralises any other angle-bracket pseudo-tag an attacker might use to mimic
 * a system marker.
 *
 * Also strips NUL and other C0 control chars that could confuse a downstream
 * renderer, except tab/newline/carriage-return which are legitimate in free
 * text.
 *
 * Idempotency note: `&lt;`/`&gt;` contain no `<`/`>`, so a second pass is a
 * no-op — escaping never compounds.
 */
export function neutraliseFenceBreakout(value: string): string {
  return (
    value
      // Strip C0 controls FIRST (except \t \n \r) so a control char can't be
      // used to split a delimiter past the bracket-escape.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      // Escape the angle brackets that DEFINE any fence/pseudo-tag delimiter.
      // No `<`/`>` survives ⇒ no literal `<untrusted-content>`/`</…>` can form,
      // regardless of any later zero-width / whitespace normalisation.
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  );
}
