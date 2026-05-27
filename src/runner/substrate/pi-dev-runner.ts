/**
 * cortex#331 Phase 1 — `pi-dev` substrate pipeline runner.
 *
 * **Cross-repo scope split (sage#40 / sage#41 / cortex#331).** Sage's local
 * ISA referred to "zero cortex changes" within the SAGE repo's Phase 1 —
 * that scope is preserved: no cortex edits land in sage#41 (sage's
 * in-process migration). cortex#331 is the separate, parallel issue that
 * owns the cortex-side wiring; this file implements its Phase 1.
 *
 * **Architectural shift.** Sage went in-process (sage#41) — its standalone
 * launchd daemon and standalone NATS subscribe path are retired. Cortex's
 * review-consumer is now the sole receiver for sage-owned review flavors.
 * That is the load-bearing change: sage stepped DOWN from owning its own
 * bus subscription; cortex stepped UP to own substrate dispatch for
 * in-process agents. This runner is the cortex-side adapter that closes
 * the round-trip.
 *
 * **Topology after sage#41 + cortex#331 ship:**
 *
 *   pilot publishes `tasks.code-review.<flavor>` envelope
 *     → cortex's `ReviewConsumer` for sage receives + verifies signature (cortex#330)
 *     → this runner spawns `sage review <pr-ref> --substrate <pi|claude|codex>` subprocess
 *       (substrate value from `SAGE_SUBSTRATE` env, defaults to `pi`)
 *     → captures sage stdout, builds `review.verdict.commented` envelope
 *     → cortex publishes verdict back to bus
 *     → pilot's `--wait` catches it
 *
 * **What this module is.** A `ReviewPipelineRunner` factory that targets
 * sage's `pi-dev` substrate. Returns an async function with the same
 * signature `runReviewPipeline` exposes (see `src/runner/review-pipeline.ts`),
 * so it slots into `ReviewConsumerOpts.pipelineRunner` without any consumer
 * code changes. The boot wire in `src/cortex.ts` picks this factory for
 * agents that declare `runtime.substrate: "pi-dev"`; everything else
 * continues to fall through to the default CC pipeline.
 *
 * **What this module does NOT do (Phase 1 scope per issue #331).**
 *
 *   - NO structured JSON verdict parsing — sage's `sage review` emits
 *     markdown today. We pass the markdown through as `payload.summary`
 *     and hardcode `verdict: "commented"` so pilot's verdict-subscriber
 *     still sees a correlated envelope. Phase 2 swaps to `--format json`
 *     and parses approved/changes-requested/commented from the verdict
 *     block.
 *   - NO library import of sage modules — we shell out via `sage review`.
 *     Phase 2 considers `import { runSageReview } from "@the-metafactory/sage"`
 *     once sage's `package.json` declares `exports`.
 *   - NO Claude Code substrate path — that stays at `runReviewPipeline`
 *     in `src/runner/review-pipeline.ts`. Phase 1 is purely additive.
 *
 * **Binary resolution.** Sage's CLI is looked up in this order:
 *
 *   1. `opts.sageBin` — explicit override, primarily a test seam.
 *   2. `process.env.SAGE_BIN` — principal override; lets the user pin
 *      a specific sage build without editing cortex.yaml.
 *   3. `Bun.which("sage")` — falls back to `$PATH`.
 *
 * If none of these resolve, we surface a typed `dispatch.task.failed`
 * envelope with `reason.kind: "cant_do"` rather than throwing — keeping
 * the boot path identical to the CC factory's contract (the consumer
 * never has to try/catch around `pipelineRunner`).
 *
 * **Failure shape.** Mirrors `runReviewPipeline`'s contract:
 *
 *   | Outcome                          | result.kind | reason.kind |
 *   |----------------------------------|-------------|-------------|
 *   | sage exit 0                      | `verdict`   | (none)      |
 *   | sage exit != 0                   | `failed`    | `cant_do`   |
 *   | sage binary not found            | `failed`    | `cant_do`   |
 *   | spawn throw (env / sandbox bug)  | `failed`    | `cant_do`   |
 *
 * Phase 1 maps every non-happy outcome to `cant_do` because we don't yet
 * distinguish substrate-transient (`not_now`) from skill-permanent
 * (`cant_do`) at this layer — sage's exit codes aren't documented as a
 * taxonomy yet. Phase 2 (sage#TBD: structured `--format json` exit codes)
 * splits this into the four-way nak taxonomy.
 *
 * **Subprocess shape.** We spawn `sage review <owner>/<repo>#<n>
 * --substrate <pi|claude|codex>` (substrate value resolved from the
 * `SAGE_SUBSTRATE` env var, defaults to `pi` — cortex#402). Stdout is captured to a single string and used as
 * `payload.summary`. Stderr is captured separately and fed into the
 * failed envelope's `reason.detail` when sage exits non-zero. Both pipes
 * are drained via `new Response(stream).text()` in parallel with the
 * `exited` promise so a large markdown blob can't deadlock on the OS
 * pipe buffer (same pattern as `src/surface/mc/api/github-fetch.ts`).
 */

