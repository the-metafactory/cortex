/**
 * cortex#1503 — pure NATS subject-set algebra for stream provisioning.
 *
 * Two stacks of one principal that share a NATS account (`$G`, or a single
 * agents account) share every fixed-name cortex stream (`CODE_REVIEW`,
 * `REVIEW_LIFECYCLE`, `DEV_IMPLEMENT`, `BRAIN_TASKS`, `RELEASE`). Each stack's
 * subjects carry its own `{principal}.{stack}` segments, so the stream has to
 * hold the UNION of both stacks' subjects. `provisionReviewStream` uses these
 * predicates to decide which of this stack's subjects the live stream already
 * captures, which it may add, and which it must leave alone.
 *
 * Token grammar: `.`-separated tokens, `*` matches exactly one token, a
 * terminal `>` matches one or more tokens.
 */

/**
 * True iff every concrete subject matching `inner` also matches `outer` —
 * i.e. a stream carrying `outer` already stores everything `inner` names.
 * `local.*.*.tasks.code-review.>` (arc's provisioning) covers
 * `local.alice.default.tasks.code-review.*`; the reverse is false.
 */
export function subjectCovers(outer: string, inner: string): boolean {
  const o = outer.split(".");
  const i = inner.split(".");
  for (const [k, ot] of o.entries()) {
    // Terminal `>` swallows the rest, provided `inner` still has ≥1 token here.
    if (ot === ">") return i.length > k;
    const it = i[k];
    if (it === undefined) return false;
    // `inner`'s multi-token tail can only be covered by an `outer` `>`.
    if (it === ">") return false;
    if (ot === "*") continue;
    // A literal `outer` token covers only the identical literal.
    if (it === "*" || ot !== it) return false;
  }
  return o.length === i.length;
}

/**
 * True iff at least one concrete subject matches both `a` and `b`. JetStream
 * rejects a stream config whose subjects overlap, so a subject that overlaps
 * an existing one WITHOUT being covered by it must never be added.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const at = a.split(".");
  const bt = b.split(".");
  for (const [k, x] of at.entries()) {
    const y = bt[k];
    if (y === undefined) break;
    if (x === ">" || y === ">") return true;
    if (x === "*" || y === "*") continue;
    if (x !== y) return false;
  }
  return at.length === bt.length;
}

/** What `provisionReviewStream` may do with a live stream's subjects. */
export interface SubjectUnionPlan {
  /** Desired subjects no existing subject covers, safe to append (no partial overlap). */
  missing: string[];
  /** Desired subjects that partially overlap an existing subject — adding them would be rejected. */
  conflicting: string[];
}

/**
 * Split `desired` into subjects the live stream already covers (dropped),
 * subjects it can safely gain (`missing`), and subjects that partially overlap
 * a live subject (`conflicting`). Never proposes removing a live subject — the
 * other stacks sharing the stream own those.
 */
export function planSubjectUnion(
  existing: readonly string[],
  desired: readonly string[],
): SubjectUnionPlan {
  const missing: string[] = [];
  const conflicting: string[] = [];
  for (const d of new Set(desired)) {
    if (existing.some((e) => subjectCovers(e, d))) continue;
    if (existing.some((e) => subjectsOverlap(e, d))) {
      conflicting.push(d);
    } else {
      missing.push(d);
    }
  }
  return { missing, conflicting };
}
