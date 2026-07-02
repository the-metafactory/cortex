/**
 * Sage review-engine runner (cortex#331, #888, #920).
 *
 * The `ReviewPipelineRunner` for `engine: sage` agents — the standalone sage
 * lens-CLI, NOT an M6 substrate harness (hence this file lives at
 * `src/runner/`, alongside the CC-path `review-pipeline.ts`, not under
 * `substrate/` — cortex#922).
 *
 * **Architectural shift.** Sage went in-process (sage#41) — its standalone
 * launchd daemon and NATS subscribe path are retired. Cortex's review-consumer
 * is the sole receiver for sage-owned review flavors; this runner is the
 * cortex-side adapter that shells the sage CLI and closes the round-trip.
 *
 * **Topology.**
 *
 *   pilot publishes `tasks.code-review.<flavor>` envelope
 *     → cortex's `ReviewConsumer` for sage receives + verifies signature (cortex#330)
 *     → this runner spawns `sage review <pr-ref> --substrate <model> --emit-verdict-block`
 *       (model from the agent's resolved `runtime.model`, else `SAGE_SUBSTRATE`
 *       env, else `pi`)
 *     → parses the structured verdict block from sage's stdout (cortex#888) →
 *       builds a `review.verdict.{approved|changes-requested|commented}` envelope
 *       (falls back to exit-code mapping when no block is present)
 *     → cortex publishes the verdict back to the bus → pilot's `--wait` catches it
 *
 * **What this module is.** A `ReviewPipelineRunner` factory with the same
 * signature `runReviewPipeline` exposes (`src/runner/review-pipeline.ts`), so it
 * slots into `ReviewConsumerOpts.pipelineRunner`. The boot wire in
 * `src/cortex.ts` selects it via `resolveReviewEngine` when `engine === "sage"`;
 * `persona` (and the legacy default) falls through to the CC pipeline.
 *
 * **What this module does NOT do.**
 *
 *   - NO library import of sage modules — we shell out via `sage review`.
 *     A future option is `import { runSageReview } from "@the-metafactory/sage"`
 *     once sage's `package.json` declares `exports`.
 *   - NO Claude Code path — that stays at `runReviewPipeline` (persona engine).
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
 * pipe buffer (same pattern as `src/surface/mc/adapters/github/fetch.ts`).
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  createReviewTaskFailedEvent,
  createReviewVerdictEvent,
} from "../bus/review-events";
import type { ReviewVerdictKind } from "../bus/review-events";
import {
  extractVerdictBlock,
  parseVerdictBlock,
  type VerdictBlock,
} from "./verdict-block";
import type {
  ReviewPipelineOpts,
  ReviewPipelineResult,
} from "./review-pipeline";

// ---------------------------------------------------------------------------
// Spawn-injection types — narrowed surface of `Bun.spawn`
// ---------------------------------------------------------------------------
//
// We don't take `typeof Bun.spawn` directly because that type is wide
// (overloads + many options) and brittle across Bun versions. The narrowed
// runner only needs three handles per child process — stdout,
// stderr, and `exited` — plus the option bag we pass on the spawn call.
// Narrowing the type makes the test seam trivial to satisfy (the unit
// tests build a fake that returns three Response-shaped readables and a
// fixed exit code) and lets us evolve internal spawn flags without
// breaking callers.

/** The handle the runner needs from `Bun.spawn`. */
export interface SageSpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

/**
 * Spawn function signature. Production wires `Bun.spawn`; tests inject a
 * deterministic fake (see `sage-runner.test.ts`).
 *
 * `argv[0]` is the resolved sage binary path; subsequent entries are the
 * `review <pr-ref> --substrate <pi|claude|codex>` arguments (substrate
 * value resolved from `SAGE_SUBSTRATE` env, defaults to `pi`).
 */
export type SageSpawnFn = (
  argv: string[],
  opts: { stdout: "pipe"; stderr: "pipe" },
) => SageSpawnResult;

/**
 * Binary resolver — returns the absolute path to the sage CLI, or
 * `undefined` if no binary is found. Production wires `Bun.which`; tests
 * stub this to simulate missing-binary cases.
 */
