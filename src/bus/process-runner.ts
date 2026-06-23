/**
 * `process` reflex code handler — a GENERIC, config-driven command runner.
 *
 * Ships ONCE. New automated processes are added as DATA — a spec file dropped
 * into the processes directory (default `~/.config/cortex/processes/*.yaml`) —
 * with NO cortex code change and NO re-release. The F-6 bridge invokes this one
 * handler for any target whose config declares `handler: "process"`; the target
 * also names which spec to run (`process: "<name>"`).
 *
 * ## Trust boundary (why this is safe)
 *
 *  - The spec NAME comes from the TARGET config (`target.process`) — operator-
 *    authored, trusted. It is NEVER read from the untrusted activation payload,
 *    so a payload cannot pick which command runs.
 *  - `cwd` and `argv` come ENTIRELY from the spec file (trusted, on-disk). The
 *    payload may only fill DECLARED, TYPED parameter slots (`{name}` tokens an
 *    int/string param), validated before substitution. argv is an ARRAY passed
 *    to `Bun.spawn` with NO shell — a param value is always a single argv
 *    element, so it cannot split into extra flags or inject a second command.
 *  - The spec name is path-segment validated (`[a-z0-9-]`), so `target.process`
 *    cannot traverse out of the processes directory.
 *
 * ## Failure model (mirrors notify.discord / build-journal)
 *
 *  - Deterministic misconfig (no `process` name, spec file missing/invalid, a
 *    param fails type/required validation) → emit `failed` visibility and
 *    RETURN. Re-firing the SAME activation won't fix a config error; the next
 *    scheduled fire will, once the file is fixed.
 *  - Runtime failure (non-zero exit, spawn error, watchdog timeout) → emit
 *    `failed` and THROW, so the bridge leaves the Decision id un-marked
 *    (re-fireable). Specs are expected to be idempotent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { MyelinRuntime } from "./myelin/runtime";
import type {
  FiredActivation,
  ReflexActivationHandler,
} from "./reflex-activation-listener";
import {
  createSystemBusProcessEvent,
  type SystemEventSource,
} from "./system-events";

/** Default watchdog — kills a hung run well below the 20m JetStream ack_wait. */
export const DEFAULT_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;

/** Path-segment grammar for a spec name (no traversal, stable file mapping). */
export const PROCESS_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A declared, typed parameter a `{name}` argv token can be filled from. */
export const ProcessParamSchema = z.object({
  type: z.enum(["int", "string"]),
  /** Default used when the activation payload omits the param. */
  default: z.union([z.number(), z.string()]).optional(),
  /** For `string` params: the closed set of allowed values. */
  enum: z.array(z.string().min(1)).optional(),
});

/** A process spec — the DATA unit operators drop into the processes directory. */
export const ProcessSpecSchema = z.object({
  /** Spec name; must equal the file basename and the target's `process:` value. */
  name: z.string().regex(PROCESS_NAME_RE, "process name must be [a-z0-9-]"),
  /** Absolute working directory the command runs in. */
  cwd: z.string().min(1),
  /** argv array (no shell). Elements may contain `{param}` tokens. */
  argv: z.array(z.string().min(1)).min(1),
  /** Watchdog timeout; default {@link DEFAULT_PROCESS_TIMEOUT_MS}. */
  timeout_ms: z.number().int().positive().default(DEFAULT_PROCESS_TIMEOUT_MS),
  /** Declared params `{name}` tokens may reference. */
  params: z.record(z.string(), ProcessParamSchema).default({}),
});

export type ProcessSpec = z.infer<typeof ProcessSpecSchema>;

/** Minimal view of a spawned subprocess (injectable for tests). */
export interface SpawnedProc {
  exited: Promise<number>;
  kill: () => void;
}

/** Spawn function — defaults to `Bun.spawn`; injected in tests. */
export type Spawn = (cmd: string[], opts: { cwd: string }) => SpawnedProc;

const defaultSpawn: Spawn = (cmd, opts) =>
  // stdio inherit → the (verbose, minutes-long) run streams into cortex-prod's
  // journald, where an operator debugs a failed run. No captured pipe → no
  // buffer-fill deadlock during a long run.
  Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  }) as unknown as SpawnedProc;

const TOKEN_RE = /\{([a-zA-Z0-9_]+)\}/g;

/** Every `{token}` referenced anywhere in argv. */
function argvTokens(argv: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const el of argv) {
    for (const m of el.matchAll(TOKEN_RE)) tokens.add(m[1]!);
  }
  return tokens;
}

/**
 * Read + validate a spec file `<dir>/<name>.yaml`. Throws on: a name that
 * isn't a clean path segment, a missing/invalid file, a `name` field that
 * disagrees with the filename, or an argv `{token}` with no matching param
 * (fail-closed — a typo can't silently pass an empty string).
 */
