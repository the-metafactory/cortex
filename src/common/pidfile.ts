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
import { realpathSync } from "fs";

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
 *     paths get distinct PID files.
 *
 * Sage cortex#1027 — **stable against config-path spelling.** The PID file is a
 * lifecycle identity: `cortex start --config X` (writer) and `cortex agents
 * reload --config X` / `cortex stop --config X` (readers) MUST resolve the same
 * file even when `X` is spelled differently (trailing slash, `./`, `..`,
 * symlink, relative vs absolute). We `realpathSync` the config path first so two
 * spellings of the SAME file canonicalize to one identity before we take the
 * basename — otherwise `~/.config/cortex/work.yaml` and a symlink to it would
 * key two different daemons and a reload would signal the wrong (or no) process.
 *
 * Keying on `stack.id` would be stricter still (the slug is the real authority
 * per CONTEXT.md §"Stack slug"), but parsing the config here would pull the full
 * schema graph into this deliberately-tiny module that the lightweight `agents`
 * CLI imports. Canonicalizing the locator is the conservative fix that keeps the
 * module dependency-free while killing the spelling-collision class.
 */
export function pidFileFor(configPath: string | undefined): string {
  if (configPath === undefined || configPath === DEFAULT_CONFIG) {
    return PID_FILE;
  }
  const canonical = canonicalizeConfigPath(configPath);
  if (canonical === DEFAULT_CONFIG) {
    return PID_FILE;
  }
  const base = basename(canonical).replace(/\.ya?ml$/i, "");
  if (base.length === 0) return PID_FILE;
  return join(STATE_DIR, `cortex-${base}.pid`);
}

/**
 * Canonicalize a config locator so different spellings of the same file map to
 * one identity. Resolves symlinks + `.`/`..` via `realpathSync`; when the path
 * does not exist on disk yet (e.g. resolving the PID file before the config is
 * created), falls back to the raw path so the previous basename behaviour is
 * preserved. Always strips a single trailing slash so a directory-style spelling
 * of a file path does not skew the basename.
 */
function canonicalizeConfigPath(configPath: string): string {
  const trimmed = configPath.replace(/\/+$/, "");
  try {
    return realpathSync(trimmed);
  } catch {
    // Path not on disk (yet) or unreadable — realpath can't canonicalize it.
    // Fall back to the trimmed literal so the basename derivation still runs;
    // two on-disk spellings of an EXISTING file still converge via the try-path.
    return trimmed;
  }
}
