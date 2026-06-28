/**
 * C-1257 — the LIVE adapters for `cortex network make-live`.
 *
 * These touch the real world: arc (`add-bot` / `export-account`), the nats config
 * (`resolver_preload`), the creds file, and the launchd/systemd services. The
 * orchestration is pure over the injected ports (`network-make-live-lib.ts`);
 * these adapters are constructed only on a real `--apply` (the dry-run path uses
 * read-only state probes built in the CLI). cortex NEVER runs nsc — the account
 * tree + JWT come from arc (ADR-0013 Model B invariant).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

import { expandTilde } from "../../../common/config/loader";
import { renderOperatorModeBlocks, renderBaseIsolatedConfig } from "../../../common/nats/leaf-remote-renderer";
import {
  selectNatsServiceManager,
  currentServicePlatform,
  bunExecRunner,
  type ServicePlatform,
} from "../../../common/nats/nats-service-manager";
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
  MakeLivePorts,
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

/**
 * Insert `insertion` immediately before the closing brace of the
 * `resolver_preload { … }` block in `text`. Uses a brace-matched scan so a
 * nested object inside the block can't confuse the close detection. Returns the
 * new text, or null when no resolver_preload block is found.
 */
export function insertIntoResolverPreload(text: string, insertion: string): string | null {
  const key = /resolver_preload\s*[:=]?\s*\{/.exec(text);
  if (key === null) return null;
  const open = key.index + key[0].length - 1; // index of the `{`
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Insert before this closing brace (which sits at column 0 of its line).
        const lineStart = text.lastIndexOf("\n", i) + 1;
        return text.slice(0, lineStart) + insertion + text.slice(lineStart);
      }
    }
  }
  return null; // unbalanced braces — refuse to edit
}

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
        // Back up before the in-place edit (timestamped — the rollback artefact).
        copyFileSync(abs, `${abs}.bak-makelive-${Date.now().toString()}`);
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
          copyFileSync(abs, `${abs}.bak-makelive-${Date.now().toString()}`);
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
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");

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

/** Build the live {@link MakeLivePorts} bundle for a real `--apply` run. */
export function buildLiveMakeLivePorts(mutate: boolean): MakeLivePorts {
  return {
    creds: buildCredsMintAdapter(),
    accountExport: buildAccountExportAdapter(),
    resolver: buildResolverPreloadAdapter(),
    restart: buildServiceRestartAdapter(mutate),
  };
}
