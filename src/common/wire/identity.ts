/**
 * The canonical wire-identity codec (WP-2, cortex#1878; epic #1876).
 *
 * ## Why this module exists
 *
 * `did:mf:` is overloaded across three structurally-indistinguishable identity
 * classes — **principal**, **stack**, and **agent** — minted independently at
 * ~8 sites and compared with `===`. A `StackDid === PrincipalDid` comparison
 * silently returns `false` and drops presence. That is the open jc-fold bug.
 *
 * Two mechanisms make that class of bug unrepresentable:
 *
 * 1. **Branded types.** `StackDid` and `PrincipalDid` are nominally distinct
 *    (zero runtime cost), so `stackDid(x) === principalDid(y)` is a *compile*
 *    error, not a silent runtime `false`.
 * 2. **One module owns every transform.** Parsing and rendering of principal
 *    ids, stack slugs, stack ids, DIDs, and federated subjects happen here and
 *    only here.
 *
 * ## Fail loud, never fabricate
 *
 * Parse constructors return a discriminated {@link ParseResult}. They never
 * throw and — critically — they **never fabricate a `default`**. The live
 * fabrication this rules out is `federation-reconciler.ts:459`, which turns a
 * malformed `stack_id` into a silent `"default"` stack.
 *
 * Render constructors are total over *branded* inputs. Where an input pair is
 * individually legal yet renders a DID the wire grammar rejects (see
 * {@link stackDid}), they throw {@link WireIdentityError} rather than emit an
 * invalid identity or silently mutate the caller's identity.
 *
 * ## Scope discipline
 *
 * - This module **encodes today's rules**; it invents none. Every regex below
 *   is transcribed from a live call site, cited inline.
 * - It **does not decide the DID encoding**. Because slugs permit `-`,
 *   `did:mf:{p}-{s}` is ambiguous with `did:mf:{principal}`. That decision is
 *   **WP-4 (#1880)**. {@link parseDid} therefore reports `"ambiguous"` and
 *   never guesses.
 * - It **migrates no call site**. That is WP-5, held behind review.
 *
 * @see docs/adr/0004-stack-slug-authority.md
 */

// ---------------------------------------------------------------------------
// Branded types — nominal typing, zero runtime cost
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/** Attach a compile-time-only nominal tag `B` to the structural type `T`. */
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A principal's id — the human/org authority. e.g. `"andreas"`. */
export type PrincipalId = Brand<string, "PrincipalId">;

/** The trailing segment of a stack id. e.g. `"meta-factory"`. */
export type StackSlug = Brand<string, "StackSlug">;

/** The canonical `{principal}/{stack}` literal. e.g. `"andreas/meta-factory"`. */
export type StackId = Brand<string, "StackId">;

/** A principal's DID. e.g. `"did:mf:andreas"`. */
export type PrincipalDid = Brand<string, "PrincipalDid">;

/** A stack's DID. e.g. `"did:mf:andreas-meta-factory"`. */
export type StackDid = Brand<string, "StackDid">;

/** An agent's DID. e.g. `"did:mf:echo"`. */
export type AgentDid = Brand<string, "AgentDid">;

/** A `federated.{principal}.{stack}.{...}` NATS subject. */
export type FederatedSubject = Brand<string, "FederatedSubject">;

/** A parsed `{principal}/{stack}` pair — the two halves, never re-spliced by hand. */
export interface StackScope {
  principal: PrincipalId;
  stack: StackSlug;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated parse outcome. Parse constructors never throw and never default. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Thrown by a render constructor when its inputs cannot produce a valid wire identity. */
export class WireIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireIdentityError";
  }
}

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const err = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// Today's rules — transcribed, not invented. Each cites its live source.
// ---------------------------------------------------------------------------

/** The `did:mf:` method prefix. */
export const DID_PREFIX = "did:mf:";

/**
 * A principal id. Source: `src/cli/cortex/commands/network.ts:244`,
 * `provision-stack.ts:86`, `stack.ts:74`. Note: **no** `_`.
 */
export const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * A stack slug. Source: `src/cli/cortex/commands/network.ts:3832`,
 * `stack.ts:73`, `src/common/nats/hub-leaf-authorization.ts:48`.
 * Note: permits `_`, where {@link PRINCIPAL_ID_RE} does not. That asymmetry is
 * today's reality, not a choice made here.
 */
export const STACK_SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/** An agent id. Source: `src/cli/cortex/commands/creds.ts:77`. */
export const AGENT_ID_RE = /^[a-z0-9-]+$/;

/**
 * The authoritative wire DID grammar. Source: myelin
 * `src/identity/types.ts:1` (`DID_RE`), mirrored by
 * `src/bus/myelin/vendor/envelope.schema.json`. Permits `.` and `_`, forbids
 * **consecutive** hyphens — which is why `cortex.ts:1024` collapses `-+` runs.
 */
