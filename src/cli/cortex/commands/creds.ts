#!/usr/bin/env bun
/**
 * `cortex creds <subcommand>` — manage per-agent NATS user credentials.
 *
 * cortex#79 — arc-delegated implementation. Mutation subcommands shell out
 * to `arc nats … --json` (schema `arc.nats.v1`, contract pinned at
 * the-metafactory/arc:docs/integrations/cortex-creds.md). arc owns nsc and
 * the principal's $SYS account; cortex stays a thin delegator with no
 * signing-key handling of its own. Supersedes the cortex#67 daemon-IPC
 * implementation (deleted in this same PR).
 *
 * Verb mapping (cortex → arc):
 *   issue  <id>  → arc nats add-bot     <id> [--account <name>] --json
 *   rotate <id>  → arc nats reissue-bot <id> [--account <name>] --json
 *   revoke <id>  → arc nats remove-bot  <id> [--account <name>] --delete-creds --json
 *   list         — local filesystem scan, unchanged.
 *
 * Usage:
 *   bun src/cli/cortex/commands/creds.ts list   [--creds-dir <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts issue  <agent-id> [--account <name>] [--json]
 *   bun src/cli/cortex/commands/creds.ts revoke <agent-id> [--account <name>] [--json]
 *   bun src/cli/cortex/commands/creds.ts rotate <agent-id> [--account <name>] [--json]
 *   bun src/cli/cortex/commands/creds.ts --help
 *
 * Exit codes:
 *   0  — success (incl. idempotent USER_NOT_FOUND on revoke)
 *   1  — arc reported ok=false, arc binary missing, or contract drift
 *   2  — usage error (bad flag, bad agent id, missing positional)
 */

