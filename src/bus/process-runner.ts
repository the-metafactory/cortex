/**
 * `process` reflex code handler — a GENERIC, config-driven command runner.
 *
 * Ships ONCE. New automated processes are added as DATA — a spec file dropped
 * into the processes directory (default `~/.config/cortex/processes/*.yaml`) —
 * with NO cortex code change and NO re-release. The F-6 bridge invokes this one
 * handler for any target whose config declares `handler: "process"`; the target
 * also names which spec to run (`process: "<name>"`).
 *
 * NOTE on placement: like `notify-discord.ts`, this code handler lives under
 * `src/bus` because it is invoked DIRECTLY by the reflex-activation bridge (the
 * gated entry point), not over a second bus hop. CONTEXT.md's "bus stays dumb,
 * smarts at M7" ideal would put both handlers in an application module; moving
 * them is a separate refactor that should relocate `notify.discord` too, so
 * this PR keeps the established precedent rather than splitting it.
 *
 * ## Trust boundary (why this is safe)
 *
 *  - The spec NAME comes from the TARGET config (`target.process`) — config-
 *    authored, trusted. It is NEVER read from the untrusted activation payload,
 *    so a payload cannot pick which command runs.
 *  - `cwd` and `argv` come from the spec FILE, not the activation. The spec is
 *    deployment-controlled config; its trust rests on the filesystem permissions
 *    of the processes directory (the same trust as cortex.yaml), NOT on any
 *    code check here — this layer validates SHAPE, not provenance. What this
 *    layer DOES guarantee: the payload can only fill DECLARED, TYPED parameter
 *    slots (`{name}` tokens), validated before substitution; a `string` slot is
 *    `enum`-constrained unless `freeform` is explicitly set. argv is an ARRAY
 *    passed to `Bun.spawn` with NO shell — a param value is always a single
 *    argv element, so it cannot split into extra flags or inject a 2nd command.
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
 *    `failed` and THROW. The bridge ACKS the JetStream message either way (it
 *    does NOT nack/redeliver — same as notify.discord); "re-fireable" means only
 *    that a THROW leaves the Decision id UN-marked in the bridge's dedup, so a
 *    LATER reflex fire of the same Decision (e.g. the next schedule tick) is not
 *    deduped away. There is no immediate retry. Specs are expected idempotent.
 *    (Detached specs already returned, so they report `failed` via visibility
 *    only — they cannot throw; the next scheduled fire re-runs them.)
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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

/**
 * Hard ceiling on a spec's `timeout_ms`. The watchdog must fire BEFORE the
 * 20-min JetStream `ack_wait` (`DEFAULT_ACK_WAIT_NS`) so a killed run is reported
 * and acked before the broker redelivers it — keep a margin under it.
 */
export const MAX_PROCESS_TIMEOUT_MS = 19 * 60 * 1000;

/** Grace between the watchdog's SIGTERM and the SIGKILL that can't be ignored. */
export const SIGKILL_GRACE_MS = 10 * 1000;

/** Path-segment grammar for a spec name (no traversal, stable file mapping). */
export const PROCESS_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A declared, typed parameter a `{name}` argv token can be filled from. */
export const ProcessParamSchema = z
  .object({
    type: z.enum(["int", "string"]),
    /** Default used when the activation payload omits the param. */
    default: z.union([z.number(), z.string()]).optional(),
    /** For `string` params: the closed set of allowed values. */
    enum: z.array(z.string().min(1)).optional(),
    /**
     * Opt in to an UNCONSTRAINED string value (no `enum`). A free-form string
     * param's value reaches argv as a single token, so for a target wired to an
     * untrusted impulse source (http/github) it is one attacker-controlled arg.
     * Requiring this flag makes that a deliberate, greppable choice rather than
     * an oversight — a `string` param is otherwise `enum`-constrained.
     */
    freeform: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.type === "int") {
      if (p.enum !== undefined) {
        ctx.addIssue({ code: "custom", message: "`enum` is only valid on a `string` param", path: ["enum"] });
      }
      if (p.freeform === true) {
        ctx.addIssue({ code: "custom", message: "`freeform` is only valid on a `string` param", path: ["freeform"] });
      }
      if (p.default !== undefined && (typeof p.default !== "number" || !Number.isInteger(p.default))) {
        ctx.addIssue({ code: "custom", message: "`default` for an `int` param must be an integer", path: ["default"] });
      }
    } else {
      // A string value reaches argv verbatim — require it be constrained by an
      // `enum`, or that free-form is opted into explicitly.
      if (p.enum === undefined && p.freeform !== true) {
        ctx.addIssue({
          code: "custom",
          message: "a `string` param needs `enum: [...]` or `freeform: true` (its value reaches argv unconstrained)",
          path: ["enum"],
        });
      }
      if (p.default !== undefined && typeof p.default !== "string") {
        ctx.addIssue({ code: "custom", message: "`default` for a `string` param must be a string", path: ["default"] });
      }
      if (p.enum !== undefined && typeof p.default === "string" && !p.enum.includes(p.default)) {
        ctx.addIssue({ code: "custom", message: "`default` must be one of `enum`", path: ["default"] });
      }
    }
  });