import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  createReviewTaskFailedEvent,
  createReviewVerdictEvent,
} from "../../bus/review-events";
import type { ReviewVerdictKind } from "../../bus/review-events";
import type {
  ReviewPipelineOpts,
  ReviewPipelineResult,
} from "../review-pipeline";

// ---------------------------------------------------------------------------
// Spawn-injection types — narrowed surface of `Bun.spawn`
// ---------------------------------------------------------------------------
//
// We don't take `typeof Bun.spawn` directly because that type is wide
// (overloads + many options) and brittle across Bun versions. The
// `pi-dev-runner` only needs three handles per child process — stdout,
// stderr, and `exited` — plus the option bag we pass on the spawn call.
// Narrowing the type makes the test seam trivial to satisfy (the unit
// tests build a fake that returns three Response-shaped readables and a
// fixed exit code) and lets us evolve internal spawn flags without
// breaking callers.

/** The handle the runner needs from `Bun.spawn`. */
export interface PiDevSpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

/**
 * Spawn function signature. Production wires `Bun.spawn`; tests inject a
 * deterministic fake (see `pi-dev-runner.test.ts`).
 *
 * `argv[0]` is the resolved sage binary path; subsequent entries are the
 * `review <pr-ref> --substrate <pi|claude|codex>` arguments (substrate
 * value resolved from `SAGE_SUBSTRATE` env, defaults to `pi`).
 */
export type PiDevSpawnFn = (
  argv: string[],
  opts: { stdout: "pipe"; stderr: "pipe" },
) => PiDevSpawnResult;

/**
 * Binary resolver — returns the absolute path to the sage CLI, or
 * `undefined` if no binary is found. Production wires `Bun.which`; tests
 * stub this to simulate missing-binary cases.
 */
