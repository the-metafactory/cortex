/**
 * `cortex-brain/v1` per-task exec runner (Bot Packs B-1;
 * `docs/design-bot-packs.md` §5, §11 B-1).
 *
 * The cortex-side half of the `kind: exec`, `lifecycle: per-task` seam: spawn
 * the pack's declared command, write the `task` event to its stdin, stream-
 * parse its stdout effects, route each effect to caller-supplied hooks, and
 * answer host effects (`gate_verdict`, `effect_rejected`) back on stdin.
 *
 * **A NEW sibling to `src/runner/sage-runner.ts`, not a modification of it.**
 * Sage-runner carries cortex#888/917/920 history and stays untouched (§11:
 * "sage-runner itself untouched … migrating sage onto the generic runner is a
 * later option, not a B-1 goal"). This file borrows its precedents — the
 * narrowed `Bun.spawn` handle, parallel stdout/stderr drain so a large blob
 * can't deadlock the OS pipe buffer — but the lifecycle is different: a brain
 * is alive until it emits `result`, emitting many effects in between, whereas
 * sage is spawn-read-exit.
 *
 * ## Lifecycle (per-task — §5 "lifecycle: per-task means alive until result")
 *
 *   1. Create a per-task scoped scratch dir (becomes `TMPDIR`).
 *   2. Spawn the manifest argv with a MINIMAL env: PATH, HOME, LANG, the
 *      scoped TMPDIR, plus ONLY the explicit `secrets` map (verbatim). No
 *      ambient fleet credentials (§8 "No ambient fleet credentials").
 *   3. Write the `task` event as one JSONL line to stdin.
 *   4. Stream-parse stdout via {@link JsonlDecoder} + {@link parseBrainEffect}.
 *      Route each effect:
 *        - `post`          → `hooks.onPost`
 *        - `ask_principal` → `hooks.onAskPrincipal` → answer `gate_verdict`
 *        - `dispatch`      → `hooks.onDispatch`; may reject → `effect_rejected`
 *        - `log`           → `hooks.onLog`
 *        - `result`        → terminal; resolve.
 *   5. task_id correlation: any effect whose `task_id` ≠ the spawned task's id
 *      is refused with `effect_rejected` (`wont_do`) and DROPPED (§5
 *      "task_id correlation is enforced host-side").
 *   6. Termination: process stays until `result`. At `timeoutMs` → SIGTERM;
 *      +5 s grace → SIGKILL (§5/§7 escalation). Brain exit WITHOUT a `result`
 *      → synthesize `result: failed (cant_do, "brain exited without result")`
 *      with the captured stderr tail in `reason.detail`.
 *
 * The runner returns the final `result` plus the collected log lines and the
 * stderr tail.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  encodeBrainEvent,
  parseBrainEffect,
  JsonlDecoder,
  type TaskEvent,
  type PostEffect,
  type AskPrincipalEffect,
  type DispatchEffect,
  type LogEffect,
  type ResultEffect,
  type GateVerdictValue,
  type BrainReason,
} from "./protocol";

// ---------------------------------------------------------------------------
// Spawn-injection types — narrowed surface of `Bun.spawn`
// ---------------------------------------------------------------------------
//
// Same rationale as sage-runner: we don't take `typeof Bun.spawn` (wide,
// brittle across Bun versions). The runner needs a writable stdin, readable
// stdout + stderr, `exited`, and a `kill(signal)` handle. Narrowing keeps the
// test seam trivial (a fake yields a controllable stdin sink + stdout/stderr
// streams + a settable exit code) and lets internal spawn flags evolve.

/** A writable stdin sink — the subset of Bun's `FileSink` the runner uses. */
export interface BrainStdinSink {
  write(chunk: string | Uint8Array): number | Promise<number>;
  /**
   * Flush buffered bytes. Bun's `FileSink.flush()` returns the byte count
   * synchronously or a `Promise<number>` when it must drain — the runner
   * `await`s it either way (an awaited number is a no-op).
   */
  flush?(): number | Promise<number>;
  end(): void;
}

