#!/usr/bin/env bun
/**
 * `cortex quickstart` — L3 (cortex#2094): env-contract driven one-command
 * first install (Debian).
 *
 * Collapses the validated Debian runbook (README-AGENTS.md Appendix A + §5,
 * merged PR#2090 — itself crediting the community gist it's based on) into
 * ONE idempotent command, driven entirely by the DD-L5 `CTX_*` env contract
 * (arc `design/linux-host-support.md`, arc#309):
 *
 *   set -a; . ./cortex.env; set +a; cortex quickstart
 *
 * Eight numbered steps, each printing a ✓/✗ table before the next one runs.
 * The WHOLE run is re-runnable without damage — every step is designed to
 * be a no-op (skip/verified) on a config that's already in the desired
 * state, so a principal can re-run this after fixing one env var without
 * fear of clobbering anything already wired up.
 *
 *   1. Preflight        — bun/claude/nats-server on PATH, claude authenticated,
 *                          Linux linger enabled. All read-only.
 *   2. Validate env      — every required CTX_* present + shape-checked.
 *   3. nats conf         — write ~/.config/nats/$CTX_SLUG.conf (skip if
 *                          byte-identical; refuse a DIFFERENT existing file
 *                          without --force).
 *   4. Scaffold          — `cortex stack create` (or verify+skip if the
 *                          stack already exists with matching identity).
 *   5. Patch configs     — the three formerly-manual edits, guarded +
 *                          comment-preserving (quickstart-lib.ts).
 *   6. Seed provisioning — the SAME entry postupgrade.sh uses.
 *   7. Services          — Linux: systemd user units (L1, cortex#2071
 *                          REQUIRED — declared as a hard dependency, not
 *                          re-implemented here); a re-run also try-restarts
 *                          running units so fixed configs are picked up
 *                          (cortex#2283). macOS: LOADED stack service →
 *                          restart via launchctl kickstart -k (load/unload
 *                          stays arc-owned, cortex#2283); NOT loaded (a fresh
 *                          Mac) → start the daemon DIRECTLY via a detached
 *                          `cortex start --config <pointer>` backstop so the
 *                          gate reaches a RUNNING daemon, not a printed hint
 *                          (cortex#2322) — idempotent (a re-run skips when the
 *                          backstop daemon is already running).
 *   8. Gate              — the §5 healthy-boot grep table + nats /healthz,
 *                          bounded wait.
 *
 * Explicitly OUT OF SCOPE (cortex#2094): rendering the systemd units
 * (cortex#2071 — quickstart REQUIRES it merged, checked in step 7); the
 * container entrypoint (a future L4 issue calls INTO this command, not the
 * reverse); Discord bot creation / invite flow (irreducibly manual — the
 * Developer Portal has no API for it; quickstart only validates the
 * resulting ids via the env contract).
 *
 * Secret hygiene (non-negotiable, cortex#2094 acceptance criteria):
 * `CTX_DISCORD_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` values NEVER reach stdout,
 * stderr, or any error message — every place quickstart reports on them
 * prints only `"set" | "missing"` (see `quickstart-lib.ts`'s
 * `validateEnvContract` / `renderEnvTable`, which structurally keep those two
 * keys out of any value-carrying field).
 *
 * Exit codes: 0 success (or a fully-idempotent no-op re-run) · 1 operational
 * failure (a step's precondition failed, or a step itself failed) · 2 usage
 * error (bad flag) or a missing/malformed env contract.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import { discoverStacks } from "./stack-lib";
import { dispatchStack } from "./stack";
import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";

import { CC_AUTH_FAILURE_MESSAGE, isCcAuthFailure } from "../../../runner/cc-failure-classifier";
import type { CCSessionResult } from "../../../runner/cc-session";
import { resolveConfigDir } from "../../../common/config/config-path";
import { validateConfigLoads } from "../../../common/config/validate-on-write";
import { expandTilde } from "../../../common/config/loader";

import { buildQuickstartPorts } from "./quickstart-adapters";
import type { QuickstartPorts } from "./quickstart-ports";
import {
  daemonErrorLogPath,
  daemonLogPath,
  detectBusConnectFailure,
  evaluateHealthyBootGate,
  gatePassed,
  launchdStackLabel,
  natsConfPath,
  nkeyBasenameForSlug,
  patchStackYaml,
  patchSurfacesYaml,
  patchSystemNatsPort,
  pointerConfigPath,
  readSurfaceAgent,
  renderEnvTable,
  renderGateTable,
  renderNatsConf,
  stackAgentConfigPath,
  stackTargetDir,
  surfacesConfigPath,
  systemConfigPath,
  validateEnvContract,
  validateWebEnvContract,
  writeWebSurfacesYaml,
  type CtxRequiredKey,
  type CtxWebRequiredKey,
  type EnvValidationResult,
  type Surface,
} from "./quickstart-lib";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Injectable ports factory (mirrors network.ts's *PortsFactory convention)
// =============================================================================

/** Production omits this — the live adapters. Tests pass a fake bundle so
 *  quickstart's CLI-level tests never spawn a real `systemctl`/`loginctl`/
 *  `claude`, never hit a real `/healthz`, and never wait real wall-clock
 *  time in the gate's poll loop. */
export type QuickstartPortsFactory = () => QuickstartPorts;
const DEFAULT_QUICKSTART_PORTS_FACTORY: QuickstartPortsFactory = buildQuickstartPorts;

/** Bounded wait window for step 8's gate poll loop (cortex#2094: "30s-120s
 *  bounded wait"). Overridable via `--gate-timeout-ms` (tests + an unusually
 *  slow first boot). */
export const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const GATE_POLL_INTERVAL_MS = 3_000;

// =============================================================================
// Flags
// =============================================================================

interface QuickstartFlags {
  configDir?: string;
  natsDir?: string;
  force: boolean;
  json: boolean;
  skipServices: boolean;
  skipGate: boolean;
  container: boolean;
  surface: Surface;
  gateTimeoutMs: number;
  help: boolean;
}

/** quickstart takes no subcommand (it's a single, env-driven verb) — a small
 *  hand-rolled flag parser rather than `parseSubcommandArgs` (built for the
 *  `<subcommand> <flags>` shape `stack`/`network` use). */
