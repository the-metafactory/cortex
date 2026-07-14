/**
 * C-1257 — the LIVE adapters for `cortex network make-live`.
 *
 * These touch the real world: arc (`add-bot` / `export-account`), the nats config
 * (`resolver_preload`), the creds file, and the launchd/systemd services. The
 * orchestration is pure over the injected ports (`network-make-live-lib.ts`);
 * these adapters are constructed only on a real `--apply` (the dry-run path uses
 * read-only state probes built in the CLI). cortex NEVER runs nsc — the account
 * tree + JWT come from arc (ADR-0013 sovereign model invariant).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync, mkdirSync, renameSync, rmSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { Socket } from "net";

import { parseDocument } from "yaml";

import { expandTilde } from "../../../common/config/loader";
import { systemdUserDir } from "../../../common/xdg";
import {
  renderOperatorModeBlocks,
  renderBaseIsolatedConfig,
  natsConfigMonitorUrl,
  natsConfigClientListen,
  insertIntoResolverPreload,
} from "../../../common/nats/leaf-remote-renderer";

// cortex#1480 — `insertIntoResolverPreload` now lives in leaf-remote-renderer.ts
// (the PURE module) so `renderOperatorModeBlocks` can reuse it too. Re-exported
// here under its original name so existing importers of this adapters module
// (e.g. network-make-live.test.ts) are unaffected.
export { insertIntoResolverPreload };
import { probeHealthzMonitor } from "../../../common/nats/healthz-probe";
import {
  selectNatsServiceManager,
  currentServicePlatform,
  bunExecRunner,
  type ServicePlatform,
} from "../../../common/nats/nats-service-manager";
import { backupConfigFile } from "../../../common/nats/config-backup";
import {
  findCortexDaemonDescriptor,
  parsePlistProgramArguments,
  parseUnitExecStartArgs,
  configArgValue,
  type DaemonLocatorIO,
} from "./daemon-locator";
import type {
  CredsMintPort,
  AccountExportPort,
  ResolverPreloadPort,
  ServiceRestartPort,
  MakeLiveConfigWritePort,
  MakeLivePorts,
  NatsCanaryPort,
  NatsConfigSnapshot,
} from "./network-make-live-lib";

// =============================================================================
// Arc subprocess driver (injectable for tests — mirrors operator-provisioning.ts)
// =============================================================================

export interface ArcRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type ArcRunner = (argv: readonly string[]) => Promise<ArcRunResult>;

async function defaultArcRunner(argv: readonly string[]): Promise<ArcRunResult> {
  const proc = Bun.spawn(["arc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Parse the first non-blank JSON line from arc stdout. */
function firstJsonLine(result: ArcRunResult): { ok: true; value: unknown } | { ok: false; reason: string } {
  const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (line.length === 0) {
    return { ok: false, reason: `arc returned no output. stderr: ${result.stderr.trim() || "(empty)"}` };
  }
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, reason: `arc returned non-JSON output: ${line.slice(0, 200)}` };
  }
}

function arcEnvelopeError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  if (v.ok === false) {
    const code = typeof v.error?.code === "string" ? v.error.code : "(unknown code)";
    const message = typeof v.error?.message === "string" ? v.error.message : "(no message)";
    return `${code}: ${message}`;
  }
  return undefined;
}

// =============================================================================
// Creds-mint adapter — composes `arc nats add-bot`
// =============================================================================

/**
 * Live {@link CredsMintPort}. Backs up any existing creds to
 * `<credsPath>.bak-makelive-<ts>` (the documented rollback artefact) BEFORE the
 * mint, then shells `arc nats add-bot <bot> --account <agents> --output <creds>
 * --force`. The creds land `chmod 600` (arc's `writeCredsFile`).
 */
