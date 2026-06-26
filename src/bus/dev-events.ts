/**
 * F-2.1 (cortex#835) — `tasks.dev.implement` request envelope + payload parser
 * for the agentic dev-loop's `dev.implement` capability consumer.
 *
 * Mirrors `bus/review-events.ts` shape-for-shape. The reviewer side ships
 * `tasks.code-review.<flavor>` request + `review.verdict.<kind>` reply
 * builders; the dev side ships ONE request family
 * (`tasks.dev.implement`) and reuses the shared `dispatch.task.*` lifecycle
 * envelopes (`dispatch-events.ts`) for started / completed / failed — there
 * is NO bespoke verdict reply (the PR ref rides `dispatch.task.completed`'s
 * payload). See `docs/design-agentic-dev-pipeline.md` §3.1 (dev-agent row),
 * §3.4 step 2 (event walk).
 *
 * **What this file ships:**
 *   - `createDevImplementRequestEvent` → `tasks.dev.implement` request
 *     envelope. Production producer is pilot's tick (§3.4 step 1); this
 *     cortex-side helper lets the consumer's tests synthesise requests
 *     without a pilot harness — exactly the role `createReviewRequestEvent`
 *     plays for the review consumer.
 *   - `parseDevImplementPayload` → validate + normalise an inbound
 *     envelope's payload to the canonical {@link DevImplementPayload}. The
 *     consumer trusts an already-parsed payload, so validation lives here.
 *
 * **What this file is NOT:**
 *   - NOT a publisher — no NATS, no I/O. Pure envelope construction +
 *     payload parsing.
 *   - NOT a subscriber — the consumer lives in `runner/dev-consumer.ts`.
 *   - NOT a lifecycle-envelope builder — `dispatch-events.ts` owns those;
 *     the consumer co-emits them (started / completed / failed) the same
 *     way `review-consumer.ts` does. Re-exported here for ergonomics so the
 *     consumer imports one module.
 *
 * **Brief = intent + references, never a context bundle** (design DD-P3):
 * the payload carries issue / brief refs, repo, branch name, base, and the
 * gate command list. The worker pulls the actual slice (the repo, the issue
 * body, the design §) with its own tools inside the CC session.
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope as buildSharedEnvelope } from "./envelope-builder";
import type { SystemEventSource } from "./system-events";
import type { LogicalResponseRouting } from "./dispatch-events";

// Re-export so the orchestrator + dev consumer import the run-thread routing
// shape from one place (it is defined alongside the lifecycle builders that
// echo it). Purely ergonomic — the underlying type lives in `dispatch-events`.
export type { LogicalResponseRouting } from "./dispatch-events";

// Re-export the source shape under a domain-neutral alias — mirrors
// `ReviewEventSource` in `review-events.ts`. Callers import from one place.
export type DevEventSource = SystemEventSource;

// Re-exported from `dispatch-events.ts` so the dev consumer imports one
// module for the failure taxonomy (single source of truth stays in
// `dispatch-events.ts` per cortex#249).
export type { DispatchTaskFailedReason } from "./dispatch-events";

function buildSource(src: SystemEventSource): string {
  return `${src.principal}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `tasks.dev.implement` envelopes. Same posture as
 * `tasks.code-review.*` and `dispatch.task.*`: principal-local by default,
 * local residency, no frontier, no hops. A dev task names a repo + branch +
 * issue — principal-private until federation (F-5) opts a request into
 * `classification: "federated"`.
 *
 * Returned as a fresh literal per call so a downstream mutation on one
 * envelope's `sovereignty` cannot leak into a sibling envelope.
 */