/** The handle the runner needs from a spawned brain process. */
export interface BrainSpawnResult {
  stdin: BrainStdinSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  /** Send a POSIX signal to the process (SIGTERM / SIGKILL escalation). */
  kill(signal?: NodeJS.Signals | number): void;
}

/**
 * Spawn function signature. Production wires {@link defaultSpawn} (`Bun.spawn`
 * with `stdin: "pipe"`); tests inject a deterministic fake.
 *
 * `argv` is the fully resolved command (the manifest `run` string, argv-split,
 * with `{pack}` already substituted). `opts.env` is the minimal env map; `cwd`
 * is the scoped scratch dir.
 */
export type BrainSpawnFn = (
  argv: string[],
  opts: { env: Record<string, string>; cwd: string },
) => BrainSpawnResult;

// ---------------------------------------------------------------------------
// Hooks — what the caller supplies for each brain effect
// ---------------------------------------------------------------------------

/**
 * Effect hooks. The runner routes each validated, correlation-checked effect
 * to the matching hook. Cortex (the BrainConsumer, B-2 wiring) supplies these
 * to perform the actual host effects under policy.
 */
export interface BrainTaskHooks {
  /** A `post` effect — cortex posts to the task's surface/thread. */
  onPost(post: PostEffect): void | Promise<void>;

  /**
   * An `ask_principal` effect — cortex renders the gate, performs the
   * host-side principal check, and resolves with the verdict the runner then
   * forwards to the brain as a `gate_verdict` event (carrying the
   * host-resolved principal). The brain never infers a verdict from chat text
   * (the pulse#47 lesson).
   */
  onAskPrincipal(
    ask: AskPrincipalEffect,
  ): Promise<{
    verdict: GateVerdictValue;
    principal: string;
    notes?: string;
  }>;

  /**
   * A `dispatch` effect — cortex publishes the myelin envelope. Resolving with
   * `{ rejected: true, reason }` (e.g. capability outside the manifest, or
   * sovereignty refusal) makes the runner send the brain an `effect_rejected`
   * event so it can degrade. Resolving with `{ rejected: false }` (or void)
   * accepts the dispatch.
   */
  onDispatch(
    dispatch: DispatchEffect,
  ):
    | void
    | Promise<void>
    | { rejected: false }
    | { rejected: true; reason: BrainReason }
    | Promise<{ rejected: false } | { rejected: true; reason: BrainReason }>;

