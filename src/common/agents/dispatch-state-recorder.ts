/**
 * cortex#1720 S3 — dispatch lifecycle → AgentState work_items.
 *
 * The dispatch half of the agent-state contract. When a STATEFUL agent's
 * BrainConsumer ACCEPTS a dispatch (the point where `dispatch.task.started` is
 * emitted — after the backpressure, sovereignty, and shutdown gates pass), the
 * host durably records "we owe a response to this task" as a `work_item`:
 *
 *   accepted  → `errands.ts enqueue` (status=pending) + `errands.ts claim` (→ in_flight)
 *   completed → `errands.ts resolve --status=done`   → `dashboard.ts regen`
 *   failed    → `errands.ts resolve --status=failed` → `dashboard.ts regen`
 *
 * cortex#1720 S4a — a terminal resolve is a state transition, so it also
 * refreshes the derived `dashboard.md` by subprocessing to the bundle's
 * `dashboard.ts regen` (the CLI REQUIRES the explicit `regen` subcommand —
 * agent-state#6; a bare invocation prints usage and exits 2). The regen is
 * fire-and-forget: the dashboard is a DERIVED snapshot (never the source of
 * truth), so a miss just leaves the previous file, which the next terminal
 * resolve rebuilds. NO debounce/coalesce for v1 — one regen per terminal
 * resolve is acceptable (the resolve subprocesses already dominate the cost).
 * It runs under the SAME soft-skip + non-fatal + hardening contract as the
 * errands calls and is entirely inside this recorder — the BrainConsumer is
 * untouched, and a STATELESS agent (which has no recorder) never regenerates.
 *
 * Same contract as the S1 scaffold + S2 replay libs:
 *   - SUBPROCESS ONLY — cortex imports NOTHING from the bundle (platform
 *     no-coupling rule). The only contract is the `errands.ts` CLI + the
 *     standard env (`MF_AGENT_NAME`, `MF_HOST=cortex`, `MF_INSTANCE_DIR`).
 *   - NON-BLOCKING + NON-FATAL — state writes must NEVER add a latency-blocking
 *     failure mode to the dispatch hot path. Every subprocess is wrapped in a
 *     try/catch, logs ONE line on failure, and never fails the dispatch because
 *     state recording failed. The BrainConsumer fires these fire-and-forget
 *     (`void recorder.onDispatchAccepted(...)`) so they stay off the critical
 *     path entirely.
 *   - OPT-IN — a recorder is only constructed for a `state:`-declaring agent
 *     (the `if (agent.state)` guard lives at the boot wiring site). A stateless
 *     agent's BrainConsumer never gets a recorder, so it takes ZERO new code
 *     paths — the `this.stateRecorder?.…` calls short-circuit to undefined.
 *
 * IMPORTANT contract detail (ReplayPending.md / errands.ts header): the bundle's
 * lib EMITS the lifecycle events itself (`work_item_created` / `_claimed` /
 * `_resolved`). Hosts MUST NOT separately append events for these transitions —
 * this module only calls the `enqueue` / `claim` / `resolve` subcommands and
 * never touches the `events` table.
 *
 * PAYLOAD DISCIPLINE (§3): the work_item payload is QUEUE METADATA only —
 * correlation id, subject, capability, timestamp, and safe envelope metadata.
 * NEVER the prompt / message body. The session interior stays in the substrate;
 * `work_items` is the durable queue, not document storage.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { resolveInstanceDir } from "./agent-state-scaffold";

/** Default host label baked into cortex work_item env. */
const DEFAULT_HOST = "cortex";

/**
 * cortex#1720 S3 — canonical AgentState bundle errands script (shared shape with
 * S2's replay lib). The `enqueue` / `claim` / `resolve` subcommands live on the
 * SAME `errands.ts` the S2 `pending` path uses. Kept as its own env override so
 * a principal can point the dispatch-wiring at a non-standard install
 * independently. `MF_AGENT_STATE_ERRANDS_SCRIPT` overrides.
 *
 * Resolved PER CALL (not frozen at module import) so a late env override is
 * honoured — matches the `opts ?? DEFAULT` pattern used throughout.
 */
function defaultErrandsScript(): string {
  return (
    process.env.MF_AGENT_STATE_ERRANDS_SCRIPT ??
    `${process.env.HOME ?? ""}/.config/metafactory/pkg/repos/agent-state/skill/scripts/errands.ts`
  );
}

/**
 * Wall-clock ceiling for a bundle subprocess on the LIVE daemon. A hanging
 * `errands.ts` must never freeze the dispatch path; on timeout spawnSync
 * SIGTERMs the child and returns an error the caller logs + soft-skips.
 */
const RECORDER_SPAWN_TIMEOUT_MS = 30_000;

