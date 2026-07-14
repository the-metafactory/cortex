/**
 * cortex#1720 S1 — per-instance state scaffolding for stateful agent fragments.
 *
 * Ported from grove's proven host-side implementation
 * (`grove/src/bot/lib/agent-state-scaffold.ts`) and the forge contract
 * (`forge/agent/scaffold-instance.sh`). Per the agent-platform design
 * (`forge/design/agent-platform.md` §"Instantiation flow"), the HOST lays down
 * `~/.config/<host>/agents/<id>/` by SUBPROCESSING to the AgentState bundle's
 * `ScaffoldFolders` workflow — cortex imports NOTHING from the bundle
 * (platform no-coupling rule); the only contract is the subprocess CLI + env.
 *
 * When the bundle's `scaffold.ts` is on disk, that delegate path is preferred.
 * When it isn't (fresh dev box, bundle not yet installed), we fall back to a
 * manual scaffold that lays down the same principal-facing skeleton — WITHOUT
 * touching `state.sqlite` (the bundle owns that schema; creating it here would
 * bake in a shape we'd later have to migrate).
 *
 * OPT-IN: this is invoked ONLY for a fragment that declares `state:` (see
 * `AgentSchema.state`). A stateless fragment never reaches this module — the
 * `if (agent.state)` guard at the call site keeps stateless activation on
 * exactly the code path it had before #1720.
 *
 * Idempotent: re-running on an existing dir leaves principal-authored files
 * untouched and only fills what's missing.
 *
 * Non-fatal: the call site treats a thrown error / non-zero bundle exit as a
 * logged warning — activation continues, the daemon does not crash.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
// cortex#2007 — the scaffold/errands default-path resolvers now live in ONE
// shared module (was triplicated across the agent-state consumers, which is how
// the pre-#287 `~/.config/metafactory/pkg/repos` default shipped three times).
// Both route through `resolveArcPackReposDir()`; env overrides + per-call lazy
// resolution are preserved.
import {
  defaultScaffoldScript,
  defaultErrandsScript,
} from "./agent-state-scripts";

/** Default host label baked into cortex-scaffolded instance dirs. */
const DEFAULT_HOST = "cortex";

export type ScaffoldStrategy =
  | "agent-state-bundle"
  | "fallback-manual"
  | "skipped-home-unset"; // $HOME unset + no explicit instanceDir → nothing scaffolded

export interface ScaffoldResult {
  strategy: ScaffoldStrategy;
  instanceDir: string;
  /** Files/dirs created on this run (for principal visibility). */
  created: string[];
  /** Files that already existed and were NOT touched. */
  skipped: string[];
}

/** Minimal shape of the agent this scaffolder needs (id only). */
export interface ScaffoldAgent {
  id: string;
  displayName?: string;
}

/** Result shape of the injectable spawn seam. */
export interface ScaffoldSpawnResult {
  status: number | null;
  error?: Error;
  stderr?: Buffer | string;
}

export type ScaffoldSpawn = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
) => ScaffoldSpawnResult;

export interface ScaffoldOptions {
  /** Override the resolved instance dir (test seam). Default: ~/.config/cortex/agents/<id>. */
  instanceDir?: string;
  /** Override the host label baked into the scaffold (test seam). Default: "cortex". */
  host?: string;
  /** Override path to the AgentState bundle scaffold script (test seam). */
  agentStateScript?: string;
  /** Force the manual fallback even if the bundle is present (test seam). */
  forceFallback?: boolean;
  /** Override the spawn used to invoke the bundle (test seam). */
  spawn?: ScaffoldSpawn;
}

/**
 * Resolve the per-instance state directory for an agent id, honoring the
 * `~/.config/<host>/agents/<id>/` convention. Exposed so the call site can log
 * the path without re-deriving it.
 */
export function resolveInstanceDir(agentId: string, host: string = DEFAULT_HOST): string {
  const home = process.env.HOME ?? "";
  return join(home, ".config", host, "agents", agentId);
}

/**
 * Scaffold the per-instance state directory for a stateful agent.
 *
 * Strategy preference: the AgentState bundle if its `scaffold.ts` is on disk,
 * otherwise the manual fallback. The manual fallback never creates
 * `state.sqlite` — that is owned by the bundle's schema.
 */
