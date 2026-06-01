/**
 * IAW CFG.b.3 — shared, fail-loud validator for the `nats.subjects` block.
 *
 * `nats.subjects` is the single place subject overrides live (CFG.b.2): the
 * push-mode broad-pattern subscriber list the daemon binds at boot. It is the
 * landmine behind the double-message problem — a duplicate or malformed pattern
 * here re-creates a boot-subscriber that double-binds the same handler set, so
 * every inbound chat/Direct/Delegate envelope is delivered AND dispatched twice
 * (cortex#491, the `pre-natsdedup` backup era). The whole point of isolating the
 * block in `system.yaml` is that this validation can be the one true gate.
 *
 * The contract is therefore: a malformed `nats.subjects` block fails LOUDLY at
 * config load — a clear zod error — rather than parsing into a silently-partial
 * config that would double-publish. "Malformed" means any of:
 *
 *   1. not an array of strings (caught by the element schema);
 *   2. an entry that is not a syntactically-valid NATS subject pattern
 *      (whitespace, empty segments, `>` not in final position, etc.);
 *   3. a DUPLICATE entry — two identical patterns bind the same subscription
 *      twice, which is exactly the double-publish footgun.
 *
 * Why centralised: the block lives in TWO schemas during the MIG-7.2 overlap
 * window — `NatsConfigSchema` (cortex-config.ts) and the inline `nats` block in
 * `AgentConfigSchema` (config.ts). Both flow to the same runtime subscribe path
 * (`MyelinRuntime`'s boot-time `nats.subjects` loop), so both can double-publish.
 * One validator, one source of truth — mirrors the `nkey.ts` precedent.
 */

import { z } from "zod/v4";

/**
 * NATS subject pattern grammar for `nats.subjects[]` entries.
 *
 * Unlike the federation `accept_subjects[]`/`deny_subjects[]` grammar (which is
 * deliberately placeholder-free), `nats.subjects[]` patterns carry the
 * `{principal}` / `{stack}` substitution tokens that `makeSubjectPlaceholderSubstituter`
 * resolves at runtime (see `src/bus/myelin/runtime.ts`). The grammar therefore
 * admits, per dotted segment:
 *
 *   - a lowercase-alphanumeric token: `[a-z][a-z0-9_-]*`
 *   - a single-segment wildcard: `*`
 *   - a placeholder token: `{principal}` or `{stack}`
 *
 * plus an optional trailing `>` multi-segment wildcard as the FINAL segment only.
 *
 * Segments are dot-separated with no empty segments (no leading/trailing dot, no
 * `..`), and no whitespace anywhere. A bare `>` is permitted here (unlike the
 * federation grammar) — `nats.subjects` is the local subscriber interest list,
 * not a federation accept-list, so a catch-all local subscription is a legitimate
 * (if rarely-wanted) choice the principal makes explicitly.
 */
export const NATS_SUBSCRIBE_SUBJECT_RE =
  /^(([a-z][a-z0-9_-]*|\*|\{principal\}|\{stack\}))(\.([a-z][a-z0-9_-]*|\*|\{principal\}|\{stack\}))*(\.>)?$|^>$/;

/**
 * Validate a single `nats.subjects[]` entry. Returns an error string when the
 * entry is malformed, or `null` when it is a valid subscribe pattern. Pulled
 * out so the zod schema and any imperative caller share one rule.
 */
export function invalidSubscribeSubjectReason(subject: string): string | null {
  if (subject.length === 0) {
    return "empty subject pattern";
  }
  if (!NATS_SUBSCRIBE_SUBJECT_RE.test(subject)) {
    return (
      `"${subject}" is not a valid NATS subscribe pattern — expected ` +
      `dot-separated lowercase segments (or the {principal}/{stack} placeholders ` +
      `or a "*" single-segment wildcard), with an optional trailing ">" ` +
      `multi-segment wildcard as the final segment`
    );
  }
  return null;
}

/**
 * Find the first duplicate entry in a subjects list, or `null` when all entries
 * are distinct. Duplicate patterns are the double-bind footgun: listing the same
 * pattern twice re-subscribes the same handler set, doubling delivery.
 */
export function firstDuplicateSubject(subjects: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const s of subjects) {
    if (seen.has(s)) return s;
    seen.add(s);
  }
  return null;
}

/**
 * The `nats.subjects` field schema — an array of validated subscribe patterns
 * that is also rejected, at parse time, for duplicate entries. Defaults to `[]`
 * (the documented pull-only default per cortex#337). Shared verbatim by
 * `NatsConfigSchema` (cortex-config.ts) and the inline `nats` block in
 * `AgentConfigSchema` (config.ts) so the two cannot drift.
 *
 * The element-level pattern check (`.refine` per entry) catches malformed
 * patterns with a precise message; the array-level `.superRefine` catches a
 * duplicate and attaches the error to the offending index so the principal sees
 * exactly which line in their `system.yaml` to delete. Either failure throws a
 * zod error at `loadConfigWithAgents` — a loud load-time failure, never a silent
 * partial config.
 */
export const NatsSubjectsSchema = z
  .array(
    z.string().min(1).superRefine((s, ctx) => {
      const reason = invalidSubscribeSubjectReason(s);
      if (reason !== null) {
        ctx.addIssue({ code: "custom", message: `nats.subjects: ${reason}` });
      }
    }),
  )
  .superRefine((subjects, ctx) => {
    const seen = new Map<string, number>();
    for (const [i, s] of subjects.entries()) {
      const firstAt = seen.get(s);
      if (firstAt !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message:
            `nats.subjects: duplicate subject pattern "${s}" ` +
            `(first seen at index ${firstAt}). Duplicate patterns double-bind the ` +
            `same subscription, which delivers and dispatches every matching ` +
            `envelope twice (the double-message problem). Remove the duplicate.`,
        });
      } else {
        seen.set(s, i);
      }
    }
  })
  .default([]);
