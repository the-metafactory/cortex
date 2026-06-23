/**
 * `build-journal.run` code handler — the executor behind the weekly public
 * build journal.
 *
 * A pure, in-process handler the F-6 `ReflexActivationListener` invokes
 * DIRECTLY for a target whose config declares `handler: "build-journal"`
 * (target `@jc/build-journal`, fired by the reflex `build-journal-weekly`
 * schedule blueprint every Sunday). It shells the pulse build-journal pipeline:
 *
 *     cd <pulse_repo>
 *     bun examples/build-journal/run-journal.ts --llm --days <N> [--post] [--deploy]
 *
 * The pipeline gathers the week's repo activity, drafts + federated-reviews the
 * narrative, writes the build-log HTML, posts a Discord teaser (`--post`) and
 * deploys stack.meta-factory.ai (`--deploy`). The run takes minutes (nested
 * `claude` sessions) — well inside the JetStream `ack_wait` (20m), and the
 * bridge awaits this handler synchronously, so a single in-flight run blocks the
 * pull loop until it returns. A weekly cadence makes that acceptable.
 *
 * ## Why direct invocation (not a bus re-emit + agent session)
 *
 * Same rationale as `notify.discord` (cortex#1180): the bridge is the single
 * already-gated entry point (it durably consumes reflex `fired` events, which
 * reflex policy-gated). A deterministic code handler that shells a FIXED command
 * is the right fit for an unattended public deploy — there is no LLM in the
 * control path to be talked out of the command by an untrusted payload. The
 * activation payload is DATA (`days`/`post`/`deploy`), never instructions.
 *
 * ## Failure model
 *
 * Throw to signal a TRANSIENT failure (non-zero exit, spawn error, or the
 * watchdog timeout) — the bridge leaves the Decision id un-marked so reflex can
 * re-fire. The pipeline must be idempotent (a re-run of the same week is safe:
 * it overwrites that date's build-log entry and a clean site repo makes the
 * commit a no-op). Return only on a clean exit 0.
 */

import type { BuildJournalConfig } from "../common/types/cortex-config";
import type { MyelinRuntime } from "./myelin/runtime";
import type {
  FiredActivation,
  ReflexActivationHandler,
} from "./reflex-activation-listener";
import {
  createSystemBusBuildJournalEvent,
  type SystemEventSource,
} from "./system-events";

/** Relative path of the pulse runner from the pulse repo root. */
export const RUNNER_REL_PATH = "examples/build-journal/run-journal.ts";

/** Default watchdog — kills a hung run well below the 20m JetStream ack_wait. */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Minimal view of a spawned subprocess (injectable for tests). */
export interface SpawnedProc {
  exited: Promise<number>;
  kill: () => void;
}

/** Spawn function — defaults to `Bun.spawn`; injected in tests. */
export type Spawn = (cmd: string[], opts: { cwd: string }) => SpawnedProc;

const defaultSpawn: Spawn = (cmd, opts) =>
  // stdout/stderr inherit → the (verbose, minutes-long) run streams into
  // cortex-prod's journald, where an operator debugs a failed Sunday run. No
  // pipe is captured, so there is no buffer-fill deadlock during a long run.
  Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  }) as unknown as SpawnedProc;

export interface BuildJournalRunnerOpts {
  runtime: MyelinRuntime;
  source: SystemEventSource;
  /** Absolute path to the pulse repo root (`build_journal.pulse_repo`). */
  pulseRepo: string;
  /** Fallback journal period when the payload omits `days`. */
  daysDefault: number;
  /** Watchdog timeout in ms (default {@link DEFAULT_RUN_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable spawn (default: `Bun.spawn`). */
  spawn?: Spawn;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

/** Typed, defaulted view of the journal-run knobs the payload carries. */
export interface BuildJournalRunSpec {
  days: number;
  post: boolean;
  deploy: boolean;
}

/**
 * Read the run knobs from a fired-activation payload. `days` falls back to the
 * configured default; `post`/`deploy` default to TRUE (the schedule blueprint's
 * intent is to publish) and are only disabled by an explicit `false`.
 */
export function parseRunSpec(
  payload: unknown,
  daysDefault: number,
): BuildJournalRunSpec {
  const p =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return {
    days: typeof p.days === "number" && p.days > 0 ? p.days : daysDefault,
    post: p.post !== false,
    deploy: p.deploy !== false,
  };
}

/** Assemble the `bun run-journal.ts` argv for a run spec. */
export function buildRunnerArgv(pulseRepo: string, spec: BuildJournalRunSpec): string[] {
  const argv = ["bun", `${pulseRepo}/${RUNNER_REL_PATH}`, "--llm", "--days", String(spec.days)];
  if (spec.post) argv.push("--post");
  if (spec.deploy) argv.push("--deploy");
  return argv;
}

/**
 * Build the `build-journal.run` handler. The returned function shells the pulse
 * runner, awaits its exit, and emits `system.bus.build_journal` visibility
 * (`started` → `completed` | `failed`). A non-zero exit / spawn error / timeout
 * emits `failed` and THROWS so the bridge leaves the Decision re-fireable.
 */
export function createBuildJournalRunner(
  opts: BuildJournalRunnerOpts,
): ReflexActivationHandler {
  const spawn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? console;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  const emit = (
    outcome: "started" | "completed" | "failed",
    activation: FiredActivation,
    spec: BuildJournalRunSpec,
    reason?: string,
  ): void => {
    void opts.runtime
      .publish(
        createSystemBusBuildJournalEvent({
          source: opts.source,
          outcome,
          days: spec.days,
          decisionId: activation.decisionId,
          ...(reason !== undefined && { reason }),
          ...(activation.correlationId !== undefined && {
            correlationId: activation.correlationId,
          }),
        }),
      )
      .catch((err: unknown) => {
        log.error(`build-journal: visibility publish failed: ${errMsg(err)}`);
      });
  };

  return async (activation) => {
    const spec = parseRunSpec(activation.payload, opts.daysDefault);
    const argv = buildRunnerArgv(opts.pulseRepo, spec);
    log.info(
      `build-journal: running ${argv.join(" ")} (decision ${activation.decisionId})`,
    );
    emit("started", activation, spec);

    let proc: SpawnedProc;
    try {
      proc = spawn(argv, { cwd: opts.pulseRepo });
    } catch (err) {
      emit("failed", activation, spec, `spawn:${errMsg(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } catch (err) {
      clearTimeout(timer);
      emit("failed", activation, spec, `wait:${errMsg(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    clearTimeout(timer);

    if (timedOut) {
      emit("failed", activation, spec, `timeout-${timeoutMs}ms`);
      throw new Error(
        `build-journal run exceeded ${timeoutMs}ms watchdog (killed; decision ${activation.decisionId})`,
      );
    }
    if (exitCode !== 0) {
      emit("failed", activation, spec, `exit-${exitCode}`);
      throw new Error(`build-journal run exited ${exitCode} (decision ${activation.decisionId})`);
    }
    emit("completed", activation, spec);
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
