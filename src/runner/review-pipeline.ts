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
 * | CC factory throws synchronously (binary missing)     | `not_now`   | Transient substrate failure (§7.3); operator-recoverable.   |
 * | CC session `kill()` / inactivity timeout / abort     | `not_now`   | Substrate-side crash (§7.6) — pilot maps to exit 4.        |
 * | CC session exits non-zero with no parseable block    | `not_now`   | Substrate-side crash (§7.6).                                |
 * | CC session exits clean (0) but no verdict block      | `cant_do`   | Skill didn't fulfil its contract (§4.5).                    |
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

import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  createReviewTaskFailedEvent,
  createReviewVerdictEvent,
  type DispatchTaskFailedReason,
  type ReviewEventSource,
  type ReviewRequestPayload,
  type ReviewVerdictKind,
  type ReviewVerdictPayload,
} from "../bus/review-events";
import type {
  CCSessionFactory,
  CCSessionLike,
} from "../substrates/claude-code/harness";
import type { CCSessionOpts, CCSessionResult } from "./cc-session";
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
 */
export type ReviewPipelineResult =
  | { kind: "verdict"; envelope: Envelope }
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
   * Sourced from cortex.yaml's `operator.id` + `cortex` + `local` per
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
  // cortex#360: the factory-throw + result-classification logic is lifted
  // into `cc-failure-classifier.ts` so the chat-path (dispatch-handler)
  // can share the same taxonomy. Behaviour preserved byte-for-byte.
  let result: CCSessionResult;
  try {
    const session: CCSessionLike = opts.ccSessionFactory({
      prompt: opts.prompt,
      ...opts.sessionOpts,
    });
    session.start();
    result = await session.wait();
  } catch (err) {
    // §7.3 not_now bucket — "transient infrastructure failure (CC binary
    // not found; etc.). Operator-recoverable." Pilot maps to exit 4
    // (transient, retry safe) per design-pilot-restructure.md §4.4.
    // `classifyCcSpawnError` always returns a `not_now` reason; the
    // union narrowing here exists to keep TypeScript happy when the
    // classifier signature gains other kinds in future.
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
  // last assistant message. Absent block on a clean exit = skill didn't
  // honour the contract (`cant_do`, permanent — operator must fix the
  // skill, not retry the request).
  const block = extractVerdictBlock(result.response);
  if (block === null) {
    return failed(
      opts,
      correlationId,
      startedAt,
      {
        kind: "cant_do",
        detail: "skill did not return parseable verdict block",
      },
      "skill did not return parseable verdict block",
    );
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
  };

  let envelope: Envelope;
  try {
    envelope = createReviewVerdictEvent({
      source: opts.source,
      kind: parsed.value.verdict,
      correlationId,
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
  });
  return { kind: "failed", envelope };
}

/**
 * Extract the LAST fenced JSON block from a CC stream's response text.
 *
 * Per §4.5 the skill emits the verdict block at the end of its output;
 * picking the last block is robust against the skill emitting earlier
 * exploratory JSON (e.g. lens-internal scratch output) before the
 * terminal verdict. Returns the raw block text (still fenced-free) for
 * the JSON parser, or `null` if no block is present.
 *
 * The fence regex accepts both `\`\`\`json` and `\`\`\`JSON` (case-insensitive
 * tag) and tolerates a `\r\n` line-ending — Windows-line-ending output
 * from CC is rare but cheap to support.
 */
function extractVerdictBlock(response: string): string | null {
  const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null = re.exec(response);
  while (m !== null) {
    if (m[1] !== undefined) matches.push(m[1]);
    m = re.exec(response);
  }
  if (matches.length === 0) return null;
  // Last block wins — §4.5 says the verdict is the terminal artefact.
  // Type assertion safe because length is checked above.
  return matches[matches.length - 1] ?? null;
}

/** Internal shape of the parsed verdict block per §4.5's contract. */
interface VerdictBlock {
  verdict: ReviewVerdictKind;
  summary: string;
  github_review_id: number;
  github_review_url: string;
  submitted_at: string;
  commit_id: string;
  findings: { blockers: number; majors: number; nits: number };
  inline_comments: number;
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string };

/**
 * Parse + validate the verdict block JSON. Returns a structured error
 * detail for any failure mode (JSON parse, missing field, wrong type,
 * out-of-enum verdict). The detail flows into the `cant_do` envelope's
 * `reason.detail` so operators can see which field tripped on the
 * dashboard.
 *
 * Validation is hand-rolled (no Zod) to keep PR-5 dependency-free and
 * because the contract is small (8 fields). If the contract grows, a
 * Zod schema is the natural refactor — symmetric with PR-4's config
 * loader.
 */
function parseVerdictBlock(raw: string): ParseResult<VerdictBlock> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `JSON.parse failed: ${detail}` };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, detail: "expected JSON object at top level" };
  }
  const obj = value as Record<string, unknown>;

  const verdict = obj.verdict;
  if (
    verdict !== "approved" &&
    verdict !== "changes-requested" &&
    verdict !== "commented"
  ) {
    return {
      ok: false,
      detail: `verdict must be one of "approved" | "changes-requested" | "commented" (got ${JSON.stringify(verdict)})`,
    };
  }

  if (typeof obj.summary !== "string") {
    return { ok: false, detail: "summary must be a string" };
  }
  if (typeof obj.github_review_id !== "number" || !Number.isInteger(obj.github_review_id)) {
    return { ok: false, detail: "github_review_id must be an integer" };
  }
  if (typeof obj.github_review_url !== "string") {
    return { ok: false, detail: "github_review_url must be a string" };
  }
  if (typeof obj.submitted_at !== "string") {
    return { ok: false, detail: "submitted_at must be a string (ISO 8601)" };
  }
  if (typeof obj.commit_id !== "string") {
    return { ok: false, detail: "commit_id must be a string" };
  }
  if (typeof obj.inline_comments !== "number" || !Number.isInteger(obj.inline_comments)) {
    return { ok: false, detail: "inline_comments must be an integer" };
  }
  if (
    typeof obj.findings !== "object" ||
    obj.findings === null ||
    Array.isArray(obj.findings)
  ) {
    return { ok: false, detail: "findings must be an object" };
  }
  const findings = obj.findings as Record<string, unknown>;
  if (typeof findings.blockers !== "number" || !Number.isInteger(findings.blockers)) {
    return { ok: false, detail: "findings.blockers must be an integer" };
  }
  if (typeof findings.majors !== "number" || !Number.isInteger(findings.majors)) {
    return { ok: false, detail: "findings.majors must be an integer" };
  }
  if (typeof findings.nits !== "number" || !Number.isInteger(findings.nits)) {
    return { ok: false, detail: "findings.nits must be an integer" };
  }

  return {
    ok: true,
    value: {
      verdict,
      summary: obj.summary,
      github_review_id: obj.github_review_id,
      github_review_url: obj.github_review_url,
      submitted_at: obj.submitted_at,
      commit_id: obj.commit_id,
      findings: {
        blockers: findings.blockers,
        majors: findings.majors,
        nits: findings.nits,
      },
      inline_comments: obj.inline_comments,
    },
  };
}
