/**
 * #1317 — resolve WHICH nats-server process a `cortex network secret` reload
 * must signal.
 *
 * ## The bug this closes
 *
 * The hub reload shelled out to a BARE `nats-server --signal reload` with no
 * target. That form refuses the moment it sees more than one nats-server
 * process running locally:
 *
 *     nats-server: multiple nats-server processes running: 2264 2265 2266
 *
 * which is the NORMAL multi-stack state (e.g. `community.conf`, `local.conf`,
 * `halden.conf` all live at once). The command already knows exactly WHICH hub
 * config it just wrote — it must reload THAT server, never a global scan.
 *
 * ## This module
 *
 * The PURE selection core, decoupled from any process exec so it is directly
 * unit-testable. Two resolution paths, in priority order:
 *
 *   1. **`pid_file` directive** — if the hub config declares `pid_file: <path>`,
 *      that file holds the running server's PID. Preferred: it is the server's
 *      own self-report — but a `pid_file` is NOT removed on crash / `kill -9`,
 *      so a stale file can point at a recycled, unrelated PID.
 *   2. **config-path match** — otherwise, find the single running nats-server
 *      whose argv carries `-c <thisHubConfig>` (the resolved absolute path).
 *
 * ## Trust-path invariant — never signal an unverified PID (#1396)
 *
 * Both a stale `pid_file` and the enumerate→signal TOCTOU window can put an
 * innocent PID in front of the signal. So the adapter re-verifies the resolved
 * PID's LIVE argv through {@link argvIsNatsServerForConfig} immediately before it
 * `process.kill(pid, "SIGHUP")`s it — an argv that is not a nats-server loading
 * THIS config is never signalled. This matters because SIGHUP's default
 * disposition is TERMINATE: an unverified signal to a recycled PID would kill an
 * arbitrary process. The signal is a raw `process.kill` (nats-server applies the
 * authorization change in place); the argv re-check — NOT a nats-aware
 * `--signal reload=<pid>` form — is the load-bearing safety.
 *
 * The I/O (reading the pid_file, listing/inspecting processes, sending the
 * signal) lives in the adapter (`network-secret-adapters.ts`); this module
 * decides the target from already-gathered inputs and owns the argv predicate.
 */

import { resolve as resolvePath } from "path";

/** A running nats-server process, as gathered by the adapter's process lister. */
export interface NatsProcess {
  /** The process id. */
  pid: number;
  /** The full command line (argv joined), e.g. `nats-server -c /…/local.conf -js`. */
  command: string;
}

/**
 * The resolved reload target. `pid` is the process to signal; `via` records how
 * it was resolved (for plan/log output). The adapter re-verifies `pid`'s LIVE
 * argv (see {@link argvIsNatsServerForConfig}) before signalling, regardless of
 * how `via` resolved it.
 */
export interface HubReloadTarget {
  pid: number;
  via: "pid_file" | "config-match";
}

export type HubReloadTargetResult =
  | { ok: true; target: HubReloadTarget }
  | { ok: false; reason: string };

/**
 * Read the `pid_file` directive from a nats-server config, if declared. HOCON
 * permits `pid_file: "…"`, `pid_file = …`, with or without quotes. Returns the
 * raw path (caller resolves `~`/relative), or `undefined` when absent.
 */
export function readPidFileDirective(confText: string): string | undefined {
  // pid_file (NATS canonical) — tolerate `:` or `=`, optional quotes, any ws.
  const m = /(^|\n)\s*pid_file\s*[:=]\s*("([^"]*)"|'([^']*)'|(\S+))/.exec(confText);
  if (m === null) return undefined;
  const raw = (m[3] ?? m[4] ?? m[5] ?? "").trim();
  return raw === "" ? undefined : raw;
}

/**
 * Matches the `nats-server` binary at the head of a command line (path-tolerant:
 * `nats-server`, `/opt/nats/nats-server …`). The ONE definition of "is this argv
 * a nats-server", reused by the adapter's process lister AND the pre-signal argv
 * re-check — so the two never drift.
 */
const NATS_SERVER_COMMAND = /(^|\/)nats-server(\s|$)/;