  /** A `log` effect — diagnostic; not surfaced to the principal. */
  onLog(log: LogEffect): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory options + result
// ---------------------------------------------------------------------------

/** Options for {@link makeExecBrainRunner}. */
export interface MakeExecBrainRunnerOpts {
  /**
   * The manifest `run` string, e.g. `"bun {pack}/brain/main.ts"`. Argv-split
   * on whitespace; `{pack}` is substituted from {@link packDir}.
   */
  run: string;
  /** The arc install dir — substituted for the `{pack}` placeholder in `run`. */
  packDir: string;
  /**
   * Secret env vars (the manifest `brain.secrets` resolved to values),
   * injected verbatim into the brain env. Principal-approved at install time.
   * Defaults to `{}`.
   */
  secrets?: Record<string, string>;
  /**
   * Per-task timeout in ms. On expiry the runner sends SIGTERM, then SIGKILL
   * after a 5 s grace. Defaults to 120_000 (2 min).
   */
  timeoutMs?: number;
  /**
   * Grace period between SIGTERM and SIGKILL, in ms. Defaults to 5_000 (§5/§7).
   */
  killGraceMs?: number;
  /**
   * Spawn function — defaults to {@link defaultSpawn} (`Bun.spawn`). Tests
   * inject a fake.
   */
  spawn?: BrainSpawnFn;
  /**
   * Scratch-dir factory — creates a fresh per-task scratch dir and returns its
   * path. Defaults to {@link defaultMakeScratchDir} (`mkdtempSync` under the
   * OS temp dir). Tests can stub this.
   */
  makeScratchDir?: () => string;
}

/** What {@link runBrainTask} resolves with. */
export interface BrainTaskRunResult {
  /**
   * The terminal `result` effect — either the brain's own, or a synthesized
   * `failed` when the brain exited without emitting one / timed out.
   */
  result: ResultEffect;
  /** Every `log` effect's text, in emission order. */
  logs: string[];
  /** The captured stderr tail (whole stderr; callers may trim). */
  stderrTail: string;
  /** The brain process exit code, or `null` if it was killed before exit. */
  exitCode: number | null;
}

/** A `runBrainTask` function bound to a configured runner. */
export type RunBrainTask = (
  task: TaskEvent,
  hooks: BrainTaskHooks,
) => Promise<BrainTaskRunResult>;

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a per-task brain runner from a manifest's `brain` block.
 *
 * No side effects at construction — the factory only closes over `opts`. The
 * scratch dir, spawn, and stdin write all happen inside {@link runBrainTask}.
 */
export function makeExecBrainRunner(
  opts: MakeExecBrainRunnerOpts,
): RunBrainTask {
  const spawn = opts.spawn ?? defaultSpawn;
  const makeScratchDir = opts.makeScratchDir ?? defaultMakeScratchDir;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const secrets = opts.secrets ?? {};

  return async (
    task: TaskEvent,
    hooks: BrainTaskHooks,
  ): Promise<BrainTaskRunResult> => {
    const argv = buildArgv(opts.run, opts.packDir);
    const scratchDir = makeScratchDir();
    const env = buildEnv(scratchDir, secrets);

    const logs: string[] = [];
    // We collect stderr to a single string (drained in parallel below). It
    // feeds the synthesized-failure reason.detail when the brain exits
    // without a result.
    let stderrTail = "";

    // The terminal result. Resolved either by the brain's `result` effect or
    // by the exit/timeout fallback. We use a manual promise so the stdout
    // pump can settle it from inside the read loop.
    let resolveResult!: (r: ResultEffect) => void;
    const resultPromise = new Promise<ResultEffect>((res) => {
      resolveResult = res;
    });
    let resultSeen = false;
    const settleResult = (r: ResultEffect): void => {
      if (!resultSeen) {
        resultSeen = true;
        resolveResult(r);
      }
    };

    let proc: BrainSpawnResult;
    try {
      proc = spawn(argv, { env, cwd: scratchDir });
    } catch (err) {
      // Spawn throw (bad argv, sandbox/env bug). Synthesize a cant_do.
      cleanupScratch(scratchDir);
      const detail = err instanceof Error ? err.message : String(err);
      return {
        result: synthFailed(task.task_id, `brain spawn failed: ${detail}`),
        logs,
        stderrTail: "",
        exitCode: null,
      };
    }

    // --- timeout → SIGTERM → (grace) → SIGKILL ----------------------------
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const clearTimers = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };
    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        console.warn(
          "exec-brain-runner: SIGTERM failed (process likely already exited):",
          err instanceof Error ? err.message : err,
        );
      }
      graceTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch (err) {
          console.warn(
            "exec-brain-runner: SIGKILL failed (process likely already exited):",
            err instanceof Error ? err.message : err,
          );
        }
      }, killGraceMs);
    }, timeoutMs);

    // --- write the task event to stdin ------------------------------------
    try {
      proc.stdin.write(encodeBrainEvent(task) + "\n");
      await proc.stdin.flush?.();
    } catch (err) {
      // stdin closed before we could write — treat as a brain that refused
      // the task. Let the exit fallback below synthesize the failure, but
      // record why.
      stderrTail +=
        (stderrTail ? "\n" : "") +
        `[runner] stdin write failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    /**
     * Send a host event back to the brain on stdin. Best-effort: a closed
     * stdin (brain already exiting) is logged, not thrown — the exit path
     * handles overall task resolution.
     *
     * The flush is AWAITED. Bun's `FileSink.flush()` returns a Promise; a
     * fire-and-forget flush can leave the line buffered (the brain then
     * blocks on `read()` and we deadlock until the timeout). Awaiting it
     * guarantees the line is on the wire before we return — critical for the
     * gate round-trip (`ask_principal` → `gate_verdict`).
     */
    const sendEvent = async (line: string): Promise<void> => {
      try {
        proc.stdin.write(line + "\n");
        await proc.stdin.flush?.();
      } catch (err) {
        console.warn(
          "exec-brain-runner: failed to write event to brain stdin (likely exiting):",
          err instanceof Error ? err.message : err,
        );
      }
    };

    // --- route one validated, correlation-checked effect ------------------
    const routeEffect = async (
      effect: ReturnType<typeof parseBrainEffect>,
    ): Promise<void> => {
      if (effect.kind === "invalid") {
        // Malformed line / failed validation (e.g. oversized attachment).
        // Drop-and-log; never throws the pump.
        logs.push(`[runner] dropped invalid effect: ${effect.detail}`);
        return;
      }
      if (effect.kind === "unknown") {
        // Forward-compat: unknown effect type — drop and log (§5).
        logs.push(
          `[runner] dropped unknown effect type: ${String(effect.raw["type"])}`,
        );
        return;
      }

      const e = effect.effect;

      // `log` is task-agnostic — it carries no `task_id` and is a pure
      // diagnostic, so it bypasses correlation entirely (running it through
      // the task_id check below would treat its absent id as "foreign").
      if (e.type === "log") {
        logs.push(e.text);
        await hooks.onLog(e);
        return;
      }

      // task_id correlation — host-enforced. Every TASK-SCOPED effect (post,
      // ask_principal, dispatch, result) must carry THIS brain's task id; a
      // foreign or absent id is refused with effect_rejected (wont_do) and the
      // effect is DROPPED (§5 "task_id correlation is enforced host-side").
      if (e.task_id !== task.task_id) {
        await sendEvent(
          encodeBrainEvent({
            v: 1,
            type: "effect_rejected",
            // Echo OUR task id, not the (possibly undefined) foreign one — the
            // brain correlates the rejection to the task it actually owns.
            task_id: task.task_id,
            effect: e.type,
            reason: {
              kind: "wont_do",
              detail: `foreign task_id ${String(e.task_id)} (this brain owns ${task.task_id})`,
            },
          }),
        );
        return;
      }

      switch (e.type) {
        case "post":
          await hooks.onPost(e);
          return;
        case "ask_principal": {
          const verdict = await hooks.onAskPrincipal(e);
          await sendEvent(
            encodeBrainEvent({
              v: 1,
              type: "gate_verdict",
              task_id: task.task_id,
              gate: e.gate,
              verdict: verdict.verdict,
              principal: verdict.principal,
              ...(verdict.notes !== undefined && { notes: verdict.notes }),
            }),
          );
          return;
        }
        case "dispatch": {
          const outcome = await hooks.onDispatch(e);
          if (
            outcome !== undefined &&
            outcome !== null &&
            typeof outcome === "object" &&
            "rejected" in outcome &&
            outcome.rejected === true
          ) {
            await sendEvent(
              encodeBrainEvent({
                v: 1,
                type: "effect_rejected",
                task_id: task.task_id,
                effect: "dispatch",
                reason: outcome.reason,
              }),
            );
          }
          return;
        }
        case "result":
          settleResult(e);
          return;
        default: {
          // Exhaustiveness guard — a new effect type added to the union but
          // not handled here trips this at compile time.
          const _never: never = e;
          void _never;
          return;
        }
      }
    };

    // --- stdout pump: stream-parse effects --------------------------------
    const pumpStdout = async (): Promise<void> => {
      const decoder = new JsonlDecoder();
      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            for (const line of decoder.push(value)) {
              await routeEffect(parseBrainEffect(line));
            }
          }
        }
        // Flush any final newline-less line.
        for (const line of decoder.flush()) {
          await routeEffect(parseBrainEffect(line));
        }
      } finally {
        reader.releaseLock();
      }
    };

    // --- stderr drain (parallel, so a big blob can't deadlock the pipe) ----
    const pumpStderr = async (): Promise<void> => {
      try {
        stderrTail += await new Response(proc.stderr).text();
      } catch (err) {
        // Stream error — record it but don't fail the task on stderr alone.
        stderrTail +=
          (stderrTail ? "\n" : "") +
          `[runner] stderr stream error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    // Run stdout pump, stderr drain, and the exit wait concurrently. The
    // stdout pump completing (stream closed) and `exited` resolving both bound
    // the task; we await all so logs/stderr are fully collected.
    const stdoutDone = pumpStdout();
    const stderrDone = pumpStderr();

    let exitCode: number | null = null;
    try {
      exitCode = await proc.exited;
    } catch (err) {
      console.warn(
        "exec-brain-runner: `exited` rejected:",
        err instanceof Error ? err.message : err,
      );
      exitCode = null;
    }

    // The process has exited — drain the remaining stdout/stderr then resolve.
    await Promise.allSettled([stdoutDone, stderrDone]);
    clearTimers();

    // If the brain exited without emitting a `result`, synthesize one.
    if (!resultSeen) {
      const reasonDetail = timedOut
        ? `brain timed out after ${timeoutMs}ms${
            stderrTail.trim() ? `; stderr: ${tail(stderrTail)}` : ""
          }`
        : `brain exited without result${
            stderrTail.trim() ? `; stderr: ${tail(stderrTail)}` : ""
          }`;
      settleResult(synthFailed(task.task_id, reasonDetail));
    }

    const result = await resultPromise;
    cleanupScratch(scratchDir);

    return { result, logs, stderrTail, exitCode };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split the manifest `run` string into argv and substitute `{pack}`.
 * Whitespace-split is sufficient for the house style (`bun {pack}/brain/main.ts`);
 * shell-quoted args are out of scope for v1 (the manifest author controls the
 * string). Throws on an empty argv — a manifest bug, surfaced before spawn.
 */
export function buildArgv(run: string, packDir: string): string[] {
  const argv = run
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((tok) => tok.replaceAll("{pack}", packDir));
  if (argv.length === 0) {
    throw new Error("brain `run` string is empty after substitution");
  }
  return argv;
}

/**
 * Build the minimal brain env (§8): PATH, HOME, LANG, the scoped TMPDIR, plus
 * the explicit secrets verbatim. NO ambient fleet credentials. The secrets map
 * is spread LAST but env keys it shares with the minimal set would be a
 * manifest author's explicit choice — secrets win, which is the documented
 * "injected verbatim" behavior.
 */
export function buildEnv(
  scratchDir: string,
  secrets: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? scratchDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: scratchDir,
  };
  for (const [k, v] of Object.entries(secrets)) {
    env[k] = v;
  }
  return env;
}