function defaultDevSovereignty(
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
// tasks.dev.implement — request payload
// ---------------------------------------------------------------------------

/**
 * Canonical `tasks.dev.implement` payload (§3.4 step 1 brief = intent + refs).
 *
 * Required fields are the load-bearing routing keys the consumer cannot
 * proceed without:
 *   - `repo`  — `owner/name`, the repo to branch + open the PR against.
 *   - `branch` — the feature branch name (worktree-discipline SOP form,
 *     e.g. `feat/c-300-panel`).
 *   - `base`  — the base branch the worktree is cut from + the PR targets
 *     (almost always `main` per the SOP, but explicit so a release branch
 *     can override).
 *   - `brief` — the intent string handed to the CC session. INTENT + REFS,
 *     not a context bundle: it names the issue, the design §, the
 *     acceptance criteria, and (on a fix cycle) the review findings refs.
 *
 * Optional fields:
 *   - `issue`  — issue number the work closes (stamped into the PR body so
 *     merging auto-closes it). Surfaces render for context.
 *   - `gates`  — the gate command list run after the CC session, BEFORE the
 *     PR opens (e.g. `["bunx tsc --noEmit", "bun test src/"]`). When omitted
 *     the consumer opens the PR without running gates (the caller is then
 *     responsible for gating in review).
 *   - `feature` / `title` — principal-supplied context surfaces render but
 *     the consumer does not branch on.
 */
export interface DevImplementPayload {
  /** `owner/name` repo string, e.g. `"the-metafactory/cortex"`. */
  repo: string;
  /** Feature branch name (worktree-discipline SOP), e.g. `"feat/c-300-panel"`. */
  branch: string;
  /** Base branch the worktree is cut from + the PR targets, e.g. `"main"`. */
  base: string;
  /** Intent string handed to the CC session — refs, not a context dump. */
  brief: string;
  /** Optional issue number the PR closes (auto-close via `Closes #N`). */
  issue?: number;
  /** Optional gate commands run after the session, before the PR opens. */
  gates?: readonly string[];
  /** Optional feature id (e.g. `"F-2.1"`). Surfaces render for context. */
  feature?: string;
  /** Optional human-readable PR title. */
  title?: string;
}

/** Options for {@link createDevImplementRequestEvent}. */
export interface CreateDevImplementRequestEventOpts {
  source: DevEventSource;
  /**
   * Optional sovereignty classification. Defaults to `"local"` (principal-
   * private). `"federated"` for cross-principal dispatch (F-5). Mismatch
   * with the publish-time subject is a protocol violation caught by
   * `validateSubjectEnvelopeAlignment`.
   */
  classification?: Classification;
  /** Payload per §3.4 step 1. */
  payload: DevImplementPayload;
  /**
   * cortex#1206 (S2) — the run's LOGICAL response routing (`{ surface, channel,
   * thread }` — repo-short channel + `{repo-short}/issue/{N}` entity thread per
   * the channel-routing SOP). Stamped VERBATIM onto `payload.response_routing`
   * so the dev consumer echoes it onto every `dispatch.task.*` lifecycle
   * envelope (`readLogicalRouting`) and the review-sink resolves it to the ONE
   * run thread (the cortex#502/#1148 logical-routing spine). The builder never
   * inspects it. Omitted ⇒ no `response_routing` on the wire — byte-identical to
   * a pre-#1206 unrouted dispatch (backward compatible).
   */
  responseRouting?: LogicalResponseRouting;
}

/**
 * Construct a `tasks.dev.implement` request envelope.
 *
 * The envelope's `id` is the correlation root for the whole implement →
 * fix-cycle chain (§3.6b warm sessions): every lifecycle envelope the
 * consumer emits carries it as `correlation_id`, and the consumer's
 * warm-session store keys the CC session id on the request's
 * `correlation_id` (or its explicit chain id) so a subsequent fix-cycle
 * request resumes the same CC session.
 *
 * This is the cortex-side mirror of pilot's tick publisher. The cortex
 * consumer does NOT publish request envelopes in production — pilot does —
 * but cortex-side tests synthesise them to drive the consumer pipeline
 * without a pilot harness.
 *
 * @returns a fresh `Envelope` literal with a new UUID id; safe to publish.
 */
export function createDevImplementRequestEvent(
  opts: CreateDevImplementRequestEventOpts,
): Envelope {
  const p = opts.payload;
  return buildSharedEnvelope({
    type: "tasks.dev.implement",
    source: buildSource(opts.source),
    sovereignty: defaultDevSovereignty(opts.source, opts.classification),
    payload: {
      repo: p.repo,
      branch: p.branch,
      base: p.base,
      brief: p.brief,
      ...(p.issue !== undefined && { issue: p.issue }),
      ...(p.gates !== undefined && { gates: [...p.gates] }),
      ...(p.feature !== undefined && { feature: p.feature }),
      ...(p.title !== undefined && { title: p.title }),
      // cortex#1206 (S2) — the run-thread address. Echoed verbatim by the dev
      // consumer onto every lifecycle envelope; the review-sink resolves it to
      // the one run thread. Omitted when absent (backward compatible).
      ...(opts.responseRouting !== undefined && {
        response_routing: opts.responseRouting,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// payload parsing — validate + normalise an inbound envelope
// ---------------------------------------------------------------------------

// `owner/name` — same grammar as `review-events.ts`'s OWNER_REPO_RE.
const OWNER_REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
// A git branch / ref name — conservative: no whitespace, no `..` segment, no
// leading `-`, no control chars. Not the full `git check-ref-format` grammar
// (that is the forge seam's job to honour); this is the cheap structural gate
// so a blank or obviously-malformed branch fails fast as `cant_do` rather than
// reaching `git worktree add`. The `(?!.*\.\.)` lookahead enforces the stated
// "no `..`" intent (a `..` in a ref is both a git-illegal sequence AND a
// path-traversal shape) — defense-in-depth even though the worktree/forge
// seams would also reject it downstream.
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9][\w./-]*$/;

/**
 * Parse a `tasks.dev.implement` envelope's payload into the canonical
 * {@link DevImplementPayload}, or `null` on any shape violation.
 *
 * The consumer maps a `null` here to a `cant_do` permanent failure (term
 * ack) — a malformed brief won't become valid on redelivery, exactly the
 * way `review-consumer.ts` treats `parseReviewRequestPayload` returning
 * `null`.
 *
 * Validates the load-bearing routing keys structurally:
 *   - `repo` matches `owner/name`.
 *   - `branch` + `base` match the conservative branch grammar above.
 *   - `brief` is a non-empty string.
 *   - `gates`, when present, is an array of non-empty strings.
 *   - `issue`, when present, is a positive integer.
 *
 * Exported for the dev-consumer tests.
 */
export function parseDevImplementPayload(
  envelope: Envelope,
): DevImplementPayload | null {
  const p = envelope.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;

  if (typeof p.repo !== "string" || !OWNER_REPO_RE.test(p.repo)) return null;
  if (typeof p.branch !== "string" || !BRANCH_RE.test(p.branch)) return null;
  if (typeof p.base !== "string" || !BRANCH_RE.test(p.base)) return null;
  if (typeof p.brief !== "string" || p.brief.trim().length === 0) return null;

  const out: DevImplementPayload = {
    repo: p.repo,
    branch: p.branch,
    base: p.base,
    brief: p.brief,
  };

  if (p.issue !== undefined) {
    if (typeof p.issue !== "number" || !Number.isInteger(p.issue) || p.issue <= 0) {
      return null;
    }
    out.issue = p.issue;
  }

  if (p.gates !== undefined) {
    if (!Array.isArray(p.gates)) return null;
    const gates: string[] = [];
    for (const g of p.gates) {
      if (typeof g !== "string" || g.trim().length === 0) return null;
      gates.push(g);
    }
    out.gates = gates;
  }

  if (typeof p.feature === "string") out.feature = p.feature;
  if (typeof p.title === "string") out.title = p.title;

  return out;
}

/**
 * Extract the correlation CHAIN id from an inbound `tasks.dev.implement`
 * envelope — the key the warm-session store maps to a CC session id
 * (§3.6b). The fix-cycle carries the SAME chain id as the implement that
 * preceded it, so a subsequent task resumes the same CC session.
 *
 * Resolution precedence:
 *   1. `envelope.correlation_id` — pilot stamps the chain's root request id
 *      here on every task in the chain (the implement AND its fix cycles),
 *      so it is the durable chain key.
 *   2. `envelope.id` — fallback for a first-of-chain request that carries no
 *      explicit `correlation_id` (the cortex-side test synthesiser path);
 *      the root request's own id IS the chain root.
 *
 * Never returns empty: both branches are UUID-shaped by envelope
 * construction. Exported for the dev-consumer tests.
 */
export function devCorrelationChainId(envelope: Envelope): string {
  const corr = envelope.correlation_id;
  if (typeof corr === "string" && corr.length > 0) return corr;
  return envelope.id;
}