export function scaffoldInstance(
  agent: ScaffoldAgent,
  opts: ScaffoldOptions = {},
): ScaffoldResult {
  const host = opts.host ?? DEFAULT_HOST;

  // $HOME unset with no explicit instanceDir → `resolveInstanceDir` yields a
  // CWD-relative path that we'd then `mkdir`. Rather than scatter a state dir
  // into the daemon's cwd, soft-skip with one log line; the fragment still
  // activates stateless (the caller's log surfaces the strategy).
  if (opts.instanceDir === undefined && !process.env.HOME) {
    process.stderr.write(
      `agent-state-scaffold: $HOME unset for agent=${agent.id} — skipping scaffold ` +
        `(cannot resolve ~/.config/${host}/agents/${agent.id} safely)\n`,
    );
    return { strategy: "skipped-home-unset", instanceDir: "", created: [], skipped: [] };
  }

  const instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, host);
  // Resolve the bundle script PER CALL (not frozen at module import) so a late
  // env override is honoured — matches the `opts ?? DEFAULT` pattern.
  // `defaultScaffoldScript()` owns the `MF_AGENT_STATE_SCRIPT` precedence.
  const agentStateScript = opts.agentStateScript ?? defaultScaffoldScript();

  const created: string[] = [];
  const skipped: string[] = [];

  // Always make the dir up front so the bundle path can land into it.
  if (!existsSync(instanceDir)) {
    mkdirSync(instanceDir, { recursive: true });
    created.push(instanceDir);
  } else {
    skipped.push(instanceDir);
  }

  // ── Preferred path: delegate to the bundle's scaffold.ts ────────────────
  if (!opts.forceFallback && existsSync(agentStateScript)) {
    const spawn = opts.spawn ?? defaultSpawn;
    const result = spawn(
      "bun",
      [
        agentStateScript,
        instanceDir,
        `--host=${host}`,
        `--agent=${agent.id}`,
      ],
      {
        stdio: "pipe",
        env: {
          ...process.env,
          MF_AGENT_NAME: agent.id,
          MF_HOST: host,
          MF_INSTANCE_DIR: instanceDir,
        },
      },
    );
    if (result.status === 0) {
      return { strategy: "agent-state-bundle", instanceDir, created, skipped };
    }
    // Bundle invocation failed — surface and fall back to manual so the
    // principal isn't blocked while the bundle is being debugged. The call
    // site's own non-fatal guard also covers a thrown spawn; this branch
    // covers a clean spawn that exited non-zero.
    process.stderr.write(
      `agent-state-scaffold: bundle invocation failed for agent=${agent.id} ` +
        `(status=${result.status}); falling back to manual scaffold. ` +
        (result.stderr ? `stderr: ${String(result.stderr).slice(0, 200)}\n` : "\n"),
    );
  }

  // ── Fallback: manual scaffold (mirrors forge/agent/scaffold-instance.sh) ──
  const ctxDir = join(instanceDir, "context");
  const retrosDir = join(instanceDir, "retros");

  for (const dir of [ctxDir, retrosDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    } else {
      skipped.push(dir);
    }
  }

  // CLAUDE.md — the per-instance bridge file.
  const claudeMdPath = join(instanceDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, defaultClaudeMd(agent, host), "utf8");
    created.push(claudeMdPath);
  } else {
    skipped.push(claudeMdPath);
  }

  // dashboard.md — placeholder; the bundle regenerates it on the first event.
  const dashboardPath = join(instanceDir, "dashboard.md");
  if (!existsSync(dashboardPath)) {
    writeFileSync(dashboardPath, defaultDashboardMd(agent), "utf8");
    created.push(dashboardPath);
  } else {
    skipped.push(dashboardPath);
  }

  // context/repos.md (principal-owned seed).
  const reposPath = join(ctxDir, "repos.md");
  const label = agent.displayName ?? agent.id;
  if (!existsSync(reposPath)) {
    writeFileSync(
      reposPath,
      `# Repos this ${label} instance handles\n\n(Principal: list scoped repos here.)\n`,
      "utf8",
    );
    created.push(reposPath);
  } else {
    skipped.push(reposPath);
  }

  // NOTE: state.sqlite is intentionally NOT created. The AgentState bundle owns
  // the schema; touching it here would commit us to a layout we'd have to
  // migrate.

  return { strategy: "fallback-manual", instanceDir, created, skipped };
}

/**
 * Wall-clock ceiling for a bundle subprocess. A hanging `scaffold.ts` (bad
 * install, wedged bun) must NOT freeze the daemon — worst during a hot-reload
 * where consumers are already drained. On timeout spawnSync SIGTERMs the child
 * and returns `error` (code `ETIMEDOUT`) / a signal, which flows into the same
 * non-zero-exit fallback the caller already handles.
 */
