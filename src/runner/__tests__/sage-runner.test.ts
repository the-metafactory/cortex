/**
 * cortex#331 Phase 1 — `pi-dev-runner.ts` unit tests.
 *
 * Drives the runner via injected `spawn` + `which` seams so no real
 * `sage` binary is invoked in CI. Pins the three load-bearing branches
 * from the issue:
 *
 *   1. Happy path: exit 0 + stdout → `{ kind: "verdict", envelope }` with
 *      `payload.summary === stdout`, `correlation_id === requestEnvelope.id`.
 *   2. Failure path: non-zero exit + stderr → `{ kind: "failed", envelope }`
 *      with `reason.kind: "cant_do"` carrying stderr verbatim.
 *   3. Binary not found: `which` returns undefined → `{ kind: "failed",
 *      envelope }` with a useful principal-facing detail string. Boot path
 *      is structurally identical for all three — the runner never throws.
 *
 * The four-way nak taxonomy (`cant_do` / `wont_do` / `not_now` /
 * `compliance_block`) is intentionally collapsed to `cant_do` in Phase 1
 * (see module docblock); when Phase 2's `--format json` lands, expand
 * these cases to cover the substrate-transient `not_now` paths too.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  createReviewRequestEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "../../bus/review-events";
import type { ReviewPipelineOpts } from "../review-pipeline";
import type { CCSessionFactory } from "../../substrates/claude-code/harness";
import {
  makeSageReviewRunner,
  type SageSpawnFn,
  type SageSpawnResult,
  type SageWhichFn,
} from "../sage-runner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: ReviewEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const VALID_PAYLOAD: ReviewRequestPayload = {
  repo: "the-metafactory/cortex",
  pr: 331,
  reviewer: "sage",
  feature: "C-331",
  title: "feat: pi-dev substrate adapter",
};

/** Build a ReviewPipelineOpts for the runner. The CC factory is a stub
 *  that throws if invoked — the pi-dev runner MUST NOT touch it. */
function makePipelineOpts(): ReviewPipelineOpts {
  const requestEnvelope = createReviewRequestEvent({
    source: SOURCE,
    flavor: "typescript",
    payload: VALID_PAYLOAD,
  });
  const stubCCFactory: CCSessionFactory = () => {
    throw new Error(
      "pi-dev-runner test: CC factory must NEVER be called by the pi-dev runner",
    );
  };
  return {
    requestEnvelope,
    payload: VALID_PAYLOAD,
    agentId: "sage",
    source: SOURCE,
    ccSessionFactory: stubCCFactory,
    prompt: "(unused by pi-dev runner)",
  };
}

/**
 * Build a `SageSpawnResult` from a canned stdout, stderr, and exit code.
 * Uses `Response.body` to turn strings into the same `ReadableStream<Uint8Array>`
 * shape `Bun.spawn` returns — same trick the production runner uses to
 * drain via `new Response(stream).text()`.
 */
function makeSpawnResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): SageSpawnResult {
  const stdoutStream = new Response(stdout).body!;
  const stderrStream = new Response(stderr).body!;
  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    exited: Promise.resolve(exitCode),
  };
}

/**
 * Make a spawn fake that captures every argv it sees and returns the
 * given `SageSpawnResult`. Pins the argv shape the runner builds
 * (`sage review owner/repo#N --substrate pi`).
 */
function makeRecordingSpawn(
  result: SageSpawnResult,
): { fn: SageSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SageSpawnFn = (argv, _opts) => {
    calls.push([...argv]);
    return result;
  };
  return { fn, calls };
}

/** `which` stub that returns a fixed sage binary path. */
const FAKE_SAGE_BIN = "/usr/local/bin/sage";
const whichSuccess: SageWhichFn = (cmd) =>
  cmd === "sage" ? FAKE_SAGE_BIN : undefined;
const whichMissing: SageWhichFn = () => undefined;