export const WIRE_DID_RE = /^did:mf:[a-z](?:[a-z0-9._]|-(?!-))+$/;

/** A single NATS subject token: no separator, no wildcard, non-empty. */
const SUBJECT_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/** The federated subject prefix. Source: `src/bus/jetstream/review-subjects.ts:49`. */
const FEDERATED_PREFIX = "federated";

// ---------------------------------------------------------------------------
// Parse constructors — fail loud, never fabricate
// ---------------------------------------------------------------------------

/** Parse a bare principal id. Rejects DIDs, slashes, uppercase, `_`, and `""`. */
export function parsePrincipalId(s: string): ParseResult<PrincipalId> {
  if (s.length === 0) return err("empty principal id");
  if (!PRINCIPAL_ID_RE.test(s)) return err(`principal id "${s}" violates ${String(PRINCIPAL_ID_RE)}`);
  return ok(s as PrincipalId);
}

/** Parse a bare stack slug. Rejects `.` (the NATS separator), slashes, and `""`. */
export function parseStackSlug(s: string): ParseResult<StackSlug> {
  if (s.length === 0) return err("empty stack slug");
  if (!STACK_SLUG_RE.test(s)) return err(`stack slug "${s}" violates ${String(STACK_SLUG_RE)}`);
  return ok(s as StackSlug);
}

/**
 * Parse a `{principal}/{stack}` stack id into its two halves.
 *
 * **Never fabricates a `default`.** `"andreas"`, `"andreas/"`, `"/default"` and
 * `""` all fail. Contrast `federation-reconciler.ts:459`, which today resolves
 * a malformed id to `stack = "default"` and silently mis-addresses the stack.
 *
 * Requires **exactly one** `/`. A 3-segment id is rejected rather than
 * arbitrated: `roster-read.ts:263` splits on the FIRST slash while
 * `stack-id.ts`'s `stackSlugFromStackId` splits on the LAST. They disagree, so
 * this codec refuses to pick a winner and fails loud instead.
 */
export function parseStackId(s: string): ParseResult<StackScope> {
  if (s.length === 0) return err("empty stack id");

  const parts = s.split("/");
  if (parts.length !== 2) {
    return err(`stack id "${s}" must contain exactly one "/" (got ${String(parts.length - 1)})`);
  }

  const [rawPrincipal, rawStack] = parts;
  const principal = parsePrincipalId(rawPrincipal ?? "");
  if (!principal.ok) return err(`stack id "${s}": ${principal.reason}`);

  const stack = parseStackSlug(rawStack ?? "");
  if (!stack.ok) return err(`stack id "${s}": ${stack.reason}`);

  return ok({ principal: principal.value, stack: stack.value });
}

/**
 * Classify a `did:mf:` identity into exactly one of the three classes.
 *
 * TODO(WP-4, cortex#1880) — **the disambiguation decision belongs here.**
 * Today every class' rule set overlaps every other's:
 *
 * - `did:mf:echo` is a legal principal id AND a legal agent id.
 * - `did:mf:andreas-meta-factory` is additionally a legal `{p}-{s}` stack pair,
 *   because {@link PRINCIPAL_ID_RE} permits `-`.
 *
 * So **no** well-formed DID is uniquely classifiable, and this function returns
 * `{ ok: false, reason: "ambiguous" }` for all of them rather than guessing.
 * `review-consumer.ts:1453` guesses today (splits on the first hyphen, assuming
 * principals contain none) — an assumption `PRINCIPAL_ID_RE` does not enforce.
 *
 * When WP-4 picks an encoding (a class prefix, a reserved separator, or a
 * hyphen ban in one class), amend the predicates below; the signature and every
 * caller stay unchanged, and `ok:true` becomes reachable.
 */
export function parseDid(s: string): ParseResult<PrincipalDid | StackDid | AgentDid> {
  if (!WIRE_DID_RE.test(s)) return err("malformed");

  const body = s.slice(DID_PREFIX.length);

  const couldBePrincipal = PRINCIPAL_ID_RE.test(body);
  const couldBeAgent = AGENT_ID_RE.test(body);
  const couldBeStack = splitsIntoStackPair(body);

  const candidates = [couldBePrincipal, couldBeStack, couldBeAgent].filter(Boolean).length;

  if (candidates === 0) return err("unclassifiable");
  if (candidates > 1) return err("ambiguous");

  // Unreachable today — retained so WP-4's decision lands as a predicate edit.
  if (couldBePrincipal) return ok(s as PrincipalDid);
  if (couldBeStack) return ok(s as StackDid);
  return ok(s as AgentDid);
}

