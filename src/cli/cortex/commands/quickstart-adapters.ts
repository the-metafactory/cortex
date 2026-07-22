/**
 * `cortex quickstart` — LIVE adapters (cortex#2094, L3).
 *
 * Wires real `PATH` resolution, real subprocess spawns, and real HTTP into
 * the {@link QuickstartPorts} the orchestrator (`quickstart.ts`) depends on.
 * Constructed only on a real `cortex quickstart` invocation; tests inject
 * fakes (`quickstart-lib.test.ts` / `quickstart.test.ts`) and never reach
 * this file — no real `systemctl`/`loginctl` exists on the macOS dev/CI hosts
 * these tests run on.
 *
 * Every spawn is wrapped so a missing binary or a spawn-level failure (EACCES,
 * ENOENT racing a PATH check) surfaces as a `CommandResult` with a synthetic
 * non-zero exit code, never an uncaught throw — a preflight/service check
 * failing is an ordinary, expected outcome for quickstart, not a bug.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { pidFileFor } from "../../../common/pidfile";
import type {
  CommandResult,
  GatePort,
  PreflightPorts,
  ProvisionPort,
  ServicePort,
} from "./quickstart-ports";

// =============================================================================
// Shared spawn helper
// =============================================================================

/** Run `cmd` synchronously, capturing stdout/stderr. Never throws — a spawn
 *  failure (missing binary, EACCES) is reported as `exitCode: 127` with the
 *  error message on `stderr`, matching the shell convention for "command not
 *  found" so callers can treat every path uniformly. */
function runSync(cmd: string[]): CommandResult {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf-8"),
      stderr: r.stderr.toString("utf-8"),
    };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// Preflight
// =============================================================================

export function buildPreflightPorts(): PreflightPorts {
  return {
    which(bin: string): string | undefined {
      return Bun.which(bin) ?? undefined;
    },
    claudeVersion(): CommandResult {
      return runSync(["claude", "--version"]);
    },
    lingerStatus(user: string): "yes" | "no" | "unknown" {
      if (process.platform !== "linux") return "unknown";
      const r = runSync(["loginctl", "show-user", user, "-p", "Linger"]);
      if (r.exitCode !== 0) return "unknown";
      // Output shape: a single line `Linger=yes` / `Linger=no`.
      const m = /Linger=(yes|no)/.exec(r.stdout);
      return m?.[1] === "yes" || m?.[1] === "no" ? m[1] : "unknown";
    },
  };
}

// =============================================================================
// Service (systemd user units on Linux; launchd restart-only on darwin)
// =============================================================================

/** Where L1 (cortex#2071) renders the two template units. Mirrors the path
 *  Appendix A (README-AGENTS.md) documents. */
function systemdUserUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/** cortex#2283 — launchd domain target for the current user's GUI domain:
 *  `gui/<uid>/<label>`. `process.getuid` exists on every POSIX platform
 *  (darwin included); the 0 fallback is unreachable in practice — these
 *  methods are only invoked on darwin. */