/** Production spawn — `Bun.spawn` with a piped stdin. */
function defaultSpawn(
  argv: string[],
  opts: { env: Record<string, string>; cwd: string },
): BrainSpawnResult {
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    cwd: opts.cwd,
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal as number | NodeJS.Signals | undefined),
  };
}

/** Production scratch-dir factory — `mkdtempSync` under the OS temp dir. */
function defaultMakeScratchDir(): string {
  return mkdtempSync(join(tmpdir(), "cortex-brain-"));
}

/** Best-effort scratch-dir removal. A leftover temp dir is non-fatal. */
function cleanupScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Non-fatal: a leftover scratch dir under the OS temp dir is cleaned by
    // the OS eventually; we log rather than fail the task on cleanup.
    console.warn(
      "exec-brain-runner: scratch-dir cleanup failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Synthesize a `result: failed (cant_do)` for the no-result / spawn-fail /
 * timeout paths. `cant_do` because the brain failed to complete under its own
 * power — distinct from a `wont_do` policy refusal or a `not_now` transient
 * the brain would have declared itself.
 */
function synthFailed(taskId: string, detail: string): ResultEffect {
  return {
    v: 1,
    type: "result",
    task_id: taskId,
    status: "failed",
    reason: { kind: "cant_do", detail },
  };
}

/** Trim a stderr blob to a bounded tail for inclusion in a reason detail. */
function tail(s: string, max = 1_000): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}