/** A process spec — the DATA unit dropped into the processes directory. */
export const ProcessSpecSchema = z.object({
  /** Spec name; must equal the file basename and the target's `process:` value. */
  name: z.string().regex(PROCESS_NAME_RE, "process name must be [a-z0-9-]"),
  /** Absolute working directory the command runs in. */
  cwd: z.string().min(1).refine((c) => isAbsolute(c), "cwd must be an absolute path"),
  /** argv array (no shell). Elements may contain `{param}` tokens. */
  argv: z.array(z.string().min(1)).min(1),
  /** Watchdog timeout; default {@link DEFAULT_PROCESS_TIMEOUT_MS}, capped at {@link MAX_PROCESS_TIMEOUT_MS}. */
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_PROCESS_TIMEOUT_MS, "timeout_ms must stay under the 20-min JetStream ack_wait")
    .default(DEFAULT_PROCESS_TIMEOUT_MS),
  /**
   * Long-running? When `true`, the handler spawns + emits `started` + RETURNS
   * immediately, supervising the run (watchdog + `completed`/`failed`
   * visibility) in the background — so a minutes-long run does NOT block the
   * single, serial reflex bridge pull loop (other activations keep flowing).
   * Trade-off: a detached run reports failure via `system.bus.process{failed}`
   * only — it cannot THROW to re-fire the Decision (the handler already
   * returned). Fine for an idempotent scheduled job; the next fire re-runs it.
   * Default `false` = synchronous (the bridge awaits; failures re-fire).
   */
  detach: z.boolean().default(false),
  /**
   * Environment ALLOW-LIST: names of vars passed through from cortex's env to
   * the child. When set, the child gets ONLY these (so a process can't read
   * unrelated cortex secrets — bus creds, webhook tokens, LLM keys). When
   * OMITTED, the child inherits cortex's FULL environment — convenient for a
   * trusted spec that needs many vars (build-journal needs claude / wrangler /
   * discord auth + HOME/PATH), but it means that spec sees every cortex secret.
   * Prefer an allow-list for anything that doesn't genuinely need the world.
   */
  env: z.array(z.string().min(1)).optional(),
  /** Declared params `{name}` tokens may reference. */
  params: z.record(z.string(), ProcessParamSchema).default({}),
});

export type ProcessSpec = z.infer<typeof ProcessSpecSchema>;

/** Minimal view of a spawned subprocess (injectable for tests). */
export interface SpawnedProc {
  exited: Promise<number>;
  /** Send a signal (default SIGTERM); the watchdog escalates to SIGKILL. */
  kill: (signal?: string) => void;
}

/**
 * Spawn function — defaults to `Bun.spawn`; injected in tests. `env` undefined
 * means "inherit the parent environment" (Bun's default); a record restricts
 * the child to exactly those vars.
 */
export type Spawn = (cmd: string[], opts: { cwd: string; env?: Record<string, string> }) => SpawnedProc;

const defaultSpawn: Spawn = (cmd, opts) => {
  // stdio inherit → the (verbose, minutes-long) run streams into cortex-prod's
  // journald, where an admin debugs a failed run. No captured pipe → no
  // buffer-fill deadlock during a long run.
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
    ...(opts.env !== undefined && { env: opts.env }),
  });
  return { exited: p.exited, kill: (signal) => { p.kill(signal as never); } };
};

const TOKEN_RE = /\{([a-zA-Z0-9_]+)\}/g;

/** Every `{token}` referenced anywhere in argv. */
function argvTokens(argv: readonly string[]): Set<string> {
  const tokens = new Set<string>();
  for (const el of argv) {
    for (const m of el.matchAll(TOKEN_RE)) {
      const name = m[1];
      if (name !== undefined) tokens.add(name);
    }
  }
  return tokens;
}

/**
 * Read + validate a spec file `<dir>/<name>.yaml`. Throws on: a name that
 * isn't a clean path segment, a missing/invalid file, a `name` field that
 * disagrees with the filename, or an argv `{token}` with no matching param
 * (fail-closed — a typo can't silently pass an empty string).
 */
