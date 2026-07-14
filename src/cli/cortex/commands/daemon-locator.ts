/**
 * #800 — locate the cortex daemon's service descriptor so `network join`/`leave`
 * restart the RIGHT service instead of guessing `ai.meta-factory.cortex.<slug>`.
 *
 * ## The bug this closes
 *
 * The daemon-restart step derived the launchd label from the stack slug:
 * `ai.meta-factory.cortex.${stackId.split("/")[1]}`. When the slug differs from
 * the plist suffix — the driving case `jc/default` whose real daemon is
 * `ai.meta-factory.cortex.meta-factory` — `launchctl kickstart` always fails
 * with `113 / Could not find service … (503)`, so the join reports FAILED even
 * though the leaf config landed.
 *
 * ## The fix
 *
 * Don't guess. The stack daemon is the launchd service (macOS) or systemd user
 * unit (Linux) whose argv carries `--config <cortexConfigPath>` — the very
 * cortex.yaml the join derives its inputs from. That config arg uniquely
 * identifies the stack daemon: its `relay`/`mc` siblings under the same
 * `ai.meta-factory.cortex.*` prefix don't carry it (relay runs `relay.ts start`,
 * mc runs `run …/index.ts`). We discover the descriptor by that match and hand
 * its PATH to {@link selectNatsServiceManager}, which restarts by the real
 * `<key>Label</key>` (launchd) / unit id (systemd) — the same #763 mechanism the
 * nats-server restart already uses.
 *
 * All file I/O is injected ({@link DaemonLocatorIO}) so the matcher is a pure,
 * unit-testable function with no dependence on the host's `~/Library/LaunchAgents`.
 */

import { join, resolve } from "path";

import { expandTilde } from "../../../common/config/loader";
import type { ServicePlatform } from "../../../common/nats/nats-service-manager";

/** Injected filesystem seam — real `fs` in prod, fakes in tests. */
export interface DaemonLocatorIO {
  /** List directory entries (file names only). Returns `[]` if absent/unreadable. */
  listDir(dir: string): string[];
  /** Read a file as UTF-8. */
  readFile(path: string): string;
  /** Does the path exist? */
  exists(path: string): boolean;
}

/**
 * Extract the value of a `-c` / `--config` / `--config=<v>` argument from an
 * argv list. Returns `undefined` when no config arg is present.
 */
export function configArgValue(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-c" || a === "--config") {
      const v = args[i + 1];
      if (v !== undefined && v !== "") return v;
    }
    const eq = /^--config=(.+)$/.exec(a);
    if (eq) return eq[1];
  }
  return undefined;
}

/** Parse the `<key>ProgramArguments</key><array><string>…</string></array>` entries. */
export function parsePlistProgramArguments(xml: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (block === null) return [];
  const args: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1] ?? "")) !== null) {
    args.push(
      (m[1] ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    );
  }
  return args;
}

/** Parse the `ExecStart=` argv from a systemd unit, stripping the `@-+!:` prefixes. */
export function parseUnitExecStartArgs(unitText: string): string[] {
  const line = unitText.split("\n").find((l) => /^\s*ExecStart\s*=/.test(l));
  if (line === undefined) return [];
  const value = line.slice(line.indexOf("=") + 1).trim();
  const prefix = /^([@\-+!:]+)/.exec(value)?.[1] ?? "";
  return value
    .slice(prefix.length)
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Two config paths point at the same file. We `expandTilde` then `resolve` both
 * sides, so a relative `--config`, a trailing slash, or a `.`/`..` segment still
 * matches the absolute path arc renders into the plist. NOTE: this does NOT
 * resolve symlinks (e.g. macOS `/var`→`/private/var`) — that would need a
 * realpath syscall, which the injected-IO purity here deliberately avoids; arc
 * renders a non-symlinked absolute path and the join expands the same default,
 * so the symlinked-HOME edge is a known, accepted gap (PR #806 review note).
 */
function sameConfig(a: string, b: string): boolean {
  return resolve(expandTilde(a)) === resolve(expandTilde(b));
}

/**
 * Discover the cortex daemon's service descriptor for the stack whose daemon
 * loads `cortexConfigPath`. Returns the descriptor path (launchd plist on macOS,
 * systemd unit on Linux) or `undefined` when no installed service references it.
 */
export function findCortexDaemonDescriptor(opts: {
  platform: ServicePlatform;
  cortexConfigPath: string;
  launchAgentsDir: string;
  systemdUserDir: string;
  io: DaemonLocatorIO;
}): string | undefined {
  const { platform, cortexConfigPath, io } = opts;
  if (platform === "darwin") {
    return scanDir(opts.launchAgentsDir, /^ai\.meta-factory\.cortex\..+\.plist$/, io, (text) =>
      configMatches(parsePlistProgramArguments(text), cortexConfigPath),
    );
  }
  // Linux (systemd user units). The clawbox daemon is `cortex-bot.service`; match
  // by the ExecStart `--config` rather than a hard-coded unit name.
  //
  // cortex#1909 G-39 (NAMING DECISION — GRANDFATHER): the name pattern is the
  // maximally-permissive `/\.service$/`, NEVER a specific label. This is a
  // deliberate grandfather: a cortex daemon unit named under EITHER the frozen
  // doc convention (`cortex-<slug>.service`, plain) OR the shipped
  // `ai.meta-factory.cortex.*` label style is discovered identically, purely by
  // the ExecStart `--config` match. No forced rename/disable migration is done —
  // nothing is deployed on Linux yet, so forcing a rename would only risk
  // orphaning a hand-authored unit for no gain. `--config` uniqueness (the relay/
  // mc siblings carry no `--config`) keeps the match unambiguous regardless of name.
  return scanDir(opts.systemdUserDir, /\.service$/, io, (text) =>
    configMatches(parseUnitExecStartArgs(text), cortexConfigPath),
  );
}

function configMatches(args: string[], cortexConfigPath: string): boolean {
  const cfgArg = configArgValue(args);
  return cfgArg !== undefined && sameConfig(cfgArg, cortexConfigPath);
}

/** Return the first descriptor in `dir` matching `namePattern` whose body passes `predicate`. */
function scanDir(
  dir: string,
  namePattern: RegExp,
  io: DaemonLocatorIO,
  predicate: (text: string) => boolean,
): string | undefined {
  if (!io.exists(dir)) return undefined;
  for (const name of io.listDir(dir)) {
    if (!namePattern.test(name)) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = io.readFile(path);
    } catch (_err) {
      // Unreadable descriptor (race/permissions) — safe to skip; another
      // candidate may still match. Nothing actionable to log per-file.
      continue;
    }
    if (predicate(text)) return path;
  }
  return undefined;
}
