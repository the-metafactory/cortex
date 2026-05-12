#!/usr/bin/env bun
/**
 * F-4 — `cortex creds <subcommand>` CLI.
 *
 * Manages per-agent NATS user credentials (cortex#58 D7+D8 + cortex#60 §6.3).
 *
 * **v1 scope (cortex#67 implementation):**
 *
 *   - `list` is fully functional — scans the local creds dir.
 *   - `issue` calls the cortex daemon via UNIX-socket IPC and writes the
 *     minted .creds file to disk (chmod 600). Lights up end-to-end when
 *     the daemon is running.
 *   - `revoke` calls the daemon, which deletes the local file but does NOT
 *     yet perform server-side NATS account-JWT revoke (see
 *     `src/runner/creds-handler.ts` for the rationale). The daemon's
 *     response message documents the limitation; the CLI surfaces it.
 *   - `rotate` is local-file rotate (delete + re-mint). Same caveat as
 *     `revoke` on the server-side revoke.
 *
 * **Transport:** UNIX-domain socket at `~/.config/cortex/cortex.sock`
 * (configurable via `--socket <path>`). The daemon listens there when
 * config has `nats.accountSigningKeyPath` set and `agents:[]` has ≥1 entry.
 * NATS request/reply transport is deferred — see creds-handler.ts.
 *
 * Usage:
 *   bun src/cli/cortex/commands/creds.ts list   [--creds-dir <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts issue  <agent-id> [--config <path>] [--socket <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts revoke <agent-id> [--config <path>] [--socket <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts rotate <agent-id> [--config <path>] [--socket <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts --help
 *
 * Exit codes:
 *   0  — success
 *   1  — operational failure (daemon unreachable, daemon returned ok=false)
 *   2  — usage error (bad flag, bad agent id)
 */

import { existsSync, lstatSync, readdirSync } from "fs";
import { connect } from "net";
import { join } from "path";