export async function loadProcessSpec(dir: string, name: string): Promise<ProcessSpec> {
  if (!PROCESS_NAME_RE.test(name)) {
    throw new Error(`invalid process name "${name}" (must be ${PROCESS_NAME_RE})`);
  }
  const path = join(dir, `${name}.yaml`);
  const raw = parseYaml(await readFile(path, "utf-8")) as unknown;
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
  loadSpec?: (name: string) => ProcessSpec | Promise<ProcessSpec>;
  /** Injectable spawn (default: `Bun.spawn`). */
  spawn?: Spawn;
  /** SIGTERM→SIGKILL grace (default {@link SIGKILL_GRACE_MS}); overridable for tests. */
  sigkillGraceMs?: number;
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
  const sigkillGraceMs = opts.sigkillGraceMs ?? SIGKILL_GRACE_MS;

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
    const processName = target?.process;
    if (processName === undefined || processName.length === 0) {
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
      spec = await loadSpec(processName);
      argv = resolveArgv(spec, activation.payload);
    } catch (err) {
      // Deterministic: a bad spec / param won't fix on re-fire of THIS decision.
      emit("failed", processName, activation, `spec:${errMsg(err)}`);
      return;
    }

    // Log the un-substituted spec template (tokens, not values) — a resolved
    // argv could carry a param value that is a secret (esp. a `freeform` slot).
    log.info(`process-runner: running "${processName}" → ${spec.argv.join(" ")} (decision ${activation.decisionId})`);
    emit("started", processName, activation);

    // Restrict the child to the spec's env allow-list when present; omitted →
    // inherit the full cortex env (see `env` on ProcessSpecSchema for the risk).
    const childEnv =
      spec.env !== undefined
        ? Object.fromEntries(
            spec.env
              .map((k) => [k, process.env[k]] as const)
              .filter((e): e is readonly [string, string] => e[1] !== undefined),
          )
        : undefined;

    let proc: SpawnedProc;
    try {
      proc = spawn(argv, { cwd: spec.cwd, ...(childEnv !== undefined && { env: childEnv }) });
    } catch (err) {
      emit("failed", processName, activation, `spawn:${errMsg(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (spec.detach) {
      // Long-running: don't block the serial bridge pull loop. Supervise in the
      // background; report via visibility only (the handler already returned, so
      // a failure can't re-fire — the next scheduled fire re-runs the job).
      void superviseRun(proc, spec.timeout_ms, sigkillGraceMs)
        .then((r) => { emit(r.ok ? "completed" : "failed", processName, activation, r.ok ? undefined : r.reason); })
        .catch((err: unknown) => { log.error(`process-runner: detached supervise threw: ${errMsg(err)}`); });
      return;
    }

    // Synchronous: the bridge awaits, and a failure THROWS so the Decision is
    // left un-marked (re-fireable).
    const result = await superviseRun(proc, spec.timeout_ms, sigkillGraceMs);
    if (!result.ok) {
      emit("failed", processName, activation, result.reason);
      throw new Error(`process "${processName}" failed: ${result.reason} (decision ${activation.decisionId})`);
    }
    emit("completed", processName, activation);
  };
}

/**
 * Await a spawned run under a SIGTERM→SIGKILL watchdog. Returns a typed outcome
 * (never throws); the caller decides whether a failure also THROWS (synchronous
 * mode → re-fireable) or is visibility-only (detached mode). SIGKILL escalation
 * ensures a child that ignores SIGTERM can't park us on `proc.exited` forever.
 */
async function superviseRun(
  proc: SpawnedProc,
  timeoutMs: number,
  sigkillGraceMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // A holder object (not a bare `let`) so the watchdog's async mutation is
  // visible to readers below — and so static analysis doesn't treat the flag as
  // a provable constant.
  const state: { timedOut: boolean; killTimer?: ReturnType<typeof setTimeout> } = { timedOut: false };
  const watchdog = setTimeout(() => {
    state.timedOut = true;
    proc.kill(); // SIGTERM — give the child a chance to clean up…
    // …then SIGKILL (uncatchable) so a SIGTERM-ignoring child still unblocks us.
    state.killTimer = setTimeout(() => { proc.kill("SIGKILL"); }, sigkillGraceMs);
  }, timeoutMs);
  const clearTimers = () => {
    clearTimeout(watchdog);
    if (state.killTimer !== undefined) clearTimeout(state.killTimer);
  };
  try {
    const exitCode = await proc.exited;
    clearTimers();
    // exit 0 = the run finished its own work (a watchdog-killed run exits
    // non-zero), so treat it as success even if the watchdog just fired.
    if (exitCode === 0) return { ok: true };
    if (state.timedOut) return { ok: false, reason: `timeout-${timeoutMs}ms` };
    return { ok: false, reason: `exit-${exitCode}` };
  } catch (err) {
    clearTimers();
    return { ok: false, reason: `wait:${errMsg(err)}` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
