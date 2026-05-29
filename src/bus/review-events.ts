/**
 * cortex#237 PR-2 — `review.verdict.*` + `tasks.code-review.*` envelope
 * constructors for the capability-dispatch review pipeline.
 *
 * Per `docs/design-capability-dispatch-review-consumer.md` §6 and the
 * pilot caller-side spec at `docs/design-pilot-restructure.md` §4.1–§4.2,
 * the review pipeline emits two new envelope families plus an extension to
 * the existing `dispatch.task.failed` lifecycle envelope. This file ships
 * the producer-side builders. It is pure code — no NATS, no I/O, no
 * subscription wiring; callers stay responsible for `MyelinRuntime.publish`.
 *
 * **Three builders:**
 *   - `createReviewRequestEvent`  → `tasks.code-review.<flavor>` (pilot-side
 *     producer; ratified pilot-side in `src/nats-publish.ts`. Cortex-side
 *     helper added here so PR-5/PR-6 tests can synthesise request envelopes
 *     without round-tripping through pilot. Mirrors the §4.1 payload shape.)
 *   - `createReviewVerdictEvent`  → `review.verdict.{approved,changes-requested,commented}`
 *     (cortex-side producer; the spec's §6 builder verbatim.)
 *   - `createReviewTaskFailedEvent` → thin re-export wrapper around
 *     `createDispatchTaskFailedEvent` for the four-way nak taxonomy
 *     (cortex#249, already shipped in `dispatch-events.ts`). Re-exported
 *     here for review-consumer ergonomics — review code imports one module.
 *
 * **Shape contract** (mirrors `dispatch-events.ts`):
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope idempotency key).
 *   - `timestamp` is the helper-call time. Domain-specific moments
 *     (`submitted_at`) live in payload.
 *   - `source` is the dotted `{principal}.{agent}.{instance}` per the schema.
 *   - `correlation_id` semantics differ per envelope family:
 *       - Request envelopes: no correlation_id (the envelope's `id` is the
 *         correlation root that the verdict envelope echoes — per §5.1).
 *       - Verdict envelopes: REQUIRED, equals the request envelope's `id`
 *         (the single load-bearing pilot contract per §5.1).
 *       - Failed envelopes: per `dispatch-events.ts` semantics — defaults
 *         to `task_id` unless the caller passes the request envelope's id
 *         explicitly (which the review-consumer does per §5.2).
 *   - `sovereignty` defaults to local-only / NZ / max_hop=0 / frontier_ok=false /
 *     model_class=local-only — same posture as `dispatch.task.*`. Verdicts
 *     reveal PR metadata + reviewer findings; default keeps them principal-local.
 *     Federated reviews opt into `classification: "federated"` via the
 *     optional `classification` field (IAW Phase A.3 parameterisation pattern).
 *
 * **Subject derivation:** envelope `type` is `tasks.code-review.<flavor>` or
 * `review.verdict.<kind>`. The wire subject (`local.{principal}.<type>` /
 * `federated.{network}.<type>`) is derived publish-side by
 * `MyelinRuntime.publish` via the namespace-derivation logic landed in
 * IAW Phase A.3 (cortex#129). This builder produces the in-memory envelope
 * only — the publisher computes the subject from `envelope.type` and the
 * runtime's namespace configuration.
 *
 * **Discriminator alignment (defensive):** for the verdict builder, the
 * `kind` argument MUST equal `payload.verdict` (§6.3). A mismatch is a
 * caller bug — we throw rather than silently emit an envelope whose type
 * suffix disagrees with its payload discriminator. This is the analogue
 * of `validateSubjectEnvelopeAlignment` for the envelope-internal
 * discriminator.
 *
 * **What this file is NOT:**
 *   - NOT a publisher. No NATS calls; no `MyelinRuntime` import. Pure
 *     envelope construction (failure mode of importing this in a hot
 *     loop is zero — it's just object literals + `crypto.randomUUID()`).
 *   - NOT a subscriber. The consumer that subscribes to
 *     `tasks.code-review.>` lives in PR-6 (`src/runner/review-consumer.ts`).
 *   - NOT a validator. Call `validateEnvelope` from the schema validator
 *     if you need pre-publish validation; this builder produces a literal
 *     that conforms to the type but doesn't run the JSON Schema (the
 *     tests assert schema conformance).
 *   - NOT a re-export of `DispatchTaskFailedReason`. The discriminated
 *     union stays in `dispatch-events.ts` (single source of truth per
 *     cortex#249); consumers import the type from there.
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope as buildSharedEnvelope } from "./envelope-builder";
import {
  createDispatchTaskFailedEvent,
  type AnyResponseRouting,
  type DispatchTaskFailedOpts,
  type DispatchTaskFailedReason,
} from "./dispatch-events";
import type { SystemEventSource } from "./system-events";

// Re-export the source shape under a domain-neutral alias — mirrors the
// `DispatchEventSource` pattern in `dispatch-events.ts`. Callers in the
// review consumer / pilot import from one place.
export type ReviewEventSource = SystemEventSource;

function buildSource(src: SystemEventSource): string {
  return `${src.principal}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `tasks.code-review.*` and `review.verdict.*`
 * envelopes. Same posture as `dispatch.task.*`: principal-local by default,
 * local residency, no frontier, no hops.
 *
 * Returned as a fresh literal per call so a downstream mutation on one
 * envelope's `sovereignty` cannot leak into a sibling envelope. Mirrors
 * `dispatch-events.ts:defaultDispatchSovereignty`.
 */