const SPAWN_TIMEOUT_MS = 30_000;

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { stdio: "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
): ScaffoldSpawnResult {
  // stdin is IGNORED (not an open pipe): a bundle that blocks on stdin would
  // otherwise hang forever. stdout/stderr keep the caller's mode. `timeout`
  // caps the wall clock so a wedged child can't freeze the daemon.
  const r = spawnSync(cmd, args, {
    ...opts,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SPAWN_TIMEOUT_MS,
  });
  // With stdio:"pipe" (the path this scaffolder always uses), r.stderr is a
  // Buffer; TS narrows it non-null here, so we pass it straight through. A
  // timeout surfaces as a non-null `r.error` (ETIMEDOUT) — treated as a failed
  // invocation by the caller (falls back to manual scaffold).
  return { status: r.status, error: r.error, stderr: r.stderr };
}

function defaultClaudeMd(agent: ScaffoldAgent, host: string): string {
  const label = agent.displayName ?? agent.id;
  return `# ${label} — instance bridge

This file bridges the per-instance state directory
(\`~/.config/${host}/agents/${agent.id}/\`) and the Claude Code session the host
spawns when ${label} is invoked.

## Identity

You are **${label}** (agent id: \`${agent.id}\`).

Read your persona file before answering — it defines your voice, defaults, and
the routing table for which blueprint to invoke when.

## Where state lives

This directory (\`~/.config/${host}/agents/${agent.id}/\`):

- \`state.sqlite\` — work_items + events (managed by the AgentState bundle).
- \`dashboard.md\` — derived snapshot, regenerated on every state transition.
- \`context/\` — principal-owned seed files (repos in scope, channels, etc.).
- \`retros/YYYY-Wxx.md\` — weekly retros.

## Hard rules

- Authority lives in the host (cortex config), translated from the agent
  fragment's declarations. Do not invent new authority mechanisms here — if a
  guardrail blocks you, ask the principal to widen the fragment and reload.
`;
}

function defaultDashboardMd(agent: ScaffoldAgent): string {
  const label = agent.displayName ?? agent.id;
  return `# ${label} — dashboard

(Empty — regenerated by the AgentState bundle on the first state transition.
Until the bundle ships and runs once, this file stays empty.)
`;
}

// ===========================================================================
// cortex#1720 S2 — ReplayPending on stateful agent activation.
// ===========================================================================
//
// The `onStart` half of the agent-state contract. After a stateful agent's
// instance dir is scaffolded (S1), cortex re-surfaces the work that was still
// pending when the daemon last stopped by SUBPROCESSING to the bundle's
// `errands.ts pending` — one NDJSON row per pending work_item, exit 0.
//
// S2 scope is deliberately the PENDING-ROWS CLI PATH ONLY. Stale `in_flight`
// re-detection is library-level in the bundle (`pendingForReplay`, no CLI yet)
// and is NOT wired here. "Re-emit to the worker" is minimal for S2: we LOG the
// count and post a structured log event. Wiring the pending items back into
// `BrainConsumer` dispatch is S3 — this module does not touch dispatch.
//
// Same contract as the S1 scaffold: subprocess only (no import from the
// bundle), standard env (`MF_AGENT_NAME`, `MF_HOST`, `MF_INSTANCE_DIR`),
// non-fatal, opt-in behind the call site's `if (agent.state)` guard.