export type PiDevWhichFn = (cmd: string) => string | undefined;

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link makePiDevPipelineRunner}.
 *
 * All fields are optional; the default behaviour is:
 *
 *   - Resolve sage binary via `SAGE_BIN` env then `Bun.which("sage")`.
 *   - Use `Bun.spawn` for the subprocess.
 *   - Use the current process env (no scrubbing — sage piggybacks on the
 *     principal's `gh` auth and `GITHUB_TOKEN` via inherited env).
 */
export interface MakePiDevRunnerOpts {
  /**
   * Explicit sage binary path. Highest-priority resolution (skips env +
   * PATH lookup). Primarily a test seam; production callers typically
   * leave this undefined.
   */
  sageBin?: string;
  /**
   * Spawn function — defaults to `Bun.spawn`. Tests inject a fake that
   * yields a canned `PiDevSpawnResult`.
   */
  spawn?: PiDevSpawnFn;
  /**
   * `which`-style lookup — defaults to `Bun.which`. Tests stub this to
   * simulate the binary-not-found path without touching `$PATH`.
   */
  which?: PiDevWhichFn;
}

/**
 * Build a pipeline runner that dispatches to sage's `pi-dev` substrate.
 *
 * The returned function has the exact signature
 * `(opts: ReviewPipelineOpts) => Promise<ReviewPipelineResult>` —
 * structurally identical to `runReviewPipeline`, so it drops straight
 * into `ReviewConsumerOpts.pipelineRunner`.
 *
 * **Lifetime.** Binary resolution happens lazily on every invocation,
 * NOT at factory-construction time. This means:
 *
 *   - Boot never fails on a missing sage binary — the consumer comes up
 *     fine and individual review requests surface the failure as a
 *     `dispatch.task.failed` envelope. Operators can install sage after
 *     boot without restarting cortex.
 *   - A sage install/upgrade is picked up on the next review request
 *     (no stale binary path cached).
 *
 * **No side effects at construction.** The factory just closes over
 * `opts`; no spawn, no I/O. Safe to call at boot time.
 */
export function makePiDevPipelineRunner(
  opts: MakePiDevRunnerOpts = {},
): (pipeline: ReviewPipelineOpts) => Promise<ReviewPipelineResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const which = opts.which ?? defaultWhich;
  const explicitBin = opts.sageBin;

  return async (pipeline: ReviewPipelineOpts): Promise<ReviewPipelineResult> => {
    const correlationId = pipeline.requestEnvelope.id;
    const startedAt = new Date();

    // Coerce the payload — review-consumer already validated the shape
    // before handing it to the pipeline runner, but the type on
    // `Envelope.payload` is `unknown` so we narrow once here.
    const payload = pipeline.payload;

    // Resolve the sage binary. Priority: explicit > env > $PATH.
    const sageBin =
      explicitBin ?? process.env.SAGE_BIN ?? which("sage") ?? undefined;
    if (sageBin === undefined) {
      return failed(
        pipeline,
        correlationId,
        startedAt,
        "pi-dev: sage binary not found (set SAGE_BIN env or install sage on PATH)",
      );
    }

    // Build the pr-ref string from the request payload. `payload.repo`
    // is already `owner/repo` (per ReviewRequestPayload in
    // src/bus/review-events.ts §4.1), so we concatenate with `#<pr>`
    // directly — no separate owner field on the cortex-side payload.
    const prRef = `${payload.repo}#${payload.pr}`;
    // cortex#402 — substrate is overridable via `SAGE_SUBSTRATE` env so
    // principals without a pi.dev model provider configured (e.g. no
    // DeepSeek API key) can route sage's lens execution through
    // `claude` or `codex` instead. Defaults to `pi` to preserve the
    // pre-#402 behaviour. Sage's CLI accepts `{pi|claude|codex}` per
    // `sage review --help`; values outside that set surface as a sage-
    // side `--substrate` parse error (which the failure-mapping table
    // below maps to `cant_do`).
    const substrate = process.env.SAGE_SUBSTRATE ?? "pi";
    const argv = [sageBin, "review", prRef, "--substrate", substrate];
    // Propagate the dispatch's `--post` intent. `sage dispatch --post`
    // stamps `payload.post: true` (sage#8) and the review-consumer carries
    // it through; without this the verdict is computed but never posted to
    // the forge (the prior `posted=false` behaviour).
    if (pipeline.payload.post === true) {
      argv.push("--post");
    }

    let proc: PiDevSpawnResult;
    try {
      proc = spawn(argv, { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return failed(
        pipeline,
        correlationId,
        startedAt,
        `pi-dev: sage spawn failed: ${detail}`,
      );
    }

    // Drain stdout + stderr in parallel with `exited` so a large markdown
    // blob can't deadlock on the OS pipe buffer (same pattern as
    // `src/surface/mc/api/github-fetch.ts`).
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      const [so, se, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      stdout = so;
      stderr = se;
      exitCode = code;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return failed(
        pipeline,
        correlationId,
        startedAt,
        `pi-dev: sage subprocess stream error: ${detail}`,
      );
    }

    // sage's exit-code contract (sage cli/index.ts):
    //   0   → approved / commented verdict
    //   1   → changes-requested verdict (a VALID review outcome, CI-gate
    //         convention — NOT an error; the review markdown is on stdout)
    //   ≥2  → real error (forge selection, substrate parse, etc.)
    //   -1  → subprocess killed
    // Treat 0 and 1 as verdicts; everything else fails.
    if (exitCode !== 0 && exitCode !== 1) {
      return failed(
        pipeline,
        correlationId,
        startedAt,
        `sage review exited ${exitCode}: ${stderr.trim()}`,
      );
    }

    // Map the exit code to the verdict decision. Exit 1 ⇒ changes-requested.
    // Exit 0 stays `commented` because sage doesn't distinguish approved
    // from commented via exit code — Phase 2 (sage `--format json`, sage#TBD)
    // parses the structured verdict block to recover approved/findings.
    const decision: ReviewVerdictKind =
      exitCode === 1 ? "changes-requested" : "commented";
    return verdict(pipeline, correlationId, stdout, decision);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Production spawn — `Bun.spawn`. */
function defaultSpawn(
  argv: string[],
  opts: { stdout: "pipe"; stderr: "pipe" },
): PiDevSpawnResult {
  const proc = Bun.spawn(argv, {
    stdout: opts.stdout,
    stderr: opts.stderr,
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
  };
}

/** Production binary resolution — `Bun.which`. */
function defaultWhich(cmd: string): string | undefined {
  return Bun.which(cmd) ?? undefined;
}

/**
 * Build a `dispatch.task.failed` envelope with `reason.kind: "cant_do"`
 * for any non-happy substrate outcome. Phase 1 collapses every failure
 * to `cant_do` (see module docblock). Phase 2 splits substrate-transient
 * from skill-permanent.
 */
function failed(
  pipeline: ReviewPipelineOpts,
  correlationId: string,
  startedAt: Date,
  errorSummary: string,
): ReviewPipelineResult {
  const source = pipeline.source;
  const envelope = createReviewTaskFailedEvent({
    source,
    taskId: crypto.randomUUID(),
    agentId: pipeline.agentId,
    correlationId,
    startedAt,
    failedAt: new Date(),
    errorSummary,
    reason: { kind: "cant_do", detail: errorSummary },
  });
  return { kind: "failed", envelope };
}

/**
 * Build a `review.verdict.{decision}` envelope carrying sage's markdown
 * stdout as `payload.summary`. `decision` is derived from sage's exit code
 * (changes-requested vs commented). `reviewer` is hardcoded to `sage`;
 * Phase 2 (sage `--format json`) derives reviewer + findings from the
 * structured verdict block.
 */
function verdict(
  pipeline: ReviewPipelineOpts,
  correlationId: string,
  stdout: string,
  decision: ReviewVerdictKind,
): ReviewPipelineResult {
  const payload = pipeline.payload;
  const source = pipeline.source;
  const envelope: Envelope = createReviewVerdictEvent({
    source,
    kind: decision,
    correlationId,
    payload: {
      repo: payload.repo,
      pr: payload.pr,
      // Phase 1 default — sage is the substrate doing the review.
      // Phase 2 reads the reviewer agent identity from sage's
      // structured verdict block.
      reviewer: "sage",
      verdict: decision,
      summary: stdout,
      // Placeholder fields Phase 1 doesn't have access to without a
      // structured verdict block. The verdict envelope schema requires
      // these fields; we surface zeros / empty strings so pilot's
      // subscriber still sees a well-formed envelope and principals can
      // grep the markdown summary for the actual values. Phase 2
      // populates these from sage's `--format json` block.
      github_review_id: 0,
      github_review_url: "",
      submitted_at: new Date().toISOString(),
      commit_id: "",
      findings: { blockers: 0, majors: 0, nits: 0 },
      inline_comments: 0,
    },
  });
  return { kind: "verdict", envelope };
}