function defaultReviewSovereignty(
  source: SystemEventSource,
  classification: Classification = "local",
): Envelope["sovereignty"] {
  return {
    classification,
    data_residency: source.dataResidency ?? "NZ",
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

// ---------------------------------------------------------------------------
// Re-exports — review consumer ergonomics
// ---------------------------------------------------------------------------

/**
 * Re-exported from `dispatch-events.ts` so the review consumer (PR-6) and
 * pilot's verdict subscriber import one module rather than two. The
 * discriminated union itself stays defined in `dispatch-events.ts` per
 * cortex#249 (single source of truth for the nak taxonomy).
 */
export type { DispatchTaskFailedReason } from "./dispatch-events";

// ---------------------------------------------------------------------------
// tasks.code-review.<flavor> — request envelope
// ---------------------------------------------------------------------------

/**
 * Known review flavors per `design-pilot-restructure.md` §4.1's
 * `KNOWN_SPECIALIZATIONS`. The wire grammar accepts any string (the
 * subject `>` wildcard matches arbitrary segments), but pilot's
 * publisher constrains to this set. We keep the type union narrow here
 * so cortex-side test fixtures and PR-6 routing tables don't drift from
 * pilot's vocabulary. New flavors land by extending this union in
 * lockstep with pilot's `KNOWN_SPECIALIZATIONS`.
 */
export type ReviewFlavor =
  | "generic"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "sql"
  | "docs"
  | "security";

/**
 * Request envelope payload per `design-pilot-restructure.md` §4.1.
 *
 * Mirrors `src/nats-publish.ts`'s pilot-side payload verbatim so the
 * review consumer (PR-6) and pilot's publisher agree on the shape
 * without a round-trip through a shared type module.
 *
 * Required fields are the load-bearing routing keys (`repo`, `pr`,
 * `reviewer`). Optional fields are the principal-supplied context
 * (`feature`, `title`, `cycle`, `note`) that surfaces render but do not
 * branch on.
 */
export interface ReviewRequestPayload {
  /** Owner/repo string, e.g. `"the-metafactory/cortex"`. */
  repo: string;
  /** PR number. Integer. */
  pr: number;
  /**
   * Reviewer name. Informational — capability-dispatch routes by the
   * `<flavor>` subject suffix, not by this field. Carried through so
   * surfaces can render "review requested from {reviewer}". See
   * `design-pilot-restructure.md` §5.1's `--reviewer` flag.
   */
  reviewer: string;
  /** Optional feature ID (e.g. `"C-237"`). Surfaces render for context. */
  feature?: string;
  /** Optional human-readable PR title. */
  title?: string;
  /** Optional review cycle counter (1-indexed). */
  cycle?: number;
  /** Optional free-form note (defaults to empty string in pilot's publisher). */
  note?: string;
  /**
   * Whether the reviewer should post the verdict back to the forge
   * (GitHub/GitLab). Set by `sage dispatch --post` (sage#8: the sender
   * sends `true` or omits — never `false`). When true, the substrate
   * runner passes `--post` to the sage subprocess.
   */
  post?: boolean;
  /**
   * Forge backend the task target belongs to. Omitted means GitHub for
   * backwards compatibility with pre-sage#43 publishers.
   */
  forge?: "github" | "gitlab";
}

/** Options for {@link createReviewRequestEvent}. */
export interface CreateReviewRequestEventOpts {
  source: ReviewEventSource;
  /**
   * Review flavor — becomes the `<flavor>` segment of `envelope.type`
   * (`tasks.code-review.<flavor>`). Pilot constrains to
   * `ReviewFlavor`; cortex-side builders accept the same union.
   */
  flavor: ReviewFlavor;
  /**
   * Optional sovereignty classification. Defaults to `"local"` (principal-
   * private). Set to `"federated"` for cross-principal capability dispatch;
   * `"public"` for global visibility. Mismatch with the publish-time
   * subject is a protocol violation caught by
   * `validateSubjectEnvelopeAlignment`.
   */
  classification?: Classification;
  /** Payload per §4.1. */
  payload: ReviewRequestPayload;
}

/**
 * Construct a `tasks.code-review.<flavor>` request envelope per
 * `design-pilot-restructure.md` §4.1.
 *
 * The envelope's `id` becomes the correlation root for the entire
 * review pipeline (§5.1): the verdict envelope echoes this id as its
 * `correlation_id`, and the lifecycle envelopes the review consumer
 * emits use it explicitly via the `correlationId` option on
 * `createDispatchTaskStartedEvent` / `Completed` / `Failed`.
 *
 * This is the cortex-side mirror of pilot's `publishReviewRequested`
 * (`src/nats-publish.ts`). The cortex consumer (PR-6) does NOT publish
 * request envelopes in production — pilot does — but cortex-side tests
 * synthesise them to drive the consumer pipeline without spinning up a
 * pilot harness.
 *
 * @returns a fresh `Envelope` literal with a new UUID id; safe to publish.
 */
export function createReviewRequestEvent(
  opts: CreateReviewRequestEventOpts,
): Envelope {
  return buildSharedEnvelope({
    type: `tasks.code-review.${opts.flavor}`,
    source: buildSource(opts.source),
    sovereignty: defaultReviewSovereignty(opts.source, opts.classification),
    payload: {
      repo: opts.payload.repo,
      pr: opts.payload.pr,
      reviewer: opts.payload.reviewer,
      ...(opts.payload.feature !== undefined && { feature: opts.payload.feature }),
      ...(opts.payload.title !== undefined && { title: opts.payload.title }),
      ...(opts.payload.cycle !== undefined && { cycle: opts.payload.cycle }),
      ...(opts.payload.note !== undefined && { note: opts.payload.note }),
    },
  });
}

// ---------------------------------------------------------------------------
// review.verdict.<kind> — verdict envelope
// ---------------------------------------------------------------------------

/**
 * The three verdict kinds per cortex#248 §4.2.1 and
 * `design-pilot-restructure.md` §4.2. The wire subject is
 * `local.{principal}.review.verdict.<kind>`.
 */
export type ReviewVerdictKind =
  | "approved"
  | "changes-requested"
  | "commented";

/**
 * Verdict envelope payload per cortex#248 §4.2.1 and
 * `design-pilot-restructure.md` §4.2.
 *
 * Payload-shape compatibility with the legacy
 * `nats-review-io.ts:ReviewCompletedPayload` is preserved so workflow-side
 * consumers (the existing `runReviewCycle` ReviewCycleIO) don't need
 * behavioural changes — only the subject and the `correlation_id` are new.
 */
export interface ReviewVerdictPayload {
  /** Owner/repo string, echoed from the request envelope. */
  repo: string;
  /** PR number, echoed from the request envelope. */
  pr: number;
  /**
   * Reviewer name — the agent that produced the verdict (`echo`,
   * `luna`, etc.). Distinct from the request payload's `reviewer`
   * field, which was advisory; this one is the *actual* agent.
   */
  reviewer: string;
  /**
   * The verdict discriminator. MUST equal the `kind` field of the
   * containing options; mismatch throws — see §6.3.
   */
  verdict: ReviewVerdictKind;
  /** Human-readable summary, e.g. `"verdict: blockers=0 majors=2 nits=3 — request-changes"`. */
  summary: string;
  /** GitHub's review id (numeric, from the `pulls/reviews` API). */
  github_review_id: number;
  /** Deep-link to the review on github.com. */
  github_review_url: string;
  /** ISO 8601 timestamp when GitHub recorded the review. */
  submitted_at: string;
  /** Commit SHA the review was submitted against. */
  commit_id: string;
  /** Structured findings count by severity. */
  findings: {
    blockers: number;
    majors: number;
    nits: number;
  };
  /** Total inline comments posted with the review. */
  inline_comments: number;
}

/** Options for {@link createReviewVerdictEvent}. */
export interface CreateReviewVerdictEventOpts {
  source: ReviewEventSource;
  /**
   * Verdict kind — becomes the `<kind>` segment of `envelope.type`
   * (`review.verdict.<kind>`). MUST equal `payload.verdict` (the
   * builder throws otherwise — defensive against the discriminator
   * drifting from the subject suffix per §6.3).
   */
  kind: ReviewVerdictKind;
  /**
   * The request envelope's `id`. REQUIRED — this is the single
   * load-bearing pilot contract per §5.1. Pilot's `subscribe-verdict`
   * filters on this value.
   */
  correlationId: string;
  /**
   * Optional sovereignty classification. Defaults to `"local"`.
   * Federated reviews opt into `"federated"`; mirrors the
   * `tasks.code-review.*` parameterisation.
   */
  classification?: Classification;
  /**
   * cortex#502 — **Response routing** echoed from the inbound review
   * request envelope onto the verdict. The verdict is the PRIMARY reply
   * the review sink renders, so it MUST carry routing (the shared
   * `dispatch.task.*` builders carry it on the lifecycle envelopes; this
   * is the only NEW emit surface). When supplied, surfaces as
   * `payload.response_routing` (the logical
   * {@link import("./dispatch-events").LogicalResponseRouting} shape for
   * review). Omitted (no field on the wire) for bus-peer / direct-pilot-
   * only / Offer dispatches whose request carried no routing — the review
   * sink then ignores the verdict envelope (the authoritative verdict
   * still reaches pilot via `correlation_id`, unchanged).
   */
  responseRouting?: AnyResponseRouting;
  /** Payload per §4.2. */
  payload: ReviewVerdictPayload;
}

/**
 * Construct a `review.verdict.<kind>` envelope per cortex#248 §4.2.1
 * and the design spec §6.2.
 *
 * **Discriminator-alignment guard:** throws if `opts.kind !== opts.payload.verdict`.
 * A subject suffix that disagrees with its payload discriminator is a
 * protocol violation that would silently break pilot's filter (pilot
 * groups envelopes by the subject suffix; a `verdict.approved` envelope
 * with `payload.verdict: "commented"` would be filed under "approved"
 * but render as "commented" — principal-visible inconsistency). Fail
 * loud at the producer instead.
 *
 * **Correlation:** the verdict envelope's `correlation_id` is the
 * REQUEST envelope's `id` (NOT a fresh task UUID). See §5.1 for the
 * load-bearing contract; see §5.2 for the mechanism (the consumer
 * stashes the request envelope's id in a per-task closure).
 *
 * @throws `Error` if `opts.kind !== opts.payload.verdict`.
 */
export function createReviewVerdictEvent(
  opts: CreateReviewVerdictEventOpts,
): Envelope {
  if (opts.kind !== opts.payload.verdict) {
    throw new Error(
      `review-events: verdict-kind/payload mismatch — ` +
        `kind="${opts.kind}" but payload.verdict="${opts.payload.verdict}". ` +
        `The subject suffix and payload discriminator MUST agree (cortex#248 §4.2.1).`,
    );
  }
  return buildSharedEnvelope({
    type: `review.verdict.${opts.kind}`,
    source: buildSource(opts.source),
    sovereignty: defaultReviewSovereignty(opts.source, opts.classification),
    correlationId: opts.correlationId,
    payload: {
      repo: opts.payload.repo,
      pr: opts.payload.pr,
      reviewer: opts.payload.reviewer,
      verdict: opts.payload.verdict,
      summary: opts.payload.summary,
      github_review_id: opts.payload.github_review_id,
      github_review_url: opts.payload.github_review_url,
      submitted_at: opts.payload.submitted_at,
      commit_id: opts.payload.commit_id,
      findings: {
        blockers: opts.payload.findings.blockers,
        majors: opts.payload.findings.majors,
        nits: opts.payload.findings.nits,
      },
      inline_comments: opts.payload.inline_comments,
      // cortex#502 — echo response routing when the inbound review request
      // carried it, so the review sink can render the verdict to the
      // originating thread. Omitted (no key on the wire) for pilot-only /
      // bus-peer / Offer dispatches.
      ...(opts.responseRouting !== undefined && {
        response_routing: opts.responseRouting,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// dispatch.task.failed — review-flavour wrapper
// ---------------------------------------------------------------------------

/**
 * Options for {@link createReviewTaskFailedEvent}. Same shape as
 * `DispatchTaskFailedOpts` from `dispatch-events.ts` — re-exported here
 * for review-consumer ergonomics so the consumer imports one module.
 *
 * The `reason` field carries the four-way nak taxonomy
 * (`cant_do` / `wont_do` / `not_now` / `compliance_block`) plus the
 * existing `policy_denied` discriminator — see `DispatchTaskFailedReason`
 * in `dispatch-events.ts`.
 *
 * **Correlation_id reminder:** per §5.2 the review consumer MUST pass
 * the request envelope's `id` as `correlationId`, NOT rely on the
 * `correlation_id ?? taskId` default in `dispatch-events.ts`. Pilot's
 * `wait-for-verdict` filters on the request envelope id; using a fresh
 * task UUID here would orphan the failed envelope from pilot's filter.
 */
export type CreateReviewTaskFailedEventOpts = DispatchTaskFailedOpts;

/**
 * Construct a `dispatch.task.failed` envelope for the review pipeline.
 *
 * Thin pass-through to `createDispatchTaskFailedEvent` — exists so the
 * review consumer (PR-6) imports a single `review-events` module
 * instead of mixing `review-events` and `dispatch-events` imports.
 * The underlying envelope is byte-identical to one produced by
 * `createDispatchTaskFailedEvent` directly; the wrapper exists for
 * module-boundary hygiene only.
 *
 * The four nak `reason.kind` values (`cant_do`, `wont_do`, `not_now`,
 * `compliance_block`) are the producer-side contract for pilot's nak
 * handling per `design-pilot-restructure.md` §4.4 and architecture §7.3.
 * `policy_denied` (the existing C.3.1 kind) is also supported for
 * back-compat with non-review dispatch paths.
 */
export function createReviewTaskFailedEvent(
  opts: CreateReviewTaskFailedEventOpts,
): Envelope {
  return createDispatchTaskFailedEvent(opts);
}

// Sanity export of the wrapped reason union for ergonomic re-import.
// The type lives in `dispatch-events.ts` (cortex#249, single source of
// truth); this is a value-free re-binding so review-consumer call sites
// don't need to dual-import.
export type ReviewTaskFailedReason = DispatchTaskFailedReason;
