/**
 * cortex#237 PR-5 — `review-pipeline.ts`
 *
 * **CC bridge for the capability-dispatch review consumer.** Translates a
 * single parsed `ReviewRequestPayload` into either a `review.verdict.<kind>`
 * envelope (success) or a `dispatch.task.failed` envelope (failure), by
 * running the CodeReview skill inside a Claude Code session and parsing the
 * structured verdict block the skill emits at the end of its output.
 *
 * Anchors:
 *   - `docs/design-capability-dispatch-review-consumer.md` §4.5 — skill
 *     stdout contract (the fenced JSON block).
 *   - §5 — correlation_id contract (the verdict envelope's `correlation_id`
 *     is the REQUEST envelope's `id`; the failed-envelope wrapper takes
 *     `correlationId` explicitly for the same reason).
 *   - §6 — verdict envelope shape (cortex#248 §4.2.1 payload contract).
 *   - §7 — nak taxonomy (cortex#249 `DispatchTaskFailedReason`) and the
 *     mapping table this module implements.
 *   - §7.6 — substrate-side failure mapping (`not_now` rather than
 *     `cant_do` for CC crashes / timeouts / aborts; pilot maps to exit 4
 *     transient).
 *   - §10.1 PR-5 row — scope of this PR (pure code; no subscribe, no
 *     publish, no boot wiring).
 *
 * **What this module IS:**
 *   - A pure translation function: `request → result envelope`.
 *   - The owner of the skill-stdout → verdict-payload parsing contract.
 *   - The owner of the substrate-failure → nak-kind mapping.
 *
 * **What this module is NOT:**
 *   - NOT a subscriber. PR-6 (`src/runner/review-consumer.ts`) does
 *     `runtime.onEnvelope` + JetStream pull subscription wiring.
 *   - NOT a publisher. PR-6 calls `runtime.publish` on the envelope we
 *     return; this module never touches `MyelinRuntime`.
 *   - NOT responsible for `dispatch.task.{started,progress,completed,
 *     aborted}` lifecycle envelopes — PR-6's per-envelope handler emits
 *     those around the call to `runReviewPipeline`. This module emits the
 *     *terminal* outcome only.
 *   - NOT a concurrency gate. The `maxConcurrent` knob from PR-4's
 *     `AgentRuntimeSchema` is enforced upstream of this function in PR-6's
 *     consumer (before `dispatch.task.started` emits, per §7.5). If we
 *     ever do call this with too many in-flight reviews, that's a PR-6 bug
 *     — this module just runs whatever it's handed.
 *   - NOT responsible for compliance attestation (`compliance_block`).
 *     Per §7.4 + Echo cortex#253 R1 Minor-5, v1 does not ship the dead
 *     branch — the discriminator stays declared in
 *     `DispatchTaskFailedReason` for forward-compat but no producer emits
 *     it until §13.5 lands.
 *
 * **Failure-reason mapping table (per §7):**
 *
 * | Outcome                                              | reason.kind | rationale                                                  |
 * |------------------------------------------------------|-------------|------------------------------------------------------------|
 * | CC factory throws synchronously (binary missing)     | `not_now`   | Transient substrate failure (§7.3); principal-recoverable. |
 * | CC session `kill()` / inactivity timeout / abort     | `not_now`   | Substrate-side crash (§7.6) — pilot maps to exit 4.        |
 * | CC session exits non-zero with no parseable block    | `not_now`   | Substrate-side crash (§7.6).                                |
 * | CC session exits clean (0) but no verdict block      | (none)      | cortex#503 — agent answered in prose; SUCCESS completion   |
 * |                                                      |             | `{ kind: "completed", presentation }` (NOT a fail/verdict).|
 * | Verdict block present but JSON parse fails           | `cant_do`   | Skill emitted malformed output (§4.5).                      |
 * | Verdict block parses but required field missing/bad  | `cant_do`   | Schema mismatch (§4.5).                                     |
 * | Caller-injected policy refusal (e.g. scope-out)      | `wont_do`   | Reviewer policy refused (§7.2); explicit opt-in via opt.    |
 * | Happy path: parseable verdict block                  | (none)      | Returns `{ kind: 'verdict', envelope }`.                    |
 *
 * The `wont_do` path is wired via the optional `policyCheck` callback —
 * PR-6 (or a future sovereignty/compliance layer) supplies the predicate
 * if/when it has a real check to run. Until then, no caller passes
 * `policyCheck` and the path is dormant; tests exercise it via the opt.
 *
 * **Discriminator-alignment guard:** the verdict builder
 * (`createReviewVerdictEvent`) throws if the kind suffix and the
 * `payload.verdict` field disagree (§6.3). Because we derive `kind` from
 * `payload.verdict` ourselves before calling the builder, the only way
 * to hit the throw would be a bug in this module's parse logic; we still
 * catch and downgrade to a `cant_do` failure rather than crash the
 * consumer.
 */