/**
 * stdout ceiling for the enqueue output read. The `{ inserted, row }` dump is
 * tiny, but an explicit 16MB cap (matching the S2 replay lib) is cheap insurance
 * against a wedged/verbose bundle overflowing Bun's 1MB default (ENOBUFS).
 */
const RECORDER_MAX_BUFFER = 16 * 1024 * 1024;

/** Terminal outcome an accepted dispatch resolves to. */
export type DispatchResolveStatus = "done" | "failed";

/** Result shape of the injectable spawn seam (captures stdout for the id). */
export interface RecorderSpawnResult {
  status: number | null;
  error?: Error;
  /** Captured stdout — the `enqueue` JSON row (for the work_item id). */
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export type RecorderSpawn = (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
) => RecorderSpawnResult;

/** Minimal shape of the agent this recorder needs (id only). */
export interface RecorderAgent {
  id: string;
}

export interface DispatchStateRecorderOptions {
  /** Override the resolved instance dir (test seam). Default: ~/.config/cortex/agents/<id>. */
  instanceDir?: string;
  /** Override the host label baked into the env (test seam). Default: "cortex". */
  host?: string;
  /** Override path to the bundle's errands.ts (test seam). */
  errandsScript?: string;
  /**
   * Override path to the bundle's dashboard.ts (test seam / non-standard
   * install). Default: the `dashboard.ts` SIBLING of the resolved errands
   * script — the two always co-locate in the bundle's `skill/scripts/` dir, so
   * deriving it keeps a single install path to configure while still allowing
   * an independent override via this seam or `MF_AGENT_STATE_DASHBOARD_SCRIPT`.
   */
  dashboardScript?: string;
  /** Override the spawn used to invoke the bundle (test seam). */
  spawn?: RecorderSpawn;
  /** Override the logger (test seam). Default: stderr. */
  log?: (line: string) => void;
}

/**
 * Compact, payload-disciplined queue metadata for one accepted dispatch.
 * NEVER carries prompt / message content — correlation id + subject + safe
 * envelope metadata only (§3). Serialized to the `--payload` JSON.
 */
export interface DispatchWorkItemMeta {
  /** The dispatch correlation id — also the enqueue `--id` (stable per task). */
  correlationId: string;
  /** The capability the dispatch targets — the work_item `--kind`. */
  capability: string;
  /** The bus subject the envelope arrived on (routing metadata, not content). */
  subject: string;
  /** ISO-8601 accept timestamp. */
  acceptedAt: string;
}

/**
 * The seam the BrainConsumer talks to. A stateful agent's consumer holds ONE of
 * these (constructed at boot wiring behind `if (agent.state)`); a stateless
 * agent holds `undefined` and the consumer's `this.stateRecorder?.…` calls are
 * no-ops. Both methods are TOTAL and NON-THROWING — a bundle miss, spawn error,
 * or non-zero exit logs one line and returns; the dispatch is never affected.
 */
export interface DispatchStateRecorder {
  /**
   * An accepted dispatch (post-gates, at `dispatch.task.started`): enqueue a
   * pending work_item then atomically claim it (→ in_flight). Idempotent on the
   * correlation id (re-delivery of the same envelope is a bundle-side no-op).
   */
  onDispatchAccepted(meta: DispatchWorkItemMeta): void;
  /**
   * A terminal dispatch outcome: resolve the previously-enqueued work_item to
   * `done` (completed) or `failed` (failed). A resolve for an id we never
   * enqueued (bundle miss on accept, or a stateless→stateful reload race) is a
   * logged no-op — we only resolve ids we hold in the in-flight map.
   */
  onDispatchResolved(correlationId: string, status: DispatchResolveStatus): void;
}

/**
 * The production recorder: subprocesses to the bundle's `errands.ts`. Holds an
 * in-memory map from correlation id → work_item id so `resolve` targets the row
 * `enqueue` created. The map is best-effort: it survives only for the process
 * lifetime (a restart re-surfaces unfinished rows via S2's ReplayPending, not
 * this map). A recorder is scoped to ONE agent (one instance dir).
 */
export class SubprocessDispatchStateRecorder implements DispatchStateRecorder {
  private readonly agent: RecorderAgent;
  private readonly host: string;
  private readonly instanceDir: string;
  private readonly errandsScript: string;
  private readonly dashboardScript: string;
  private readonly spawn: RecorderSpawn;
  private readonly log: (line: string) => void;

  /**
   * correlation id → work_item id. Populated on a successful `enqueue`; read +
   * cleared on `resolve`. An entry is only present for a row we actually created,
   * so `resolve` never fabricates an id.
   */
  private readonly inFlightIds = new Map<string, string>();