export function buildCredsMintAdapter(runner: ArcRunner = defaultArcRunner): CredsMintPort {
  return {
    mint: async ({ botName, account, credsPath, force }) => {
      const abs = expandTilde(credsPath);
      // Back up the existing (old-account) creds before overwriting — the
      // rollback artefact. chmod 600 so the backup is no more readable than the
      // live creds it copies (#130 leaked-backup discipline).
      // M1 — TIMESTAMPED filename (mirrors the resolver backup below): a second
      // `--apply`/`--force` must not clobber the FIRST migration's backup, which
      // holds the original shared-account creds the rollback (§3.4) restores. A
      // fixed `.bak-makelive` would copy the NEW agents creds over the original.
      if (existsSync(abs)) {
        try {
          const bak = `${abs}.bak-makelive-${Date.now().toString()}`;
          copyFileSync(abs, bak);
          chmodSync(bak, 0o600);
        } catch (err) {
          return { ok: false, reason: `failed to back up existing creds at ${abs}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      // make-live always overwrites the daemon's connection creds (the prior
      // creds were just backed up); `force` is accepted on the port for symmetry
      // with the orchestrator's force flag but does not change add-bot here.
      void force;
      const argv = [
        "nats", "add-bot", botName,
        "--account", account,
        "--output", abs,
        "--force",
        "--json",
      ];
      let result: ArcRunResult;
      try {
        result = await runner(argv);
      } catch (err) {
        return { ok: false, reason: `failed to invoke 'arc nats add-bot': ${err instanceof Error ? err.message : String(err)}` };
      }
      const parsed = firstJsonLine(result);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const envErr = arcEnvelopeError(parsed.value);
      if (envErr !== undefined) return { ok: false, reason: `arc nats add-bot failed: ${envErr}` };
      const v = parsed.value as { credsPath?: string; pubKey?: string };
      return { ok: true, credsPath: v.credsPath ?? abs, userPubkey: v.pubKey ?? "" };
    },
  };
}

// =============================================================================
// Account-export adapter — composes `arc nats export-account`
// =============================================================================

/** Live {@link AccountExportPort}. Shells `arc nats export-account <name> --json`. */
export function buildAccountExportAdapter(runner: ArcRunner = defaultArcRunner): AccountExportPort {
  return {
    exportAccount: async (account) => {
      let result: ArcRunResult;
      try {
        result = await runner(["nats", "export-account", account, "--json"]);
      } catch (err) {
        return { ok: false, reason: `failed to invoke 'arc nats export-account': ${err instanceof Error ? err.message : String(err)}` };
      }
      const parsed = firstJsonLine(result);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const envErr = arcEnvelopeError(parsed.value);
      if (envErr !== undefined) return { ok: false, reason: `arc nats export-account failed: ${envErr}` };
      const v = parsed.value as { pubKey?: string; jwt?: string; seedPath?: string | null };
      if (typeof v.jwt !== "string" || !v.jwt.startsWith("eyJ") || typeof v.pubKey !== "string") {
        return { ok: false, reason: `arc nats export-account returned no valid account JWT for ${account}` };
      }
      return { ok: true, pubKey: v.pubKey, jwt: v.jwt, seedPath: v.seedPath ?? null };
    },
  };
}

// =============================================================================
// resolver_preload adapter — append an account block to the nats config
// =============================================================================

/** Live {@link ResolverPreloadPort}. Edits the nats config on disk in place. */
export function buildResolverPreloadAdapter(): ResolverPreloadPort {
  return {
    hasAccount: (natsConfigPath, accountPubkey) => {
      const abs = expandTilde(natsConfigPath);
      if (!existsSync(abs)) return false;
      return readFileSync(abs, "utf-8").includes(accountPubkey);
    },
    // M3 — operator-mode probe: does the config carry a resolver_preload block?
    // Same brace-anchored pattern insertIntoResolverPreload uses to find the block.
    hasResolverPreload: (natsConfigPath) => {
      const abs = expandTilde(natsConfigPath);
      if (!existsSync(abs)) return false;
      return /resolver_preload\s*[:=]?\s*\{/.test(readFileSync(abs, "utf-8"));
    },
    appendAccount: ({ natsConfigPath, accountName, accountPubkey, accountJwt }) => {
      try {
        const abs = expandTilde(natsConfigPath);
        if (!existsSync(abs)) return { ok: false, reason: `nats config not found at ${abs}` };
        const text = readFileSync(abs, "utf-8");
        if (text.includes(accountPubkey)) return { ok: true, changed: false }; // idempotent
        const insertion = `  // Account "${accountName}" (cortex make-live)\n  ${accountPubkey}: ${accountJwt}\n`;
        const next = insertIntoResolverPreload(text, insertion);
        if (next === null) {
          return { ok: false, reason: `could not locate a resolver_preload { … } block in ${abs}` };
        }
        // cortex#1483 (join-4) — back up before the in-place edit (timestamped —
        // the rollback artefact), via the ONE shared .bak helper so this and the
        // bootstrap write below never drift on naming.
        backupConfigFile(abs, "makelive");
        writeFileSync(abs, next, "utf-8");
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    // cortex#1265 — bootstrap an initial operator-mode skeleton (local-only path).
    // Reuses renderOperatorModeBlocks (the SINGLE source of the §B0.1 grammar) so
    // the bootstrapped conf is byte-identical to one `cortex network join` would
    // render.
    //
    // Two cases on the target config:
    //   - EXISTS (the SOP §B0.1 base, carrying server_name/listen/jetstream): APPEND
    //     the operator-mode blocks onto it.
    //   - ABSENT + `baseIdentity` supplied (cortex#1265 PR8, the truly from-scratch
    //     path): SYNTHESISE the hard-isolated base from the stack's OWN derived
    //     identity (renderBaseIsolatedConfig — listen from the stack's nats.url,
    //     names <slug>-<principal>), then render the operator-mode blocks onto it.
    //     One shot, zero raw `nsc generate config`.
    //   - ABSENT + no `baseIdentity`: keep the historical refusal — never INVENT a
    //     server identity (the #1265 PR1 invariant; a join-path caller passes no
    //     identity and still gets the refuse).
    bootstrapOperatorMode: ({ natsConfigPath, package: pkg, baseIdentity }) => {
      try {
        const abs = expandTilde(natsConfigPath);
        const fileExists = existsSync(abs);
        if (!fileExists && baseIdentity === undefined) {
          return {
            ok: false,
            reason:
              `nats config not found at ${abs} — bootstrap appends operator-mode blocks to an ` +
              "EXISTING bus config (carrying its server_name/listen/http). Create the base config first.",
          };
        }
        // ABSENT + identity ⇒ synthesise the hard-isolated base from the stack's
        // OWN config; EXISTS ⇒ read it. Either way `current` is the base the
        // operator-mode blocks render onto.
        let current: string;
        if (fileExists) {
          current = readFileSync(abs, "utf-8");
        } else if (baseIdentity !== undefined) {
          current = renderBaseIsolatedConfig(baseIdentity);
        } else {
          // ABSENT + no derivable identity = the refuse-floor (guarded upstream,
          // re-asserted here for the type): never invent a server.
          return {
            ok: false,
            reason:
              `${abs} does not exist and no base identity could be derived from the ` +
              "stack's nats.url — refusing to invent a server (create the base config first).",
          };
        }
        const result = renderOperatorModeBlocks(current, pkg);
        if (result.status === "refuse") return { ok: false, reason: result.reason };
        if (result.status === "already") return { ok: true, changed: false };
        // converted — back up an existing file first (the rollback artefact); a
        // freshly-synthesised config has nothing to back up. Ensure the parent dir
        // exists, then write in place.
        if (fileExists) {
          backupConfigFile(abs, "makelive");
        } else {
          mkdirSync(dirname(abs), { recursive: true });
        }
        writeFileSync(abs, result.conf, "utf-8");
        return { ok: true, changed: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Service-restart adapter — nats-server + cortex daemon
// =============================================================================

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");

const realLocatorIO: DaemonLocatorIO = {
  listDir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readFile: (path) => readFileSync(path, "utf-8"),
  exists: (path) => existsSync(path),
};

/**
 * Find the launchd plist / systemd unit running `nats-server -c <natsConfigPath>`.
 * Sibling of {@link findCortexDaemonDescriptor}: matches by the program looking
 * like a nats-server AND the `-c`/`--config` arg pointing at the same nats config
 * (so a multi-nats-server host restarts the RIGHT one — never guesses a label).
 */
export function findNatsServerDescriptor(opts: {
  platform: ServicePlatform;
  natsConfigPath: string;
  launchAgentsDir: string;
  systemdUserDir: string;
  io: DaemonLocatorIO;
}): string | undefined {
  const { platform, natsConfigPath, io } = opts;
  const target = expandTilde(natsConfigPath);
  const matches = (args: string[]): boolean => {
    const prog = (args[0] ?? "").toLowerCase();
    if (!prog.includes("nats-server")) return false;
    const cfg = configArgValue(args);
    return cfg !== undefined && expandTilde(cfg) === target;
  };
  const dir = platform === "darwin" ? opts.launchAgentsDir : opts.systemdUserDir;
  const namePattern = platform === "darwin" ? /\.plist$/ : /\.service$/;
  if (!io.exists(dir)) return undefined;
  for (const name of io.listDir(dir)) {
    if (!namePattern.test(name)) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = io.readFile(path);
    } catch {
      continue;
    }
    const args = platform === "darwin" ? parsePlistProgramArguments(text) : parseUnitExecStartArgs(text);
    if (matches(args)) return path;
  }
  return undefined;
}

/** Live {@link ServiceRestartPort}. Discovers descriptors, restarts via launchd/systemd. */
export function buildServiceRestartAdapter(mutate: boolean): ServiceRestartPort {
  const platform = currentServicePlatform();
  // cortex#1909 (G-38) — resolve the systemd user unit dir at call time so
  // $XDG_CONFIG_HOME is honored (was a module-level hardcoded ~/.config/systemd/
  // user, blind to a relocated config home — the exact var this epic honors).
  const SYSTEMD_USER_DIR = systemdUserDir();
  return {
    // BLOCK 2 — read-only descriptor resolution for the dry-run preview. Reuses
    // the SAME finders the restarts use, so the previewed target is exactly the
    // one --apply would kickstart. Never mutates.
    resolveTargets: ({ natsConfigPath, cortexConfigPath }) => {
      const natsDescriptor = findNatsServerDescriptor({
        platform,
        natsConfigPath,
        launchAgentsDir: LAUNCH_AGENTS_DIR,
        systemdUserDir: SYSTEMD_USER_DIR,
        io: realLocatorIO,
      });
      const daemonDescriptor = findCortexDaemonDescriptor({
        platform,
        cortexConfigPath,
        launchAgentsDir: LAUNCH_AGENTS_DIR,
        systemdUserDir: SYSTEMD_USER_DIR,
        io: realLocatorIO,
      });
      return {
        ...(natsDescriptor !== undefined && { natsDescriptor }),
        ...(daemonDescriptor !== undefined && { daemonDescriptor }),
      };
    },
    restartNats: async (natsConfigPath) => {
      const descriptor = findNatsServerDescriptor({
        platform,
        natsConfigPath,
        launchAgentsDir: LAUNCH_AGENTS_DIR,
        systemdUserDir: SYSTEMD_USER_DIR,
        io: realLocatorIO,
      });
      if (descriptor === undefined) {
        return {
          ok: false,
          reason:
            `could not find the launchd/systemd service running nats-server -c ${natsConfigPath}. ` +
            `Restart the nats-server manually (its MEMORY resolver must reload to pick up the new account).`,
        };
      }
      const mgr = selectNatsServiceManager({ platform, descriptorPath: descriptor, mutate, exec: bunExecRunner });
      return mgr.restart();
    },
    restartDaemon: async (cortexConfigPath) => {
      const descriptor = findCortexDaemonDescriptor({
        platform,
        cortexConfigPath,
        launchAgentsDir: LAUNCH_AGENTS_DIR,
        systemdUserDir: SYSTEMD_USER_DIR,
        io: realLocatorIO,
      });
      if (descriptor === undefined) {
        return {
          ok: false,
          reason:
            `could not find the cortex daemon service loading ${cortexConfigPath}. ` +
            `Restart the daemon manually so it reconnects with the new creds.`,
        };
      }
      const mgr = selectNatsServiceManager({ platform, descriptorPath: descriptor, mutate, exec: bunExecRunner });
      return mgr.restart();
    },
  };
}

// =============================================================================
// Full live port bundle
// =============================================================================

/**
 * cortex#1265 (v5.30.2) — persist a DEFAULTED `nats.credsPath` back to the daemon's
 * config. Surgical single-key set via the YAML Document API (`setIn`), so every
 * other key + comment (encryption, federated JWTs, `nats_infra`) survives. Targets
 * the SYSTEM/bus layer only. On a dry-run (`mutate=false`) it no-ops (mirrors the
 * restart adapter). A missing target file is an ERROR (never synthesise a partial
 * config) — the daemon's config always exists by the time make-live runs.
 */
export function buildMakeLiveConfigWriteAdapter(mutate: boolean): MakeLiveConfigWritePort {
  return {
    writeBusCredsPath: ({ systemConfigPath, credsPath }) => {
      const expanded = expandTilde(systemConfigPath);
      if (!mutate) return { ok: true, path: expanded, changed: false };
      try {
        if (!existsSync(expanded)) {
          return { ok: false, reason: `config file ${expanded} not found — cannot write nats.credsPath` };
        }
        const doc = parseDocument(readFileSync(expanded, "utf-8"));
        // Idempotent: a matching value already present ⇒ no write, no churn.
        if (doc.getIn(["nats", "credsPath"]) === credsPath) {
          return { ok: true, path: expanded, changed: false };
        }
        doc.setIn(["nats", "credsPath"], credsPath);
        mkdirSync(dirname(expanded), { recursive: true });
        writeFileSync(expanded, doc.toString(), "utf-8");
        return { ok: true, path: expanded, changed: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Canary adapter (cortex#1483, join-4) — validate/snapshot/health/rollback
// around the nats-server restart. Mirrors network-adapters.ts's
// buildNatsServerPort (validateConfig via `nats-server -t`, isHealthy via the
// config's own /healthz monitor) + the #821 leaf-state snapshot/restore
// pattern, adapted to make-live's single nats config file (no per-network leaf
// include — the whole config IS the mutation target here).
// =============================================================================

// cortex#1495 nit 4 — kept LOCAL rather than imported from network-adapters.ts
// (join's adapter), so make-live's canary adapter doesn't reach across into
// join's module for a shared default. Mirrors network-adapters.ts's
// DEFAULT_HEALTH_PROBE_TIMEOUT_MS (a 5s probe bound); the two are independent by
// design. (cortex#1495 v2: the :8222 monitor DEFAULT was dropped — a bus with no
// declared monitor now falls back to a TCP client-port probe, not a guessed :8222.)
const MAKELIVE_HEALTH_PROBE_TIMEOUT_MS = 5000;
/** NATS default client listen port — the TCP-connect liveness target when a bus declares no monitor. */
const NATS_DEFAULT_CLIENT_PORT = 4222;

/**
 * cortex#1495 v3 (important) — map a PARSED nats `listen` host to the address the
 * liveness TCP connect should actually dial:
 *   - a specific host (`10.0.0.5`, `localhost`, an IPv6 literal) is used as-is —
 *     hardcoding `127.0.0.1` would false-fail (and false-rollback) a bus that
 *     listens on a non-loopback address;
 *   - a WILDCARD bind is reachable via loopback: `0.0.0.0` → `127.0.0.1`,
 *     `::`/`[::]` → `::1`;
 *   - an empty/unparseable host (bare `port:` / `listen: <port>`) → `127.0.0.1`.
 */
function connectHostForListen(rawHost: string): string {
  const h = rawHost.trim();
  if (h === "" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]") return "::1";
  return h;
}

/**
 * cortex#1495 v2 (important 2) — an injectable bounded TCP-connect probe. A bus
 * with NO HTTP monitor (the #1476 community class) still has a client listen
 * port; a successful connect is a REAL liveness signal (the process is up and
 * accepting), a refused/timed-out connect means the restart left it DOWN → the
 * orchestrator's auto-rollback fires. Injected so tests script connect-ok /
 * connect-fail without opening a real socket. Resolves `true` on connect,
 * `false` on refusal/timeout/error. NEVER rejects.
 */
export type TcpConnectProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** Real bounded TCP connect (node `net.Socket`); destroyed the moment it settles. */
const realTcpConnectProbe: TcpConnectProbe = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { finish(true); });
    socket.once("timeout", () => { finish(false); });
    socket.once("error", () => { finish(false); });
    socket.connect(port, host);
  });

/**
 * Live {@link NatsCanaryPort}. `nats-server -t` gate, snapshot/restore, and a
 * two-tier post-restart liveness probe: the config's `/healthz` monitor when one
 * is declared, else a TCP connect to the client listen port (cortex#1495 v2).
 * `tcpConnect` is injectable so tests exercise the no-monitor path without a real
 * socket; production uses {@link realTcpConnectProbe}.
 */
export function buildNatsCanaryAdapter(
  mutate: boolean,
  healthProbeTimeoutMs?: number,
  tcpConnect: TcpConnectProbe = realTcpConnectProbe,
): NatsCanaryPort {
  return {
    async validateConfig(natsConfigPath) {
      // #821 MAJOR-1 parity — cheap pre-restart syntax gate. Dry-run is inert.
      // cortex#1495 v2 (suggestion) — the "invalid config → -t refuses the reload"
      // contract is exercised at the ORCHESTRATION level with FAKE ports only
      // (network-make-live.test.ts). It is not asserted against a real nats-server:
      // that needs the `nats-server` binary in CI (out of scope) and would be flaky.
      // The `code !== 0 → invalid` mapping below is the single point of trust.
      if (!mutate) return { status: "valid" };
      const abs = expandTilde(natsConfigPath);
      let result: { code: number; stderr: string };
      try {
        result = await bunExecRunner(["nats-server", "-c", abs, "-t"]);
      } catch (err) {
        // cortex#1495 BLOCKER — a missing binary (spawn ENOENT) is `skipped`,
        // NOT `valid`: fail-OPEN here would let a bad config reload onto a live
        // bus on any host without `nats-server` on PATH. The orchestrator warns
        // loudly + proceeds on `skipped` rather than silently passing.
        return {
          status: "skipped",
          reason: `could not run nats-server -t: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (result.code !== 0) {
        return {
          status: "invalid",
          reason: `nats-server -c ${abs} -t exited ${result.code.toString()}: ${result.stderr.trim()}`,
        };
      }
      return { status: "valid" };
    },
    snapshot(natsConfigPath) {
      const abs = expandTilde(natsConfigPath);
      return {
        natsConfigPath: abs,
        contents: existsSync(abs) ? readFileSync(abs, "utf-8") : undefined,
      };
    },
    restore(snapshot: NatsConfigSnapshot) {
      if (!mutate) return;
      const { natsConfigPath, contents } = snapshot;
      if (contents === undefined) {
        // The config did not exist pre-mutation (the from-scratch bootstrap
        // path) — remove what make-live wrote so a retry starts clean.
        rmSync(natsConfigPath, { force: true });
        return;
      }
      // Atomic write (temp + rename) — a crash mid-rollback must never corrupt
      // the very config it is trying to restore (mirrors network-adapters.ts's
      // O-3 atomicWriteFileSync).
      // cortex#1495 v2 (important 1) — the nats config is SECRET-bearing (leaf
      // creds, hub authorization users, payload keys), so the restore write is
      // created 0600 (mode on the temp + explicit chmod against a permissive
      // umask), same discipline as the `.bak` sidecar and the leaf-include write.
      const tmp = `${natsConfigPath}.tmp-canary-restore-${process.pid.toString()}`;
      writeFileSync(tmp, contents, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, natsConfigPath);
    },
    async isHealthy(natsConfigPath) {
      if (!mutate) return { healthy: true };
      const abs = expandTilde(natsConfigPath);
      const timeoutMs = healthProbeTimeoutMs ?? MAKELIVE_HEALTH_PROBE_TIMEOUT_MS;
      const configText = existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
      // Same precedence as network-adapters.ts's resolveMonitorBase: derive the
      // monitor from the config's own http_port/monitor_port/http.
      let base: string | undefined;
      if (configText !== undefined) {
        const derived = natsConfigMonitorUrl(configText);
        if (derived !== undefined) base = derived;
      }

      // cortex#1495 v2 (important 2) — a bus with NO HTTP monitor (the #1476
      // community bus class: no `http_port`) must NOT read as inconclusive-healthy,
      // or auto-rollback goes inert on the exact config that motivated this slice.
      // Fall back to a REAL liveness signal: a bounded TCP connect to the client
      // listen address (parsed from `listen:`/`host:`+`port:`). Connect ⇒ genuinely
      // healthy (NOT inconclusive); refused/timeout ⇒ unhealthy → the orchestrator
      // rolls back. cortex#1495 v3 — dial the PARSED host (wildcard/empty mapped to
      // loopback), never a hardcoded 127.0.0.1 that would false-fail a bus bound to
      // a specific non-loopback address. RESIDUAL: a listening client port proves
      // the process is up + accepting, not that JetStream fully recovered — but it
      // catches the "nats-server crashed on the new config" case the slice targets.
      if (base === undefined) {
        if (configText === undefined) {
          // The client listen addr genuinely can't be resolved (config
          // absent/unreadable) — disclosed fallback to inconclusive-healthy.
          return { healthy: true, inconclusive: true };
        }
        const listen = natsConfigClientListen(configText);
        const host = connectHostForListen(listen?.host ?? "");
        const port = listen?.port ?? NATS_DEFAULT_CLIENT_PORT;
        const connected = await tcpConnect(host, port, timeoutMs);
        return connected
          ? { healthy: true }
          : {
              healthy: false,
              reason: `bus client port ${host}:${port.toString()} not accepting connections after restart (no HTTP monitor to probe; TCP connect failed)`,
            };
      }
      // cortex#1495 v3 — shared `/healthz` fetch+timeout+error-map (join + make-live
      // call the ONE helper so their probe bodies can't drift).
      return probeHealthzMonitor(base, timeoutMs);
    },
  };
}

/** Build the live {@link MakeLivePorts} bundle for a real `--apply` run. */
export function buildLiveMakeLivePorts(mutate: boolean): MakeLivePorts {
  return {
    creds: buildCredsMintAdapter(),
    accountExport: buildAccountExportAdapter(),
    resolver: buildResolverPreloadAdapter(),
    restart: buildServiceRestartAdapter(mutate),
    configWrite: buildMakeLiveConfigWriteAdapter(mutate),
    natsCanary: buildNatsCanaryAdapter(mutate),
  };
}