function parseQuickstartArgs(argv: string[]): QuickstartFlags {
  const flags: QuickstartFlags = {
    force: false,
    json: false,
    skipServices: false,
    skipGate: false,
    container: false,
    // Default `discord` — byte-identical to pre-#2153 behaviour for every
    // caller that doesn't pass --surface (the entrypoint + every existing test).
    surface: "discord",
    gateTimeoutMs: DEFAULT_GATE_TIMEOUT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--config-dir":
        flags.configDir = requireValue(argv, ++i, "--config-dir");
        break;
      case "--nats-dir":
        flags.natsDir = requireValue(argv, ++i, "--nats-dir");
        break;
      case "--gate-timeout-ms": {
        const raw = requireValue(argv, ++i, "--gate-timeout-ms");
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new CliArgsError("quickstart", `--gate-timeout-ms must be a positive number, got "${raw}"`);
        }
        flags.gateTimeoutMs = n;
        break;
      }
      case "--force":
        flags.force = true;
        break;
      case "--json":
        flags.json = true;
        break;
      // Linux-only step 7 is already a clean no-op on macOS (checked via
      // `process.platform`); this flag exists for CI/tests that want to
      // exercise steps 1-6+8 without a systemd host at all.
      case "--skip-services":
        flags.skipServices = true;
        break;
      // Skip step 8's healthy-boot gate and report it as DEFERRED (cortex#2275).
      // Sibling of --skip-services: the container entrypoint runs quickstart
      // BEFORE the daemon exists (`exec cortex start` is phase 2), so the gate
      // structurally cannot pass — the supervisor's healthcheck (compose) is the
      // real health signal. Unlike --container this does NOT imply
      // --skip-services; the entrypoint passes both explicitly.
      case "--skip-gate":
        flags.skipGate = true;
        break;
      // Container mode (cortex#2155): skip step 8's healthy-boot gate. Under
      // the L4 split-container model the daemon starts only AFTER quickstart
      // returns (`exec cortex start`), so the gate's log-grep can never pass —
      // it just stalls the whole poll window (~60s) then fails on every boot.
      // The container's real health signal is compose `restart:` + the nats
      // healthcheck (deploy/compose/README.md). Implies --skip-services (the
      // daemon is launched by the entrypoint, not by step 7 here).
      case "--container":
        flags.container = true;
        flags.skipServices = true;
        break;
      // Surface mode (cortex#2153): which surface to provision. `discord`
      // (default) validates the Discord snowflake contract + patches a discord
      // binding; `web` validates a host/port/token contract + scaffolds a web
      // binding. EXPLICIT — never auto-detected from which CTX_* are present
      // (epic #2164 planner decision).
      case "--surface": {
        const raw = requireValue(argv, ++i, "--surface");
        if (raw !== "discord" && raw !== "web") {
          throw new CliArgsError("quickstart", `--surface must be "discord" or "web", got "${raw}"`);
        }
        flags.surface = raw;
        break;
      }
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        throw new CliArgsError("quickstart", `unknown flag: ${a}`);
    }
  }
  return flags;
}

function requireValue(argv: string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (v === undefined || v.startsWith("--")) {
    throw new CliArgsError("quickstart", `${flag} requires a value`);
  }
  return v;
}

// =============================================================================
// Step result + report accumulation
// =============================================================================

interface StepReport {
  name: string;
  ok: boolean;
  lines: string[];
  /** cortex#2275 — step was deliberately not executed (e.g. --skip-gate).
   *  Surfaced in the --json items as `skipped: "true"` so a principal sees an
   *  explicit deferral, never a green check for work that didn't run. */
  skipped?: boolean;
  /** Short machine-readable annotation (--json `note`): the reason
   *  accompanying `skipped` (cortex#2275), and — cortex#2283 — step 7's
   *  action-taken line ("restarted (config re-applied)" / "started (first
   *  boot)" / "skip (not loaded — arc owns launchd load)"). */
  note?: string;
}

function step(name: string, ok: boolean, lines: string[]): StepReport {
  return { name, ok, lines };
}

function renderReport(reports: StepReport[]): string {
  const out: string[] = [];
  for (const r of reports) {
    out.push(`── ${r.name} ${r.ok ? "✓" : "✗"} ──`);
    for (const l of r.lines) out.push(l);
    out.push("");
  }
  return out.join("\n");
}

// =============================================================================
// Step 1 — preflight
// =============================================================================

function runPreflight(ports: QuickstartPorts): StepReport {
  const lines: string[] = [];
  let ok = true;

  const bun = ports.preflight.which("bun");
  lines.push(`  ${bun !== undefined ? "✓" : "✗"} bun on PATH${bun !== undefined ? ` (${bun})` : ""}`);
  if (bun === undefined) ok = false;

  const claudePath = ports.preflight.which("claude");
  if (claudePath === undefined) {
    lines.push("  ✗ claude on PATH — install Claude Code first (https://claude.com/claude-code)");
    ok = false;
  } else {
    const versionResult = ports.preflight.claudeVersion();
    if (versionResult.exitCode === 0) {
      lines.push(`  ✓ claude authenticated (${claudePath})`);
    } else {
      // cortex#2068 — reuse the shared classifier's signature match instead
      // of re-deriving auth-failure regexes here. `claudeVersion()` doesn't
      // return a real CCSessionResult (there's no dispatched session), so a
      // minimal shape carrying only the fields `isCcAuthFailure` reads is
      // built here — never echoing anything beyond claude's own CLI output.
      const fakeResult: CCSessionResult = {
        success: false,
        response: versionResult.stdout,
        stderr: versionResult.stderr,
        exitCode: versionResult.exitCode,
        durationMs: 0,
      };
      if (isCcAuthFailure(fakeResult)) {
        lines.push(`  ✗ claude not authenticated`);
        lines.push(`    ${CC_AUTH_FAILURE_MESSAGE}`);
      } else {
        lines.push(`  ✗ claude --version failed (exit ${String(versionResult.exitCode)})`);
        if (versionResult.stderr.trim().length > 0) {
          lines.push(`    ${versionResult.stderr.trim()}`);
        }
      }
      ok = false;
    }
  }

  const natsServer = ports.preflight.which("nats-server");
  lines.push(`  ${natsServer !== undefined ? "✓" : "✗"} nats-server on PATH${natsServer !== undefined ? ` (${natsServer})` : ""}`);
  if (natsServer === undefined) ok = false;

  if (process.platform === "linux") {
    const user = process.env.USER;
    const linger = user !== undefined ? ports.preflight.lingerStatus(user) : "unknown";
    if (linger === "yes") {
      lines.push("  ✓ systemd linger enabled");
    } else if (linger === "no") {
      const target = user !== undefined ? `"${user}"` : '"$USER"';
      lines.push("  ✗ systemd linger disabled — services stop the moment your SSH session ends");
      lines.push(`    fix: sudo loginctl enable-linger ${target}`);
      ok = false;
    } else {
      lines.push("  ○ systemd linger status unknown (loginctl unavailable — verify manually)");
    }
  }

  return step("1. Preflight", ok, lines);
}