import { existsSync, lstatSync, readdirSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { expandTilde } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import {
  materialFromSeedString,
  randomNonce,
  signClaimWithSeed,
  type StackIdentityMaterial,
} from "../../../bus/stack-provisioning";
import { canonicalJSON } from "../../../common/registry/signing";
import { assignRole, resolveRoleId } from "../../discord/lib/discord";
import { loadConfig as loadDiscordConfig } from "../../discord/lib/config";
import { resolveServerContext } from "../../discord/lib/server-context";
import { CliArgsError, MissingPositionalError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { assertExhaustive } from "./_shared/assert-exhaustive";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";
import { boolFlag, listFlag, valueFlag } from "./_shared/hydrate";

// =============================================================================
// Types
// =============================================================================

export interface ParsedCredsArgs {
  subcommand: "list" | "issue" | "revoke" | "rotate" | "grant" | "help" | "unknown";
  rawSubcommand: string;
  agentId: string | undefined;
  credsDir: string | undefined;
  /** NSC operator account name passed through as `arc nats … --account <name>`.
   *  Optional; when absent, arc resolves the account via nsc env. */
  account: string | undefined;
  /** Per-bot publish subject scope for `issue` (cortex#1057). Repeatable at
   *  the surface; joined comma-separated into arc's single `--pub` flag.
   *  Empty when omitted — the safe default scope is applied in that case. */
  pub: string[];
  /** Per-bot subscribe subject scope for `issue` (cortex#1057). Same shape +
   *  semantics as `pub`. The subscribe scope is the load-bearing isolation
   *  boundary in ADR-0012's shared-account default. */
  sub: string[];
  json: boolean;
  help: boolean;
  // G2 — grant subcommand fields (optional so existing partial-args tests keep compiling)
  /** G2: request-id positional for `grant`. */
  requestId?: string | undefined;
  /** G2: path to admin nkey seed file (chmod-600 gated). */
  adminSeed?: string | undefined;
  /** G2: registry base URL (defaults to prod). */
  registryUrl?: string | undefined;
  /** G2: NATS subject scope override (e.g. "federated.echo.>"). Space-separated
   *  multi-subject is accepted; defaults to the request's requested_scope. */
  scope?: string | undefined;
  /** G2: NSC operator JWT (for assembling the leaf package). */
  operatorJwt?: string | undefined;
  /** G2: Discord member id (snowflake) for the O-5 role admit. Optional. */
  discordMember?: string | undefined;
  /** G2: Discord server profile name (from discord cli.yaml) for role resolution. */
  discordServer?: string | undefined;
  /** G2: Discord guild id override (wins over profile). */
  discordGuild?: string | undefined;
  /** G2: Discord role name to assign (default: community-fleet). */
  discordRole?: string | undefined;
  /** G2: dry-run flag (default true — pass --apply to mutate). */
  dryRun?: boolean;
  /** G2: explicit --apply flag. */
  apply?: boolean;
}

export { type ExitResult } from "./_shared/exit-result";

/** Per-creds-file metadata returned in the JSON envelope's `items` array
 *  for `list`. Mutation subcommands embed arc-supplied fields in the
 *  envelope's `data` map instead (creds_path, pub key, etc.). */
export interface CredsItem {
  id: string;
  path: string;
  issuedAt: string;
}

const AGENT_ID_REGEX = /^[a-z0-9-]+$/;
const DEFAULT_CREDS_DIR = "~/.config/nats/creds";

/**
 * Safe-default subject scope applied on `issue` when `--pub`/`--sub` are
 * omitted (cortex#1057, ADR-0012 D1). The per-bot subject scope IS the
 * isolation boundary in the shared `community` account: an UNSCOPED bot
 * could subscribe `federated.>` (everyone) — the exact cross-principal leak
 * the shared-account default must prevent. So rather than issue unscoped,
 * we default to the bot's own federated namespace plus its inbox.
 *
 * `{id}` is the (already regex-validated `/^[a-z0-9-]+$/`) agent id, so the
 * interpolated subject is always a legal NATS token — no injection surface.
 */
function defaultScopeFor(agentId: string): string[] {
  return [`federated.${agentId}.>`, "_INBOX.>"];
}

/**
 * Normalize a `--pub`/`--sub` value list the same way arc will (cortex#1057
 * NIT-1): trim each entry and drop empties. arc does `split(",").map(trim)`
 * after we comma-join, so a whitespace-padded `" federated.> "` would
 * otherwise survive cortex verbatim and be un-padded by arc back into the
 * everyone-scope `federated.>`. Trimming here keeps cortex's view of "the
 * scope" identical to arc's, so the empty-check (→ safe default) and any
 * future cortex-side validation see the real subjects.
 */
function sanitizeScope(values: string[]): string[] {
  return values.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A multi-thousand-entry creds directory is a misconfiguration; refuse
 *  to enumerate rather than allocate unbounded memory. */
const MAX_CREDS_DIR_ENTRIES = 10_000;

/** Schema string emitted by `arc nats … --json` (arc#134). Bump only if
 *  arc ever ships `arc.nats.v2`. */
const ARC_NATS_SCHEMA_V1 = "arc.nats.v1";

/** Minimum arc version that ships the stable `--json` contract this CLI
 *  depends on. Surfaced in errors when the arc binary is missing or the
 *  schema check fails. Also pinned in cortex's arc-manifest.yaml. */
export const MIN_ARC_VERSION = "0.25.0";

/** Closed-set arc error codes per `arc:docs/integrations/cortex-creds.md`. */
export type ArcErrorCode =
  | "NSC_NOT_INSTALLED"
  | "USER_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PUSH_FAILED"
  | "REVOKE_FAILED"
  | "VALIDATION_ERROR"
  | "INVALID_USER_KEY"
  | "ROLLBACK_FAILED"
  | "UNKNOWN";

interface ArcEnvelopeError {
  schema: typeof ARC_NATS_SCHEMA_V1;
  ok: false;
  // ArcErrorCode literal union widens to `string` to allow forward-compat
  // codes from arc; the literal members document the known set.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  error: { code: ArcErrorCode | string; message: string };
}

interface ArcEnvelopeAddBot {
  schema: typeof ARC_NATS_SCHEMA_V1;
  ok: true;
  bot: string;
  account: string;
  credsPath: string;
  jwt: string;
  pubKey: string;
}

interface ArcEnvelopeReissueBot {
  schema: typeof ARC_NATS_SCHEMA_V1;
  ok: true;
  bot: string;
  account: string;
  credsPath: string;
  newPubKey: string;
  revokedPubKey: string;
}

interface ArcEnvelopeRemoveBot {
  schema: typeof ARC_NATS_SCHEMA_V1;
  ok: true;
  bot: string;
  account: string;
  revokedPubKey: string;
  credsFileDeleted: boolean;
}

type ArcEnvelope =
  | ArcEnvelopeError
  | ArcEnvelopeAddBot
  | ArcEnvelopeReissueBot
  | ArcEnvelopeRemoveBot;

// =============================================================================
// parseCredsArgs
// =============================================================================

const CREDS_SPEC: SubcommandSpec<"list" | "issue" | "revoke" | "rotate" | "grant"> = {
  cliName: "creds",
  subcommands: {
    list: { flags: { "--creds-dir": "value" } },
    issue: {
      positionals: ["agent-id"],
      flags: {
        "--account": "value",
        // cortex#1057 — repeatable subject scope, comma-joined into arc's
        // single `--pub`/`--sub` flag. issue-only: rotate/revoke don't scope.
        "--pub": "value-list",
        "--sub": "value-list",
      },
    },
    revoke: { positionals: ["agent-id"], flags: { "--account": "value" } },
    rotate: { positionals: ["agent-id"], flags: { "--account": "value" } },
    // G2 — one-command admin grant act (cortex#1118)
    grant: {
      positionals: ["request-id"],
      flags: {
        "--admin-seed": "value",
        "--registry-url": "value",
        "--scope": "value",
        "--operator-jwt": "value",
        "--discord-member": "value",
        "--discord-server": "value",
        "--discord-guild": "value",
        "--discord-role": "value",
        "--apply": "bool",
        "--dry-run": "bool",
        "--account": "value",
      },
    },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

export function parseCredsArgs(argv: string[]): ParsedCredsArgs {
  let parsed;
  try {
    parsed = parseSubcommandArgs(CREDS_SPEC, argv);
  } catch (err) {
    if (err instanceof MissingPositionalError) {
      const sub = err.rawSubcommand;
      const known =
        sub === "list" || sub === "issue" || sub === "revoke" || sub === "rotate" || sub === "grant"
          ? sub
          : "unknown";
      return {
        subcommand: known,
        rawSubcommand: sub,
        agentId: undefined,
        credsDir: undefined,
        account: undefined,
        pub: [],
        sub: [],
        json: false,
        help: false,
        requestId: undefined,
        adminSeed: undefined,
        registryUrl: undefined,
        scope: undefined,
        operatorJwt: undefined,
        discordMember: undefined,
        discordServer: undefined,
        discordGuild: undefined,
        discordRole: undefined,
        dryRun: true,
        apply: false,
      };
    }
    throw err;
  }

  return {
    subcommand: parsed.subcommand,
    rawSubcommand: parsed.rawSubcommand,
    agentId: parsed.positionals["agent-id"],
    credsDir: valueFlag(parsed.flags, "--creds-dir"),
    account: valueFlag(parsed.flags, "--account"),
    pub: listFlag(parsed.flags, "--pub"),
    sub: listFlag(parsed.flags, "--sub"),
    json: boolFlag(parsed.flags, "--json"),
    help: parsed.help,
    // G2 grant fields
    requestId: parsed.positionals["request-id"],
    adminSeed: valueFlag(parsed.flags, "--admin-seed"),
    registryUrl: valueFlag(parsed.flags, "--registry-url"),
    scope: valueFlag(parsed.flags, "--scope"),
    operatorJwt: valueFlag(parsed.flags, "--operator-jwt"),
    discordMember: valueFlag(parsed.flags, "--discord-member"),
    discordServer: valueFlag(parsed.flags, "--discord-server"),
    discordGuild: valueFlag(parsed.flags, "--discord-guild"),
    discordRole: valueFlag(parsed.flags, "--discord-role"),
    apply: boolFlag(parsed.flags, "--apply"),
    dryRun: boolFlag(parsed.flags, "--dry-run") || !boolFlag(parsed.flags, "--apply"),
  };
}

// =============================================================================
// runCredsList — local filesystem scan (unchanged from cortex#64)
// =============================================================================

export function runCredsList(args: ParsedCredsArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: listHelp(), stderr: "" };
  }

  const dir = expandTilde(args.credsDir ?? DEFAULT_CREDS_DIR);

  if (!existsSync(dir)) {
    if (args.json) {
      return { exitCode: 0, stdout: renderJson(envelopeOk<CredsItem>([])), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `0 creds files in ${dir} (directory does not exist)\n`,
      stderr: "",
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds list: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  if (entries.length > MAX_CREDS_DIR_ENTRIES) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds list: refusing to enumerate ${dir} — ${entries.length} entries exceeds ${MAX_CREDS_DIR_ENTRIES} cap. Trim the directory or split by deployment.\n`,
    };
  }

  const creds: CredsItem[] = [];
  const seenIds = new Map<string, string>();
  const skippedMalformed: string[] = [];
  const skippedColliding: { id: string; first: string; second: string }[] = [];

  for (const filename of entries) {
    const filePath = join(dir, filename);
    let mtime: Date;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) continue;
      mtime = stat.mtime;
    } catch {
      continue;
    }

    // id = filename stem before the FIRST dot. `echo.creds` → `echo`,
    // `my.agent.creds` → `my` (`my.agent` would fail the regex anyway).
    // Symlinks are skipped (lstatSync above).
    const id = filename.split(".")[0] ?? "";
    if (!AGENT_ID_REGEX.test(id)) {
      skippedMalformed.push(filename);
      continue;
    }
    if (seenIds.has(id)) {
      skippedColliding.push({ id, first: seenIds.get(id) ?? "", second: filename });
      continue;
    }
    seenIds.set(id, filename);
    creds.push({ id, path: filePath, issuedAt: mtime.toISOString() });
  }

  creds.sort((a, b) => a.id.localeCompare(b.id));

  let warnings = "";
  for (const f of skippedMalformed) {
    warnings += `cortex creds list: skipping "${f}" — filename stem doesn't match agent-id regex /^[a-z0-9-]+$/\n`;
  }
  for (const c of skippedColliding) {
    warnings += `cortex creds list: skipping "${c.second}" — id "${c.id}" already taken by "${c.first}"\n`;
  }

  if (args.json) {
    return { exitCode: 0, stdout: renderJson(envelopeOk(creds)), stderr: warnings };
  }

  if (creds.length === 0) {
    return {
      exitCode: 0,
      stdout: `0 creds files in ${dir}\n`,
      stderr: warnings,
    };
  }

  return {
    exitCode: 0,
    stdout: creds.map(formatCredsLine).join("\n") + "\n",
    stderr: warnings,
  };
}

// =============================================================================
// arc nats subprocess driver
// =============================================================================

/** Runner result shape — exactly what `Bun.spawn` surfaces post-await. */
export interface ArcRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable subprocess driver. Production code uses `defaultArcRunner`
 *  (Bun.spawn against the real `arc` binary on PATH). Tests inject a
 *  fake via `__setArcRunnerForTests`. */
export type ArcRunner = (argv: readonly string[]) => Promise<ArcRunResult>;

let arcRunnerOverride: ArcRunner | null = null;

/** Test-only setter. Production callers never touch this. Passing `null`
 *  restores the real-binary default. */
export function __setArcRunnerForTests(runner: ArcRunner | null): void {
  arcRunnerOverride = runner;
}

async function defaultArcRunner(argv: readonly string[]): Promise<ArcRunResult> {
  const proc = Bun.spawn(["arc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

interface ArcCallResult {
  envelope: ArcEnvelope | null;
  /** Surface raw output back to the principal on parse-failure paths. */
  rawStderr: string;
  rawStdout: string;
  /** Non-null on spawn failure (arc binary missing, not executable). */
  spawnError: string | null;
}

async function callArcNats(argv: readonly string[]): Promise<ArcCallResult> {
  const runner = arcRunnerOverride ?? defaultArcRunner;
  let result: ArcRunResult;
  try {
    result = await runner(argv);
  } catch (err) {
    return {
      envelope: null,
      rawStderr: "",
      rawStdout: "",
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }

  // arc emits one JSON line per `--json` invocation. Use the first
  // non-blank line so a leading newline or accidental "Running command…"
  // chatter on stderr doesn't break parsing.
  const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  if (line.length === 0) {
    return {
      envelope: null,
      rawStderr: result.stderr,
      rawStdout: result.stdout,
      spawnError: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      envelope: null,
      rawStderr: result.stderr,
      rawStdout: result.stdout,
      spawnError: null,
    };
  }

  // Schema check. Any envelope without `schema === "arc.nats.v1"` is a
  // contract violation; arc#134's stability promise pins this.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== ARC_NATS_SCHEMA_V1
  ) {
    return {
      envelope: null,
      rawStderr: result.stderr,
      rawStdout: result.stdout,
      spawnError: null,
    };
  }

  return {
    envelope: parsed as ArcEnvelope,
    rawStderr: result.stderr,
    rawStdout: result.stdout,
    spawnError: null,
  };
}

// =============================================================================
// runCredsIssue / Revoke / Rotate — arc-backed
// =============================================================================

export async function runCredsIssue(args: ParsedCredsArgs): Promise<ExitResult> {
  return runArcSubcommand(args, "issue");
}

export async function runCredsRevoke(args: ParsedCredsArgs): Promise<ExitResult> {
  return runArcSubcommand(args, "revoke");
}

export async function runCredsRotate(args: ParsedCredsArgs): Promise<ExitResult> {
  return runArcSubcommand(args, "rotate");
}

async function runArcSubcommand(
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): Promise<ExitResult> {
  if (args.help) {
    return { exitCode: 0, stdout: subcommandHelp(subcommand), stderr: "" };
  }

  if (!args.agentId) {
    return usageError(args, subcommand,
      `missing agent id (usage: cortex creds ${subcommand} <agent-id>)`);
  }
  if (!AGENT_ID_REGEX.test(args.agentId)) {
    return usageError(args, subcommand,
      `agent id "${args.agentId}" is invalid — must match /^[a-z0-9-]+$/`);
  }

  const arcVerb = arcVerbFor(subcommand);
  const argv: string[] = ["nats", arcVerb, args.agentId];
  if (args.account) argv.push("--account", args.account);

  // cortex#1057 — subject-scope passthrough (issue only). arc's
  // `add-bot --pub <subjects>` takes ONE comma-separated string (Commander
  // option, last-wins if repeated; arc itself splits on ","). cortex's
  // surface accepts repeatable --pub/--sub for ergonomics and joins each
  // with commas into a SINGLE arc flag — emitting one arc flag per value
  // would make arc keep only the last subject, silently narrowing (or, for
  // a default scope, dropping `_INBOX.>`) the very boundary we're setting.
  //
  // Safe default (ADR-0012 D1): when a scope is omitted we do NOT issue an
  // unscoped bot (which could subscribe `federated.>` = everyone in the
  // shared `community` account). We fall back to the bot's own
  // `federated.<id>.>` namespace + `_INBOX.>`. pub and sub default
  // independently so `--pub x` alone still gets a safe `--sub` default.
  //
  // Sanitize BEFORE the empty-check (cortex#1057 NIT-1): arc itself does
  // `split(",").map(s => s.trim())`, so a whitespace-padded value like
  // `--pub " federated.> "` would survive cortex verbatim and arc would trim
  // it back to `federated.>` (everyone-subscribe) — bypassing the safe
  // default. Trimming + dropping empties here means a whitespace-only scope
  // collapses to [] and correctly falls through to the safe default rather
  // than reaching arc as an everyone-scope.
  if (subcommand === "issue") {
    const pubScope = sanitizeScope(args.pub);
    const subScope = sanitizeScope(args.sub);
    const pub = pubScope.length > 0 ? pubScope : defaultScopeFor(args.agentId);
    const sub = subScope.length > 0 ? subScope : defaultScopeFor(args.agentId);
    argv.push("--pub", pub.join(","));
    argv.push("--sub", sub.join(","));
  }

  // cortex always wants the local .creds file gone on revoke — the file
  // is meaningless once the pubkey is server-side revoked. Carries
  // arc.remove-bot's `--delete-creds`.
  if (subcommand === "revoke") argv.push("--delete-creds");
  argv.push("--json");

  const call = await callArcNats(argv);
  return formatArcResult(call, args, subcommand);
}

function arcVerbFor(sub: "issue" | "revoke" | "rotate"): string {
  switch (sub) {
    case "issue": return "add-bot";
    case "rotate": return "reissue-bot";
    case "revoke": return "remove-bot";
    default: {
      // Exhaustive on the union — unreachable at runtime. The throw
      // is a typescript-level guarantee, not an operational concern.
      const _never: never = sub;
      throw new Error(`arcVerbFor: unreachable subcommand "${String(_never)}"`);
    }
  }
}

function usageError(
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
  reason: string,
): ExitResult {
  if (args.json) {
    return {
      exitCode: 2,
      stdout: errorEnvelopeForSubcommand(reason, subcommand, args.agentId),
      stderr: "",
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `cortex creds ${subcommand}: ${reason}\n`,
  };
}

function formatArcResult(
  call: ArcCallResult,
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): ExitResult {
  if (call.spawnError) {
    const reason =
      `failed to invoke 'arc nats ${arcVerbFor(subcommand)}' — ${call.spawnError}. ` +
      `Ensure arc (>= ${MIN_ARC_VERSION}) is installed and on PATH.`;
    if (args.json) {
      return {
        exitCode: 1,
        stdout: errorEnvelopeForSubcommand(reason, subcommand, args.agentId),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds ${subcommand}: ${reason}\n` };
  }

  if (!call.envelope) {
    const reason =
      `arc returned no valid '${ARC_NATS_SCHEMA_V1}' envelope. ` +
      `Confirm arc >= ${MIN_ARC_VERSION} is installed and that 'arc nats ${arcVerbFor(subcommand)}' supports --json.`;
    const passthrough = [call.rawStdout, call.rawStderr]
      .filter((s) => s.trim().length > 0)
      .join("\n");
    if (args.json) {
      const ctx: Record<string, string> = { subcommand };
      if (args.agentId) ctx.agentId = args.agentId;
      if (passthrough) ctx.arc_output = passthrough.slice(0, 400);
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError<CredsItem>(reason, ctx)),
        stderr: "",
      };
    }
    const tail = passthrough ? `\n  arc output: ${passthrough}` : "";
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds ${subcommand}: ${reason}${tail}\n`,
    };
  }

  if (!call.envelope.ok) {
    return formatArcError(call.envelope, args, subcommand);
  }
  return formatArcSuccess(call.envelope, args, subcommand);
}

function formatArcError(
  env: ArcEnvelopeError,
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): ExitResult {
  const code = env.error.code;
  const message = env.error.message;

  // USER_NOT_FOUND on revoke is benign: the agent is already gone
  // server-side, treat as idempotent exit 0. For issue/rotate it's a
  // real failure. Matches arc:docs/integrations/cortex-creds.md verbatim.
  if (code === "USER_NOT_FOUND" && subcommand === "revoke") {
    if (args.json) {
      const data: Record<string, string> = {
        subcommand,
        agentId: args.agentId ?? "",
        arc_code: code,
        note: "idempotent revoke — bot was not present server-side",
      };
      return { exitCode: 0, stdout: renderJson(envelopeOk<CredsItem>([], data)), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: `cortex creds revoke: agent="${args.agentId}" was not present server-side (idempotent).\n`,
      stderr: "",
    };
  }

  // PUSH_FAILED carries a critical operational warning — the old creds
  // are STILL VALID on the bus. Surface it loudly.
  const warning =
    code === "PUSH_FAILED"
      ? "\n  WARNING: old creds remain VALID on the bus until you retry this command after fixing connectivity."
      : "";

  if (args.json) {
    const ctx: Record<string, string> = {
      subcommand,
      agentId: args.agentId ?? "",
      arc_code: code,
    };
    return {
      exitCode: 1,
      stdout: renderJson(envelopeError<CredsItem>(message, ctx)),
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `cortex creds ${subcommand}: ${code}: ${message}${warning}\n`,
  };
}

function formatArcSuccess(
  env: ArcEnvelopeAddBot | ArcEnvelopeReissueBot | ArcEnvelopeRemoveBot,
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): ExitResult {
  if (args.json) {
    const data: Record<string, string> = {
      subcommand,
      agentId: args.agentId ?? "",
      arc_account: env.account,
      arc_bot: env.bot,
    };
    if ("credsPath" in env) data.creds_path = env.credsPath;
    if ("pubKey" in env) data.pub_key = env.pubKey;
    if ("newPubKey" in env) data.new_pub_key = env.newPubKey;
    if ("revokedPubKey" in env) data.revoked_pub_key = env.revokedPubKey;
    if ("credsFileDeleted" in env) data.creds_file_deleted = String(env.credsFileDeleted);
    return { exitCode: 0, stdout: renderJson(envelopeOk<CredsItem>([], data)), stderr: "" };
  }

  const lines: string[] = [];
  lines.push(`cortex creds ${subcommand}: ok — agent="${args.agentId}" account="${env.account}"`);
  if ("credsPath" in env) lines.push(`  creds_path: ${env.credsPath}`);
  if ("pubKey" in env) lines.push(`  pub_key:    ${env.pubKey}`);
  if ("newPubKey" in env) {
    lines.push(`  new_pub_key:     ${env.newPubKey}`);
    lines.push(`  revoked_pub_key: ${env.revokedPubKey}`);
  }
  if (subcommand === "revoke" && "revokedPubKey" in env && !("newPubKey" in env)) {
    lines.push(`  revoked_pub_key: ${env.revokedPubKey}`);
    lines.push(`  creds_file_deleted: ${env.credsFileDeleted}`);
  }
  return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
}

function errorEnvelopeForSubcommand(
  reason: string,
  subcommand: string,
  agentId: string | undefined,
): string {
  const context: Record<string, string> = { subcommand };
  if (agentId) context.agentId = agentId;
  return renderJson(envelopeError<CredsItem>(reason, context));
}

// =============================================================================
// G2 — Discord client injection seam (mirrors ArcRunner pattern)
// =============================================================================

/** Minimal Discord client surface used by runCredsGrant — injectable for tests. */
export interface DiscordGrantClient {
  resolveRoleId(botToken: string, guildId: string, roleName: string): Promise<string>;
  assignRole(botToken: string, guildId: string, userId: string, roleId: string): Promise<{ success: boolean; error?: string }>;
}

let discordGrantClientOverride: DiscordGrantClient | null = null;

/** Test-only setter. Production callers never touch this. Passing `null`
 *  restores the real discord-lib default. */
export function __setDiscordGrantClientForTests(client: DiscordGrantClient | null): void {
  discordGrantClientOverride = client;
}

/** Default production client — thin wrappers over the real discord lib. */
const defaultDiscordGrantClient: DiscordGrantClient = {
  resolveRoleId,
  assignRole,
};

// =============================================================================
// G2 — runCredsGrant: one-command admin grant act (cortex#1118)
// =============================================================================

/** Default registry URL — mirrors network create / join constants. */
const DEFAULT_GRANT_REGISTRY_URL = "https://network.meta-factory.ai";

/** Default Discord role for O-5 community-fleet admission. */
const DEFAULT_DISCORD_ROLE = "community-fleet";

/**
 * Mirror of the registry's `IssuanceRequest` shape used on the client side.
 * Reproduced rather than imported (registry is a separately-bundled CF Worker).
 */
interface IssuanceRequestClient {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  requested_scope: string;
  status: "PENDING" | "GRANTED" | "REJECTED";
  created_at: string;
  updated_at: string;
  granted_by: string | null;
  leaf_package: string | null;
}

/**
 * On-wire shape for the grant claim. Mirrors `IssuanceDecisionClaimWithPackage`
 * from the registry types — reproduced on the client side (same CF Worker
 * boundary isolation as the rest of the CLI).
 */
interface GrantLeafPackageClient {
  operatorJwt: string;
  account: string;
  accountJwt: string;
  systemAccount?: string;
  systemAccountJwt?: string;
  endpoint?: string;
}

interface IssuanceDecisionClaimWithPackageClient {
  request_id: string;
  decision: "grant";
  admin_pubkey: string;
  issued_at: string;
  nonce: string;
  leaf_package?: GrantLeafPackageClient;
}

/** Load + derive admin material from a seed file (chmod-600 gated). */
async function adminMaterialFromSeedPath(
  seedPath: string,
): Promise<{ ok: true; material: StackIdentityMaterial } | { ok: false; reason: string }> {
  const expanded = expandTilde(seedPath);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `--admin-seed file not found at ${expanded}` };
  }
  try {
    enforceChmod600(expanded);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  let seed: string;
  try {
    seed = await readFile(expanded, "utf-8");
  } catch (err) {
    return { ok: false, reason: `failed to read --admin-seed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { ok: true, material: materialFromSeedString(seed) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build an admin-signed issuance decision body. The claim is canonicalJSON'd
 * and signed with the admin nkey via the shared `signClaimWithSeed` primitive
 * from stack-provisioning.ts — one source of truth for the PKCS#8 bridge so
 * divergent prefix bytes cannot silently break signatures.
 */
async function buildGrantDecisionBody(
  requestId: string,
  material: StackIdentityMaterial,
  leafPackage: GrantLeafPackageClient | undefined,
  opts: { issuedAt?: string; nonce?: string } = {},
): Promise<{ claim: IssuanceDecisionClaimWithPackageClient; signature: string }> {
  const claim: IssuanceDecisionClaimWithPackageClient = {
    request_id: requestId,
    decision: "grant",
    admin_pubkey: material.pubkeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
    ...(leafPackage !== undefined && { leaf_package: leafPackage }),
  };

  // Bytes to be signed: canonical-JSON(claim) — same as the registry verifies.
  const msgBytes = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(material.seed, msgBytes);

  return { claim, signature };
}

/**
 * Build an admin-signed read claim for the `x-admin-signed` header used on
 * GET /issuance-requests/{id}. No nonce (reads are idempotent). Clock-skew
 * applies on the registry side. Uses `signClaimWithSeed` — the same PKCS#8
 * bridge as buildGrantDecisionBody, single source of truth.
 */
async function buildAdminReadHeader(
  material: StackIdentityMaterial,
): Promise<string> {
  const claim = {
    admin_pubkey: material.pubkeyB64,
    issued_at: new Date().toISOString(),
  };

  const msgBytes = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(material.seed, msgBytes);

  return JSON.stringify({ claim, signature });
}

/**
 * Validate a GrantLeafPackage shape — checks that required JWT-shaped and
 * nkey-U-shaped fields are non-empty, and that `systemAccount`/`systemAccountJwt`
 * are either both present or both absent (half-specified is rejected).
 *
 * Returns null on success, a reason string on failure.
 */
function validateLeafPackage(pkg: GrantLeafPackageClient): string | null {
  if (!pkg.operatorJwt.startsWith("eyJ")) {
    return "leaf package: operatorJwt must be a non-empty JWT (eyJ…)";
  }
  if (!pkg.account || pkg.account.length < 4) {
    return "leaf package: account must be a non-empty nkey-A public key";
  }
  if (!pkg.accountJwt.startsWith("eyJ")) {
    return "leaf package: accountJwt must be a non-empty JWT (eyJ…)";
  }
  const hasSysAccount = pkg.systemAccount !== undefined && pkg.systemAccount.length > 0;
  const hasSysJwt = pkg.systemAccountJwt !== undefined && pkg.systemAccountJwt.length > 0;
  if (hasSysAccount !== hasSysJwt) {
    return "leaf package: systemAccount and systemAccountJwt must both be present or both absent";
  }
  return null;
}

export async function runCredsGrant(args: ParsedCredsArgs): Promise<ExitResult> {
  if (args.help) {
    return { exitCode: 0, stdout: grantHelp(), stderr: "" };
  }

  // --- Usage validation ---

  if (!args.requestId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "cortex creds grant: missing request-id (usage: cortex creds grant <request-id> --admin-seed <path>)\n",
    };
  }

  if (!args.adminSeed) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "cortex creds grant: --admin-seed <path> is required\n",
    };
  }

  const applyFlag = args.apply ?? false;
  const dryRunFlag = args.dryRun ?? !applyFlag;

  // --apply and --dry-run together is a usage error:
  // dryRun=true AND apply=true means both were explicitly passed
  if (applyFlag && dryRunFlag) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "cortex creds grant: --apply and --dry-run are mutually exclusive\n",
    };
  }

  const registryUrl = args.registryUrl ?? DEFAULT_GRANT_REGISTRY_URL;

  // Load the admin seed (chmod-600 gated) — exit 1 on any failure
  const matRes = await adminMaterialFromSeedPath(args.adminSeed);
  if (!matRes.ok) {
    const reason = matRes.reason;
    if (args.json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }
  const material = matRes.material;

  // --- Dry-run: print plan, touch nothing ---

  if (!applyFlag) {
    if (args.json) {
      return {
        exitCode: 0,
        stdout: renderJson(
          envelopeOk<CredsItem>([], {
            subcommand: "grant",
            request_id: args.requestId,
            registry_url: registryUrl,
            admin_fingerprint: material.fingerprint,
            applied: "false",
          }),
        ),
        stderr: "",
      };
    }
    const lines = [
      `cortex creds grant ${args.requestId}: dry-run (no registry write; pass --apply to execute)`,
      `  registry:         ${registryUrl}`,
      `  admin_fingerprint: ${material.fingerprint}`,
      `  scope:            ${args.scope ?? "(from request's requested_scope)"}`,
      `  operator_jwt:     ${args.operatorJwt ? `${args.operatorJwt.slice(0, 20)}…` : "(none — leaf package will be absent)"}`,
      ...(args.discordMember ? [`  discord_member:   ${args.discordMember}`] : []),
      ``,
    ];
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  }

  // --- APPLY path ---

  // 1. Fetch the PENDING request (admin-signed GET)
  let request: IssuanceRequestClient;
  try {
    const adminReadHeader = await buildAdminReadHeader(material);
    const getUrl = `${registryUrl.replace(/\/+$/, "")}/issuance-requests/${encodeURIComponent(args.requestId)}`;
    const getResp = await globalThis.fetch(getUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-admin-signed": adminReadHeader,
      },
    });
    if (getResp.status === 404) {
      const reason = `request-id "${args.requestId}" not found in registry (HTTP 404)`;
      if (args.json) {
        return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant", request_id: args.requestId })), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
    }
    if (!getResp.ok) {
      const body = await getResp.text();
      const reason = `registry GET failed (HTTP ${getResp.status.toString()}): ${body}`;
      if (args.json) {
        return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant", request_id: args.requestId })), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
    }
    request = (await getResp.json()) as IssuanceRequestClient;
  } catch (err) {
    const reason = `failed to fetch request from registry: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  // Validate request is PENDING — fail clearly if not
  if (request.status !== "PENDING") {
    const reason = `request "${args.requestId}" is not PENDING (status: ${request.status}) — cannot grant an already-decided request`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant", request_id: args.requestId, status: request.status })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  // 2. Issue scoped creds via arc (the existing creds-issue path)
  // Resolve scope: explicit --scope flag > request's requested_scope
  const rawScope = args.scope ?? request.requested_scope;
  // Split on whitespace to support multiple subjects in --scope "sub1 sub2"
  const scopeParts = rawScope.split(/\s+/).filter((s) => s.length > 0);
  const scopeStr = scopeParts.join(",");

  // Derive a usable agent-id from the principal_id for `arc nats add-bot`
  // The principal_id is already a valid lower-kebab identifier.
  const agentId = request.principal_id;

  // Build arc argv — same pattern as runArcSubcommand
  const arcArgv: string[] = [
    "nats", "add-bot", agentId,
    "--pub", scopeStr,
    "--sub", scopeStr,
  ];
  if (args.account) arcArgv.push("--account", args.account);
  arcArgv.push("--json");

  const arcCall = await callArcNats(arcArgv);

  if (arcCall.spawnError) {
    const reason = `failed to invoke 'arc nats add-bot' — ${arcCall.spawnError}. Ensure arc (>= ${MIN_ARC_VERSION}) is installed and on PATH.`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  if (!arcCall.envelope) {
    const reason = `arc returned no valid '${ARC_NATS_SCHEMA_V1}' envelope. Confirm arc >= ${MIN_ARC_VERSION} is installed and supports --json.`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  if (!arcCall.envelope.ok) {
    const arcErr = arcCall.envelope as { ok: false; error: { code: string; message: string } };
    const reason = `arc creds issue failed: ${arcErr.error.code}: ${arcErr.error.message}`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant", arc_code: arcErr.error.code })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  // Extract PUBLIC fields from the arc envelope — the secret .creds stays local
  const arcSuccess = arcCall.envelope as { ok: true; bot: string; account: string; credsPath: string; jwt: string; pubKey: string };
  const localCredsPath = arcSuccess.credsPath;
  const issuedAccount = arcSuccess.account;
  const issuedAccountJwt = arcSuccess.jwt;

  // 3. Assemble the PUBLIC leaf package
  // operatorJwt comes from --operator-jwt flag. Without it, leaf_package is absent
  // (grant without a package is valid per O-4a.2 — leaf_package column stays null).
  let leafPackage: GrantLeafPackageClient | undefined;
  if (args.operatorJwt) {
    leafPackage = {
      operatorJwt: args.operatorJwt,
      account: issuedAccount,
      accountJwt: issuedAccountJwt,
    };

    // Validate before sending
    const pkgErr = validateLeafPackage(leafPackage);
    if (pkgErr) {
      const reason = pkgErr;
      if (args.json) {
        return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
    }
  }

  // 4. Sign + POST the grant
  let grantBody: { claim: IssuanceDecisionClaimWithPackageClient; signature: string };
  try {
    grantBody = await buildGrantDecisionBody(args.requestId, material, leafPackage);
  } catch (err) {
    const reason = `failed to build grant decision claim: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  // Safety: verify the ACTUAL WIRE PAYLOAD carries no secret material
  // (belt-and-suspenders on the full POST body — not just the leaf package —
  // so any future field that bleeds credsPath/seed is caught on the actual bytes).
  {
    const wireStr = JSON.stringify(grantBody);
    if (wireStr.includes("credsPath") || wireStr.includes(".creds")) {
      const reason = "internal: grant body contains secret field (credsPath/.creds) — refusing to POST";
      process.stderr.write(`cortex creds grant: ${reason}\n`);
      return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
    }
  }

  let grantResponse: unknown;
  try {
    const postUrl = `${registryUrl.replace(/\/+$/, "")}/issuance-requests/${encodeURIComponent(args.requestId)}/grant`;
    const postResp = await globalThis.fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(grantBody),
    });
    grantResponse = await postResp.json();
    if (!postResp.ok) {
      const reason = `registry rejected grant (HTTP ${postResp.status.toString()}): ${JSON.stringify(grantResponse)}`;
      if (args.json) {
        return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant", request_id: args.requestId })), stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
    }
  } catch (err) {
    const reason = `registry POST failed: ${err instanceof Error ? err.message : String(err)}`;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError<CredsItem>(reason, { subcommand: "grant" })), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex creds grant: ${reason}\n` };
  }

  // 5. Assign Discord role (O-5) — when --discord-member is given
  let discordStatus = "skipped";
  let discordWarning = "";

  if (args.discordMember) {
    // Use the injected client when running under tests; fall back to the
    // real discord lib for production (which reads from loadDiscordConfig()).
    const discordClient = discordGrantClientOverride;

    try {
      // Resolve bot token + guild id from config/flags — mirrors discord.ts role add
      const discordConfig = loadDiscordConfig();
      const ctx = resolveServerContext(discordConfig, {
        server: args.discordServer,
        guild: args.discordGuild,
      });

      const botToken = discordClient ? "injected" : ctx.botToken;
      const guildId = discordClient ? (args.discordGuild ?? ctx.guildId) : ctx.guildId;

      if (!discordClient && !botToken) {
        discordWarning = "Discord role not assigned: no bot token configured (run: discord config set botToken <token>)";
        discordStatus = "skipped_no_token";
      } else if (!guildId) {
        discordWarning = "Discord role not assigned: no guild id configured — pass --discord-guild <id> or run: discord config set guildId <id>";
        discordStatus = "skipped_no_guild";
      } else {
        const client = discordClient ?? defaultDiscordGrantClient;
        const roleName = args.discordRole ?? DEFAULT_DISCORD_ROLE;
        let roleId: string;
        try {
          roleId = await client.resolveRoleId(botToken ?? "", guildId, roleName);
        } catch (err) {
          discordWarning = `Discord role not assigned: ${err instanceof Error ? err.message : String(err)} — assign manually`;
          discordStatus = "failed";
          roleId = "";
        }

        if (roleId) {
          const roleResult = await client.assignRole(botToken ?? "", guildId, args.discordMember, roleId);
          if (roleResult.success) {
            discordStatus = "assigned";
          } else {
            discordWarning = `Discord role assignment failed: ${roleResult.error ?? "unknown error"} — grant already committed, assign role manually`;
            discordStatus = "failed";
          }
        }
      }
    } catch (err) {
      discordWarning = `Discord role assignment error: ${err instanceof Error ? err.message : String(err)} — grant already committed, assign role manually`;
      discordStatus = "failed";
    }
  }

  // 6. Output summary
  if (args.json) {
    const data: Record<string, string> = {
      subcommand: "grant",
      applied: "true",
      request_id: args.requestId,
      principal_id: request.principal_id,
      scope: scopeStr,
      local_creds_path: localCredsPath,
      admin_fingerprint: material.fingerprint,
      ...(discordStatus !== "skipped" && { discord_status: discordStatus }),
    };
    if (discordWarning) data.discord_warning = discordWarning;
    return { exitCode: 0, stdout: renderJson(envelopeOk<CredsItem>([], data)), stderr: "" };
  }

  const lines: string[] = [
    `cortex creds grant ${args.requestId}: granted`,
    `  principal:       ${request.principal_id}`,
    `  scope:           ${scopeStr}`,
    `  creds_path:      ${localCredsPath}  (local — NOT sent to registry)`,
    `  leaf_package:    ${leafPackage ? "posted to registry" : "none (no --operator-jwt)"}`,
    `  admin:           ${material.fingerprint}`,
  ];
  if (args.discordMember) {
    if (discordStatus === "assigned") {
      lines.push(`  discord:         role "${args.discordRole ?? DEFAULT_DISCORD_ROLE}" assigned to member ${args.discordMember}`);
    } else {
      lines.push(`  discord:         ${discordWarning}`);
    }
  }
  lines.push("");
  return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
}

// =============================================================================
// dispatchCreds
// =============================================================================

export async function dispatchCreds(argv: string[]): Promise<ExitResult> {
  let args: ParsedCredsArgs;
  try {
    args = parseCredsArgs(argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex creds: ${err.message}\n${topLevelHelp()}`,
      };
    }
    throw err;
  }

  switch (args.subcommand) {
    case "list":
      return runCredsList(args);
    case "issue":
      return await runCredsIssue(args);
    case "revoke":
      return await runCredsRevoke(args);
    case "rotate":
      return await runCredsRotate(args);
    case "grant":
      return await runCredsGrant(args);
    case "help":
      return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
    case "unknown":
      if (args.rawSubcommand === "") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `cortex creds: usage error — no subcommand specified.\n${topLevelHelp()}`,
        };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex creds: unknown subcommand "${args.rawSubcommand}".\n${topLevelHelp()}`,
      };
    default:
      return assertExhaustive(args.subcommand, "creds");
  }
}

// =============================================================================
// Output helpers
// =============================================================================

function formatCredsLine(c: CredsItem): string {
  return `${c.id.padEnd(20)} ${c.path}  issued ${c.issuedAt}`;
}

// =============================================================================
// Help text
// =============================================================================

function topLevelHelp(): string {
  return `cortex creds — manage per-agent NATS user credentials

Cortex delegates credential minting to arc (\`arc nats … --json\`). arc owns
nsc and the principal's $SYS account; cortex shells out and surfaces the
result. See the-metafactory/arc:docs/integrations/cortex-creds.md for the
contract.

Usage:
  cortex creds list   [--creds-dir <path>] [--json]
  cortex creds issue  <agent-id> [--account <name>] [--pub <subject>]... [--sub <subject>]... [--json]
  cortex creds revoke <agent-id> [--account <name>] [--json]
  cortex creds rotate <agent-id> [--account <name>] [--json]
  cortex creds grant  <request-id> --admin-seed <path> [--operator-jwt <jwt>]
                      [--scope <subjects>] [--registry-url <url>]
                      [--discord-member <id>] [--discord-guild <id>]
                      [--discord-server <profile>] [--discord-role <name>]
                      [--apply] [--dry-run] [--json]
  cortex creds --help

Subcommands:
  list     List existing creds files (local filesystem scan)
  issue    Mint creds for an agent — shells out to \`arc nats add-bot\`
  revoke   Revoke creds — shells out to \`arc nats remove-bot --delete-creds\`
  rotate   Rotate creds — shells out to \`arc nats reissue-bot\`
  grant    One-command admin grant act (G2, cortex#1118): fetch pending request,
           issue scoped creds via arc, post the signed grant + public leaf package
           to the registry, optionally assign the Discord community-fleet role.
           DRY-RUN by default (pass --apply to execute).

Per-subcommand options:
  list:    --creds-dir <path>   Directory containing .creds files (default: ~/.config/nats/creds)
  issue/revoke/rotate:
           --account <name>     NSC operator account name (default: arc resolves via nsc env)
  issue:   --pub <subject>      Publish subject scope. Repeatable; multiple values
                                are comma-joined into arc's single --pub flag.
           --sub <subject>      Subscribe subject scope. Same shape as --pub.
                                The subject scope is the bot's isolation boundary in
                                a shared account (ADR-0012). When --pub/--sub are
                                OMITTED, the bot is NOT issued unscoped — it defaults
                                to "federated.<agent-id>.>" + "_INBOX.>".

Universal options:
  --json               Emit structured JSON envelope
  --help, -h           Show help

Exit codes:
  0    success (incl. idempotent USER_NOT_FOUND on revoke)
  1    operational failure (arc reported ok=false, arc binary missing, contract drift)
  2    usage error (bad flag, bad agent id, missing positional)

Requires: arc >= ${MIN_ARC_VERSION} on PATH.
`;
}

function grantHelp(): string {
  return `cortex creds grant — one-command admin grant act (G2, cortex#1118)

Scripted form of the human grant: fetch the PENDING issuance request,
issue scoped NATS credentials via arc, assemble the PUBLIC leaf package
(no creds path or secret), sign + POST the grant to the registry, and
optionally admit the peer to Discord (O-5 community-fleet role).

Usage:
  cortex creds grant <request-id> --admin-seed <path> [options]

Required:
  <request-id>                   Hex issuance request id (from the registry)
  --admin-seed <path>            Path to the admin nkey seed file (SU…, chmod 600)

Options:
  --operator-jwt <jwt>           NSC operator JWT — included in the public leaf
                                 package POSTed to the registry. Omit if you don't
                                 want to supply the NSC operator JWT hint.
  --scope <subjects>             Space-separated NATS subjects for pub/sub scope.
                                 Defaults to the request's requested_scope.
  --registry-url <url>           Registry base URL (default: https://network.meta-factory.ai)
  --account <name>               NSC operator account name (passed to arc)
  --discord-member <snowflake>   Discord user id to assign the community-fleet role
  --discord-guild <id>           Discord guild id override
  --discord-server <profile>     Named server profile from discord cli.yaml
  --discord-role <name>          Role to assign (default: community-fleet)
  --apply                        Execute the grant (default: dry-run)
  --dry-run                      Force dry-run (default; mutually exclusive with --apply)
  --json                         Emit structured JSON envelope

Security guarantees:
  - The .creds file produced by arc is LOCAL ONLY — it is NEVER sent to the
    registry. Only public leaf package fields (JWTs, nkey-A account keys) go up.
  - The admin seed is chmod-600 gated before any I/O.
  - Dry-run (default) touches no registry and calls no arc.

Partial success:
  If the grant POST succeeds but the Discord role assignment fails, the command
  exits 0 with a warning — the grant is already committed and CANNOT be rolled
  back from here. The admin must assign the role manually.

Exit codes:
  0    success (or dry-run)
  1    operational failure (registry error, arc failure, seed not readable)
  2    usage error (missing positional, bad flags)

Requires: arc >= ${MIN_ARC_VERSION} on PATH (for --apply).
`;
}

function listHelp(): string {
  return `cortex creds list — list local NATS creds files

Usage:
  cortex creds list [--creds-dir <path>] [--json]

Options:
  --creds-dir <path>   Default: ~/.config/nats/creds
  --json               Emit envelope { status, items: [{id, path, issuedAt}], error? }

Behavior:
  - Filenames whose stem doesn't match /^[a-z0-9-]+$/ are SKIPPED with a
    warning on stderr.
  - Id collisions (two files yielding the same stem) are SKIPPED with a
    warning naming both files.
  - Symlinks are skipped (lstatSync).
`;
}

function subcommandHelp(sub: "issue" | "revoke" | "rotate"): string {
  const arcVerb = arcVerbFor(sub);
  const verbDesc = sub === "issue" ? "mint" : sub === "revoke" ? "revoke" : "rotate";
  const scopeUsage = sub === "issue" ? " [--pub <subject>]... [--sub <subject>]..." : "";
  // issue-only: the subject-scope contract + safe default (cortex#1057).
  const scopeBehavior =
    sub === "issue"
      ? `  - --pub/--sub scope the bot's NATS subject permissions. Each is repeatable;
    multiple values are comma-joined into arc's single --pub/--sub flag.
  - The subject scope IS the bot's isolation boundary in a shared account
    (ADR-0012). When --pub/--sub are OMITTED, the bot is NOT issued unscoped
    (which could subscribe "federated.>" = everyone) — it defaults to
    "federated.<agent-id>.>" + "_INBOX.>".\n`
      : "";
  return `cortex creds ${sub} — ${verbDesc} per-agent NATS credentials via arc

Usage:
  cortex creds ${sub} <agent-id> [--account <name>]${scopeUsage} [--json]

Behavior:
  - Shells out to \`arc nats ${arcVerb} <agent-id>${sub === "revoke" ? " --delete-creds" : ""} [--account <name>] --json\`.
${scopeBehavior}  - Parses arc's \`${ARC_NATS_SCHEMA_V1}\` envelope and surfaces the result.
  - On success: stdout summarises bot, account, creds_path, and pub key(s).
  - On arc failure: exit 1 with the structured error code and message.
  - On arc binary missing: exit 1 with install instructions.

USER_NOT_FOUND on revoke is treated as idempotent (exit 0).
PUSH_FAILED is surfaced with a WARNING — the old creds remain valid on the
bus until the principal retries after fixing connectivity.

Exit codes:
  0    arc reported ok=true (or revoke-of-already-gone)
  1    arc reported ok=false OR arc binary missing / contract drift
  2    bad agent id / missing positional / bad flag

Requires: arc >= ${MIN_ARC_VERSION} on PATH.
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchCreds(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
