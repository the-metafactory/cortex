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

/**
 * Canonical AgentState bundle scaffold script.
 *
 * NOTE: this is `skill/scripts/scaffold.ts`, NOT `scripts/errands.ts`. Grove's
 * own default (`grove/src/bot/lib/agent-state-scaffold.ts`) points at the wrong
 * path — it omits the `skill/` segment and names `errands.ts` (a filed grove
 * bug). The bundle installed by arc lays the workflow scripts down under
 * `.../agent-state/skill/scripts/`, and the scaffold entrypoint is
 * `scaffold.ts` (`bun scaffold.ts <instance-dir> --host=<h> --agent=<a>`).
 * `MF_AGENT_STATE_SCRIPT` overrides for non-standard installs.
 */
const DEFAULT_AGENT_STATE_SCRIPT =
  process.env.MF_AGENT_STATE_SCRIPT ??
  `${process.env.HOME ?? ""}/.config/metafactory/pkg/repos/agent-state/skill/scripts/scaffold.ts`;

/**
 * cortex#1720 S2 — canonical AgentState bundle errands script.
 *
 * The `ReplayPending` workflow (`agent-state/skill/Workflows/ReplayPending.md`)
 * lists pending work via `bun <bundle>/skill/scripts/errands.ts pending` — a
 * SIBLING of `scaffold.ts` in the same `skill/scripts/` dir, NOT the scaffold
 * entrypoint. Kept as its own constant (rather than deriving from
 * `DEFAULT_AGENT_STATE_SCRIPT`) so a principal can install / override the two
 * independently. `MF_AGENT_STATE_ERRANDS_SCRIPT` overrides for non-standard
 * installs.
 */
const DEFAULT_AGENT_STATE_ERRANDS_SCRIPT =
  process.env.MF_AGENT_STATE_ERRANDS_SCRIPT ??
  `${process.env.HOME ?? ""}/.config/metafactory/pkg/repos/agent-state/skill/scripts/errands.ts`;

/** Default host label baked into cortex-scaffolded instance dirs. */
const DEFAULT_HOST = "cortex";

export type ScaffoldStrategy = "agent-state-bundle" | "fallback-manual";

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
  const instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, host);
  const agentStateScript = opts.agentStateScript ?? DEFAULT_AGENT_STATE_SCRIPT;

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

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { stdio: "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
): ScaffoldSpawnResult {
  const r = spawnSync(cmd, args, opts);
  // With stdio:"pipe" (the path this scaffolder always uses), r.stderr is a
  // Buffer; TS narrows it non-null here, so we pass it straight through.
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
  | "script-absent" // bundle errands.ts not installed → soft-skip
  | "spawn-error" // spawn threw (ENOENT on bun, etc.)
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

/** Count NDJSON rows in a `errands.ts pending` stdout dump (blank-line safe). */
function countPendingRows(stdout: Buffer | string | undefined): number {
  if (stdout === undefined) return 0;
  return String(stdout)
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
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
  const instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, host);
  const errandsScript = opts.errandsScript ?? DEFAULT_AGENT_STATE_ERRANDS_SCRIPT;

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
    return { ran: false, pendingCount: 0, instanceDir, skipReason: "spawn-error" };
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

function defaultReplaySpawn(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
): ReplaySpawnResult {
  const r = spawnSync(cmd, args, { stdio: "pipe", env: opts.env });
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
