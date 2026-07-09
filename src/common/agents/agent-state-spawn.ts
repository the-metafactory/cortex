/**
 * cortex#1720 — shared, live-daemon-hardened spawn for AgentState bundle
 * subprocesses.
 *
 * S1 (scaffold), S2 (replay), S3/S4a (dispatch recorder) each grew a private
 * `spawnSync` wrapper with the SAME hardening. S4b retires the file-backed
 * `dev-session-store` onto the bundle's KV surface (`errands.ts get/annotate`),
 * which needs the identical wrapper again. Rather than a fourth copy, the
 * hardening lives here ONCE and the recorder + the new session store import it.
 *
 * The contract every AgentState subprocess must hold on the LIVE daemon:
 *   - **stdin IGNORED** (`stdio: ["ignore", "pipe", "pipe"]`) — a bundle that
 *     blocks on stdin can never hang the hot path.
 *   - **30s wall-clock `timeout`** — a wedged child is SIGTERM'd and surfaces as
 *     `r.error` (ETIMEDOUT), which the caller treats as a failed invocation.
 *   - **16MB `maxBuffer`** — explicit cap so a verbose bundle never trips Bun's
 *     1MB default (spurious ENOBUFS → `r.error`).
 *
 * NON-THROWING by construction: `spawnSync` reports failures via `r.error` /
 * `r.status`, not exceptions, so callers wrap in a single try/catch (belt) and
 * branch on the returned fields (braces) to log one line + soft-skip.
 */

import { spawnSync } from "node:child_process";

/** Wall-clock ceiling for a bundle subprocess on the live daemon. */
export const AGENT_STATE_SPAWN_TIMEOUT_MS = 30_000;

/**
 * stdout ceiling for a bundle subprocess read. The JSON dumps these CLIs print
 * (`{ inserted, row }`, a `list` page, a `get` row) are tiny; the explicit 16MB
 * cap is cheap insurance against a wedged/verbose bundle overflowing Bun's 1MB
 * default (ENOBUFS).
 */
export const AGENT_STATE_SPAWN_MAX_BUFFER = 16 * 1024 * 1024;

/** Result shape of the injectable AgentState spawn seam (captures stdout). */
export interface AgentStateSpawnResult {
  status: number | null;
  error?: Error;
  /** Captured stdout — a JSON row / page a caller may parse. */
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

/**
 * The injectable spawn seam. Production wires {@link defaultAgentStateSpawn};
 * tests inject a recording fake so no real `bun` runs and no `~/.config` is
 * touched.
 */
export type AgentStateSpawn = (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
) => AgentStateSpawnResult;

/**
 * The production spawn: `spawnSync` with the live-daemon hardening above. A
 * timeout / ENOBUFS both surface via `r.error` so the caller's error branch
 * logs one line and never throws.
 */
export function defaultAgentStateSpawn(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv },
): AgentStateSpawnResult {
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env,
    timeout: AGENT_STATE_SPAWN_TIMEOUT_MS,
    maxBuffer: AGENT_STATE_SPAWN_MAX_BUFFER,
  });
  return { status: r.status, error: r.error, stdout: r.stdout, stderr: r.stderr };
}