export function loadProcessSpec(dir: string, name: string): ProcessSpec {
  if (!PROCESS_NAME_RE.test(name)) {
    throw new Error(`invalid process name "${name}" (must be ${PROCESS_NAME_RE})`);
  }
  const path = join(dir, `${name}.yaml`);
  const raw = parseYaml(readFileSync(path, "utf-8")) as unknown;
  const spec = ProcessSpecSchema.parse(raw);
  if (spec.name !== name) {
    throw new Error(`spec name "${spec.name}" in ${path} must match filename "${name}"`);
  }
  for (const token of argvTokens(spec.argv)) {
    if (!(token in spec.params)) {
      throw new Error(`argv token "{${token}}" in process "${name}" has no declared param`);
    }
  }
  return spec;
}

/**
 * Resolve argv for a run: fill each declared param from the activation payload
 * (or its default), validate the value against the param type, then substitute
 * `{token}` occurrences. Throws on a missing required param or a type/enum
 * violation — DATA, not instructions, so a bad value fails the run rather than
 * altering the command shape.
 */
export function resolveArgv(spec: ProcessSpec, payload: Record<string, unknown>): string[] {
  const values: Record<string, string> = {};
  for (const [name, param] of Object.entries(spec.params)) {
    const provided = payload[name];
    const value = provided !== undefined ? provided : param.default;
    if (value === undefined) {
      throw new Error(`param "${name}" is required (no payload value, no default)`);
    }
    if (param.type === "int") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`param "${name}" must be an integer, got ${JSON.stringify(value)}`);
      }
      values[name] = String(value);
    } else {
      if (typeof value !== "string") {
        throw new Error(`param "${name}" must be a string, got ${JSON.stringify(value)}`);
      }
      if (param.enum !== undefined && !param.enum.includes(value)) {
        throw new Error(`param "${name}" must be one of ${param.enum.join("|")}, got "${value}"`);
      }
      values[name] = value;
    }
  }
  return spec.argv.map((el) => el.replace(TOKEN_RE, (_m, k: string) => values[k] ?? `{${k}}`));
}

export interface ProcessRunnerOpts {
  runtime: MyelinRuntime;
  source: SystemEventSource;
  /** Directory holding `<name>.yaml` spec files. */
  processesDir: string;
  /** Injectable spec loader (default: read from {@link processesDir}). */
  loadSpec?: (name: string) => ProcessSpec;
  /** Injectable spawn (default: `Bun.spawn`). */
  spawn?: Spawn;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

/**
 * Build the generic `process` handler. It reads `target.process`, loads that
 * spec fresh from disk (so a newly dropped spec file is picked up on the next
 * fire — no restart), resolves argv from the payload params, spawns, and emits
 * `system.bus.process` visibility (`started` → `completed` | `failed`).
 */
export function createProcessRunner(opts: ProcessRunnerOpts): ReflexActivationHandler {
  const spawn = opts.spawn ?? defaultSpawn;
  const log = opts.log ?? console;
  const loadSpec = opts.loadSpec ?? ((name: string) => loadProcessSpec(opts.processesDir, name));

  const emit = (
    outcome: "started" | "completed" | "failed",
    process: string,
    activation: FiredActivation,
    reason?: string,
  ): void => {
    void opts.runtime
      .publish(
        createSystemBusProcessEvent({
          source: opts.source,
          outcome,
          process,
          decisionId: activation.decisionId,
          ...(reason !== undefined && { reason }),
          ...(activation.correlationId !== undefined && {
            correlationId: activation.correlationId,
          }),
        }),
      )
      .catch((err: unknown) => {
        log.error(`process-runner: visibility publish failed: ${errMsg(err)}`);
      });
  };

  return async (activation, target) => {
    const process = target?.process;
    if (process === undefined || process.length === 0) {
      // Misconfig: a `handler: process` target with no `process:` name. The
      // schema forbids this, so this is a belt-and-braces guard — deterministic,
      // re-firing won't fix it.
      log.error(`process-runner: target ${activation.target} has no process name — skipped`);
      emit("failed", "(none)", activation, "no-process-name");
      return;
    }

    let spec: ProcessSpec;
    let argv: string[];
    try {
      spec = loadSpec(process);
      argv = resolveArgv(spec, activation.payload);
    } catch (err) {
      // Deterministic: a bad spec / param won't fix on re-fire of THIS decision.
      emit("failed", process, activation, `spec:${errMsg(err)}`);
      return;
    }

    log.info(`process-runner: running "${process}" → ${argv.join(" ")} (decision ${activation.decisionId})`);
    emit("started", process, activation);

    let proc: SpawnedProc;
    try {
      proc = spawn(argv, { cwd: spec.cwd });
    } catch (err) {
      emit("failed", process, activation, `spawn:${errMsg(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, spec.timeout_ms);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } catch (err) {
      clearTimeout(timer);
      emit("failed", process, activation, `wait:${errMsg(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    clearTimeout(timer);

    if (timedOut) {
      emit("failed", process, activation, `timeout-${spec.timeout_ms}ms`);
      throw new Error(`process "${process}" exceeded ${spec.timeout_ms}ms watchdog (killed)`);
    }
    if (exitCode !== 0) {
      emit("failed", process, activation, `exit-${exitCode}`);
      throw new Error(`process "${process}" exited ${exitCode} (decision ${activation.decisionId})`);
    }
    emit("completed", process, activation);
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