function launchdGuiTarget(label: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${String(uid)}/${label}`;
}

/** cortex#2322 — resolve the `cortex` binary for the fresh-host backstop start.
 *  Prefers `~/.local/bin/cortex` — the EXACT binary the launchd stack plist
 *  invokes (`__HOME__/.local/bin/cortex start …`, `ai.meta-factory.cortex.stack.plist`),
 *  so the backstop daemon and a later arc-loaded launchd daemon are the same
 *  binary — then falls back to whatever `cortex` resolves to on PATH.
 *  `undefined` when neither is found (surfaced as a clean step failure, never a
 *  spawn throw). */
function resolveCortexBin(): string | undefined {
  const canonical = join(homedir(), ".local", "bin", "cortex");
  if (existsSync(canonical)) return canonical;
  return Bun.which("cortex") ?? undefined;
}

export function buildServicePort(): ServicePort {
  return {
    unitFileExists(unitTemplate: string): boolean {
      return existsSync(join(systemdUserUnitDir(), unitTemplate));
    },
    daemonReload(): CommandResult {
      return runSync(["systemctl", "--user", "daemon-reload"]);
    },
    truncateLog(logPath: string): void {
      // cortex#2264 / cortex#2283 — clear ONE append-mode daemon log before
      // the (re)start so the gate reads only CURRENT-boot content (step 7
      // pair-truncates both the `.log` and the `.error.log`). Best-effort: a
      // failure here must NOT block the restart — the gate simply degrades to
      // its timeout path (never a false-fail). mkdir -p first so a
      // first-install run (log dir not yet created by the daemon) still lands
      // an empty file.
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        writeFileSync(logPath, "");
      } catch (_err) {
        // Swallow — see above; the gate never depends on this succeeding. Safe
        // to ignore.
      }
    },
    enableNow(units: string[]): CommandResult {
      return runSync(["systemctl", "--user", "enable", "--now", ...units]);
    },
    tryRestart(units: string[]): CommandResult {
      // cortex#2283 — restart the probed-active units so the recovery re-run
      // picks up patched configs; the orchestrator passes ONLY units the
      // isActive pre-probe found running (a blanket try-restart would kill
      // units enable --now just started, mid-bus-connect — review F2).
      return runSync(["systemctl", "--user", "try-restart", ...units]);
    },
    isActive(unit: string): boolean {
      // Read-only pre-start probe (cortex#2283) — exit 0 ⇔ active. Selects
      // the tryRestart set + names the per-unit action in step 7's output.
      // `--quiet` suppresses the state word; we only need the code.
      return runSync(["systemctl", "--user", "is-active", "--quiet", unit]).exitCode === 0;
    },
    launchdServiceLoaded(label: string): boolean {
      // cortex#2283 — exit 0 ⇔ loaded in the user's GUI domain. Quickstart
      // never loads/unloads (arc owns that); this only gates the kickstart.
      return runSync(["launchctl", "print", launchdGuiTarget(label)]).exitCode === 0;
    },
    launchdKickstart(label: string): CommandResult {
      // cortex#2283 — `-k`: kill the running instance, then restart it, so a
      // re-run applies patched configs on macOS.
      return runSync(["launchctl", "kickstart", "-k", launchdGuiTarget(label)]);
    },
    daemonBackstopRunning(pointerConfigPath: string): boolean {
      // cortex#2322 — read the pointer's pidfile (the SAME derivation
      // `cortex start --config <pointer>` writes, so the two converge across
      // path spellings) and liveness-probe the pid. A missing/stale/unparseable
      // pidfile ⇒ not running (safe to start); EPERM (a live pid owned by
      // another user) counts as alive — conservatively skip rather than
      // double-start.
      const pidPath = pidFileFor(pointerConfigPath);
      if (!existsSync(pidPath)) return false;
      let pid: number;
      try {
        pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      } catch (_err) {
        // Unreadable pidfile (race / permissions) — treat as not running; the
        // start below is idempotent at the daemon layer (checkSingleton).
        return false;
      }
      if (Number.isNaN(pid)) return false;
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, delivers nothing
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    startDaemonBackstop(opts: {
      pointerConfigPath: string;
      logPath: string;
      errorLogPath: string;
    }): CommandResult {
      // cortex#2322 — the fresh-Mac backstop: `cortex start --config <pointer>`
      // launched DETACHED, redirecting stdout/stderr to the SAME log files the
      // launchd plist targets and Step 8's gate greps (cortex#2282). This does
      // NOT load a launchd service (arc owns that lifecycle); it starts the
      // daemon process directly, exactly as the luna-stack bundle / runbook §F2
      // document — lifted here so every consumer reaches a running daemon.
      const cortexBin = resolveCortexBin();
      if (cortexBin === undefined) {
        return {
          exitCode: 127,
          stdout: "",
          stderr:
            "cortex binary not found (~/.local/bin/cortex or on PATH) — cannot start the fresh-host daemon backstop",
        };
      }
      try {
        // Both files were just truncated by clearPriorBootLogs (paired
        // truncate → start → gate); open append so the detached daemon writes
        // this boot's output into the gate-visible files.
        mkdirSync(dirname(opts.logPath), { recursive: true });
        const outFd = openSync(opts.logPath, "a");
        const errFd = openSync(opts.errorLogPath, "a");
        // node:child_process `detached: true` → setsid (own session/pgid), so
        // the daemon survives quickstart's exit + any controlling-terminal
        // SIGHUP; `unref()` lets quickstart exit without waiting on it.
        const child = spawn(cortexBin, ["start", "--config", opts.pointerConfigPath], {
          detached: true,
          stdio: ["ignore", outFd, errFd],
        });
        child.unref();
        // The child dup'd both fds at spawn; close our copies so quickstart
        // doesn't hold them open past this call.
        closeSync(outFd);
        closeSync(errFd);
        return {
          exitCode: 0,
          stdout: `cortex daemon backstop started (pid ${child.pid !== undefined ? String(child.pid) : "?"})`,
          stderr: "",
        };
      } catch (err) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// =============================================================================
// Provision (stack signing identity)
// =============================================================================

/** Repo root, resolved from THIS file's location (mirrors `release.ts`'s
 *  `projectRoot()` — `src/cli/cortex/commands/` is 4 levels under root). */
function repoRoot(): string {
  return join(import.meta.dir, "..", "..", "..", "..");
}

export function buildProvisionPort(): ProvisionPort {
  return {
    provisionSeed(stackConfigPath: string, nkeyBasename: string): CommandResult {
      // The SAME entry postupgrade.sh sources — invoked as a one-shot bash
      // call rather than re-implementing seed generation / the G3 nkey_pub
      // write-back in TypeScript. `set -e` so a mid-script failure (e.g. the
      // config-backup `cp` failing) surfaces as a non-zero exit instead of
      // silently continuing.
      const scriptPath = join(repoRoot(), "scripts", "lib", "stack-identity-provision.sh");
      const shellCmd = [
        `source ${shellQuote(scriptPath)}`,
        `provision_stack_identity ${shellQuote(stackConfigPath)} ${shellQuote(nkeyBasename)}`,
      ].join("\n");
      return runSync(["bash", "-c", shellCmd]);
    },
  };
}

/** Minimal single-quote shell escaping for the two path/basename arguments
 *  passed into the `bash -c` script above. Both come from THIS process's own
 *  resolved config paths / slug-derived basenames — never from the untrusted
 *  CTX_* env directly — but quoting defensively costs nothing. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// =============================================================================
// Gate (bounded healthy-boot wait)
// =============================================================================

export function buildGatePort(): GatePort {
  return {
    readLog(logPath: string): string | undefined {
      if (!existsSync(logPath)) return undefined;
      try {
        return readFileSync(logPath, "utf-8");
      } catch (_err) {
        // Racing rotation / permission blip — treat as "not readable yet",
        // the poll loop retries on the next tick. Safe to ignore.
        return undefined;
      }
    },
    async fetchHealthz(url: string, timeoutMs: number): Promise<boolean> {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
      } catch (_err) {
        return false;
      }
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    now(): number {
      return Date.now();
    },
  };
}

export function buildQuickstartPorts(): {
  preflight: PreflightPorts;
  service: ServicePort;
  provision: ProvisionPort;
  gate: GatePort;
} {
  return {
    preflight: buildPreflightPorts(),
    service: buildServicePort(),
    provision: buildProvisionPort(),
    gate: buildGatePort(),
  };
}