/** Result shape of the injectable replay-spawn seam (captures stdout). */
export interface ReplaySpawnResult {
  status: number | null;
  error?: Error;
  /** Captured stdout — NDJSON, one JSON work_item per line. */
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export type ReplaySpawn = (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
) => ReplaySpawnResult;

/** Why a replay did no work (for structured logging / test assertions). */
export type ReplaySkipReason =
  | "home-unset" // $HOME unset → can't resolve the instance dir safely
  | "script-absent" // bundle errands.ts not installed → soft-skip
  | "spawn-error" // spawn threw (ENOENT on bun, timeout, etc.)
  | "output-too-large" // stdout exceeded maxBuffer (ENOBUFS) — legit large backlog
  | "nonzero-exit"; // errands.ts exited non-zero

export interface ReplayResult {
  /** Did the pending-listing subprocess run and exit 0? */
  ran: boolean;
  /** Number of pending work_items re-surfaced (0 when none / skipped). */
  pendingCount: number;
  /** The instance dir the replay targeted. */
  instanceDir: string;
  /** Set when `ran === false`; explains the soft-skip. */
  skipReason?: ReplaySkipReason;
}

export interface ReplayOptions {
  /** Override the resolved instance dir (test seam). Default: ~/.config/cortex/agents/<id>. */
  instanceDir?: string;
  /** Override the host label baked into the env (test seam). Default: "cortex". */
  host?: string;
  /** Override path to the bundle's errands.ts (test seam). */
  errandsScript?: string;
  /** Override the spawn used to invoke the bundle (test seam). */
  spawn?: ReplaySpawn;
}

/**
 * Count NDJSON rows in a `errands.ts pending` stdout dump. Blank-line safe, and
 * counts ONLY lines that start with `{` — cheap insurance against a future
 * diagnostic/banner line on stdout being miscounted as a work_item.
 */
function countPendingRows(stdout: Buffer | string | undefined): number {
  if (stdout === undefined) return 0;
  return String(stdout)
    .split("\n")
    .filter((line) => line.trim().startsWith("{")).length;
}

/** True when a spawn error is a maxBuffer overflow (ENOBUFS). */
function isEnobufs(err: Error | undefined): boolean {
  return (
    err !== undefined && (err as NodeJS.ErrnoException).code === "ENOBUFS"
  );
}

/**
 * Re-surface pending work for a stateful agent by listing its pending
 * work_items via the bundle's `errands.ts pending`.
 *
 * SOFT-SKIP: if the errands script isn't on disk (bundle not installed), returns
 * `{ ran: false, skipReason: "script-absent" }` — the call site logs one line
 * and moves on. A spawn error or non-zero exit is likewise reported as a skip,
 * never thrown here (the call site's own guard is a second belt-and-braces
 * layer, but this function is intentionally total for the CLI path).
 */
export function replayPending(
  agent: ScaffoldAgent,
  opts: ReplayOptions = {},
): ReplayResult {
  const host = opts.host ?? DEFAULT_HOST;

  // $HOME unset with no explicit instanceDir → `resolveInstanceDir` would return
  // a CWD-relative path. Rather than replay against a stray dir, soft-skip.
  if (opts.instanceDir === undefined && !process.env.HOME) {
    return { ran: false, pendingCount: 0, instanceDir: "", skipReason: "home-unset" };
  }

  const instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, host);
  // Resolve the script path PER CALL (not frozen at module import) so an env
  // override set after import is honoured — matches the `opts ?? DEFAULT` pattern.
  // `defaultErrandsScript()` owns the `MF_AGENT_STATE_ERRANDS_SCRIPT` precedence.
  const errandsScript = opts.errandsScript ?? defaultErrandsScript();

  // Bundle not installed → soft-skip (S1 already logged this class of miss on
  // the scaffold side; here we degrade the onStart hook to a no-op).
  if (!existsSync(errandsScript)) {
    return { ran: false, pendingCount: 0, instanceDir, skipReason: "script-absent" };
  }

  const spawn = opts.spawn ?? defaultReplaySpawn;
  const result = spawn("bun", [errandsScript, "pending"], {
    env: {
      ...process.env,
      MF_AGENT_NAME: agent.id,
      MF_HOST: host,
      MF_INSTANCE_DIR: instanceDir,
    },
  });

  if (result.error) {
    // A legit large pending backlog overflows maxBuffer (ENOBUFS) — distinguish
    // it from a broken install / wedged bun so the log is honest.
    const skipReason: ReplaySkipReason = isEnobufs(result.error)
      ? "output-too-large"
      : "spawn-error";
    return { ran: false, pendingCount: 0, instanceDir, skipReason };
  }
  if (result.status !== 0) {
    return { ran: false, pendingCount: 0, instanceDir, skipReason: "nonzero-exit" };
  }

  return {
    ran: true,
    pendingCount: countPendingRows(result.stdout),
    instanceDir,
  };
}

/** stdout ceiling for the replay listing — a large pending backlog is legit. */
const REPLAY_MAX_BUFFER = 16 * 1024 * 1024; // 16 MB

function defaultReplaySpawn(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
): ReplaySpawnResult {
  // stdin IGNORED (no open pipe to hang on), wall-clock `timeout`, and an
  // explicit 16MB `maxBuffer` so a big-but-legitimate pending backlog doesn't
  // ENOBUFS at Bun's 1MB default and get miscategorised as a broken install.
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env,
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: REPLAY_MAX_BUFFER,
  });
  return { status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Pure helper: would scaffolding this agent into the given instance dir be a
 * no-op? Used by tests and by any future \`--dry-run\`.
 */
export function isFullyScaffolded(instanceDir: string): boolean {
  if (!existsSync(instanceDir)) return false;
  if (!statSync(instanceDir).isDirectory()) return false;
  for (const required of ["CLAUDE.md", "dashboard.md", "context", "retros"]) {
    if (!existsSync(join(instanceDir, required))) return false;
  }
  return true;
}
