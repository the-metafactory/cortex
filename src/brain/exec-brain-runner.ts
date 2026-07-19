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
 *        - `create_private_thread` → ALWAYS refused `effect_rejected` (this
 *          lifecycle has no live surface-adapter binding; cortex#2206 is
 *          daemon-lifecycle only — see `daemon-brain-host.ts`)
 *        - `post_log`      → ALWAYS refused `effect_rejected` (cortex#2256 is
 *          likewise daemon-lifecycle only — the log-channel binding + rate
 *          limiter live on the supervising host)
 *        - `compose`       → ALWAYS refused `effect_rejected` (cortex#2257 is
 *          likewise daemon-lifecycle only — the compose opt-in, rate limiter,
 *          and substrate seam live on the supervising host)
 *        - `log`           → `hooks.onLog`
 *        - `result`        → terminal; resolve.
 *   5. task_id correlation: any effect whose `task_id` ≠ the spawned task's id
 *      is refused with `effect_rejected` (`wont_do`) and DROPPED (§5
 *      "task_id correlation is enforced host-side").
 *   6. Scratch confinement: a `post` attachment `path` must resolve within the
 *      task's realpath'd scratch dir; an escape is refused with
 *      `effect_rejected` (`wont_do`, "attachment path outside scratch dir") and
 *      the post DROPPED. The host owns the filesystem boundary, not the brain.
 *   7. Termination: `result` is TERMINAL — on a schema-valid `result` for the
 *      owned task the run RESOLVES immediately. Process reaping then happens
 *      fire-and-forget AFTER resolution (close stdin → `resultGraceMs` self-exit
 *      grace → SIGTERM → +`killGraceMs` SIGKILL) and can never delay or reject
 *      the resolved promise. A `timeoutMs` with no result → SIGTERM → grace →
 *      SIGKILL. Brain exit WITHOUT a `result` → synthesize
 *      `result: failed (cant_do, "brain exited without result")` with the
 *      captured (bounded) stderr tail in `reason.detail`.
 *
 * The runner returns the final `result` plus the collected log lines and the
 * bounded stderr tail.
 */

import { mkdtempSync, realpathSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve as resolvePath, sep } from "path";
import {
  encodeBrainEvent,
  parseBrainEffect,
  JsonlDecoder,
  type TaskEvent,
  type PostEffect,
  type PostLogEffect,
  type AskPrincipalEffect,
  type DispatchEffect,
  type LogEffect,
  type ResultEffect,
  type GateVerdictValue,
  type BrainReason,
} from "./protocol";
import { AttachmentBudget } from "./attachment-budget";

/**
 * Max stderr we retain in memory. A chatty brain must not grow the runner's
 * heap without bound, so we keep only the last {@link STDERR_TAIL_CAP} bytes as
 * a ring (older bytes are dropped, a truncation marker is prepended once).
 */
const STDERR_TAIL_CAP = 8 * 1024;

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
  onDispatch(dispatch: DispatchEffect): BrainDispatchOutcome | Promise<BrainDispatchOutcome>;

  /** A `log` effect — diagnostic; not surfaced to the principal. */
  onLog(log: LogEffect): void | Promise<void>;

  /**
   * cortex#2248 — the host successfully created a private thread for THIS
   * task (`create_private_thread`, cortex#2206). OPTIONAL: the BrainConsumer
   * uses it to RETARGET the task's subsequent `post` routing into the
   * created thread — the conversation moves into the thread the host itself
   * created and verified; without it the posts kept landing in the parent
   * channel and the thread stayed empty. §5 property 1 is preserved: the
   * brain STILL never names a target — `threadId` is host-derived (the
   * adapter's create result), never brain-supplied wire input. Only the
   * `lifecycle: daemon` host wires `create_private_thread`, so the per-task
   * runner never fires this hook; it is optional so per-task callers (and
   * tests that don't care about routing) omit it.
   */
  onThreadCreated?(threadId: string): void | Promise<void>;

  /**
   * cortex#2256 — a `post_log` effect that PASSED the daemon host's gates
   * (log-channel binding present, length cap, rate limit). The BrainConsumer
   * publishes the log-channel `dispatch.task.post` envelope routed at
   * `logChannelId` — the HOST-derived target passed here so the single
   * source of the binding stays the host (§5 property 1: the brain never
   * named it; the hook receives only what the host already decided, the
   * same shape as `onThreadCreated`'s host-resolved `threadId`).
   *
   * Resolves `{ ok: false, detail }` on a failed publish so the host can
   * refuse the effect `not_now` (transient/retryable); never throws by
   * contract. OPTIONAL: only the `lifecycle: daemon` host wires `post_log`
   * (the per-task runner refuses it, same as `create_private_thread`), so
   * per-task callers and routing-agnostic tests omit it.
   */
  onPostLog?(
    post: PostLogEffect,
    logChannelId: string,
  ): Promise<{ ok: true } | { ok: false; detail: string }>;
}