// =============================================================================
// Step 2 — env contract
// =============================================================================

/** The four SHARED env values every surface needs (NATS identity + stack
 *  scaffold — the genuinely-useful parts quickstart keeps across surfaces). */
interface SharedEnvValues {
  principal: string;
  slug: string;
  natsPort: string;
  natsMon: string;
}

/** Step-2 outcome. `ok` gates progression; `shared` is the cross-surface value
 *  set; exactly one of `discord`/`web` is populated (the surface's typed
 *  values) when `ok`. */
interface EnvStepResult {
  report: StepReport;
  ok: boolean;
  shared?: SharedEnvValues;
  discord?: Record<CtxRequiredKey, string>;
  web?: Record<CtxWebRequiredKey, string>;
}

function runEnvValidation(surface: Surface): EnvStepResult {
  // drop the "env contract (CTX_*):" header — the step name is already the header
  if (surface === "web") {
    const result = validateWebEnvContract(process.env);
    const report = step("2. Validate env contract", result.ok, renderEnvTable(result).split("\n").slice(1));
    if (!result.ok || result.values === undefined) return { report, ok: false };
    const v = result.values;
    return {
      report,
      ok: true,
      shared: { principal: v.CTX_PRINCIPAL, slug: v.CTX_SLUG, natsPort: v.CTX_NATS_PORT, natsMon: v.CTX_NATS_MON },
      web: v,
    };
  }
  const result: EnvValidationResult = validateEnvContract(process.env);
  const report = step("2. Validate env contract", result.ok, renderEnvTable(result).split("\n").slice(1));
  if (!result.ok || result.values === undefined) return { report, ok: false };
  const v = result.values;
  return {
    report,
    ok: true,
    shared: { principal: v.CTX_PRINCIPAL, slug: v.CTX_SLUG, natsPort: v.CTX_NATS_PORT, natsMon: v.CTX_NATS_MON },
    discord: v,
  };
}

// =============================================================================
// Step 3 — nats conf
// =============================================================================

function runNatsConf(opts: {
  slug: string;
  principal: string;
  port: string;
  monitorPort: string;
  natsDir: string;
  force: boolean;
}): StepReport {
  const path = natsConfPath(opts.natsDir, opts.slug);
  const desired = renderNatsConf({
    slug: opts.slug,
    principal: opts.principal,
    port: opts.port,
    monitorPort: opts.monitorPort,
    natsDir: opts.natsDir,
  });

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8");
    if (existing === desired) {
      return step("3. nats conf", true, [`  ✓ ${path} already up to date (skip)`]);
    }
    if (!opts.force) {
      return step("3. nats conf", false, [
        `  ✗ ${path} exists and differs from the expected contents`,
        `    refusing to overwrite without --force (a hand-edited or differently-configured .conf is preserved by default)`,
      ]);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desired, "utf-8");
    return step("3. nats conf", true, [`  ✓ ${path} overwritten (--force)`]);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, "utf-8");
  return step("3. nats conf", true, [`  ✓ ${path} written`]);
}

// =============================================================================
// Step 4 — scaffold
// =============================================================================

async function runScaffold(opts: {
  slug: string;
  principal: string;
  configDir: string;
  /** cortex#2331 (7a) — when set (from CTX_REPO), scaffold a software-factory
   *  ("code") stack scoped to this `owner/repo`: the stack's agent declares the
   *  `code` capability and gets the git-write + gh-pr bash allowlist, repo-
   *  scoped. Absent ⇒ a chat-only stack (unchanged). */
  grantedRepo?: string;
}): Promise<StepReport> {
  const create = await dispatchStack([
    "create",
    opts.slug,
    "--principal",
    opts.principal,
    ...(opts.grantedRepo !== undefined
      ? ["--capability", "code", "--repo", opts.grantedRepo]
      : []),
    "--apply",
    "--config-dir",
    opts.configDir,
  ]);

  if (create.exitCode === 0) {
    return step("4. Scaffold", true, [`  ✓ stack "${opts.slug}" created under ${opts.configDir}`]);
  }

  // Idempotency: `stack create` refuses a dir collision. That's expected on
  // a re-run — verify the ALREADY-discovered stack's identity actually
  // matches this env's CTX_PRINCIPAL/CTX_SLUG (a structural check, not a
  // string-match on create's error text) before treating it as a skip.
  const targetDir = stackTargetDir(opts.configDir, opts.slug);
  if (existsSync(targetDir)) {
    const discovered = discoverStacks(opts.configDir).find((s) => s.slugLocator === opts.slug);
    const expectedStackId = `${opts.principal}/${opts.slug}`;
    if (discovered?.stackId === expectedStackId) {
      return step("4. Scaffold", true, [
        `  ✓ stack "${opts.slug}" already exists with matching identity (${expectedStackId}) — skip`,
      ]);
    }
    return step("4. Scaffold", false, [
      `  ✗ ${targetDir} exists but its stack.id ("${discovered?.stackId ?? "(unreadable)"}") does not match the expected "${expectedStackId}"`,
      `    this is a pre-existing, differently-identified stack at the CTX_SLUG path — resolve manually before re-running quickstart`,
    ]);
  }

  return step("4. Scaffold", false, [
    `  ✗ cortex stack create failed:`,
    ...create.stderr.split("\n").filter((l) => l.length > 0).map((l) => `    ${l}`),
  ]);
}

// =============================================================================
// Step 5 — patch configs from env
// =============================================================================