/** Is `command` an invocation of the nats-server binary? */
export function isNatsServerCommand(command: string): boolean {
  return NATS_SERVER_COMMAND.test(command);
}

/**
 * The trust-path predicate (#1396): may the PID whose LIVE argv is `command` be
 * SIGHUP'd as the hub for `configPath`? True iff the argv (a) is a nats-server
 * AND (b) loads THIS config via `-c`/`--config`. BOTH resolution paths call this
 * ONE helper on the freshly-read argv immediately before signalling — the
 * pid_file path to guard against a stale, PID-recycled file, and the config-match
 * path to collapse the enumerate→signal TOCTOU window. A PID whose argv fails
 * this check is NEVER signalled (SIGHUP's default disposition is TERMINATE).
 */
export function argvIsNatsServerForConfig(command: string, configPath: string): boolean {
  return isNatsServerCommand(command) && commandLoadsConfig(command, configPath);
}

/** Does this process command load `configPath` via `-c`/`--config`? */
function commandLoadsConfig(command: string, configPath: string): boolean {
  // Tokenise on whitespace; match the resolved abs path against the value that
  // follows `-c`/`--config`, or the `--config=<path>` fused form. Resolve both
  // sides so `./local.conf` and an absolute path compare equal.
  //
  // Known limitation: a config path containing whitespace cannot be recovered
  // from unquoted `ps` output (argv is space-joined), so such a server never
  // config-matches — it degrades to a fail-loud zero-match, never a mis-signal.
  // Declare a `pid_file` for spaced paths. cortex configs live under
  // ~/.config/cortex (no spaces), so real-world impact is nil.
  const want = resolvePath(configPath);
  const toks = command.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] ?? "";
    if ((t === "-c" || t === "--config") && i + 1 < toks.length) {
      const val = toks[i + 1] ?? "";
      if (resolvePath(stripQuotes(val)) === want) return true;
    }
    if (t.startsWith("--config=")) {
      if (resolvePath(stripQuotes(t.slice("--config=".length))) === want) return true;
    }
  }
  return false;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Resolve the reload target for the hub at `configPath`.
 *
 * @param configPath   the (already tilde-expanded) hub config path that was written.
 * @param pidFromPidFile  the PID read from the config's `pid_file`, if the config
 *   declared one AND the file was readable; `undefined` otherwise. The adapter
 *   resolves this so the pure core stays I/O-free.
 * @param processes    the running nats-server processes the adapter enumerated.
 *
 * pid_file wins when present. Otherwise exactly one config-path match is
 * required: zero matches ⇒ the hub isn't running (or runs under a different
 * config path) — fail LOUDLY rather than signalling a wrong server; more than
 * one match ⇒ ambiguous, also fail (the config must declare a `pid_file`).
 */
export function resolveHubReloadTarget(
  configPath: string,
  pidFromPidFile: number | undefined,
  processes: NatsProcess[],
): HubReloadTargetResult {
  if (pidFromPidFile !== undefined) {
    if (!Number.isInteger(pidFromPidFile) || pidFromPidFile <= 0) {
      return { ok: false, reason: `pid_file held an invalid PID (${String(pidFromPidFile)})` };
    }
    return { ok: true, target: { pid: pidFromPidFile, via: "pid_file" } };
  }

  const matches = processes.filter((p) => commandLoadsConfig(p.command, configPath));
  const only = matches[0];
  if (matches.length === 1 && only !== undefined) {
    return { ok: true, target: { pid: only.pid, via: "config-match" } };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        `no running nats-server is serving ${resolvePath(configPath)} ` +
        `(found ${processes.length.toString()} nats-server process(es), none loading this config). ` +
        `Start the hub, or declare a \`pid_file\` in the config so the reload can target it.`,
    };
  }
  return {
    ok: false,
    reason:
      `${matches.length.toString()} running nats-server processes load ${resolvePath(configPath)} ` +
      `(PIDs ${matches.map((m) => m.pid.toString()).join(", ")}) — ambiguous. ` +
      `Declare a \`pid_file\` in the config to disambiguate the reload target.`,
  };
}