import type { Classification, Envelope } from "../bus/myelin/envelope-validator";
import {
  createReviewTaskFailedEvent,
  createReviewVerdictEvent,
  type DispatchTaskFailedReason,
  type ReviewEventSource,
  type ReviewRequestPayload,
  type ReviewVerdictPayload,
} from "../bus/review-events";
import type { AnyResponseRouting } from "../bus/dispatch-events";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../substrates/claude-code/harness";
import type { CCSessionOpts, CCSessionResult } from "./cc-session";
import {
  extractVerdictBlock,
  parseVerdictBlock,
  type VerdictBlock,
} from "./verdict-block";
import {
  classifyCcFailure,
  classifyCcSpawnError,
} from "./cc-failure-classifier";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated result of running a single review through the CC pipeline.
 *
 * `kind: "verdict"` carries the `review.verdict.<kind>` envelope built via
 * PR-2's `createReviewVerdictEvent`. `kind: "failed"` carries the
 * `dispatch.task.failed` envelope built via PR-2's
 * `createReviewTaskFailedEvent`. Either way the envelope's `correlation_id`
 * is the request envelope's `id` (load-bearing pilot contract per §5).
 *
 * PR-6's consumer pattern-matches on `result.kind` to decide whether to
 * also publish a `dispatch.task.completed` (verdict path) or to skip
 * straight to acking the JetStream message (failed path).
 *
 * cortex#503 — a THIRD variant `kind: "completed"` carries the
 * **prose-fallback** success: the CC session exited clean but emitted no
 * parseable structured verdict block, so the agent answered in prose. The
 * pipeline does NOT fabricate a structured verdict from that prose (that
 * would violate "no agent/LLM tokens author the verdict" + the
 * discriminator-alignment guard). Instead it returns the agent's own prose
 * (markdown) as `presentation` and the consumer publishes a plain
 * `dispatch.task.completed` (NOT a `review.verdict.<kind>`). JSON never
 * reaches a surface: the verdict path computes deterministic presentation
 * markdown, the prose path passes the prose through as markdown.
 */
export type ReviewPipelineResult =
  | { kind: "verdict"; envelope: Envelope }
  | { kind: "completed"; presentation: string }
  | { kind: "failed"; envelope: Envelope };

/**
 * Optional policy hook — return a `wont_do` decision to short-circuit the
 * pipeline before spawning CC. Used by PR-6 / future sovereignty layer
 * when the request's classification, data-residency, or actor identity
 * fails a pre-CC policy gate (§7.2). Returning `null` means "no refusal,
 * proceed with the CC invocation."
 *
 * Kept as an opt-in callback rather than built-in logic because PR-5's
 * scope is the substrate bridge — the policy data model lives in PR-6
 * (consumer) and the planned compliance schema (§13.5). Wiring the hook
 * here lets PR-6 add the check without re-architecting the pipeline.
 */