function runPatchConfigs(opts: {
  slug: string;
  principal: string;
  configDir: string;
  natsPort: string;
  discordToken: string;
  guildId: string;
  channelId: string;
  logChannelId: string;
  myDiscordId: string;
}): StepReport {
  const lines: string[] = [];
  let ok = true;

  try {
    const surfacesResult = patchSurfacesYaml(surfacesConfigPath(opts.configDir, opts.slug), {
      token: opts.discordToken,
      guildId: opts.guildId,
      agentChannelId: opts.channelId,
      logChannelId: opts.logChannelId,
    });
    lines.push(
      `  ✓ surfaces/surfaces.yaml ${surfacesResult.changed ? "patched (token set — never echoed)" : "already up to date (skip)"}`,
    );
  } catch (err) {
    lines.push(`  ✗ surfaces/surfaces.yaml patch failed: ${errMsg(err)}`);
    ok = false;
  }

  try {
    const pointerPath = pointerConfigPath(opts.configDir, opts.slug);
    const stackResult = patchStackYaml(stackAgentConfigPath(opts.configDir, opts.slug), pointerPath, {
      principal: opts.principal,
      discordId: opts.myDiscordId,
    });
    if (stackResult.composeErrors !== undefined) {
      lines.push(`  ✗ stacks/${opts.slug}.yaml patched, but the composed config failed validation:`);
      for (const e of stackResult.composeErrors) lines.push(`    ${e}`);
      ok = false;
    } else {
      lines.push(
        `  ✓ stacks/${opts.slug}.yaml ${stackResult.changed ? "patched (discordId set)" : "already up to date (skip)"}`,
      );
    }
  } catch (err) {
    lines.push(`  ✗ stacks/${opts.slug}.yaml patch failed: ${errMsg(err)}`);
    ok = false;
  }

  // system/system.yaml's nats.url only needs a patch when the port differs
  // from the scaffold's own default (4222) — cortex#2094's explicit gate.
  if (opts.natsPort !== "4222") {
    try {
      const systemResult = patchSystemNatsPort(systemConfigPath(opts.configDir, opts.slug), opts.natsPort);
      lines.push(
        `  ✓ system/system.yaml ${systemResult.changed ? `patched (nats.url port → ${opts.natsPort})` : "already up to date (skip)"}`,
      );
    } catch (err) {
      lines.push(`  ✗ system/system.yaml patch failed: ${errMsg(err)}`);
      ok = false;
    }
  } else {
    lines.push("  ✓ system/system.yaml nats.url — CTX_NATS_PORT is the default (4222); no patch needed");
  }

  return step("5. Patch configs from env", ok, lines);
}

// =============================================================================
// Step 5 (web) — scaffold the web surface binding (cortex#2153)
// =============================================================================

/**
 * The web analogue of {@link runPatchConfigs}. Instead of patching Discord
 * values into the scaffold's `<REPLACE_ME>` slots, it REWRITES surfaces.yaml
 * to a single `web:` binding (the scaffold's discord binding can't survive a
 * web deployment — see quickstart-lib's web-scaffold section), then applies
 * the SAME shared `system/system.yaml` nats-port patch the discord path does.
 * It does NOT patch `stacks/<slug>.yaml` — a web deployment has no principal
 * discordId to set (the scaffold's `<REPLACE_ME>` discord placeholders are
 * inert with no discord surface bound).
 *
 * `token` is read from `process.env` at the call site (never stored) — same
 * secret hygiene the discord token gets.
 */
function runPatchConfigsWeb(opts: {
  slug: string;
  principal: string;
  configDir: string;
  natsPort: string;
  host: string;
  port: string;
  token: string;
}): StepReport {
  const lines: string[] = [];
  let ok = true;

  const surfacesPath = surfacesConfigPath(opts.configDir, opts.slug);
  // The agent id the scaffold wrote (default "assistant", or whatever
  // `--agent` a prior scaffold used). Read it off the file rather than
  // duplicating stack.ts's default, and prefer the web entry so a re-run reads
  // the already-rewritten file.
  const agent = readSurfaceAgent(surfacesPath);
  if (agent === undefined) {
    return step("5. Patch configs from env", false, [
      `  ✗ surfaces/surfaces.yaml: could not read the scaffolded agent id — not the shape \`cortex stack create\` writes`,
    ]);
  }

  try {
    const surfacesResult = writeWebSurfacesYaml(surfacesPath, {
      agent,
      stack: `${opts.principal}/${opts.slug}`,
      instanceId: opts.slug,
      host: opts.host,
      port: opts.port,
      token: opts.token,
    });
    lines.push(
      `  ✓ surfaces/surfaces.yaml ${surfacesResult.changed ? "written (web binding — token set, never echoed)" : "already up to date (skip)"}`,
    );
    // FS-7 discipline: compose the WHOLE config through the daemon's boot
    // validator so a broken web binding is caught at write time, not boot.
    if (surfacesResult.changed) {
      const validation = validateConfigLoads(pointerConfigPath(opts.configDir, opts.slug));
      if (!validation.ok) {
        lines.push(`  ✗ surfaces/surfaces.yaml written, but the composed config failed validation:`);
        for (const e of validation.errors) lines.push(`    ${e}`);
        ok = false;
      }
    }
  } catch (err) {
    lines.push(`  ✗ surfaces/surfaces.yaml web write failed: ${errMsg(err)}`);
    ok = false;
  }

  // system/system.yaml's nats.url — IDENTICAL shared logic to the discord path.
  if (opts.natsPort !== "4222") {
    try {
      const systemResult = patchSystemNatsPort(systemConfigPath(opts.configDir, opts.slug), opts.natsPort);
      lines.push(
        `  ✓ system/system.yaml ${systemResult.changed ? `patched (nats.url port → ${opts.natsPort})` : "already up to date (skip)"}`,
      );
    } catch (err) {
      lines.push(`  ✗ system/system.yaml patch failed: ${errMsg(err)}`);
      ok = false;
    }
  } else {
    lines.push("  ✓ system/system.yaml nats.url — CTX_NATS_PORT is the default (4222); no patch needed");
  }

  return step("5. Patch configs from env", ok, lines);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// =============================================================================
// Step 6 — seed provisioning
// =============================================================================

function runSeedProvisioning(ports: QuickstartPorts, opts: { slug: string; configDir: string }): StepReport {
  const nkeyBasename = nkeyBasenameForSlug(opts.slug);
  const result = ports.provision.provisionSeed(stackAgentConfigPath(opts.configDir, opts.slug), nkeyBasename);
  // scripts/lib/stack-identity-provision.sh is documented best-effort (its
  // own header: "Exit code: always 0") — a non-zero here means the SHELL
  // invocation itself failed (bash missing, the script unreadable), not a
  // provisioning outcome. Either way this step never blocks progression to
  // services/gate: an unsigned stack still boots (with a boot-time WARNING),
  // which is exactly the degrade path the script itself documents.
  const lines = result.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => `  ${l.trim()}`);
  if (result.exitCode !== 0) {
    lines.push(`  ⚠ provisioning script exited ${String(result.exitCode)} — continuing (stack will boot unsigned)`);
    if (result.stderr.trim().length > 0) lines.push(`    ${result.stderr.trim()}`);
  }
  return step("6. Seed provisioning", true, lines.length > 0 ? lines : ["  ✓ nothing to do"]);
}

// =============================================================================
// Step 7 — services (Linux: systemd; darwin: launchd restart-only)
// =============================================================================