  constructor(agent: RecorderAgent, opts: DispatchStateRecorderOptions = {}) {
    this.agent = agent;
    this.host = opts.host ?? DEFAULT_HOST;
    this.instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, this.host);
    this.errandsScript = opts.errandsScript ?? defaultErrandsScript();
    // cortex#1720 S4a — the dashboard script is the `dashboard.ts` SIBLING of
    // the errands script (both live in the bundle's `skill/scripts/` dir).
    // Deriving it from the resolved errands path means a principal who repoints
    // the errands install automatically repoints the dashboard too, while the
    // explicit opt / `MF_AGENT_STATE_DASHBOARD_SCRIPT` still allow decoupling.
    this.dashboardScript =
      opts.dashboardScript ??
      process.env.MF_AGENT_STATE_DASHBOARD_SCRIPT ??
      join(dirname(this.errandsScript), "dashboard.ts");
    this.spawn = opts.spawn ?? defaultRecorderSpawn;
    this.log = opts.log ?? ((line) => process.stderr.write(line));
  }

  onDispatchAccepted(meta: DispatchWorkItemMeta): void {
    // Bundle not installed → soft-skip (S1/S2 already log this class of miss on
    // their own hooks). No enqueue, so no id lands in the map and the paired
    // resolve later is itself a logged no-op — symmetric, no orphaned rows.
    if (!existsSync(this.errandsScript)) {
      this.log(
        `cortex: agent-state — dispatch enqueue SKIPPED for "${this.agent.id}" ` +
          `(reason=script-absent; correlation=${meta.correlationId})\n`,
      );
      return;
    }

    // §3 payload discipline — QUEUE METADATA ONLY. No prompt / message body.
    const payload = JSON.stringify({
      correlation_id: meta.correlationId,
      subject: meta.subject,
      capability: meta.capability,
      accepted_at: meta.acceptedAt,
    });

    // enqueue --id <correlationId> --kind <capability> --payload <json> --owner <agent>
    // The `--id` is the correlation id (stable per task → idempotent on
    // re-delivery). `--owner` is the agent, so the immediate claim reads clean.
    const enqueue = this.run([
      "enqueue",
      "--id",
      meta.correlationId,
      "--kind",
      meta.capability,
      "--payload",
      payload,
      "--owner",
      this.agent.id,
    ]);
    if (enqueue === null) return; // run() already logged the failure.

    // Capture the work_item id from the enqueue output. The CLI prints
    // `{ inserted, row }`; `row.id` is the correlation id we passed, but we read
    // it back from the row to stay honest to the bundle's own id (it echoes the
    // `--id`). Fall back to the correlation id if the shape is unexpected.
    const workItemId = this.extractRowId(enqueue) ?? meta.correlationId;
    this.inFlightIds.set(meta.correlationId, workItemId);

    // claim --id <workItemId> --owner <agent> → pending → in_flight.
    const claim = this.run(["claim", "--id", workItemId, "--owner", this.agent.id]);
    if (claim === null) {
      // Enqueue landed but claim failed — leave the id in the map so a later
      // resolve still targets the row (it is `pending`, not `in_flight`, but
      // `resolve` accepts either). One log line was already written by run().
      return;
    }
  }

  onDispatchResolved(correlationId: string, status: DispatchResolveStatus): void {
    const workItemId = this.inFlightIds.get(correlationId);
    if (workItemId === undefined) {
      // No row for this id — either the accept-side enqueue was skipped (bundle
      // absent) or this is a resolve for a task we never recorded. Logged no-op;
      // we NEVER resolve an id we did not create.
      this.log(
        `cortex: agent-state — dispatch resolve SKIPPED for "${this.agent.id}" ` +
          `(reason=no-work-item; correlation=${correlationId}; status=${status})\n`,
      );
      return;
    }
    this.inFlightIds.delete(correlationId);

    // resolve --id <workItemId> --status done|failed. Terminal; the bundle
    // emits `work_item_resolved` itself (no host-side event append).
    this.run(["resolve", "--id", workItemId, "--status", status]);

    // cortex#1720 S4a — the resolve is a state transition; refresh the derived
    // dashboard. Fire-and-forget (result ignored) and unconditional on the
    // resolve's own outcome: `dashboard.ts regen` rebuilds from the CURRENT DB
    // state, so it is truthful whether or not this resolve landed (a failed
    // resolve leaves the row `in_flight`, which the regenerated dashboard then
    // shows honestly). One regen per terminal resolve; no debounce for v1.
    this.regenerateDashboard(correlationId);
  }

