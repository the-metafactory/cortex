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
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
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
      const runner = makePiDevPipelineRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const result = await runner(makePipelineOpts());
      expect(result.kind).toBe("verdict");
      expect(spawn.calls.length).toBe(1);
      expect(spawn.calls[0]!.slice(-2)).toEqual(["--substrate", "claude"]);
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
      const runner = makePiDevPipelineRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      await runner(makePipelineOpts());
      expect(spawn.calls[0]!.slice(-2)).toEqual(["--substrate", "pi"]);
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

  test("cortex#409 — sage exit 1 → changes-requested verdict (not failed), summary=stdout", async () => {
    const prior = process.env.SAGE_SUBSTRATE;
    delete process.env.SAGE_SUBSTRATE;
    try {
      const stdout = "## review body\n\nverdict: changes-requested";
      const spawn = makeRecordingSpawn(
        makeSpawnResult(stdout, "[sage] verdict: changes-requested", 1),
      );
      const runner = makePiDevPipelineRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      const opts = makePipelineOpts();
      const result = await runner(opts);

      expect(result.kind).toBe("verdict");
      if (result.kind !== "verdict") return;
      const envelope: Envelope = result.envelope;
      expect(envelope.type).toBe("review.verdict.changes-requested");
      expect(envelope.correlation_id).toBe(opts.requestEnvelope.id);
      const payload = envelope.payload as { verdict: string; summary: string };
      expect(payload.verdict).toBe("changes-requested");
      expect(payload.summary).toBe(stdout);
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });

  test("cortex#409 — sage exit -1 (killed) → failed (not a verdict)", async () => {
    const spawn = makeRecordingSpawn(makeSpawnResult("", "killed", -1));
    const runner = makePiDevPipelineRunner({
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
      const runner = makePiDevPipelineRunner({
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
      const runner = makePiDevPipelineRunner({
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
      const runner = makePiDevPipelineRunner({
        spawn: spawn.fn,
        which: whichSuccess,
      });
      await runner(makePipelineOpts());
      expect(spawn.calls[0]).not.toContain("--post");
    } finally {
      if (prior !== undefined) process.env.SAGE_SUBSTRATE = prior;
    }
  });
});