/**
 * cortex#2264 / cortex#2282 / cortex#2283 — clear BOTH of the daemon's
 * append-mode log files (`.log` + `.error.log`) so step 8's gate only ever
 * sees CURRENT-boot content in EITHER file. Both stale directions poison the
 * gate (systemd `append:` and launchd `Std{Out,Error}Path` never truncate):
 *   - a stale `.error.log` failure line from a PRIOR boot fast-fails the gate
 *     before the fresh daemon connects — breaking "fix creds and re-run"
 *     recovery (cortex#2264);
 *   - stale HEALTHY lines in the prior boot's `.log` satisfy the gate's
 *     POSITIVE signal — try-restart/kickstart succeed at fork time regardless
 *     of whether the relaunched daemon survives, so a daemon that dies on a
 *     still-broken config would leave the old 5 healthy lines standing and
 *     turn the gate green over a dead daemon (cortex#2283 adversarial review
 *     F1).
 * Best-effort (the port swallows fs errors). A truncate is ONLY safe paired
 * atomically with a (re)start — truncate → restart → gate — otherwise it
 * destroys the current-boot evidence the gate depends on. Both callers honor
 * that pairing: the Linux branch calls it immediately before its
 * `enable --now` + per-unit `try-restart`, and the darwin branch immediately
 * before its `launchctl kickstart -k` — and ONLY when the service is loaded
 * (no restart → no truncate). Returns the human-readable step line.
 */
function clearPriorBootLogs(ports: QuickstartPorts, slug: string): string {
  const home = process.env.HOME ?? "";
  const logPath = daemonLogPath(home, slug);
  const errorLogPath = daemonErrorLogPath(home, slug);
  ports.service.truncateLog(logPath);
  ports.service.truncateLog(errorLogPath);
  return `  ✓ cleared prior-boot logs (${logPath}, ${errorLogPath})`;
}

function runServices(
  ports: QuickstartPorts,
  opts: { slug: string; configDir: string; skip: boolean },
): StepReport {
  if (opts.skip) {
    return step("7. Services", true, ["  ○ --skip-services passed — skipping"]);
  }
  if (process.platform === "linux") {
    return runServicesLinux(ports, opts.slug);
  }
  if (process.platform === "darwin") {
    // cortex#2322 — the darwin branch needs the pointer config path (for the
    // fresh-host `cortex start --config <pointer>` backstop + its pidfile
    // running-probe), not just the slug.
    return runServicesDarwin(ports, opts.slug, pointerConfigPath(opts.configDir, opts.slug));
  }
  return step("7. Services", true, ["  ○ non-Linux host — launchd is handled by arc; skip"]);
}