  /**
   * Run one `errands.ts` subcommand. TOTAL + NON-THROWING: a spawn error or
   * non-zero exit logs one line and returns null; success returns the captured
   * stdout string. Never throws — the dispatch hot path must not see a state
   * failure.
   */
  private run(args: string[]): string | null {
    let result: RecorderSpawnResult;
    try {
      result = this.spawn("bun", [this.errandsScript, ...args], {
        env: this.stdEnv(),
      });
    } catch (err) {
      // A THROWING spawn (belt-and-braces — defaultRecorderSpawn returns an
      // error field rather than throwing, but a test seam might throw).
      this.log(
        `cortex: agent-state — dispatch "${args[0]}" FAILED for "${this.agent.id}" ` +
          `(non-fatal; spawn threw: ${err instanceof Error ? err.message : String(err)})\n`,
      );
      return null;
    }
    if (result.error) {
      this.log(
        `cortex: agent-state — dispatch "${args[0]}" FAILED for "${this.agent.id}" ` +
          `(non-fatal; spawn-error: ${result.error.message})\n`,
      );
      return null;
    }
    if (result.status !== 0) {
      const stderr = result.stderr ? String(result.stderr).slice(0, 200) : "";
      this.log(
        `cortex: agent-state — dispatch "${args[0]}" FAILED for "${this.agent.id}" ` +
          `(non-fatal; nonzero-exit status=${result.status}${stderr ? `; stderr: ${stderr}` : ""})\n`,
      );
      return null;
    }
    return result.stdout !== undefined ? String(result.stdout) : "";
  }

  /**
   * The standard bundle env every subprocess carries (`MF_AGENT_NAME`,
   * `MF_HOST`, `MF_INSTANCE_DIR`). Shared by the errands `run()` path and the
   * S4a dashboard regen so both target the SAME instance dir.
   */
  private stdEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MF_AGENT_NAME: this.agent.id,
      MF_HOST: this.host,
      MF_INSTANCE_DIR: this.instanceDir,
    };
  }

  /**
   * cortex#1720 S4a — regenerate the derived `dashboard.md` after a terminal
   * state transition. TOTAL + NON-THROWING + fire-and-forget, mirroring the
   * errands soft-skip contract:
   *   - bundle `dashboard.ts` absent  → logged soft-skip, no spawn;
   *   - spawn throws / errors / exits non-zero → one log line, no throw.
   *
   * The dashboard is a DERIVED snapshot — a miss just leaves the previous file
   * for the next terminal resolve to rebuild, so failure is never fatal and
   * never affects the dispatch outcome. Invokes the REQUIRED `regen`
   * subcommand (agent-state#6): a bare invocation prints usage and exits 2.
   */
  private regenerateDashboard(correlationId: string): void {
    if (!existsSync(this.dashboardScript)) {
      this.log(
        `cortex: agent-state — dashboard regen SKIPPED for "${this.agent.id}" ` +
          `(reason=script-absent; correlation=${correlationId})\n`,
      );
      return;
    }

    let result: RecorderSpawnResult;
    try {
      result = this.spawn("bun", [this.dashboardScript, "regen"], {
        env: this.stdEnv(),
      });
    } catch (err) {
      this.log(
        `cortex: agent-state — dashboard regen FAILED for "${this.agent.id}" ` +
          `(non-fatal; spawn threw: ${err instanceof Error ? err.message : String(err)})\n`,
      );
      return;
    }
    if (result.error) {
      this.log(
        `cortex: agent-state — dashboard regen FAILED for "${this.agent.id}" ` +
          `(non-fatal; spawn-error: ${result.error.message})\n`,
      );
      return;
    }
    if (result.status !== 0) {
      const stderr = result.stderr ? String(result.stderr).slice(0, 200) : "";
      this.log(
        `cortex: agent-state — dashboard regen FAILED for "${this.agent.id}" ` +
          `(non-fatal; nonzero-exit status=${result.status}${stderr ? `; stderr: ${stderr}` : ""})\n`,
      );
    }
  }

  /** Parse `row.id` out of an `enqueue` stdout dump. Null on any shape miss. */
  private extractRowId(stdout: string): string | null {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return null;
    try {
      const parsed = JSON.parse(trimmed) as { row?: { id?: unknown } };
      const id = parsed.row?.id;
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }
}

function defaultRecorderSpawn(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
): RecorderSpawnResult {
  // Live-daemon hardening (mirrors S2's replay spawn): stdin IGNORED so a
  // bundle that blocks on stdin can't hang the dispatch path, a wall-clock
  // `timeout` caps a wedged child (SIGTERM → error → run() logs + soft-skips),
  // and an explicit 16MB `maxBuffer` avoids a spurious ENOBUFS on a verbose
  // bundle. A timeout / ENOBUFS both surface via `r.error` → the caller's
  // non-zero/error branch logs one line and never throws.
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env,
    timeout: RECORDER_SPAWN_TIMEOUT_MS,
    maxBuffer: RECORDER_MAX_BUFFER,
  });
  return { status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
}
