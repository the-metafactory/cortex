/**
 * Daemon PID-file path resolution — single source of truth shared by the
 * `cortex start/stop/status` lifecycle (in `cortex.ts`) and the
 * `cortex agents reload` daemon-signal path (in `cli/cortex/commands/agents.ts`).
 *
 * Lives in its own tiny module (no heavy import graph) so the lightweight
 * `agents` CLI can resolve the running daemon's PID without pulling the whole
 * `cortex.ts` module graph in just for `pidFileFor`.
 *
 * MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
 * paths for now so the principal's existing `bot.yaml` continues to work.
 */

import { join, basename } from "path";

export const STATE_DIR = join(
  process.env.HOME ?? "~",
  ".config",
  "grove",
  "state",
);
export const PID_FILE = join(STATE_DIR, "cortex.pid");
export const DEFAULT_CONFIG = join(
  process.env.HOME ?? "~",
  ".config",
  "grove",
  "bot.yaml",
);

/**
 * Resolve the PID file path for a given `--config` value.
 *
 * Resolution:
 *   - Default config (or unspecified) → legacy `cortex.pid` (single-instance
 *     backward compat).
 *   - Custom config → `cortex-<config-basename>.pid` (config filename without
 *     the `.yaml`/`.yml` extension). Two stacks with different `--config`
 *     paths get distinct PID files. Directory portion is omitted so a config
 *     that moves on disk still maps to the same PID file.
 */
export function pidFileFor(configPath: string | undefined): string {
  if (configPath === undefined || configPath === DEFAULT_CONFIG) {
    return PID_FILE;
  }
  const base = basename(configPath).replace(/\.ya?ml$/i, "");
  if (base.length === 0) return PID_FILE;
  return join(STATE_DIR, `cortex-${base}.pid`);
}