function runServicesLinux(ports: QuickstartPorts, slug: string): StepReport {
  const lines: string[] = [];
  const units = [`nats@${slug}`, `cortex@${slug}`];

  // L1 (cortex#2071) REQUIRED, not re-implemented here — an install without
  // it has no template units to enable an instance of.
  const natsUnit = ports.service.unitFileExists("nats@.service");
  const cortexUnit = ports.service.unitFileExists("cortex@.service");
  if (!natsUnit || !cortexUnit) {
    // The actual check above reads via ports.service.unitFileExists(), whose
    // live adapter (quickstart-adapters.ts's systemdUserUnitDir()) resolves
    // the real path off homedir()+join() — this string is a human-facing
    // diagnostic only, never a runtime path.
    lines.push("  ✗ systemd template units not found under ~/.config/systemd/user/"); // xdg-audit:allow(user-facing diagnostic naming the canonical systemd user-unit dir — not a runtime path write; cortex#2094)
    lines.push(
      "    quickstart REQUIRES cortex#2071 (L1) — run `arc install`/`arc upgrade cortex` first to render nats@.service + cortex@.service",
    );
    return step("7. Services", false, lines);
  }

  const reload = ports.service.daemonReload();
  if (reload.exitCode !== 0) {
    lines.push(`  ✗ systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
    return step("7. Services", false, lines);
  }
  lines.push("  ✓ systemctl --user daemon-reload");

  // cortex#2283 — per-unit PRE-start run-state probe. It selects which units
  // get try-restart below AND names the per-unit action taken. This is
  // run-state selection, NOT the out-of-scope config-changed detection: every
  // probed-active unit is restarted unconditionally on every re-run.
  const activeUnits = units.filter((u) => ports.service.isActive(u));
  const inactiveUnits = units.filter((u) => !activeUnits.includes(u));

  // cortex#2264 / cortex#2283 — pair-truncate BOTH append-mode daemon logs
  // IMMEDIATELY before the (re)start (see clearPriorBootLogs above), so step
  // 8's gate only ever sees CURRENT-boot content in either file.
  lines.push(clearPriorBootLogs(ports, slug));

  const enable = ports.service.enableNow(units);
  if (enable.exitCode !== 0) {
    lines.push(`  ✗ systemctl --user enable --now ${units.join(" ")} failed: ${enable.stderr.trim()}`);
    return step("7. Services", false, lines);
  }
  lines.push(`  ✓ systemctl --user enable --now ${units.join(" ")}`);

  // cortex#2283 — `enable --now` STARTS stopped units but is a silent no-op
  // on ACTIVE ones (`--now` = `start`), so a recovery re-run never picked up
  // fixed configs. try-restart the PROBED-ACTIVE units only: they are exactly
  // the ones enable --now skipped. Never the probed-inactive ones —
  // enable --now just started those, and restarting the fresh instance
  // mid-bus-connect would land its one-shot `failed to connect` marker in the
  // just-truncated `.error.log` and fast-fail the gate on a healthy system
  // (adversarial review F2 — the issue spec's unconditional try-restart was
  // wrong on this point).
  if (activeUnits.length > 0) {
    const restart = ports.service.tryRestart(activeUnits);
    if (restart.exitCode !== 0) {
      lines.push(`  ✗ systemctl --user try-restart ${activeUnits.join(" ")} failed: ${restart.stderr.trim()}`);
      return step("7. Services", false, lines);
    }
    lines.push(`  ✓ systemctl --user try-restart ${activeUnits.join(" ")}`);
  }

  // Output honesty (per unit): only units that were actually running are
  // reported restarted; cold ones were started by enable --now.
  const actions: string[] = [];
  if (activeUnits.length > 0) actions.push(`restarted (config re-applied): ${activeUnits.join(" ")}`);
  if (inactiveUnits.length > 0) actions.push(`started (first boot): ${inactiveUnits.join(" ")}`);
  for (const a of actions) lines.push(`  ✓ ${a}`);
  return { ...step("7. Services", true, lines), note: actions.join("; ") };
}

/**
 * darwin branch. arc owns the launchd load/unload lifecycle; quickstart never
 * takes that over. Two paths, split on whether arc has ALREADY loaded the
 * stack service (`launchctl print gui/$UID/<label>` exit 0):
 *
 *   - LOADED (cortex#2283) — an arc-managed install: `launchctl kickstart -k`
 *     restarts it so the daemon picks up the configs step 5 patched, with the
 *     both-logs truncate paired IMMEDIATELY before it (truncate → restart →
 *     gate, same ordering contract as Linux).
 *
 *   - NOT LOADED (cortex#2322) — a FRESH Mac: the pre-#2322 code just SKIPPED
 *     here ("handled by arc"), leaving the daemon down so Step 8's gate could
 *     only ever time out — the backstop was a printed hint, never a tested
 *     path. Now the not-loaded path STARTS the daemon directly via a detached
 *     `cortex start --config <pointer>` backstop (the exact command the
 *     luna-stack bundle + runbook §F2 document), so the gate reaches a RUNNING
 *     daemon. Idempotent: a re-run probes the pointer's pidfile
 *     (`daemonBackstopRunning`) and skips cleanly when the backstop daemon is
 *     already up — no double-start, no truncate (a truncate is only ever
 *     paired with an actual (re)start; an unpaired truncate would wipe
 *     current-boot evidence and false-GREEN the gate — A1/#2297). The start is
 *     paired with the both-logs truncate exactly as the loaded path is.
 *
 * NOTE (idempotency limit, documented): the not-loaded backstop path does NOT
 * restart an already-running backstop daemon to re-apply a config edit (unlike
 * the launchd kickstart path). Picking up a changed config on the backstop
 * daemon needs an explicit `cortex stop && cortex start --config <pointer>`
 * (runbook §"Stopping / restarting the stack"). The fresh-host FIRST run — the
 * cortex#2322 release gate — reaches a running daemon; re-run safety is a clean
 * no-op, never a crash or duplicate.
 */
function runServicesDarwin(ports: QuickstartPorts, slug: string, pointerPath: string): StepReport {
  const label = launchdStackLabel(slug);

  // --- NOT LOADED: fresh-Mac backstop (cortex#2322) --------------------------
  if (!ports.service.launchdServiceLoaded(label)) {
    // Idempotency guard: a prior quickstart run's backstop daemon is not a
    // launchd service (launchdServiceLoaded stays false for it), so gate on
    // the pointer's pidfile instead. Already running → clean skip.
    if (ports.service.daemonBackstopRunning(pointerPath)) {
      const action = "skip (not loaded; cortex daemon already running — backstop)";
      return {
        ...step("7. Services", true, [
          `  ○ launchd not loaded (arc owns load); cortex daemon already running — skip`,
        ]),
        note: action,
      };
    }

    const lines: string[] = [];
    // Paired atomically with the backstop start below (truncate → start →
    // gate) — never reached on the already-running skip above.
    lines.push(clearPriorBootLogs(ports, slug));

    const home = process.env.HOME ?? "";
    const started = ports.service.startDaemonBackstop({
      pointerConfigPath: pointerPath,
      logPath: daemonLogPath(home, slug),
      errorLogPath: daemonErrorLogPath(home, slug),
    });
    if (started.exitCode !== 0) {
      // Fail the step (exit 1, gate never runs): the truncate above already
      // wiped any prior boot's logs, so letting the gate run against a daemon
      // we FAILED to launch could only time out dishonestly. Failing here
      // keeps the truncate → start → gate pairing honest.
      lines.push(`  ✗ cortex start --config <pointer> backstop failed: ${started.stderr.trim()}`);
      return step("7. Services", false, lines);
    }
    lines.push(`  ✓ cortex start --config ${pointerPath} (detached backstop)`);
    const action = "started (fresh host — cortex start backstop)";
    lines.push(`  ✓ ${action}`);
    return { ...step("7. Services", true, lines), note: action };
  }

  // --- LOADED: arc-managed install, restart to re-apply (cortex#2283) --------
  const lines: string[] = [];
  // Paired atomically with the kickstart below — never called on the
  // not-loaded paths above.
  lines.push(clearPriorBootLogs(ports, slug));

  const restart = ports.service.launchdKickstart(label);
  if (restart.exitCode !== 0) {
    // Fail the step (exit 1, gate never runs): the truncate above already
    // wiped the prior boot's logs, so letting the gate run against a daemon
    // we FAILED to restart could only ever time out dishonestly — the daemon
    // that IS running was never re-pointed at the fixed config. Failing here
    // keeps the truncate → restart → gate pairing honest.
    lines.push(`  ✗ launchctl kickstart -k gui/$UID/${label} failed: ${restart.stderr.trim()}`);
    return step("7. Services", false, lines);
  }
  lines.push(`  ✓ launchctl kickstart -k gui/$UID/${label}`);

  const action = "restarted (config re-applied)";
  lines.push(`  ✓ ${action}`);
  return { ...step("7. Services", true, lines), note: action };
}

// =============================================================================
// Step 8 — healthy-boot gate
// =============================================================================

async function runGate(
  ports: QuickstartPorts,
  opts: { slug: string; monitorPort: string; timeoutMs: number; skip: boolean; skipGate: boolean },
): Promise<StepReport> {
  // --skip-gate (cortex#2275): the gate is deliberately DEFERRED to the
  // supervisor's healthcheck (the compose cortex-service healthcheck in the L4
  // container). Short-circuit BEFORE any ports.gate call — no log-grep, no
  // /healthz probe, no wall-clock wait — and report an explicit skip so the
  // provisioning output is green when provisioning succeeded, with the
  // deferral visible (`skipped`/`note` in --json) rather than an
  // expected-error status:error envelope.
  if (opts.skipGate) {
    return {
      ...step("8. Healthy-boot gate", true, [
        "  ○ --skip-gate passed — deferred to supervisor healthcheck",
      ]),
      skipped: true,
      note: "deferred to supervisor healthcheck",
    };
  }
  // Container mode (cortex#2155): the daemon isn't up yet (the entrypoint
  // `exec cortex start`s it only AFTER quickstart returns), so the gate could
  // never pass — it would only burn the whole poll window before failing.
  // Short-circuit BEFORE any ports.gate call: no log-grep, no /healthz probe,
  // no wall-clock wait. Reported as an explicit skip (ok), mirroring step 7's
  // --skip-services convention.
  if (opts.skip) {
    return step("8. Healthy-boot gate", true, [
      "  ○ --container passed — skipping healthy-boot gate (container health is compose restart: + nats healthcheck)",
    ]);
  }
  const home = process.env.HOME ?? "";
  const logPath = daemonLogPath(home, opts.slug);
  // cortex#2264 — the bus-connect failure the daemon logs on a dead bus is a
  // `console.error`, so it lands in the `.error.log` SIBLING, NEVER the `.log`
  // the healthy-boot gate greps. Poll it too and FAIL FAST (surfacing the real
  // error) instead of silently waiting out the whole timeout window.
  const errorLogPath = daemonErrorLogPath(home, opts.slug);
  const healthzUrl = `http://127.0.0.1:${opts.monitorPort}/healthz`;
  const deadline = ports.gate.now() + opts.timeoutMs;

  for (;;) {
    const logText = ports.gate.readLog(logPath);
    const gateLines = evaluateHealthyBootGate(logText);
    const healthzOk = await ports.gate.fetchHealthz(healthzUrl, 3_000);
    if (gatePassed(gateLines, healthzOk)) {
      return step("8. Healthy-boot gate", true, [renderGateTable(gateLines, healthzOk)]);
    }
    // cortex#2264 — a surfaced bus-connect failure is TERMINAL for this boot:
    // fail fast with the actual error line rather than burning the full
    // timeout. This is safe on the FIRST poll (before success is logged)
    // because step 7 pair-truncated BOTH append-mode logs (`.log` +
    // `.error.log`) AND (re)started the daemon right before the gate — Linux
    // via enable --now + per-unit try-restart, darwin via launchctl
    // kickstart -k when the service is loaded (cortex#2283) — so any line in
    // EITHER file is from THIS boot: no stale prior-boot failure can
    // fast-fail here, and no stale prior-boot HEALTHY lines can satisfy the
    // positive gate over a daemon that died on relaunch (review F1).
    // Residual: on darwin with the service NOT loaded
    // (arc owns the load; quickstart neither restarts nor truncates), a stale
    // prior-boot line can still fast-fail here — conservative-honest: with no
    // loaded daemon the gate could never turn green anyway, and the stale
    // line names the last real failure. SCOPE: surface + fast-fail only — the
    // daemon still degrades and continues (its fail-closed-abort posture is a
    // separate, deferred call).
    const busFailure = detectBusConnectFailure(ports.gate.readLog(errorLogPath));
    if (busFailure !== undefined) {
      return step("8. Healthy-boot gate", false, [
        renderGateTable(gateLines, healthzOk),
        `  ✗ bus connect FAILED — the daemon could not reach NATS (surfaced from ${errorLogPath}):`,
        `    ${busFailure}`,
        `  (failing fast — not waiting out the ${String(opts.timeoutMs)}ms gate; fix the bus/creds and re-run)`,
      ]);
    }
    if (ports.gate.now() >= deadline) {
      return step("8. Healthy-boot gate", false, [
        renderGateTable(gateLines, healthzOk),
        `  (timed out after ${String(opts.timeoutMs)}ms waiting on ${logPath})`,
      ]);
    }
    await ports.gate.sleep(GATE_POLL_INTERVAL_MS);
  }
}

// =============================================================================
// Orchestrator
// =============================================================================

export async function dispatchQuickstart(
  argv: string[],
  // cortex#2094 — injectable ports factory so quickstart's CLI tests drive
  // fake preflight/service/provision/gate ports (no real systemctl/loginctl/
  // claude spawn, no real HTTP, no real wall-clock wait). Production omits
  // it → the live adapters.
  portsFactory: QuickstartPortsFactory = DEFAULT_QUICKSTART_PORTS_FACTORY,
): Promise<ExitResult> {
  let flags: QuickstartFlags;
  try {
    flags = parseQuickstartArgs(argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: 2, stdout: "", stderr: `cortex quickstart: ${err.message}\n${topLevelHelp()}` };
    }
    throw err;
  }

  if (flags.help) {
    return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
  }

  const ports = portsFactory();
  // Expand a leading `~` in BOTH the default and any user-supplied flag: these
  // dirs flow into path.join (natsConfPath) and into the rendered nats.conf
  // `store_dir` — neither path.join nor nats-server expands `~`, so an
  // unexpanded default wrote a LITERAL `~/.config/nats` dir under cwd and a
  // store_dir nats-server could not use (cortex#2229). Mirrors `cortex stack
  // create` (stack.ts), which already expandTilde's these.
  const configDir = expandTilde(flags.configDir ?? resolveConfigDir());
  const natsDir = expandTilde(flags.natsDir ?? "~/.config/nats");
  const reports: StepReport[] = [];

  // --- 1. Preflight ----------------------------------------------------------
  const preflight = runPreflight(ports);
  reports.push(preflight);
  if (!preflight.ok) {
    return finish(reports, 1, flags.json);
  }

  // --- 2. Validate env contract ------------------------------------------------
  // cortex#2153 — the contract is surface-specific: `discord` (default)
  // validates the snowflake contract; `web` validates host/port/token.
  const env = runEnvValidation(flags.surface);
  reports.push(env.report);
  if (!env.ok || env.shared === undefined) {
    return finish(reports, 2, flags.json);
  }
  const s = env.shared;

  // --- 3. nats conf ------------------------------------------------------------
  const natsConfReport = runNatsConf({
    slug: s.slug,
    principal: s.principal,
    port: s.natsPort,
    monitorPort: s.natsMon,
    natsDir,
    force: flags.force,
  });
  reports.push(natsConfReport);
  if (!natsConfReport.ok) {
    return finish(reports, 1, flags.json);
  }

  // --- 4. Scaffold ---------------------------------------------------------
  // cortex#2331 (7a) — OPTIONAL: naming one repo via CTX_REPO scaffolds a
  // software-factory ("code") stack — the agent declares the `code` capability
  // and gets a repo-scoped git-write + gh-pr bash allowlist (least-privilege,
  // one repo). This is the luna-stack MVP path ("read+write access scoped to
  // one repo you name"). Absent ⇒ a chat-only stack (unchanged). A malformed
  // value is rejected by `cortex stack create --repo` (surfaced as a step fail).
  const ctxRepo = (process.env.CTX_REPO ?? "").trim();
  const scaffoldReport = await runScaffold({
    slug: s.slug,
    principal: s.principal,
    configDir,
    ...(ctxRepo.length > 0 ? { grantedRepo: ctxRepo } : {}),
  });
  reports.push(scaffoldReport);
  if (!scaffoldReport.ok) {
    return finish(reports, 1, flags.json);
  }

  // --- 5. Patch configs from env ---------------------------------------------
  // process.env access for the surface's secret token happens HERE ONLY, scoped
  // to this one call — never stored in a variable that a later step's log line
  // could accidentally interpolate.
  let patchReport: StepReport;
  if (flags.surface === "web" && env.web !== undefined) {
    const w = env.web;
    patchReport = runPatchConfigsWeb({
      slug: s.slug,
      principal: s.principal,
      configDir,
      natsPort: s.natsPort,
      host: w.CTX_WEB_HOST,
      port: w.CTX_WEB_PORT,
      token: process.env.CTX_WEB_TOKEN ?? "",
    });
  } else if (env.discord !== undefined) {
    const d = env.discord;
    patchReport = runPatchConfigs({
      slug: s.slug,
      principal: s.principal,
      configDir,
      natsPort: s.natsPort,
      discordToken: process.env.CTX_DISCORD_TOKEN ?? "",
      guildId: d.CTX_GUILD_ID,
      channelId: d.CTX_CHANNEL_ID,
      logChannelId: d.CTX_LOG_CHANNEL_ID,
      myDiscordId: d.CTX_MY_DISCORD_ID,
    });
  } else {
    // Unreachable: `env.ok` guarantees the surface's typed values are set.
    return finish(reports, 2, flags.json);
  }
  reports.push(patchReport);
  if (!patchReport.ok) {
    return finish(reports, 1, flags.json);
  }

  // --- 6. Seed provisioning ---------------------------------------------------
  const provisionReport = runSeedProvisioning(ports, { slug: s.slug, configDir });
  reports.push(provisionReport);

  // --- 7. Services -------------------------------------------------------------
  const servicesReport = runServices(ports, { slug: s.slug, configDir, skip: flags.skipServices });
  reports.push(servicesReport);
  if (!servicesReport.ok) {
    return finish(reports, 1, flags.json);
  }

  // --- 8. Healthy-boot gate -----------------------------------------------------
  const gateReport = await runGate(ports, {
    slug: s.slug,
    monitorPort: s.natsMon,
    timeoutMs: flags.gateTimeoutMs,
    skip: flags.container,
    skipGate: flags.skipGate,
  });
  reports.push(gateReport);
  if (!gateReport.ok) {
    return finish(reports, 1, flags.json);
  }

  return finish(reports, 0, flags.json);
}

function finish(reports: StepReport[], exitCode: number, json: boolean): ExitResult {
  if (json) {
    const allOk = reports.every((r) => r.ok);
    const envelope = allOk
      ? envelopeOk(
          // cortex#2275 — a deliberately-skipped step (e.g. --skip-gate) carries
          // `skipped: "true"` + a short `note`, so the JSON trace distinguishes
          // "verified ok" from "deferred". Non-skipped items are byte-identical
          // to the pre-#2275 shape.
          reports.map((r) => ({
            step: r.name,
            ok: "true",
            ...(r.skipped === true ? { skipped: "true" } : {}),
            ...(r.note !== undefined ? { note: r.note } : {}),
          })),
          {},
        )
      : envelopeError(
          reports.find((r) => !r.ok)?.name ?? "unknown step failed",
          { steps: JSON.stringify(reports.map((r) => ({ step: r.name, ok: r.ok }))) },
        );
    return { exitCode, stdout: renderJson(envelope), stderr: "" };
  }
  const text = renderReport(reports);
  return exitCode === 0
    ? { exitCode, stdout: `${text}cortex quickstart: complete ✓\n`, stderr: "" }
    : { exitCode, stdout: text, stderr: "" };
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex quickstart — env-contract driven one-command first install (cortex#2094, L3)

Usage:
  set -a; . ./cortex.env; set +a; cortex quickstart [options]

Runs the validated Debian runbook (README-AGENTS.md Appendix A + §5) as ONE
idempotent command: preflight → validate env → nats conf → scaffold → patch
configs from env → seed provisioning → services → healthy-boot gate.

Requires (env) — the SHARED keys, both surfaces: CTX_PRINCIPAL, CTX_SLUG,
CTX_NATS_PORT, CTX_NATS_MON. Optional: CLAUDE_CODE_OAUTH_TOKEN (native hosts
with an existing \`claude\` login don't need it). Then, per --surface:
  discord (default): CTX_GUILD_ID, CTX_CHANNEL_ID, CTX_LOG_CHANNEL_ID,
                     CTX_MY_DISCORD_ID, CTX_DISCORD_TOKEN.
  web:               CTX_WEB_HOST, CTX_WEB_PORT, CTX_WEB_TOKEN (no Discord
                     snowflakes — scaffolds a \`web:\` surfaces binding instead).

Flags:
  --surface <discord|web> Which surface to provision (default: discord).
                          \`web\` validates a host/port/token contract and
                          scaffolds a \`web:\` binding; \`discord\` validates the
                          snowflake contract and patches a discord binding. The
                          NATS-identity + stack scaffold is shared (cortex#2153).
  --config-dir <path>     Config dir (default: the resolved cortex config dir).
  --nats-dir <path>       NATS material dir (default: ~/.config/nats).
  --force                 Allow step 3 to overwrite a DIFFERENT existing
                          .conf file (default: refuse).
  --skip-services         Skip step 7 (systemd) entirely — for CI/tests
                          without a systemd host.
  --skip-gate             Skip step 8 (healthy-boot gate) and report it as
                          DEFERRED (cortex#2275): step 8 shows ok + skipped
                          ("deferred to supervisor healthcheck") and quickstart
                          exits 0 when steps 1–7 pass. For supervised
                          deployments (the L4 container entrypoint) where the
                          daemon starts only AFTER quickstart returns and the
                          supervisor's healthcheck owns post-start health.
                          Does NOT imply --skip-services.
  --container             L4 container mode (cortex#2155): skip step 8's
                          healthy-boot gate and return after step 7. Implies
                          --skip-services. In the split-container model the
                          daemon starts only AFTER quickstart returns
                          (\`exec cortex start\`), so the gate could never pass —
                          it would only add ~60s of stall then fail. The
                          container's real health signal is compose \`restart:\`
                          + the nats healthcheck. Step 8 is reported as an
                          explicit skip (ok) rather than run.
  --gate-timeout-ms <n>   Step 8's bounded wait (default: ${String(DEFAULT_GATE_TIMEOUT_MS)}).
  --json                  Emit a { status, items, data, error } envelope.

Requires cortex#2071 (L1 — systemd unit rendering) merged; declared as a hard
dependency, checked (not re-implemented) in step 7.

Secret hygiene: CTX_DISCORD_TOKEN / CLAUDE_CODE_OAUTH_TOKEN values are NEVER
printed — every report shows only "set" / "missing" for those two keys.
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchQuickstart(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