export type SageWhichFn = (cmd: string) => string | undefined;

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link makeSageReviewRunner}.
 *
 * All fields are optional; the default behaviour is:
 *
 *   - Resolve sage binary via `SAGE_BIN` env then `Bun.which("sage")`.
 *   - Use `Bun.spawn` for the subprocess.
 *   - Use the current process env (no scrubbing — sage piggybacks on the
 *     principal's `gh` auth and `GITHUB_TOKEN` via inherited env).
 */
export interface MakeSageRunnerOpts {
  /**
   * The LLM forwarded to `sage review --substrate <model>` (`claude`|`codex`|
   * `pi`). cortex#917 — passed from the agent's resolved `runtime.model` so a
   * sage agent runs its lenses through the configured LLM. Falls back to
   * `SAGE_SUBSTRATE` env, then `pi`.
   */
  model?: string;
  /**
   * Explicit sage binary path. Highest-priority resolution (skips env +
   * PATH lookup). Primarily a test seam; production callers typically
   * leave this undefined.
   */
  sageBin?: string;
  /**
   * Spawn function — defaults to `Bun.spawn`. Tests inject a fake that
   * yields a canned `SageSpawnResult`.
   */
  spawn?: SageSpawnFn;
  /**
   * `which`-style lookup — defaults to `Bun.which`. Tests stub this to
   * simulate the binary-not-found path without touching `$PATH`.
   */
  which?: SageWhichFn;
}

/**
 * Build a pipeline runner that dispatches to the sage lens CLI.
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
 *     `dispatch.task.failed` envelope. Principals can install sage after
 *     boot without restarting cortex.
 *   - A sage install/upgrade is picked up on the next review request
 *     (no stale binary path cached).
 *
 * **No side effects at construction.** The factory just closes over
 * `opts`; no spawn, no I/O. Safe to call at boot time.
 */
export function makeSageReviewRunner(
  opts: MakeSageRunnerOpts = {},
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

    // compass#89 (§4 L3): the sage engine has NO confidentiality lens
    // (zero-hit grep in its lens registry — see audit F8/compass#99). A
    // `code-review.confidentiality` request must therefore fail PRE-SPAWN with
    // `cant_do` rather than silently running sage's generic CodeQuality pass and
    // returning a verdict that never looked for disclosure — the runtime guard
    // for the generic-claim path (a boot-time capability guard covers the
    // declared-capability path). Threading `--lens <flavor>` for the OTHER
    // flavors is deferred to compass#99 (sage is an external pinned binary; an
    // unconditional lens flag can break older builds), so the assistant-engine
    // prompt (`buildReviewPrompt`) remains the live drift-1 fix.
    if (payload.flavor === "confidentiality") {
      return failed(
        pipeline,
        correlationId,
        startedAt,
        "sage engine has no confidentiality lens (compass#89/#99); " +
          "route code-review.confidentiality to an assistant-engine reviewer",
      );
    }

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
    const substrate = opts.model ?? process.env.SAGE_SUBSTRATE ?? "pi";
    // cortex#888 — ask sage to append the structured verdict block as the
    // terminal stdout artefact (sage#83 `--emit-verdict-block`). We parse it
    // below to recover the REAL decision (`approved` is invisible to the
    // exit-code-only fallback) + findings counts. Older sage builds that
    // don't know the flag would error on it — but the flag shipped in
    // lockstep (sage#83) and the bundled sage is pinned, so this is safe;
    // if the block is absent for any reason we fall back to exit-code mapping.
    const argv = [sageBin, "review", prRef, "--substrate", substrate, "--emit-verdict-block"];
    // Propagate the dispatch's `--post` intent. `sage dispatch --post`
    // stamps `payload.post: true` (sage#8) and the review-consumer carries
    // it through; without this the verdict is computed but never posted to
    // the forge (the prior `posted=false` behaviour).
    if (pipeline.payload.post === true) {
      argv.push("--post");
    }
    const forge = pipeline.payload.forge;
    if (forge === "github" || forge === "gitlab") {
      argv.push("--forge", forge);
    }

    let proc: SageSpawnResult;
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
    // `src/surface/mc/adapters/github/fetch.ts`).
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

    // cortex#888 (Phase 2) — recover the real verdict from sage's structured
    // block. sage emits it as the terminal ```json fence under
    // `--emit-verdict-block` (sage#83). The block carries the true decision
    // (incl. `approved`, invisible to the exit code) + findings counts +
    // commit_id. A present, well-formed block wins; anything else
    // (older sage, malformed JSON, missing block) falls back to the
    // exit-code mapping below so a parse hiccup never drops a valid review.
    const rawBlock = extractVerdictBlock(stdout);
    if (rawBlock !== null) {
      const parsed = parseVerdictBlock(rawBlock);
      if (parsed.ok) {
        return verdict(pipeline, correlationId, stdout, parsed.value.verdict, parsed.value);
      }
      // Block present but malformed — log + fall through to exit-code mapping.
      console.error(
        `[sage] verdict block malformed (${parsed.detail}); falling back to exit-code mapping`,
      );
    }

    // Fallback: exit 1 ⇒ changes-requested; exit 0 ⇒ commented (sage can't
    // distinguish approved from commented via exit code alone).
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
): SageSpawnResult {
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
 * stdout as `payload.summary`.
 *
 * When `block` is supplied (cortex#888 — sage emitted a well-formed
 * `--emit-verdict-block` artefact), the structured fields (findings counts,
 * github review id/url, commit_id, submitted_at, inline_comments) come from
 * it. Without a block (fallback path: older sage, malformed JSON), those
 * fields surface as zeros / empty strings — pilot still sees a well-formed
 * envelope and principals can grep the markdown summary for the values.
 * `reviewer` stays `sage` (the substrate doing the review).
 */
function verdict(
  pipeline: ReviewPipelineOpts,
  correlationId: string,
  stdout: string,
  decision: ReviewVerdictKind,
  block?: VerdictBlock,
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
      reviewer: "sage",
      verdict: decision,
      summary: stdout,
      github_review_id: block?.github_review_id ?? 0,
      github_review_url: block?.github_review_url ?? "",
      submitted_at: block?.submitted_at ?? new Date().toISOString(),
      commit_id: block?.commit_id ?? "",
      findings: block?.findings ?? { blockers: 0, majors: 0, nits: 0 },
      inline_comments: block?.inline_comments ?? 0,
    },
  });
  return { kind: "verdict", envelope };
}