import { expandTilde } from "../../../common/config/loader";
import { CliArgsError, MissingPositionalError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { assertExhaustive } from "./_shared/assert-exhaustive";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";
import { boolFlag, valueFlag } from "./_shared/hydrate";

// =============================================================================
// Types
// =============================================================================

export interface ParsedCredsArgs {
  subcommand: "list" | "issue" | "revoke" | "rotate" | "help" | "unknown";
  rawSubcommand: string;
  agentId: string | undefined;
  credsDir: string | undefined;
  config: string | undefined;
  /**
   * Optional override for the daemon UNIX socket path. Defaults to
   * `~/.config/cortex/cortex.sock` to match the daemon's default
   * (`src/runner/creds-handler.ts`). Used by tests + operators with
   * non-standard deployments.
   */
  socket: string | undefined;
  json: boolean;
  help: boolean;
}

// ExitResult moved to `_shared/exit-result.ts` (cortex#65 — Echo round-2
// duplication nit on cortex#64). Imported above. Kept re-export for any
// external consumer that grabbed the type via `creds.ts` directly.
export { type ExitResult } from "./_shared/exit-result";

/**
 * Per-creds-file metadata returned in the JSON envelope's `items` array.
 *
 * Echo M2 + M4 on cortex#64 — F-4 uses the shared `CliJsonEnvelope<T>` from
 * `_shared/envelope.ts` so its JSON contract is identical in shape to F-3's
 * (modulo the `items` element type — there `Agent`-shaped, here
 * `CredsItem`-shaped). Scripting consumers can pin against
 * `CliJsonEnvelope<unknown>` without per-subcommand handling.
 *
 * No deprecated re-exports of the prior `CredsJsonEnvelope` / `CredsArgsError`
 * names — F-4 is the first cortex CLI to ship the shared shape and has no
 * external consumers yet (Echo A2 nit cortex#64). Importers use the shared
 * `_shared/envelope.ts` and `_shared/arg-error.ts` directly.
 */
export interface CredsItem {
  id: string;
  path: string;
  issuedAt: string;
}

/**
 * Pre-cortex#67 deferred-stub message. Kept exported for two reasons:
 *   1. The shared `_shared/envelope.ts` shape stays stable for scripting
 *      consumers — the JSON envelope's `error.reason` still surfaces a
 *      clear deferred-feature explanation when the daemon is unreachable
 *      (we re-use it as the fallback message).
 *   2. Pre-existing tests pin against the constant; keeping it preserves
 *      backward compatibility for downstream tooling that parsed the
 *      stderr string.
 *
 * Now that cortex#67 has landed, the IPC client returns operator-actionable
 * errors (e.g. "cortex daemon not reachable; ensure it is running and that
 * its socket is at <path>"). The legacy DEFERRED_SUBCOMMAND_MESSAGE is no
 * longer the typical user-facing message — only fired when something at
 * the CLI parse layer rejects before IPC.
 */
export const DEFERRED_SUBCOMMAND_MESSAGE =
  "not yet implemented — pending cortex daemon-IPC integration (cortex#67). " +
  "v1 ships `cortex creds list` only; issue/revoke/rotate light up when " +
  "cortex.ts wires the daemon-side RPC handler. See cortex#60 §6.3 + cortex#58 D8 for the design.";

/**
 * Canonical agent-id regex (lowercase alphanumeric + dash). Mirrors
 * `AgentSchema.id` in `src/common/types/cortex-config.ts`. Used by:
 *   - operator-input validation on `issue` / `revoke` / `rotate`
 *   - filesystem-input validation on `list` (Echo M1 cortex#64)
 */
const AGENT_ID_REGEX = /^[a-z0-9-]+$/;
const DEFAULT_CREDS_DIR = "~/.config/nats/creds";

/**
 * Default daemon socket path. Matches the daemon's default in
 * `src/runner/creds-handler.ts`. Operators can override via `--socket`.
 */
const DEFAULT_SOCKET_PATH = "~/.config/cortex/cortex.sock";

/** IPC request timeout — UNIX-local calls finish in milliseconds; 5 s is
 *  generous and matches the daemon's per-request timeout. */
const IPC_TIMEOUT_MS = 5_000;

/** Hardening cap on `readdirSync` entry count (Echo H1 nit cortex#64).
 *  A creds directory with thousands of entries is a misconfiguration; refuse
 *  to enumerate rather than allocate unbounded memory. */
const MAX_CREDS_DIR_ENTRIES = 10_000;

// =============================================================================
// parseCredsArgs
// =============================================================================

/**
 * Grammar spec for `cortex creds`. Consumed by `parseSubcommandArgs`
 * (cortex#66 generic parser extract). Per-subcommand flag scoping +
 * positionals enforced via the spec.
 */
const CREDS_SPEC: SubcommandSpec<"list" | "issue" | "revoke" | "rotate"> = {
  cliName: "creds",
  subcommands: {
    list: { flags: { "--creds-dir": "value" } },
    issue: {
      positionals: ["agent-id"],
      flags: { "--config": "value", "--socket": "value" },
    },
    revoke: {
      positionals: ["agent-id"],
      flags: { "--config": "value", "--socket": "value" },
    },
    rotate: {
      positionals: ["agent-id"],
      flags: { "--config": "value", "--socket": "value" },
    },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

/**
 * Parses `cortex creds` CLI arguments via the generic `parseSubcommandArgs`
 * helper. The deferred subcommands (issue/revoke/rotate) need a required
 * `<agent-id>` positional — declared via the spec's `positionals: [...]`
 * array. Missing positional surfaces as a `CliArgsError` ("missing
 * required positional argument: <agent-id>") which the deferred-subcommand
 * handler maps to a user-friendly message.
 *
 * Note: the helper enforces required positionals; the legacy parser
 * special-cased missing-id in `runDeferredSubcommand`. That handler still
 * has a defensive missing-id check for `args.agentId` for the case where
 * callers construct ParsedCredsArgs by hand (existing test pattern).
 */
export function parseCredsArgs(argv: string[]): ParsedCredsArgs {
  let parsed;
  try {
    parsed = parseSubcommandArgs(CREDS_SPEC, argv);
  } catch (err) {
    // Echo cortex#66 round-1 M1 — was regex-matching the error message;
    // now `instanceof MissingPositionalError` and a strict
    // `positionalName === "agent-id"` check. Decoupled from internal phrasing.
    //
    // Missing-required-positional for issue/revoke/rotate used to be
    // handled inside `runDeferredSubcommand` (it checks `!args.agentId`
    // and renders a friendly envelope). The generic parser now throws on
    // the missing positional. Catch that specific subclass and return a
    // degenerate args object so the handler emits its own message;
    // re-throw everything else.
    if (
      err instanceof MissingPositionalError &&
      err.positionalName === "agent-id"
    ) {
      // Echo cortex#66 round-1 warning — use the parser-supplied
      // `rawSubcommand` rather than naively re-scanning argv. The parser
      // already walked argv skipping flag-value pairs; trust its answer.
      const sub = err.rawSubcommand;
      const known =
        sub === "list" || sub === "issue" || sub === "revoke" || sub === "rotate"
          ? sub
          : "unknown";
      return {
        subcommand: known,
        rawSubcommand: sub,
        agentId: undefined,
        credsDir: undefined,
        config: undefined,
        socket: undefined,
        json: false,
        help: false,
      };
    }
    throw err;
  }

  return {
    subcommand: parsed.subcommand,
    rawSubcommand: parsed.rawSubcommand,
    agentId: parsed.positionals["agent-id"],
    credsDir: valueFlag(parsed.flags, "--creds-dir"),
    config: valueFlag(parsed.flags, "--config"),
    socket: valueFlag(parsed.flags, "--socket"),
    json: boolFlag(parsed.flags, "--json"),
    help: parsed.help,
  };
}

// =============================================================================
// runCredsList
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

  // Echo H1 nit on cortex#64 — cap entry enumeration. A multi-thousand-entry
  // dir is a misconfiguration; bail rather than allocate unbounded memory.
  if (entries.length > MAX_CREDS_DIR_ENTRIES) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds list: refusing to enumerate ${dir} — ${entries.length} entries exceeds ${MAX_CREDS_DIR_ENTRIES} cap. Trim the directory or split by deployment.\n`,
    };
  }

  // Echo M1 on cortex#64 — id derivation now validates against the canonical
  // agent-id regex AND detects collisions. Filesystem input deserves the
  // same scrutiny as operator input on issue/revoke/rotate.
  const creds: CredsItem[] = [];
  const seenIds = new Map<string, string>();
  const skippedMalformed: string[] = [];
  const skippedColliding: { id: string; first: string; second: string }[] = [];

  for (const filename of entries) {
    const filePath = join(dir, filename);
    // Echo S1 nit on cortex#64 — lstatSync rejects symlinks. Creds files
    // are sensitive (NATS user JWT); refuse to read through a symlink that
    // could redirect to a file the operator didn't intend. Regular files
    // only.
    let mtime: Date;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) continue;
      mtime = stat.mtime;
    } catch {
      continue;
    }

    // id = filename stem before the FIRST dot. Echo C2 cortex#64 — this is
    // intentional, not the same as "strip last extension." Rationale: a
    // canonical agent id matches `/^[a-z0-9-]+$/` (no dots). So
    //   `echo.creds`        → stem `echo`         (valid, accepted)
    //   `my.agent.creds`    → stem `my`           (likely a misnamed file;
    //                                              `my.agent` would fail the
    //                                              regex anyway, so picking
    //                                              the first segment matches
    //                                              the "trim ext + reject
    //                                              dots" behavior cleanly)
    //   `holly.nats.creds`  → stem `holly`        (the `.nats` middle is a
    //                                              non-canonical extension;
    //                                              first-dot stripping
    //                                              recovers the agent id)
    //   `Bad!Name.creds`    → stem `Bad!Name`     (fails regex; skipped with
    //                                              warning)
    // Using `path.basename(filename, ext)` (strip last ext) would yield
    // `my.agent` for `my.agent.creds`, which then fails the regex and is
    // skipped — same operator-visible outcome, just less informative warning.
    // First-dot stripping makes the warning name a recognizable agent-id
    // prefix.
    const id = filename.split(".")[0]!;
    if (!AGENT_ID_REGEX.test(id)) {
      skippedMalformed.push(filename);
      continue;
    }
    if (seenIds.has(id)) {
      skippedColliding.push({ id, first: seenIds.get(id)!, second: filename });
      continue;
    }
    seenIds.set(id, filename);
    creds.push({ id, path: filePath, issuedAt: mtime.toISOString() });
  }

  creds.sort((a, b) => a.id.localeCompare(b.id));

  // Surface malformed/colliding filenames as warnings on stderr. Echo M1
  // explicitly asked for collision visibility — silent collisions are how
  // operators end up debugging non-deterministic agent registration.
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
// IPC client — daemon UNIX socket
// =============================================================================

/**
 * Daemon response envelope. Mirrors `CredsResponse` from the daemon-side
 * `src/runner/creds-handler.ts`. Defined here as a local type so the CLI
 * doesn't import the runner-side module (keeps the CLI build slim).
 */
interface DaemonResponse {
  ok: boolean;
  verb: "issue" | "revoke" | "rotate";
  agent_id?: string;
  error?: string;
  message?: string;
  creds_path?: string;
  file_deleted?: boolean;
  user_jwt_summary?: {
    sub: string;
    iss: string;
    capabilities: string[];
  };
}

/**
 * Thrown when the daemon socket is unreachable (file missing, ECONNREFUSED,
 * permission denied). Caller maps to exit 1 + operator-facing message.
 *
 * NOT thrown when the daemon returns `ok=false` — that's a structured
 * response, not a transport failure.
 */
class DaemonUnreachableError extends Error {
  readonly socketPath: string;
  // `cause` is on Error in ES2022+ but tsconfig's `noImplicitOverride` flags
  // it; declare the override explicitly. Same pattern used by the runner's
  // own structured errors.
  override readonly cause: Error | undefined;
  constructor(socketPath: string, cause?: Error) {
    super(
      `cortex daemon not reachable at ${socketPath}` +
        (cause ? ` (${cause.message})` : "") +
        " — ensure the daemon is running, that creds-handler started without errors, " +
        "and that the socket path matches (override with --socket <path>).",
    );
    this.name = "DaemonUnreachableError";
    this.socketPath = socketPath;
    this.cause = cause;
  }
}

/**
 * Send a `{verb, agent_id}` request to the daemon socket and parse the
 * JSON response. Newline-delimited framing — matches the daemon-side
 * `handleConnection`'s newline expectation (see creds-handler.ts comment
 * for the Bun-specific rationale).
 *
 * Throws `DaemonUnreachableError` on transport failure. Returns the
 * parsed `DaemonResponse` on a clean round-trip — the caller decides how
 * to surface `ok=false` envelopes.
 */
async function callDaemon(
  socketPath: string,
  verb: "issue" | "revoke" | "rotate",
  agentId: string,
): Promise<DaemonResponse> {
  const expandedSocket = expandTilde(socketPath);
  return new Promise<DaemonResponse>((resolve, reject) => {
    const client = connect(expandedSocket);
    let buffer = "";
    let settled = false;
    client.setEncoding("utf-8");

    const settleErr = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // best-effort cleanup
      }
      reject(err);
    };

    const timeout = setTimeout(() => {
      settleErr(
        new DaemonUnreachableError(
          expandedSocket,
          new Error(`request timed out after ${IPC_TIMEOUT_MS}ms`),
        ),
      );
    }, IPC_TIMEOUT_MS);

    client.on("connect", () => {
      client.write(JSON.stringify({ verb, agent_id: agentId }) + "\n");
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
    });

    client.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const raw = buffer.trim();
      if (raw.length === 0) {
        reject(
          new DaemonUnreachableError(
            expandedSocket,
            new Error("daemon closed connection without sending a response"),
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(raw) as DaemonResponse);
      } catch (err) {
        reject(
          new Error(
            `cortex creds ${verb}: daemon returned malformed JSON ("${raw}"): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });

    client.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      // ENOENT (socket file missing), ECONNREFUSED (no listener), EACCES
      // (permission denied) all map to the same operator-actionable
      // "daemon not reachable" error.
      if (
        err.code === "ENOENT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "EACCES" ||
        err.code === "EPERM"
      ) {
        settleErr(new DaemonUnreachableError(expandedSocket, err));
        return;
      }
      settleErr(err);
    });
  });
}