export type BrainDispatchOutcome =
  | undefined
  | { rejected: false }
  | { rejected: true; reason: BrainReason };

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
   * Grace period AFTER a terminal `result` is received: how long to let the
   * brain exit on its own (post stdin-close) before SIGTERM. The run has
   * ALREADY resolved by this point — this only bounds background reaping.
   * Defaults to 2_000 (finding 1).
   */
  resultGraceMs?: number;
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
  const resultGraceMs = opts.resultGraceMs ?? 2_000;
  const secrets = opts.secrets ?? {};

  return async (
    task: TaskEvent,
    hooks: BrainTaskHooks,
  ): Promise<BrainTaskRunResult> => {
    const argv = buildArgv(opts.run, opts.packDir);
    const scratchDir = makeScratchDir();
    const env = buildEnv(scratchDir, secrets);

    const logs: string[] = [];
    // We collect stderr into a bounded ring (drained in parallel below). It
    // feeds the synthesized-failure reason.detail when the brain exits without
    // a result, and is returned to the caller. A chatty brain cannot grow this
    // past STDERR_TAIL_CAP — see {@link StderrRing}.
    const stderrRing = new StderrRing(STDERR_TAIL_CAP);

    // Per-task attachment budget (§12.5) — 4 MiB cumulative inline + scratch
    // bytes across every `post` this task emits. Over budget → effect_rejected
    // (wont_do) and the post is DROPPED. One budget per spawned task (per-task
    // lifecycle = one task per process).
    const attachmentBudget = new AttachmentBudget();

    // Resolve the scratch dir's REAL path once (mkdtemp may hand back a path
    // through a symlinked temp root, e.g. /var → /private/var on macOS). All
    // scratch-path confinement checks compare against this realpath prefix.
    let scratchReal: string;
    try {
      scratchReal = realpathSync(scratchDir);
    } catch {
      // If realpath fails (dir vanished), fall back to the resolved literal;
      // confinement still rejects anything outside it.
      scratchReal = resolvePath(scratchDir);
    }

    // The terminal run result. The run is RESOLVED on the FIRST of: a
    // schema-valid `result` effect for the owned task, or process exit without
    // one. A manual promise lets the stdout pump settle it mid-read-loop. Once
    // resolved, cleanup (kill escalation + scratch removal) is fire-and-forget
    // and can never reject this promise (finding 1: `result` is terminal).
    let resolveRun!: (r: BrainTaskRunResult) => void;
    const runPromise = new Promise<BrainTaskRunResult>((res) => {
      resolveRun = res;
    });
    let runSettled = false;

    let proc: BrainSpawnResult;
    try {
      proc = spawn(argv, { env, cwd: scratchDir });
    } catch (err) {
      // Spawn throw (bad argv, sandbox/env bug). Synthesize a cant_do.
      void cleanupScratch(scratchDir);
      const detail = err instanceof Error ? err.message : String(err);
      return {
        result: synthFailed(task.task_id, `brain spawn failed: ${detail}`),
        logs,
        stderrTail: "",
        exitCode: null,
      };
    }

    // --- timeout → SIGTERM → (grace) → SIGKILL ----------------------------
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    /**
     * Fire-and-forget kill escalation: SIGTERM now, SIGKILL after the grace.
     * Used by BOTH the timeout path and the post-`result` cleanup. Wrapped in
     * try/catch because a process that already exited makes `kill` throw.
     */
    const escalateKill = (): void => {
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
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      escalateKill();
    }, timeoutMs);
    const clearTimers = (): void => {
      clearTimeout(killTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };

    /**
     * Resolve the run with the brain's terminal `result`, THEN run cleanup
     * fire-and-forget (finding 1: `result` is terminal — the run returns
     * promptly; the process is reaped afterward and cannot delay or reject the
     * resolved promise).
     *
     * Cleanup sequence (all AFTER resolution):
     *   1. close stdin (EOF — most brains exit on it);
     *   2. give the process `resultGraceMs` to exit on its own;
     *   3. SIGTERM, then SIGKILL after `killGraceMs`;
     *   4. remove the scratch dir (async).
     */
    const settleWithResult = (result: ResultEffect): void => {
      if (runSettled) return;
      runSettled = true;
      clearTimers();
      resolveRun({
        result,
        logs,
        stderrTail: stderrRing.value(),
        // The process has not necessarily exited yet; exit code is unknown at
        // resolution time. Callers that need the code use the no-result path
        // (which awaits exit). A terminal result is the brain's own verdict.
        exitCode: null,
      });
      // --- fire-and-forget cleanup (cannot reject the resolved run) --------
      void reapAfterResult();
    };

    /**
     * Best-effort reaping after a terminal result: close stdin, grace, escalate
     * kill, drop scratch. Every step is guarded; a throw here never surfaces
     * (the run promise is already resolved).
     */
    const reapAfterResult = async (): Promise<void> => {
      try {
        proc.stdin.end();
      } catch (err) {
        console.warn(
          "exec-brain-runner: stdin.end() after result failed:",
          err instanceof Error ? err.message : err,
        );
      }
      // Race the process's own exit against the result grace.
      const exitedOnOwn = await Promise.race([
        proc.exited.then(() => true).catch(() => true),
        new Promise<boolean>((res) =>
          setTimeout(() => { res(false); }, resultGraceMs),
        ),
      ]);
      if (!exitedOnOwn) {
        escalateKill();
        // Let the kill escalation complete in the background, then clear the
        // grace timer once the process is gone.
        proc.exited
          .catch(() => undefined)
          .finally(() => {
            if (graceTimer !== undefined) clearTimeout(graceTimer);
          });
      }
      await cleanupScratch(scratchDir);
    };

    // --- write the task event to stdin ------------------------------------
    try {
      await proc.stdin.write(encodeBrainEvent(task) + "\n");
      await proc.stdin.flush?.();
    } catch (err) {
      // stdin closed before we could write — treat as a brain that refused
      // the task. Let the exit fallback below synthesize the failure, but
      // record why.
      stderrRing.append(
        `[runner] stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        await proc.stdin.write(line + "\n");
        await proc.stdin.flush?.();
      } catch (err) {
        console.warn(
          "exec-brain-runner: failed to write event to brain stdin (likely exiting):",
          err instanceof Error ? err.message : err,
        );
      }
    };

    /**
     * Send an `effect_rejected` back to the brain and DROP the effect. Shared
     * by the foreign-task_id and scratch-confinement refusals. `kind` is a
     * brain-kind (`wont_do`) — a host policy refusal in v1.
     */
    const rejectEffect = async (
      effectType: string,
      detail: string,
    ): Promise<void> => {
      await sendEvent(
        encodeBrainEvent({
          v: 1,
          type: "effect_rejected",
          task_id: task.task_id,
          effect: effectType,
          reason: { kind: "wont_do", detail },
        }),
      );
    };

    // --- route one validated, correlation-checked effect ------------------
    const routeEffect = async (
      parsed: ReturnType<typeof parseBrainEffect>,
    ): Promise<void> => {
      // Drop-and-log invalid/unknown lines (§5 forward-compat). The type guard
      // narrows `parsed` to the `ok` variant when it returns false.
      if (!isOkEffect(parsed, logs)) return;
      const e = parsed.effect;

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
      // Echo OUR task id, not the foreign one, so the brain correlates the
      // rejection to the task it actually owns.
      if (e.task_id !== task.task_id) {
        await rejectEffect(
          e.type,
          `foreign task_id ${e.task_id} (this brain owns ${task.task_id})`,
        );
        return;
      }

      switch (e.type) {
        case "post": {
          // Scratch-path confinement (finding 3): a `path` attachment must
          // resolve to WITHIN this task's realpath'd scratch dir. An escape
          // (`..`, an absolute path elsewhere) is refused with effect_rejected
          // and the post is DROPPED — the host owns the filesystem boundary,
          // not the brain. Symlink-escape detection is out of scope for v1; we
          // normalize and prefix-check.
          let confinedPath: string | undefined;
          if (e.attachment?.path !== undefined) {
            const confined = confineScratchPath(
              scratchReal,
              e.attachment.path,
            );
            if (!confined.ok) {
              await rejectEffect(
                "post",
                "attachment path outside scratch dir",
              );
              return;
            }
            confinedPath = confined.resolved;
          }
          // Per-task attachment budget (§12.5): charge the attachment's bytes
          // (decoded inline b64 OR confined scratch-file size) against the 4 MiB
          // task ceiling. Over budget → effect_rejected (wont_do, PERMANENT for
          // this task) and the post is DROPPED — the brain must summarise/link.
          // A budget charge runs AFTER confinement so we only stat in-bounds
          // files. A text-only post (no attachment) never touches the budget.
          if (e.attachment !== undefined) {
            const charge = attachmentBudget.charge(e.attachment, confinedPath);
            if (!charge.ok) {
              await rejectEffect("post", charge.detail);
              return;
            }
          }
          await hooks.onPost(e);
          return;
        }
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
          if (outcome?.rejected) {
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
        case "create_private_thread": {
          // cortex#2206 — this capability is DAEMON-lifecycle only: it needs
          // a live surface-adapter binding + a supervising host's rate
          // limiter/timeout-pause machinery, none of which the per-task
          // (B-1) runner has (this is a fresh spawn-per-task process with no
          // standing adapter connection). Refuse rather than silently no-op.
          await rejectEffect(
            "create_private_thread",
            "create_private_thread is not supported by the per-task (lifecycle: per-task) " +
              "exec-brain runner — only daemon-lifecycle brains may open private threads (cortex#2206)",
          );
          return;
        }
        case "post_log": {
          // cortex#2256 — daemon-lifecycle only, same reasoning as
          // `create_private_thread`: the log-channel binding + per-agent
          // rate limiter live on the supervising DaemonBrainHost, which the
          // per-task runner has no counterpart for. Refuse rather than
          // silently no-op.
          await rejectEffect(
            "post_log",
            "post_log is not supported by the per-task (lifecycle: per-task) " +
              "exec-brain runner — only daemon-lifecycle brains may notify their log channel (cortex#2256)",
          );
          return;
        }
        case "compose": {
          // cortex#2257 — daemon-lifecycle only, same reasoning as
          // `create_private_thread`/`post_log`: the compose opt-in, the
          // per-agent rate limiter, and the substrate seam live on the
          // supervising DaemonBrainHost, which the per-task runner has no
          // counterpart for. Refuse rather than silently no-op.
          await rejectEffect(
            "compose",
            "compose is not supported by the per-task (lifecycle: per-task) " +
              "exec-brain runner — only daemon-lifecycle brains may render " +
              "substrate voice turns (cortex#2257)",
          );
          return;
        }
        case "result":
          // Terminal: resolve the run NOW, reap the process afterward
          // (finding 1).
          settleWithResult(e);
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
    // Returns nothing; a stream error is CAPTURED (folded into the stderr
    // ring + logs), never thrown out of the pump (finding 6). An unhandled
    // rejection here would otherwise escape the resolved run.
    const pumpStdout = async (): Promise<void> => {
      const decoder = new JsonlDecoder();
      const reader = proc.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.push(value)) {
            await routeEffect(parseBrainEffect(line));
          }
        }
        // Flush any final newline-less line.
        for (const line of decoder.flush()) {
          await routeEffect(parseBrainEffect(line));
        }
      } catch (err) {
        const msg = `[runner] stdout pump error: ${err instanceof Error ? err.message : String(err)}`;
        logs.push(msg);
        stderrRing.append(msg);
      } finally {
        reader.releaseLock();
      }
    };

    // --- stderr drain (parallel, so a big blob can't deadlock the pipe) ----
    const pumpStderr = async (): Promise<void> => {
      try {
        const reader = proc.stderr.getReader();
        const dec = new TextDecoder("utf-8");
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stderrRing.append(dec.decode(value, { stream: true }));
          }
          const trailing = dec.decode();
          if (trailing.length > 0) stderrRing.append(trailing);
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        // Stream error — record it but don't fail the task on stderr alone.
        stderrRing.append(
          `[runner] stderr stream error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    // Pumps run concurrently with the exit watch. Their rejections are already
    // captured inside; we still keep their promises so the no-result fallback
    // can await a full drain before synthesizing the failure detail.
    const stdoutDone = pumpStdout();
    const stderrDone = pumpStderr();

    // --- exit watcher: the no-result fallback -----------------------------
    // If the process exits before a terminal `result` settles the run, drain
    // the pumps and synthesize a failed result. This runs concurrently with
    // the routeEffect loop; whichever settles the run first wins (settleWith*
    // is idempotent via runSettled).
    void (async (): Promise<void> => {
      let exitCode: number | null;
      try {
        exitCode = await proc.exited;
      } catch (err) {
        console.warn(
          "exec-brain-runner: `exited` rejected:",
          err instanceof Error ? err.message : err,
        );
        exitCode = null;
      }
      // Drain the remaining stdout/stderr — a late `result` on the final chunk
      // can still settle the run inside routeEffect.
      await Promise.allSettled([stdoutDone, stderrDone]);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- routeEffect can settle the run while this exit watcher awaits process/pump completion.
      if (runSettled) return;
      clearTimers();
      const stderrTail = stderrRing.value();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the timeout callback can flip timedOut before proc.exited resolves.
      const reasonDetail = timedOut
        ? `brain timed out after ${timeoutMs}ms${
            stderrTail.trim() ? `; stderr: ${tail(stderrTail)}` : ""
          }`
        : `brain exited without result${
            stderrTail.trim() ? `; stderr: ${tail(stderrTail)}` : ""
          }`;
      runSettled = true;
      resolveRun({
        result: synthFailed(task.task_id, reasonDetail),
        logs,
        stderrTail,
        exitCode,
      });
      await cleanupScratch(scratchDir);
    })();

    return runPromise;
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

/** Env keys the runner owns — a secret may never replace them (sage: a
 * pack-declared secret named PATH/TMPDIR could steer executable lookup or
 * temp-file behavior outside the sandbox). */
const RUNNER_OWNED_ENV_KEYS = new Set(["PATH", "HOME", "LANG", "TMPDIR"]);

/**
 * Build the minimal brain env (§8): PATH, HOME, LANG, the scoped TMPDIR, plus
 * the explicit secrets. NO ambient fleet credentials. Secret names that
 * collide with the runner-owned baseline are REJECTED (throw) — fail closed
 * rather than let a manifest redefine the sandbox.
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
    if (RUNNER_OWNED_ENV_KEYS.has(k.toUpperCase())) {
      throw new Error(
        `brain secret "${k}" collides with a runner-owned env key — rename the secret`,
      );
    }
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
    kill: (signal) => { proc.kill(signal); },
  };
}

/** Production scratch-dir factory — `mkdtempSync` under the OS temp dir. */
function defaultMakeScratchDir(): string {
  return mkdtempSync(join(tmpdir(), "cortex-brain-"));
}

/**
 * Best-effort scratch-dir removal, ASYNC + non-blocking (finding 8). A leftover
 * temp dir is non-fatal. Never throws — a failed cleanup is logged, not
 * surfaced (the run is already resolved by the time this is called).
 */
async function cleanupScratch(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
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
 * Drop-and-log invalid/unknown parse results (§5 forward-compat), and act as a
 * type guard that narrows to the `ok` variant. Single tolerant-parse handler
 * shared by every parse site (finding 8 — was duplicated inline).
 *
 * Returns `true` (narrowing `parsed` to `{ kind: "ok"; effect }`) when the line
 * is a well-formed known effect; `false` when it was dropped.
 */
function isOkEffect(
  parsed: ReturnType<typeof parseBrainEffect>,
  logs: string[],
): parsed is Extract<ReturnType<typeof parseBrainEffect>, { kind: "ok" }> {
  if (parsed.kind === "invalid") {
    // Malformed line / failed validation (e.g. oversized attachment).
    logs.push(`[runner] dropped invalid effect: ${parsed.detail}`);
    return false;
  }
  if (parsed.kind === "unknown") {
    // Forward-compat: unknown effect type — drop and log (§5).
    logs.push(
      `[runner] dropped unknown effect type: ${String(parsed.raw.type)}`,
    );
    return false;
  }
  return true;
}

/**
 * Host-side scratch confinement (finding 3). A brain's `path` attachment must
 * resolve to WITHIN `scratchReal` (the realpath'd per-task scratch dir).
 *
 *   - `scratchReal` is already realpath'd by the caller (canonical, symlink-
 *     free root on the SCRATCH side).
 *   - The candidate is `path.resolve`d against the scratch root, normalizing
 *     `..` segments and binding a relative path to the scratch dir.
 *   - The resolved candidate's NEAREST EXISTING ANCESTOR is realpath'd so the
 *     comparison is symlink-canonical on both sides — this is what makes a
 *     legitimate file under a symlinked temp root (macOS `/var` →
 *     `/private/var`) compare equal instead of false-rejecting. We realpath the
 *     ancestor (not the file) because the attachment file may not exist yet.
 *   - A prefix check (`resolved === root || resolved.startsWith(root + sep)`)
 *     then rejects any path that climbed out, or an absolute path elsewhere.
 *
 * Symlink ESCAPES on the candidate side (a real file the brain placed inside
 * scratch that itself symlinks out, then references by that inner path) are
 * explicitly out of scope for v1 — we canonicalize the ANCESTOR for the
 * temp-root case, not chase a maliciously-planted leaf symlink.
 */
export function confineScratchPath(
  scratchReal: string,
  candidate: string,
): { ok: true; resolved: string } | { ok: false } {
  const root = resolvePath(scratchReal);
  // resolve() binds a relative candidate to the scratch root and collapses
  // `..`; an absolute candidate is resolved as-is.
  const resolved = resolvePath(root, candidate);
  // Canonicalize via the nearest existing ancestor so a symlinked temp root
  // doesn't cause a false reject. realpathSync throws on a missing leaf, so we
  // walk up to the first ancestor that exists.
  const canonical = realpathNearestAncestor(resolved);
  if (canonical === root || canonical.startsWith(root + sep)) {
    return { ok: true, resolved };
  }
  return { ok: false };
}

/**
 * realpath the nearest existing ancestor of `p`, re-appending the non-existent
 * tail. Lets confinement canonicalize a path whose leaf file does not exist
 * yet (the common case — the brain is about to write it).
 */
function realpathNearestAncestor(p: string): string {
  let dir = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const idx = dir.lastIndexOf(sep);
      if (idx <= 0) return p; // reached the root without a hit; use as-is
      tail.push(dir.slice(idx + 1));
      dir = dir.slice(0, idx);
    }
  }
}

/**
 * Bounded stderr ring (finding 7). Retains at most `cap` bytes; older content
 * is dropped and a one-time truncation marker is prepended so the caller knows
 * the tail is partial. Keeps a chatty brain from growing the runner heap.
 */
class StderrRing {
  private buf = "";
  private truncated = false;
  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.buf += chunk;
    if (this.buf.length > this.cap) {
      this.buf = this.buf.slice(this.buf.length - this.cap);
      this.truncated = true;
    }
  }

  value(): string {
    return this.truncated ? `…[stderr truncated]…${this.buf}` : this.buf;
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