/** True when `body` admits at least one `{principal}-{stack}` split. */
function splitsIntoStackPair(body: string): boolean {
  for (let i = 1; i < body.length - 1; i += 1) {
    if (body[i] !== "-") continue;
    if (PRINCIPAL_ID_RE.test(body.slice(0, i)) && STACK_SLUG_RE.test(body.slice(i + 1))) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a `federated.{principal}.{stack}.{...rest}` subject.
 * Requires the `federated` prefix and at least one trailing segment.
 */
export function parseFederatedSubject(
  s: string,
): ParseResult<{ scope: StackScope; rest: string[] }> {
  if (s.length === 0) return err("empty subject");

  const segments = s.split(".");
  if (segments[0] !== FEDERATED_PREFIX) {
    return err(`subject "${s}" is not federated (expected "${FEDERATED_PREFIX}." prefix)`);
  }
  if (segments.length < 4) {
    return err(`subject "${s}" must be federated.{principal}.{stack}.{...} (≥1 trailing segment)`);
  }

  const principal = parsePrincipalId(segments[1] ?? "");
  if (!principal.ok) return err(`subject "${s}": ${principal.reason}`);

  const stack = parseStackSlug(segments[2] ?? "");
  if (!stack.ok) return err(`subject "${s}": ${stack.reason}`);

  const rest = segments.slice(3);
  for (const segment of rest) {
    if (!SUBJECT_SEGMENT_RE.test(segment)) {
      return err(`subject "${s}": invalid trailing segment "${segment}"`);
    }
  }

  return ok({ scope: { principal: principal.value, stack: stack.value }, rest });
}

// ---------------------------------------------------------------------------
// Render constructors — total over branded inputs
// ---------------------------------------------------------------------------

/** Render the canonical `{principal}/{stack}` literal. */
export function stackId(scope: StackScope): StackId {
  return `${scope.principal}/${scope.stack}` as StackId;
}

/** Render a principal's DID. */
export function principalDid(p: PrincipalId): PrincipalDid {
  return `${DID_PREFIX}${p}` as PrincipalDid;
}

/**
 * Render a stack's DID as `did:mf:{principal}-{stack}`.
 *
 * Throws {@link WireIdentityError} when the naive render violates
 * {@link WIRE_DID_RE} — reachable today because a trailing-hyphen principal
 * (`"andreas-"`, legal per {@link PRINCIPAL_ID_RE}) yields `did:mf:andreas--x`,
 * and consecutive hyphens are forbidden on the wire.
 *
 * `cortex.ts:1024` instead collapses `-+` runs, which is **lossy** — it maps two
 * distinct stacks onto one DID — while `probe-responder.ts:433` does not collapse
 * at all, so the two minters disagree. Rather than adopt either behaviour, this
 * refuses to emit an invalid DID. TODO(WP-4, cortex#1880) owns the encoding.
 */
export function stackDid(scope: StackScope): StackDid {
  const did = `${DID_PREFIX}${scope.principal}-${scope.stack}`;
  if (!WIRE_DID_RE.test(did)) {
    throw new WireIdentityError(
      `cannot render a valid stack DID from "${scope.principal}" + "${scope.stack}": ` +
        `"${did}" violates the wire DID grammar. See TODO(WP-4, cortex#1880).`,
    );
  }
  return did as StackDid;
}

/**
 * Render an agent's DID. Validates against today's {@link AGENT_ID_RE} and
 * throws {@link WireIdentityError} on a rejected id — the mint sites
 * (`dispatch-source-publisher.ts:203`, `reflex-activation-listener.ts:268`)
 * perform no validation at all today.
 */
export function agentDid(a: string): AgentDid {
  if (!AGENT_ID_RE.test(a)) {
    throw new WireIdentityError(`agent id "${a}" violates ${String(AGENT_ID_RE)}`);
  }
  const did = `${DID_PREFIX}${a}`;
  if (!WIRE_DID_RE.test(did)) {
    throw new WireIdentityError(`agent DID "${did}" violates the wire DID grammar`);
  }
  return did as AgentDid;
}

/**
 * Render a `federated.{principal}.{stack}.{...segments}` subject.
 * Throws {@link WireIdentityError} on an empty segment list or any segment that
 * would corrupt the subject (embedded `.`, a `*`/`>` wildcard, or `""`).
 */
export function federatedSubject(scope: StackScope, ...segments: string[]): FederatedSubject {
  if (segments.length === 0) {
    throw new WireIdentityError("a federated subject needs ≥1 trailing segment");
  }
  for (const segment of segments) {
    if (!SUBJECT_SEGMENT_RE.test(segment)) {
      throw new WireIdentityError(`invalid federated subject segment "${segment}"`);
    }
  }
  const tail = segments.join(".");
  return `${FEDERATED_PREFIX}.${scope.principal}.${scope.stack}.${tail}` as FederatedSubject;
}