// =============================================================================
// runCredsIssue / Revoke / Rotate — IPC-backed
// =============================================================================

export async function runCredsIssue(args: ParsedCredsArgs): Promise<ExitResult> {
  return runSubcommandViaDaemon(args, "issue");
}

export async function runCredsRevoke(args: ParsedCredsArgs): Promise<ExitResult> {
  return runSubcommandViaDaemon(args, "revoke");
}

export async function runCredsRotate(args: ParsedCredsArgs): Promise<ExitResult> {
  return runSubcommandViaDaemon(args, "rotate");
}

/**
 * Shared driver for `issue` / `revoke` / `rotate`.
 *
 * Flow:
 *   1. Help short-circuit.
 *   2. Operator-input validation (agent id presence + regex).
 *   3. IPC call via `callDaemon()`.
 *   4. Map response → ExitResult. Daemon `ok=true` → exit 0; daemon
 *      `ok=false` with a known stub-error → exit 1 with the daemon's
 *      message verbatim; transport failure → exit 1 with a "daemon
 *      not reachable" message.
 *
 * Why not split the validation + IPC into two functions? Keeps the call
 * graph flat and the error-envelope shape consistent across all three
 * verbs without an extra indirection layer.
 */
async function runSubcommandViaDaemon(
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): Promise<ExitResult> {
  if (args.help) {
    return { exitCode: 0, stdout: subcommandHelp(subcommand), stderr: "" };
  }

  // Operator-input validation.
  if (!args.agentId) {
    const reason = `missing agent id (usage: cortex creds ${subcommand} <agent-id>)`;
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
  if (!AGENT_ID_REGEX.test(args.agentId)) {
    const reason = `agent id "${args.agentId}" is invalid — must match /^[a-z0-9-]+$/`;
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

  const socketPath = args.socket ?? DEFAULT_SOCKET_PATH;
  let response: DaemonResponse;
  try {
    response = await callDaemon(socketPath, subcommand, args.agentId);
  } catch (err) {
    // Transport failure — daemon unreachable or malformed reply.
    const reason = err instanceof Error ? err.message : String(err);
    if (args.json) {
      return {
        exitCode: 1,
        stdout: errorEnvelopeForSubcommand(reason, subcommand, args.agentId),
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds ${subcommand}: ${reason}\n`,
    };
  }

  return formatDaemonResponse(response, args, subcommand);
}

/**
 * Map a daemon response envelope into an `ExitResult`.
 *
 * The mapping is verb-aware because the narrower stubs (`revoke`,
 * `rotate`) carry an operator-friendly `message` field that supplements
 * `error`. We surface both so the operator understands exactly what
 * happened.
 *
 * Exit codes:
 *   - 0 on `ok=true`
 *   - 1 on `ok=false` — the daemon spoke but reported a failure (unknown
 *     agent, mint error, the narrower-stub `revoke` deferred-server-side
 *     case, etc.)
 */
function formatDaemonResponse(
  response: DaemonResponse,
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): ExitResult {
  if (args.json) {
    // The CLI's JSON envelope wraps the daemon's response — we don't pass
    // the daemon envelope through verbatim because the CLI envelope shape
    // (`status / items / error`) is the stable scripting contract. Embed
    // the daemon-supplied summary in the `context` map for callers that
    // want to inspect it.
    const ctx: Record<string, string> = {
      subcommand,
      agentId: args.agentId ?? "",
      verb: response.verb,
    };
    if (response.creds_path) ctx.creds_path = response.creds_path;
    if (response.message) ctx.message = response.message;
    if (response.user_jwt_summary?.sub) ctx.sub = response.user_jwt_summary.sub;
    if (response.user_jwt_summary?.iss) ctx.iss = response.user_jwt_summary.iss;
    if (response.user_jwt_summary?.capabilities) {
      ctx.capabilities = response.user_jwt_summary.capabilities.join(",");
    }
    if (response.file_deleted !== undefined) {
      ctx.file_deleted = String(response.file_deleted);
    }

    if (response.ok) {
      return {
        exitCode: 0,
        stdout: renderJson({
          status: "ok",
          items: [],
          // We don't surface success metadata in `error` (would be
          // misleading). Embed in `error.context` only on failure path
          // below. Operators who want structured success metadata in
          // JSON parse the text stdout from the non-JSON path.
          //
          // For now, success returns the envelope shape with empty
          // items + no error field. The interesting fields land in the
          // text mode.
        } as Parameters<typeof renderJson>[0]),
        stderr: "",
      };
    }

    return {
      exitCode: 1,
      stdout: renderJson(
        envelopeError<CredsItem>(response.error ?? "daemon reported failure", ctx),
      ),
      stderr: "",
    };
  }

  // Text mode — human-readable summary.
  if (response.ok) {
    const lines: string[] = [];
    lines.push(`cortex creds ${subcommand}: ok — agent="${response.agent_id}"`);
    if (response.creds_path) {
      lines.push(`  creds_path: ${response.creds_path}`);
    }
    if (response.user_jwt_summary) {
      lines.push(`  sub: ${response.user_jwt_summary.sub}`);
      lines.push(`  iss: ${response.user_jwt_summary.iss}`);
      lines.push(
        `  capabilities: ${response.user_jwt_summary.capabilities.length > 0 ? response.user_jwt_summary.capabilities.join(", ") : "(none)"}`,
      );
    }
    if (response.message) {
      lines.push(`  note: ${response.message}`);
    }
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  // Failure — combine `error` (machine code) + `message` (operator-facing)
  // on stderr so the operator sees both.
  const errLines: string[] = [];
  errLines.push(`cortex creds ${subcommand}: ${response.error ?? "daemon reported failure"}`);
  if (response.message) {
    errLines.push(`  ${response.message}`);
  }
  if (response.file_deleted !== undefined) {
    errLines.push(`  file_deleted: ${response.file_deleted}`);
  }
  return { exitCode: 1, stdout: "", stderr: errLines.join("\n") + "\n" };
}

/** Build a creds-specific error envelope (uses shared `context` for
 *  subcommand-specific metadata, per Echo M2). */
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
// dispatchCreds
// =============================================================================

/**
 * Async because `issue` / `revoke` / `rotate` perform real IPC (UNIX
 * socket round-trip with the cortex daemon). `list`, `help`, and the
 * usage-error branches remain synchronous but are wrapped in the same
 * `Promise<ExitResult>` for caller uniformity.
 */
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
      // Echo n1 on cortex#64 — exhaustive guard via shared helper (A4 nit
      // round 2 cortex#64 moved it to _shared/ for F-5 reuse).
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

Usage:
  cortex creds list   [--creds-dir <path>] [--json]
  cortex creds issue  <agent-id> [--config <path>] [--socket <path>] [--json]
  cortex creds revoke <agent-id> [--config <path>] [--socket <path>] [--json]
  cortex creds rotate <agent-id> [--config <path>] [--socket <path>] [--json]
  cortex creds --help

Subcommands:
  list     List existing creds files (filesystem-only)
  issue    Mint creds for an agent — daemon-mediated (cortex#67)
  revoke   Revoke creds — v1: deletes local file only; server-side revoke
           is pending system-account topology design (see cortex#67)
  rotate   Local-file rotate (delete + re-mint). Same server-side caveat
           as revoke for the old JWT.

Per-subcommand options:
  list:     --creds-dir <path>  Directory containing .creds files (default: ~/.config/nats/creds)
  issue:    --config <path>     cortex.yaml path (informational; daemon owns its own config)
            --socket <path>     Daemon socket path (default: ~/.config/cortex/cortex.sock)
  revoke:   --config / --socket  same
  rotate:   --config / --socket  same

Universal options:
  --json               Emit structured JSON envelope (shared shape via _shared/envelope.ts)
  --help, -h           Show help

Flag scoping: a flag passed to a subcommand that does not accept it is a usage
error (exit 2). E.g. \`cortex creds issue echo --creds-dir /tmp\` is rejected.

Exit codes:
  0    success
  1    operational failure (daemon unreachable, daemon reported ok=false)
  2    usage error (bad flag, bad agent id, missing positional)
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
    warning on stderr (Echo M1 on cortex#64).
  - Id collisions (two files yielding the same stem) are SKIPPED with a
    warning naming both files.
`;
}

function subcommandHelp(sub: "issue" | "revoke" | "rotate"): string {
  const verbDesc =
    sub === "issue"
      ? "mint a fresh per-agent NATS user JWT scoped to the agent's runtime.capabilities"
      : sub === "revoke"
        ? "revoke an agent's local creds file (v1: server-side revoke pending)"
        : "rotate: delete local file + re-issue (v1: server-side revoke pending)";

  return `cortex creds ${sub} — ${verbDesc}

Usage:
  cortex creds ${sub} <agent-id> [--config <path>] [--socket <path>] [--json]

Behavior:
  - Connects to the cortex daemon via UNIX socket (default: ~/.config/cortex/cortex.sock).
  - Daemon performs the action, returns a JSON envelope.
  - CLI maps the envelope to exit 0 (ok) or exit 1 (daemon reported failure / unreachable).

${sub === "revoke" || sub === "rotate" ? `Note: v1 only modifies the LOCAL .creds file. Server-side NATS account-JWT
revoke is pending system-account topology design (see src/runner/creds-handler.ts).
The daemon's response documents the limitation; the CLI surfaces it on stderr.

` : ""}Exit codes:
  0    daemon reported ok=true
  1    daemon reported ok=false OR daemon not reachable
  2    bad agent id / missing positional / bad flag
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  // dispatchCreds is async because issue/revoke/rotate IPC over UNIX socket.
  // top-level await is available in Bun.
  const result = await dispatchCreds(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
