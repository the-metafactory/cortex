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
 *      envelope }` with a useful operator-facing detail string. Boot path
 *      is structurally identical for all three — the runner never throws.
 *
 * The four-way nak taxonomy (`cant_do` / `wont_do` / `not_now` /
 * `compliance_block`) is intentionally collapsed to `cant_do` in Phase 1
 * (see module docblock); when Phase 2's `--format json` lands, expand
 * these cases to cover the substrate-transient `not_now` paths too.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import {
  createReviewRequestEvent,
  type ReviewEventSource,
  type ReviewRequestPayload,
} from "../../../bus/review-events";
import type { ReviewPipelineOpts } from "../../review-pipeline";
import type { CCSessionFactory } from "../../../substrates/claude-code/harness";
import {
  makePiDevPipelineRunner,
  type PiDevSpawnFn,
  type PiDevSpawnResult,
  type PiDevWhichFn,
} from "../pi-dev-runner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: ReviewEventSource = {
  org: "metafactory",
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
 * Build a `PiDevSpawnResult` from a canned stdout, stderr, and exit code.
 * Uses `Response.body` to turn strings into the same `ReadableStream<Uint8Array>`
 * shape `Bun.spawn` returns — same trick the production runner uses to
 * drain via `new Response(stream).text()`.
 */
function makeSpawnResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): PiDevSpawnResult {
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
 * given `PiDevSpawnResult`. Pins the argv shape the runner builds
 * (`sage review owner/repo#N --substrate pi`).
 */
function makeRecordingSpawn(
  result: PiDevSpawnResult,
): { fn: PiDevSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: PiDevSpawnFn = (argv, _opts) => {
    calls.push([...argv]);
    return result;
  };
  return { fn, calls };
}

/** `which` stub that returns a fixed sage binary path. */
const FAKE_SAGE_BIN = "/usr/local/bin/sage";
const whichSuccess: PiDevWhichFn = (cmd) =>
  cmd === "sage" ? FAKE_SAGE_BIN : undefined;
const whichMissing: PiDevWhichFn = () => undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cortex#331 Phase 1 — makePiDevPipelineRunner", () => {
  test("happy path: sage exit 0 + stdout → verdict envelope with summary=stdout, correlation_id=requestEnvelope.id", async () => {
    const stdout = "## review body\n\nverdict: commented";
    const spawn = makeRecordingSpawn(makeSpawnResult(stdout, "", 0));
    const runner = makePiDevPipelineRunner({
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

    // Argv pin — `sage review owner/repo#N --substrate pi`, with the
    // resolved binary path as argv[0].
    expect(spawn.calls.length).toBe(1);
    expect(spawn.calls[0]).toEqual([
      FAKE_SAGE_BIN,
      "review",
      `${VALID_PAYLOAD.repo}#${VALID_PAYLOAD.pr}`,
      "--substrate",
      "pi",
    ]);
  });

  test("failure path: sage exit != 0 + stderr → failed envelope with reason.kind=cant_do carrying stderr in detail", async () => {
    const stderr = "sage: PR not found";
    const spawn = makeRecordingSpawn(makeSpawnResult("", stderr, 2));
    const runner = makePiDevPipelineRunner({
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
    // (see module docblock). Detail must carry stderr so operators can
    // grep `nats consumer info` for the actual sage error.
    const reason = (envelope.payload as { reason: { kind: string; detail: string } })
      .reason;
    expect(reason.kind).toBe("cant_do");
    expect(reason.detail).toContain("sage review exited 2");
    expect(reason.detail).toContain(stderr);
  });

  test("binary not found: which returns undefined → failed envelope with operator-actionable detail, NEVER throws", async () => {
    // No spawn call should happen — the runner must short-circuit before
    // any subprocess work when the binary is missing. We still pass a
    // spawn that would throw if invoked to pin that no-call invariant.
    const spawnThatMustNotRun: PiDevSpawnFn = () => {
      throw new Error("pi-dev-runner test: spawn must not be called when sage is missing");
    };

    // Clear SAGE_BIN for this test so the env fallback can't accidentally
    // resolve a real sage on the dev box.
    const previousSageBin = process.env.SAGE_BIN;
    delete process.env.SAGE_BIN;
    try {
      const runner = makePiDevPipelineRunner({
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
      // Operator-actionable message — names the env var and PATH hint.
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
      const runner = makePiDevPipelineRunner({
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
    const spawnThatThrows: PiDevSpawnFn = () => {
      throw new Error("ENOENT: no such file or directory");
    };
    const runner = makePiDevPipelineRunner({
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
});