// ---------------------------------------------------------------------------
// Verdict-block fixtures (cortex#888) — shared by the block-recovery tests and
// the compass#99 F11/F12 tests. A well-formed block is the ONLY thing that
// yields a `review.verdict.*` post-F11; block-less / malformed stdout returns
// the prose-completion variant (no synthetic exit-code verdict).
// ---------------------------------------------------------------------------

function withBlock(body: string, block: Record<string, unknown>): string {
  return `${body}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
}

const SAMPLE_BLOCK = {
  verdict: "approved",
  summary: "No findings. Sage approves.",
  github_review_id: 999,
  github_review_url: "https://github.com/o/r/pull/1#pullrequestreview-999",
  submitted_at: "2026-06-10T09:11:36Z",
  commit_id: "abc1234deadbeef",
  findings: { blockers: 0, majors: 0, nits: 0 },
  inline_comments: 0,
};

/**
 * compass#99 F12 — a logical response-routing block (review-path shape). The
 * runner echoes it verbatim onto BOTH terminal envelopes (verdict + failed),
 * exactly as the CC path does (review-pipeline.ts).
 */
const FED_ROUTING = {
  surface: "discord",
  channel: "cortex",
  thread: "cortex/pr/331",
};

/**
 * Build ReviewPipelineOpts carrying a federated classification + response
 * routing — the shape the FEDERATED review consumer hands the runner.
 */
function makeFederatedPipelineOpts(): ReviewPipelineOpts {
  return {
    ...makePipelineOpts(),
    classification: "federated",
    responseRouting: FED_ROUTING,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cortex#331 Phase 1 — makeSageReviewRunner", () => {
  test("happy path: sage exit 0 + stdout → verdict envelope with summary=stdout, correlation_id=requestEnvelope.id", async () => {
    // cortex#402 — guard the argv pin against an ambient SAGE_SUBSTRATE
    // env value. Before #402 the env var was inert; after #402 a
    // developer machine carrying e.g. `SAGE_SUBSTRATE=claude` would
    // flip the argv assertion below from the documented default
    // (`pi`) and break this hermetic test. The two #402 tests below
    // own the env-override semantics; this test just pins the
    // default-path argv.
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      // Post-compass#99 F11 the ONLY thing that yields a `review.verdict.*` is
      // a well-formed `--emit-verdict-block` block (sage#83) — block-less
      // stdout returns the prose-completion variant. The canonical happy path
      // therefore carries a block; summary still echoes the FULL stdout.
      const stdout = withBlock("## review body", {
        ...SAMPLE_BLOCK,
        verdict: "commented",
      });
      const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });

      const opts = makePipelineOpts();
      const result = await runner(opts);

      // Result shape — verdict, not failed.
      expect(result.kind).toBe("verdict");
      if (result.kind !== "verdict") return; // narrow

      // Envelope wiring — correlation_id is the request envelope's id (the
      // single load-bearing pilot contract per design §5.1).
      const envelope: Envelope = result.envelope;
      expect(envelope.type).toBe("review.verdict.commented");
      expect(envelope.correlation_id).toBe(opts.requestEnvelope.id);

      // Payload shape — summary echoes sage's stdout verbatim, repo/pr
      // echo the request payload, reviewer is the Phase 1 default "sage".
      const payload = envelope.payload as {
        repo: string;
        pr: number;
        reviewer: string;
        verdict: string;
        summary: string;
      };
      expect(payload.summary).toBe(stdout);
      expect(payload.repo).toBe(VALID_PAYLOAD.repo);
      expect(payload.pr).toBe(VALID_PAYLOAD.pr);
      expect(payload.reviewer).toBe("sage");
      expect(payload.verdict).toBe("commented");

      // Argv pin — `sage review owner/repo#N --substrate pi
      // --emit-verdict-block`, with the resolved binary path as argv[0].
      // cortex#888 — the verdict-block flag is always passed so sage emits
      // the structured block we parse back into the verdict envelope.
      expect(spawn.calls.length).toBe(1);
      expect(spawn.calls[0]).toEqual([
        FAKE_SAGE_BIN,
        "review",
        `${VALID_PAYLOAD.repo}#${VALID_PAYLOAD.pr}`,
        "--substrate",
        "pi",
        "--emit-verdict-block",
      ]);
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("failure path: sage exit != 0 + stderr → failed envelope with reason.kind=cant_do carrying stderr in detail", async () => {
    const stderr = "sage: PR not found";
    const spawn = makeRecordingSpawn(makeSpawnResult("", stderr, 2));
    const runner = makeSageReviewRunner({
      spawn: spawn.fn,
      which: whichSuccess,
    });

    const opts = makePipelineOpts();
    const result = await runner(opts);

    // Result shape — failed, not verdict.
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return; // narrow

    // Envelope wiring — correlation_id is the request envelope's id
    // (failed-path contract per design §5.2).
    const envelope: Envelope = result.envelope;
    expect(envelope.type).toBe("dispatch.task.failed");
    expect(envelope.correlation_id).toBe(opts.requestEnvelope.id);

    // Reason — Phase 1 collapses every non-happy outcome to `cant_do`
    // (see module docblock). Detail must carry stderr so principals can
    // grep `nats consumer info` for the actual sage error.
    const reason = (envelope.payload as { reason: { kind: string; detail: string } })
      .reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("sage review exited 2");
    expect(reason.detail).toContain(stderr);
  });

  test("binary not found: which returns undefined → failed envelope with principal-actionable detail, NEVER throws", async () => {
    // No spawn call should happen — the runner must short-circuit before
    // any subprocess work when the binary is missing. We still pass a
    // spawn that would throw if invoked to pin that no-call invariant.
    const spawnThatMustNotRun: SageSpawnFn = () => {
      throw new Error("pi-dev-runner test: spawn must not be called when sage is missing");
    };

    // Clear SAGE_BIN for this test so the env fallback can't accidentally
    // resolve a real sage on the dev box.
    const previousSageBin = process.env.SAGE_BIN;
    delete process.env.SAGE_BIN;
    try {
      const runner = makeSageReviewRunner({
        spawn: spawnThatMustNotRun,
        which: whichMissing,
      });

      const opts = makePipelineOpts();
      // CRITICAL: this must not throw — the consumer assumes
      // pipelineRunner is non-throwing (see review-pipeline.ts contract).
      const result = await runner(opts);

      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;

      const envelope = result.envelope;
      expect(envelope.correlation_id).toBe(opts.requestEnvelope.id);
      const reason = (envelope.payload as { reason: { kind: string; detail: string } })
        .reason;
      expect(reason.kind).toBe("cant_do");
      // Principal-actionable message — names the env var and PATH hint.
      expect(reason.detail).toContain("sage binary not found");
      expect(reason.detail).toContain("SAGE_BIN");
    } finally {
      if (previousSageBin !== undefined) {
        process.env.SAGE_BIN = previousSageBin;
      }
    }
  });

  test("explicit sageBin option wins over both env and PATH lookup", async () => {
    // Verify the resolution-order contract from the module docblock:
    //   1. opts.sageBin → 2. process.env.SAGE_BIN → 3. Bun.which("sage")
    const explicitBin = "/opt/custom/sage";
    const spawn = makeRecordingSpawn(makeSpawnResult("ok", "", 0));
    // Set SAGE_BIN to a different path; the explicit opt should still win.
    const previousSageBin = process.env.SAGE_BIN;
    process.env.SAGE_BIN = "/different/env/sage";
    try {
      const runner = makeSageReviewRunner({
        sageBin: explicitBin,
        spawn: spawn.fn,
        which: whichSuccess, // returns yet another path — also overridden
      });

      await runner(makePipelineOpts());
      expect(spawn.calls.length).toBe(1);
      expect(spawn.calls[0]?.[0]).toBe(explicitBin);
    } finally {
      if (previousSageBin === undefined) {
        delete process.env.SAGE_BIN;
      } else {
        process.env.SAGE_BIN = previousSageBin;
      }
    }
  });

  test("spawn throw (e.g. ENOENT mid-spawn) is caught and surfaces as a failed envelope, not an unhandled rejection", async () => {
    const spawnThatThrows: SageSpawnFn = () => {
      throw new Error("ENOENT: no such file or directory");
    };
    const runner = makeSageReviewRunner({
      spawn: spawnThatThrows,
      which: whichSuccess,
    });

    const opts = makePipelineOpts();
    const result = await runner(opts);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const reason = (result.envelope.payload as { reason: { kind: string; detail: string } })
      .reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("sage spawn failed");
    expect(reason.detail).toContain("ENOENT");
  });

  // cortex#402 — `SAGE_SUBSTRATE` env override
  // ---------------------------------------------------------------------
  // Principals without a pi.dev model provider configured (e.g. no
  // DeepSeek API key) need a way to route sage's lens execution through
  // `claude` or `codex` instead. The runner reads `SAGE_SUBSTRATE`
  // verbatim and threads it into argv; sage's own CLI validates the
  // value. Unset → `pi` (preserves pre-#402 behaviour).

  test("cortex#402 — SAGE_SUBSTRATE env overrides argv[4]", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    process.env.SAGE_SUBSTRATE = "claude";
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const result = await runner(makePipelineOpts());
      // This test pins the argv `--substrate` override; the block-less stdout
      // yields a prose completion post-F11 (no synthetic verdict).
      expect(result.kind).toBe("completed");
      expect(spawn.calls.length).toBe(1);
      expect(spawn.calls[0]!.slice(-3)).toEqual(["--substrate", "claude", "--emit-verdict-block"]);
    } finally {
      if (prior === undefined) delete process.env.SAGE_SUBSTRATE;
      else process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("cortex#402 — unset SAGE_SUBSTRATE defaults to `pi` (pre-#402 behaviour)", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      await runner(makePipelineOpts());
      expect(spawn.calls[0]!.slice(-3)).toEqual(["--substrate", "pi", "--emit-verdict-block"]);
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  // cortex#409 — sage exit-code → verdict mapping
  // ---------------------------------------------------------------------
  // sage exits 1 for a "changes-requested" verdict (cli/index.ts) — a
  // VALID review outcome, not an error. Only exit ≥2 (or -1 killed) is a
  // real failure. Before this fix any non-zero exit collapsed to
  // `dispatch.task.failed`, discarding the review markdown on stdout.

  test("cortex#409 — sage exit 1 (block-less) → prose completion, NOT failed (exit 1 is a valid outcome)", async () => {
    // cortex#409's invariant: exit 1 is a VALID review outcome (CI-gate
    // convention), never an error — the review markdown on stdout is not
    // discarded. Post-compass#99 F11 a block-less exit-1 run yields the
    // prose-completion variant (presentation=stdout) rather than a synthetic
    // `changes-requested` verdict. Still NOT `failed` — that's what #409 pins.
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const stdout = "## review body\n\nverdict: changes-requested";
      const spawn = makeRecordingSpawn(
        makeSpawnResult(stdout, "[sage] verdict: changes-requested", 1),
      );
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const opts = makePipelineOpts();
      const result = await runner(opts);

      // Not failed (the #409 invariant), and not a synthetic verdict (F11).
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.presentation).toBe(stdout.trim());
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("cortex#409 — sage exit -1 (killed) → failed (not a verdict)", async () => {
    const spawn = makeRecordingSpawn(makeSpawnResult("", "killed", -1));
    const runner = makeSageReviewRunner({
      spawn: spawn.fn,
      which: whichSuccess,
    });
    const result = await runner(makePipelineOpts());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const reason = (result.envelope.payload as { reason: { kind: string } }).reason;
    expect(reason.kind).toBe("cant_do");
  });

  // cortex#409 — `--post` propagation
  // ---------------------------------------------------------------------
  // `sage dispatch --post` stamps `payload.post: true`; the runner must
  // pass `--post` to the sage subprocess so the verdict is posted to the
  // forge. Absent/false `post` → no `--post` (sage default: no post).

  test("cortex#409 — payload.post=true appends --post to argv", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const base = makePipelineOpts();
      const opts: ReviewPipelineOpts = {
        ...base,
        payload: { ...base.payload, post: true },
      };
      await runner(opts);
      expect(spawn.calls[0]).toEqual([
        FAKE_SAGE_BIN,
        "review",
        `${VALID_PAYLOAD.repo}#${VALID_PAYLOAD.pr}`,
        "--substrate",
        "pi",
        "--emit-verdict-block",
        "--post",
      ]);
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("passes payload.forge through to sage review", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    process.env.SAGE_SUBSTRATE = "codex";
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const base = makePipelineOpts();
      const opts: ReviewPipelineOpts = {
        ...base,
        payload: {
          ...base.payload,
          repo: "saca/secacademy",
          pr: 62,
          post: true,
          forge: "gitlab",
        },
      };

      await runner(opts);

      expect(spawn.calls[0]).toEqual([
        FAKE_SAGE_BIN,
        "review",
        "saca/secacademy#62",
        "--substrate",
        "codex",
        "--emit-verdict-block",
        "--post",
        "--forge",
        "gitlab",
      ]);
    } finally {
      if (prior === undefined) delete process.env.SAGE_SUBSTRATE;
      else process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("cortex#409 — absent post → argv omits --post", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      await runner(makePipelineOpts());
      expect(spawn.calls[0]).not.toContain("--post");
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  // cortex#888 — structured verdict-block recovery
  // ---------------------------------------------------------------------
  // sage appends a fenced ```json verdict block under --emit-verdict-block
  // (sage#83). The runner parses it to recover the REAL decision (incl.
  // `approved`, which the exit-code-only path cannot express) and the
  // findings counts. A missing / malformed block now yields the
  // prose-completion variant (compass#99 F11), NOT a synthetic verdict.
  // (`withBlock` + `SAMPLE_BLOCK` fixtures live at the top of this file.)

  test("cortex#888 — exit 0 + block verdict=approved → review.verdict.approved (recovers approved)", async () => {
    const stdout = withBlock("## Sage code review — approved", SAMPLE_BLOCK);
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const opts = makePipelineOpts();
    const result = await runner(opts);

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const envelope: Envelope = result.envelope;
    // Exit code alone would yield `commented`; the block recovers `approved`.
    expect(envelope.type).toBe("review.verdict.approved");
    const payload = envelope.payload as {
      verdict: string;
      github_review_id: number;
      commit_id: string;
      findings: { blockers: number; majors: number; nits: number };
      summary: string;
    };
    expect(payload.verdict).toBe("approved");
    expect(payload.github_review_id).toBe(999);
    expect(payload.commit_id).toBe("abc1234deadbeef");
    expect(payload.findings).toEqual({ blockers: 0, majors: 0, nits: 0 });
    // Full markdown stdout (block included) is preserved as the summary.
    expect(payload.summary).toBe(stdout);
  });

  test("cortex#888 — block findings counts flow into the verdict payload", async () => {
    const stdout = withBlock("## Sage code review — changes-requested", {
      ...SAMPLE_BLOCK,
      verdict: "changes-requested",
      findings: { blockers: 1, majors: 2, nits: 3 },
    });
    // Exit 1 AND block both say changes-requested — they agree here; the
    // point is the findings counts come from the block.
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 1));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const result = await runner(makePipelineOpts());

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.changes-requested");
    const payload = result.envelope.payload as {
      findings: { blockers: number; majors: number; nits: number };
    };
    expect(payload.findings).toEqual({ blockers: 1, majors: 2, nits: 3 });
  });

  test("cortex#888 — block decision OVERRIDES exit code (exit 0 but block changes-requested)", async () => {
    // Defensive: if sage's exit code and block ever disagree, the structured
    // block is authoritative (it carries the calibrated decision).
    const stdout = withBlock("## Sage code review — changes-requested", {
      ...SAMPLE_BLOCK,
      verdict: "changes-requested",
      findings: { blockers: 1, majors: 0, nits: 0 },
    });
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const result = await runner(makePipelineOpts());

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    expect(result.envelope.type).toBe("review.verdict.changes-requested");
  });

  // compass#99 F11 — FAIL CLOSED on a missing/malformed verdict block
  // ---------------------------------------------------------------------
  // drift-8 / align cortex#503. The old exit-code fallback (exit 1 ⇒
  // changes-requested, exit 0 ⇒ commented) could NEVER represent `approved`
  // and manufactured a verdict no reviewer stood behind — a real merge-stall /
  // false-signal risk. It is DROPPED: a missing OR malformed block now returns
  // the `{ kind: "completed", presentation }` variant (the same third
  // ReviewPipelineResult the CC path returns), NEVER a synthetic
  // `review.verdict.*`. pilot's `--wait` keys on `review.verdict.*`, so no
  // fabricated decision can reach it.

  test("compass#99 F11 — MISSING verdict block (exit 0) → prose completion, NEVER a synthetic verdict", async () => {
    const stdout = "## Sage code review — commented\n\n(no json block)";
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const result = await runner(makePipelineOpts());

    // Prose completion — NOT a verdict, NOT a failure.
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.presentation).toBe(stdout.trim());
    // Structurally, a `completed` result carries NO envelope — so there is no
    // `review.verdict.*` and no synthetic verdict on the wire at all.
    expect("envelope" in result).toBe(false);
  });

  test("compass#99 F11 — MISSING verdict block (exit 1) → prose completion (exit code no longer synthesises changes-requested)", async () => {
    const stdout = "## Sage code review — changes-requested\n\n(no json block)";
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 1));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const result = await runner(makePipelineOpts());

    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.presentation).toBe(stdout.trim());
  });

  test("compass#99 F11 — MALFORMED verdict block (exit 0) → prose completion, NOT a synthetic verdict", async () => {
    const stdout = "## Sage code review — commented\n\n```json\n{ not valid json\n```";
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
    const result = await runner(makePipelineOpts());

    // A malformed block means we cannot recover the real decision — we do NOT
    // fabricate one from the exit code; we hand back the raw sage markdown.
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.presentation).toBe(stdout.trim());
    expect("envelope" in result).toBe(false);
  });

  // compass#89 (§4 L3) — confidentiality flavor is a PRE-SPAWN cant_do
  // ---------------------------------------------------------------------
  // The sage engine has no confidentiality lens, so a
  // `code-review.confidentiality` request must fail with `cant_do` BEFORE any
  // subprocess runs — never silently run a generic pass and return a verdict
  // that never looked for disclosure. This is the runtime guard for the
  // generic-claim path; `--lens` threading for other flavors is deferred to
  // compass#99.

  test("compass#89 — payload.flavor=confidentiality → cant_do PRE-SPAWN (spawn never runs)", async () => {
    const spawnThatMustNotRun: SageSpawnFn = () => {
      throw new Error("sage-runner test: spawn must not run for a confidentiality request");
    };
    const runner = makeSageReviewRunner({
      spawn: spawnThatMustNotRun,
      which: whichSuccess, // binary resolvable — proves the refusal is flavor-driven, not missing-binary
    });
    const base = makePipelineOpts();
    const opts: ReviewPipelineOpts = {
      ...base,
      payload: { ...base.payload, flavor: "confidentiality" },
    };

    // Must NOT throw — the consumer assumes a non-throwing pipeline runner.
    const result = await runner(opts);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const envelope: Envelope = result.envelope;
    expect(envelope.type).toBe("dispatch.task.failed");
    expect(envelope.correlation_id).toBe(opts.requestEnvelope.id);
    const reason = (envelope.payload as { reason: { kind: string; detail: string } }).reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("no confidentiality lens");
  });

  test("compass#89 — a non-confidentiality flavor still spawns sage (guard is confidentiality-only)", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const spawn = makeRecordingSpawn(makeSpawnResult("## review\n", "", 0));
      const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });
      const base = makePipelineOpts();
      const opts: ReviewPipelineOpts = {
        ...base,
        payload: { ...base.payload, flavor: "security" },
      };
      const result = await runner(opts);
      // The guard did NOT fire — sage spawned (evidenced by the single spawn
      // call + argv below). The block-less stdout yields a prose completion
      // post-F11; the point of this test is that a non-confidentiality flavor
      // is NOT refused, not the result shape.
      expect(result.kind).toBe("completed");
      // And (deferred to #99 F13) no `--lens` flag is threaded yet, so the
      // argv is the unchanged shape.
      expect(spawn.calls.length).toBe(1);
      expect(spawn.calls[0]).not.toContain("--lens");
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  // compass#99 F12 — stamp classification + response_routing on terminals
  // ---------------------------------------------------------------------
  // wire-2. The sage terminal envelopes (verdict + failed) MUST be
  // wire-IDENTICAL to the CC path (review-pipeline.ts:498/502 + :557/561): a
  // FEDERATED review stamps `classification: "federated"` (so the emitted
  // envelope's sovereignty matches the `federated.*` subject the consumer
  // routes it on — federation-wire-protocol SOP check 5) and ECHOES the
  // inbound `response_routing` so the review sink renders to the originating
  // thread. Absent ⇒ `local` + no routing (unchanged local-consumer path).
  // These assertions MIRROR the CC-path ones so the two engines can't re-drift.

  test("compass#99 F12 — federated VERDICT carries classification=federated + echoed response_routing", async () => {
    const stdout = withBlock("## Sage code review — approved", SAMPLE_BLOCK);
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });

    const result = await runner(makeFederatedPipelineOpts());

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const envelope: Envelope = result.envelope;
    // Sovereignty mirrors the inbound federated scope (SOP check 5).
    expect(envelope.sovereignty.classification).toBe("federated");
    // Response routing echoed verbatim onto the primary reply (the verdict).
    const payload = envelope.payload as { response_routing?: unknown };
    expect(payload.response_routing).toEqual(FED_ROUTING);
  });

  test("compass#99 F12 — LOCAL verdict defaults classification=local + omits response_routing", async () => {
    // Parametric counterpart: the local review-consumer path passes neither
    // field, so the verdict stays local and carries NO routing — identical to
    // the pre-F12 behaviour, proving F12 is additive.
    const stdout = withBlock("## Sage code review — approved", SAMPLE_BLOCK);
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });

    const result = await runner(makePipelineOpts());

    expect(result.kind).toBe("verdict");
    if (result.kind !== "verdict") return;
    const envelope: Envelope = result.envelope;
    expect(envelope.sovereignty.classification).toBe("local");
    expect("response_routing" in (envelope.payload as object)).toBe(false);
  });

  test("compass#99 F12 — federated FAILED terminal carries classification=federated + echoed response_routing", async () => {
    // The other terminal the runner emits. A real error (exit ≥2) routes back
    // to the federated requester, so its sovereignty + routing must match too.
    const spawn = makeRecordingSpawn(makeSpawnResult("", "sage: boom", 2));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });

    const result = await runner(makeFederatedPipelineOpts());

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const envelope: Envelope = result.envelope;
    expect(envelope.type).toBe("dispatch.task.failed");
    expect(envelope.sovereignty.classification).toBe("federated");
    const payload = envelope.payload as { response_routing?: unknown };
    expect(payload.response_routing).toEqual(FED_ROUTING);
  });

  test("compass#99 F12 — LOCAL failed terminal defaults classification=local + omits response_routing", async () => {
    const spawn = makeRecordingSpawn(makeSpawnResult("", "sage: boom", 2));
    const runner = makeSageReviewRunner({ spawn: spawn.fn, which: whichSuccess });

    const result = await runner(makePipelineOpts());

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    const envelope: Envelope = result.envelope;
    expect(envelope.sovereignty.classification).toBe("local");
    expect("response_routing" in (envelope.payload as object)).toBe(false);
  });
});