export type ReviewPolicyCheck = (
  payload: ReviewRequestPayload,
) => { refuse: true; detail: string } | null;

/**
 * Options for {@link runReviewPipeline}.
 *
 * The shape mirrors `DispatchListenerOptions` in spirit — runtime knobs +
 * test-injection hooks. Production callers (PR-6) supply the real
 * `CCSessionFactory` from the runner module; tests inject a stub.
 */
export interface ReviewPipelineOpts {
  /**
   * The original request envelope (the inbound
   * `tasks.code-review.<flavor>` envelope). Used for two things:
   *   1. `envelope.id` is the correlation_id stamped on every emitted
   *      envelope (§5.1).
   *   2. The envelope's `source` is read by the consumer for the
   *      lifecycle envelopes; we don't read it here — but accepting the
   *      whole envelope (not just the payload) is the cleaner shape for
   *      future fields (sovereignty echo, signed_by chain).
   */
  requestEnvelope: Envelope;
  /**
   * The parsed payload from `requestEnvelope.payload`. Pre-validated by
   * PR-6's per-envelope handler (`parseReviewRequestPayload`) before
   * being handed to us — this module trusts the payload shape and does
   * not re-validate. If PR-6's parser ever changes, this assumption
   * needs revisiting.
   */
  payload: ReviewRequestPayload;
  /**
   * The reviewer agent identifier — the logical agent name that handled
   * the task (`echo`, `luna`, ...). Stamped onto the verdict envelope's
   * `payload.reviewer` (which is the *actual* agent, distinct from the
   * request's advisory `payload.reviewer` — see review-events.ts §263).
   */
  agentId: string;
  /**
   * Envelope source triple for the failure / verdict envelopes we build.
   * Sourced from cortex.yaml's `principal.id` + `cortex` + `local` per
   * PR-6's bootstrap.
   */
  source: ReviewEventSource;
  /**
   * The CC session factory. Production callers pass the real one from
   * `substrates/claude-code/harness.ts`; tests pass a stub that returns
   * a deterministic `wait()` result.
   */
  ccSessionFactory: CCSessionFactory;
  /**
   * The CC prompt to run. PR-6 builds this from the
   * security-preamble + skill invocation (`/review {repo}#{pr}` or
   * similar — the exact incantation is PR-6 territory because it depends
   * on which skill markdown we ship in PR-8). PR-5 just passes the
   * string through to `CCSessionOpts.prompt`.
   *
   * Kept as a caller-supplied string (not built inside this module)
   * because the prompt-builder pattern in `runner/prompt-builder.ts` is
   * tied to the `InboundMessage` shape from Discord/Mattermost adapters
   * — the review pipeline doesn't have an `InboundMessage`, so we can't
   * reuse `buildPrompt(...)` as-is. PR-6 is the natural place for a
   * review-flavoured prompt builder; PR-5 stays substrate-shaped.
   */
  prompt: string;
  /**
   * Optional CC session overrides — passed through to `CCSessionOpts`.
   * Production callers set `cwd`, `allowedTools`, `allowedDirs`,
   * `timeoutMs`, etc. from cortex.yaml + the request envelope's
   * envelope-source-derived defaults.
   */
  sessionOpts?: Partial<Omit<CCSessionOpts, "prompt">>;
  /**
   * Optional pre-CC policy hook (see {@link ReviewPolicyCheck}). When
   * omitted, no policy gate runs and the pipeline goes straight to CC.
   */
  policyCheck?: ReviewPolicyCheck;
  /**
   * cortex#502 — the logical response routing echoed from the inbound
   * review request envelope. Threaded onto BOTH terminal envelopes the
   * pipeline builds — the `review.verdict.<kind>` (primary reply) and the
   * `dispatch.task.failed` — so the review sink can render either outcome
   * to the originating thread. Passed through verbatim; the pipeline never
   * inspects or transforms it. Omitted → no `response_routing` on the wire
   * (pilot-only / bus-peer / Offer path unchanged).
   */
  responseRouting?: AnyResponseRouting;
  /**
   * cortex#686 — sovereignty classification for the terminal envelopes the
   * pipeline builds (`review.verdict.<kind>` + `dispatch.task.failed`).
   * Defaults to `"local"` (the local review-consumer path, unchanged). The
   * FEDERATED review consumer sets `"federated"` so the verdict + failed
   * envelopes it routes back to a cross-principal requester declare federated
   * sovereignty self-consistently with the `federated.*` subject they publish
   * on. Threaded into both builders verbatim; the pipeline never inspects it.
   */
  classification?: Classification;
  /**
   * cortex#361 — optional lifecycle hook fired after the CC session is
   * constructed + `start()` is called, before `wait()` resolves. The
   * pipeline does NOT call `runtime.publish` from this hook itself —
   * keeping the design-doc contract that this module never touches the
   * bus runtime. Instead, the consumer (PR-6 `ReviewConsumer.runPipeline`)
   * uses this hook to attach a `HeartbeatTicker` to the session so
   * `system.agent.heartbeat` envelopes flow on the bus while CC streams.
   *
   * The hook receives the raw `CCSessionLike` the factory produced.
   * Production factories return a `CCSession` (an `EventEmitter`), so
   * heartbeat wiring can subscribe to `tool-use` / `text` / `result` /
   * `error` / `exit` events; the hook checks `'on' in session` at
   * runtime since the test-stub factories return plain objects without
   * `.on` and would otherwise crash.
   *
   * Returns a `{ stop }` handle; the pipeline calls `stop()` after
   * `await session.wait()` settles (success or failure), so the ticker
   * tears down on the same code path that completes the dispatch.
   * Errors thrown by `onSessionSpawned` are swallowed + logged — a
   * heartbeat wiring failure must not crash the review.
   */
  onSessionSpawned?: (session: CCSessionLike) => { stop: () => void } | undefined;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Translate one parsed review request into a terminal envelope (verdict
 * or failed). Spawns a CC session via the supplied factory, awaits its
 * completion, and parses the structured-verdict JSON block per §4.5.
 *
 * **Non-throwing contract.** This function returns a discriminated result
 * for every outcome — including caller-side bugs (e.g. the verdict
 * builder's discriminator-alignment throw) and substrate exceptions.
 * PR-6's consumer assumes it can `await runReviewPipeline(...)` without a
 * try/catch wrapper.
 *
 * **Idempotency.** Each call spawns a fresh CC session; there is no
 * shared mutable state across calls. PR-6 can call this concurrently for
 * different envelopes (bounded by `maxConcurrent` in the consumer).
 */
export async function runReviewPipeline(
  opts: ReviewPipelineOpts,
): Promise<ReviewPipelineResult> {
  const correlationId = opts.requestEnvelope.id;
  const startedAt = new Date();

  // §7.2 — pre-CC policy gate. Caller-injected; dormant when omitted.
  if (opts.policyCheck) {
    const decision = opts.policyCheck(opts.payload);
    if (decision !== null) {
      return failed(
        opts,
        correlationId,
        startedAt,
        { kind: "wont_do", detail: decision.detail },
        `review pipeline refused by policy: ${decision.detail}`,
      );
    }
  }

  // Spawn + await the CC session. Wrap factory + wait() in a single try
  // so any synchronous factory throw, async wait() rejection, or
  // mid-stream substrate crash collapses to the §7.6 not_now path.
  //
  // cortex#360: the factory-throw + result-classification logic is lifted
  // into `cc-failure-classifier.ts` so the chat-path (dispatch-handler)
  // can share the same taxonomy. Behaviour preserved byte-for-byte.
  //
  // cortex#361 — the heartbeat handle (if the consumer wired one) lives
  // outside the try so the stop() in finally runs whether wait()
  // resolves or rejects. Initialised to a no-op so the call site is
  // uniform whether a hook was supplied or not. The handle's `stop()`
  // is idempotent — the heartbeat ticker also self-stops when it sees
  // the session's `result` / `error` / `exit` events, so calling
  // `stop()` here is defence-in-depth for sessions whose factory throws
  // before emitting any events.
  let result: CCSessionResult;
  let heartbeatHandle: { stop: () => void } = {
    stop: () => {
      // no-op until an onSessionSpawned hook returns a real handle
    },
  };
  try {
    const session: CCSessionLike = opts.ccSessionFactory({
      prompt: opts.prompt,
      ...opts.sessionOpts,
    });
    session.start();
    if (opts.onSessionSpawned) {
      try {
        const handle = opts.onSessionSpawned(session);
        if (handle) heartbeatHandle = handle;
      } catch (hookErr) {
        // Heartbeat wiring failure must NOT crash the review. Log loudly
        // and continue without bus-side liveness for this dispatch.
        process.stderr.write(
          `review-pipeline: onSessionSpawned hook threw: ${
            hookErr instanceof Error ? hookErr.message : String(hookErr)
          }\n`,
        );
      }
    }
    try {
      result = await session.wait();
    } finally {
      // Defence-in-depth: even when ticker listeners stop the ticker on
      // the session's terminal events, an early reject path (e.g. wait()
      // rejects synchronously) might bypass them. stop() is idempotent.
      // Echo cortex#363 nit — this inner finally is the canonical owner
      // of cleanup; the outer catch deliberately does NOT call stop()
      // again. The outer catch only fires when the synchronous
      // `opts.ccSessionFactory({...})` throws before the handle is ever
      // assigned (heartbeatHandle is still the noop default at that
      // point), so a second call would be redundant.
      heartbeatHandle.stop();
    }
  } catch (err) {
    // §7.3 not_now bucket — "transient infrastructure failure (CC binary
    // not found; etc.). Principal-recoverable." Pilot maps to exit 4
    // (transient, retry safe) per design-pilot-restructure.md §4.4.
    // `classifyCcSpawnError` always returns a `not_now` reason; the
    // union narrowing here exists to keep TypeScript happy when the
    // classifier signature gains other kinds in future.
    //
    // cortex#361 nit: the inner `try/finally` owns the heartbeat
    // cleanup. We deliberately do NOT call `heartbeatHandle.stop()`
    // again here — the outer catch only fires when the synchronous
    // `opts.ccSessionFactory({...})` throws before the handle is ever
    // assigned (heartbeatHandle is still the noop default at that
    // point), so a second call would be redundant.
    const reason = classifyCcSpawnError(err);
    const errorSummary =
      reason.kind === "not_now" ? reason.detail : `cc session error: ${reason.kind}`;
    return failed(
      opts,
      correlationId,
      startedAt,
      reason,
      errorSummary,
    );
  }

  // §7.6 — substrate-side abort / crash paths. `aborted` covers the
  // inactivity-timeout case (the canonical signature from cc-session.ts
  // is `exitCode: 1 + aborted: true`, not `exitCode: 143`). A non-zero
  // exit with no captured response is the "CC crashed mid-stream" case.
  // Classification lives in `cc-failure-classifier.classifyCcFailure`;
  // `null` return means "no substrate failure, continue to verdict
  // parsing below."
  const substrateFailure = classifyCcFailure(result);
  if (substrateFailure !== null) {
    return failed(
      opts,
      correlationId,
      startedAt,
      substrateFailure,
      substrateFailure.kind === "not_now"
        ? substrateFailure.detail
        : `cc session failure: ${substrateFailure.kind}`,
    );
  }

  // §4.5 — extract the structured-verdict JSON block from the CC stream's
  // last assistant message.
  //
  // cortex#503 — absent block on a CLEAN exit is NO LONGER a hard-fail.
  // Previously this returned `{ kind: "failed", reason: cant_do }`, which
  // gated pilot's `--wait` (exit non-zero) on a review the agent actually
  // completed — it just answered in prose rather than the structured block.
  // We DO NOT fabricate a structured verdict from the prose (that would
  // manufacture an approved/changes-requested/commented kind cortex cannot
  // stand behind, violating "no agent/LLM tokens author the verdict"). The
  // `inferVerdictFromProse` heuristic is deliberately NOT implemented.
  //
  // Instead this is a SUCCESS completion: `presentation` carries the raw
  // prose (trimmed, still markdown), and the consumer publishes a plain
  // `dispatch.task.completed` — NOT a `review.verdict.<kind>`. The remaining
  // failure paths (malformed JSON when a block WAS present; substrate
  // crash/timeout; field-validation) stay `cant_do`/`not_now` — those are
  // genuine substrate/contract failures, distinct from "agent answered in
  // prose".
  const block = extractVerdictBlock(result.response);
  if (block === null) {
    return { kind: "completed", presentation: result.response.trim() };
  }

  const parsed = parseVerdictBlock(block);
  if (!parsed.ok) {
    return failed(
      opts,
      correlationId,
      startedAt,
      {
        kind: "cant_do",
        detail: `verdict block malformed: ${parsed.detail}`,
      },
      `verdict block malformed: ${parsed.detail}`,
    );
  }

  // Build the verdict envelope. The discriminator-alignment guard inside
  // `createReviewVerdictEvent` would throw only if our parser handed it a
  // mismatched (kind, payload.verdict) pair — `kind` is derived from
  // `payload.verdict` two lines above, so the throw is structurally
  // unreachable. Still wrap defensively so a future refactor cannot
  // turn a parser bug into a consumer crash.
  const payload: ReviewVerdictPayload = {
    repo: opts.payload.repo,
    pr: opts.payload.pr,
    reviewer: opts.agentId,
    verdict: parsed.value.verdict,
    summary: parsed.value.summary,
    github_review_id: parsed.value.github_review_id,
    github_review_url: parsed.value.github_review_url,
    submitted_at: parsed.value.submitted_at,
    commit_id: parsed.value.commit_id,
    findings: {
      blockers: parsed.value.findings.blockers,
      majors: parsed.value.findings.majors,
      nits: parsed.value.findings.nits,
    },
    inline_comments: parsed.value.inline_comments,
    // cortex#503 — stamp the deterministic presentation markdown computed
    // by cortex from the structured fields. Zero LLM tokens: the reviewing
    // agent only authored `summary`; the heading/emoji/counts/link line are
    // code-stamped here so it rides the `review.verdict.<kind>` payload onto
    // the wire for surfaces to render verbatim.
    presentation: buildPresentationMarkdown(parsed.value),
  };

  let envelope: Envelope;
  try {
    envelope = createReviewVerdictEvent({
      source: opts.source,
      kind: parsed.value.verdict,
      correlationId,
      // cortex#502 — echo logical routing onto the verdict (primary reply).
      ...(opts.responseRouting !== undefined && {
        responseRouting: opts.responseRouting,
      }),
      // cortex#686 — federated verdict declares federated sovereignty.
      ...(opts.classification !== undefined && {
        classification: opts.classification,
      }),
      payload,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return failed(
      opts,
      correlationId,
      startedAt,
      {
        kind: "cant_do",
        detail: `verdict envelope construction failed: ${detail}`,
      },
      `verdict envelope construction failed: ${detail}`,
    );
  }

  return { kind: "verdict", envelope };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the failed envelope with a consistent fingerprint:
 *   - `taskId` is a fresh UUID (cortex-internal lifecycle key per §5.2).
 *   - `correlationId` is the request envelope's `id` (load-bearing
 *     pilot contract per §5.2 — passed explicitly, NOT defaulted to
 *     `taskId`, because `dispatch-events.ts:160` would default to the
 *     wrong id space).
 *   - `failedAt` is `Date.now()` at the point of failure.
 *
 * Single chokepoint so the §5.2 contract can't drift between branches.
 */
function failed(
  opts: ReviewPipelineOpts,
  correlationId: string,
  startedAt: Date,
  reason: DispatchTaskFailedReason,
  errorSummary: string,
): ReviewPipelineResult {
  const envelope = createReviewTaskFailedEvent({
    source: opts.source,
    taskId: crypto.randomUUID(),
    agentId: opts.agentId,
    correlationId,
    startedAt,
    failedAt: new Date(),
    errorSummary,
    reason,
    // cortex#502 — echo logical routing onto the failed terminal too so the
    // review sink can render the error to the originating thread.
    ...(opts.responseRouting !== undefined && {
      responseRouting: opts.responseRouting,
    }),
    // cortex#686 — federated failed terminal declares federated sovereignty.
    ...(opts.classification !== undefined && {
      classification: opts.classification,
    }),
  });
  return { kind: "failed", envelope };
}

/**
 * cortex#503 — build the deterministic **presentation markdown** for a
 * parsed structured verdict.
 *
 * Pure, deterministic string-templating over the already-parsed structured
 * fields (verdict kind, summary, findings counts, inline_comments, the
 * GitHub review link + 7-char commit). ZERO agent/LLM tokens: the reviewing
 * agent authored only `block.summary`; this code stamps the heading, emoji,
 * findings line, and link. Idempotent — the same {@link VerdictBlock} in
 * produces a byte-identical string out (no clocks, no randomness, no
 * environment reads).
 *
 * Surfaces render this string VERBATIM as markdown (the review sink + any
 * `review.verdict.*` adapter), so it must never embed raw JSON. Per the
 * control-plane/data-plane rule, the FULL review body lives on GitHub (the
 * `github_review_url`); this markdown is the cortex-side render the surfaces
 * post — a Discord entity thread typically derives a one-liner from it.
 *
 * Shape:
 *
 *   ### {emoji} {Verdict-Label} — {repo}#{pr}
 *
 *   {summary}
 *
 *   **Findings:** {b} blockers · {m} majors · {n} nits · {i} inline comments
 *
 *   [Review on GitHub]({github_review_url}) ({commit7})
 *
 * Emoji + label by verdict:
 *   - `approved`          → ✅ "Approved"
 *   - `changes-requested` → 🔴 "Changes requested"
 *   - `commented`         → 💬 "Commented"
 */
export function buildPresentationMarkdown(block: VerdictBlock): string {
  let emoji: string;
  let label: string;
  if (block.verdict === "approved") {
    emoji = "✅";
    label = "Approved";
  } else if (block.verdict === "changes-requested") {
    emoji = "🔴";
    label = "Changes requested";
  } else {
    emoji = "💬";
    label = "Commented";
  }

  const { blockers, majors, nits } = block.findings;
  const findingsLine =
    `**Findings:** ${blockers} blockers · ${majors} majors · ${nits} nits ` +
    `· ${block.inline_comments} inline comments`;

  const lines: string[] = [`### ${emoji} ${label}`];

  const summary = block.summary.trim();
  if (summary.length > 0) {
    lines.push("", summary);
  }

  lines.push("", findingsLine);

  // GitHub link line — only when a URL is present (sage Phase-1 verdicts can
  // carry an empty url). The commit suffix is the first 7 chars of the SHA
  // (the conventional short form); omitted when commit_id is empty.
  const url = block.github_review_url.trim();
  if (url.length > 0) {
    const commit7 = block.commit_id.trim().slice(0, 7);
    const commitSuffix = commit7.length > 0 ? ` (\`${commit7}\`)` : "";
    lines.push("", `[Review on GitHub](${url})${commitSuffix}`);
  }

  return lines.join("\n");
}
