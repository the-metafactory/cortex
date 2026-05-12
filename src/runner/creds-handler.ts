/**
 * cortex#67 — creds-handler: daemon-side RPC handler for `cortex creds
 * issue / revoke / rotate`.
 *
 * The handler exposes a JSON request/reply surface over a UNIX domain socket
 * (chmod 600). The cortex CLI's `creds.ts` commands talk to this socket to
 * request per-agent NATS user JWTs minted from the operator's account signing
 * key. Each minted JWT is scoped to the requesting agent's
 * `runtime.capabilities` list via `mintUserCreds()` (prereq A).
 *
 * # Transport
 *
 * **v1 ships UNIX-socket only.** The spec's NATS request/reply transport
 * remains a v2 concern for two reasons surfaced during implementation:
 *
 *   1. `MyelinRuntime` only exposes `onEnvelope` + `publish`. It has no
 *      `subscribe-with-reply` primitive — adding one is invasive (touches
 *      `runtime.ts`, `subscriber.ts`, and the surface-router contract). The
 *      spec's STOP+REPORT trigger says to surface this rather than extend.
 *   2. The intended NATS subject-auth gate ("only operator-trusted creds get
 *      processed via `TrustResolver`") doesn't have a direct map onto the
 *      existing `TrustResolver`, which is the *platform-identity* trust map
 *      (Discord/Mattermost user-id ↔ agent-id). NATS-side operator-trust
 *      verification would need a different primitive. Surface, defer.
 *
 * The UNIX socket alone is sufficient for v1 because cortex's CLI runs on the
 * same host as the daemon — the operator's laptop / server. The socket file
 * being chmod 600 + owned by the daemon user gives OS-enforced auth.
 *
 * Architecture leaves room for the NATS path: `handleRequest()` is
 * transport-agnostic (takes a parsed `CredsRequest`, returns a
 * `CredsResponse`). A future PR that adds NATS subscribe/reply to the runtime
 * can call the same `handleRequest()` body and reuse this file unchanged.
 *
 * # Request / response shape
 *
 * Wire format: JSON, one message per UNIX-socket connection (or one
 * request/reply round trip per NATS msg in v2).
 *
 * Request:
 *   { "verb": "issue" | "revoke" | "rotate", "agent_id": "<id>" }
 *
 * Response (verb-specific — see CredsResponse below). All responses carry:
 *   - `ok: boolean`
 *   - `verb: <verb>`
 *   - `agent_id: <id>` (when applicable)
 *   - `error: <string>` (on ok=false)
 *   - per-verb fields (creds_path, user_jwt_summary, etc.)
 *
 * # Verb semantics (v1)
 *
 *   - **`issue`** — fully implemented end-to-end. Looks up the agent in the
 *     registry, reads `agent.runtime.capabilities`, mints a fresh user JWT
 *     scoped to those caps, writes `{credsDir}/{agentId}.creds` with chmod
 *     600, returns the path + a JWT summary.
 *   - **`revoke`** — narrower stub per spec: deletes the local creds file if
 *     present; **does NOT** revoke server-side via account-JWT update. That
 *     requires system-account topology design that's out of scope for v1.
 *     Returns `{ ok: false, error: "server_side_revoke_not_implemented", ... }`
 *     with a clear message so operators understand what happened.
 *   - **`rotate`** — narrower stub: local-file rotate (delete + re-mint).
 *     Server-side revocation of the old JWT is again deferred. Returns
 *     `{ ok: true, ..., message: "v1: local file rotated; server-side
 *     revoke pending system-account topology" }`.
 *
 * # Idempotency + safety
 *
 *   - `start()` / `stop()` are idempotent (matches prereq C stub contract).
 *   - The socket file is unlinked on stop AND on start (defensive: an
 *     orphaned socket from a prior crashed daemon would otherwise EADDRINUSE).
 *   - Concurrent `issue` requests for the same agent race on disk write; the
 *     last writer wins. Acceptable — a re-issued cred file is a new user
 *     identity (mint is non-idempotent by design, see jwt-mint.ts).
 *
 * # Logging
 *
 * No sensitive material logged. We log:
 *   - the verb + agent_id on receipt,
 *   - the creds_path on success (the path, not the file contents),
 *   - error class + message on failure.
 * We never log the JWT, the seed, or the .creds file bytes.
 */

import { existsSync, unlinkSync, chmodSync, mkdirSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";
import type { Server, Socket } from "net";
import { createServer } from "net";
import type { KeyPair } from "nkeys.js";
import { decode, type User } from "@nats-io/jwt";

import type { AgentRegistry } from "../common/agents/registry";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { mintUserCreds } from "../bus/nats/jwt-mint";

// =============================================================================
// Constants
// =============================================================================

/**
 * Default socket path. `~/.config/cortex/cortex.sock` matches the spec's
 * default. Resolved via `process.env.HOME` for portability.
 */
const DEFAULT_SOCKET_PATH = "~/.config/cortex/cortex.sock";

/**
 * Default creds directory. `~/.config/nats/creds/` matches the F-4 CLI's
 * `DEFAULT_CREDS_DIR` in `cli/cortex/commands/creds.ts` so issued files land
 * where `cortex creds list` already looks for them.
 */
const DEFAULT_CREDS_DIR = "~/.config/nats/creds";

/** Cap on inbound request payload size — 64 KiB is gigantic for a JSON
 *  envelope of `{verb, agent_id}`. Defence against accidental log-flood or
 *  buffer-overflow probing. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** Per-connection read timeout. UNIX-local request/reply finishes in
 *  milliseconds; 5 s is generous. */
const REQUEST_TIMEOUT_MS = 5_000;

// =============================================================================
// Public types
// =============================================================================

/**
 * Construction options for the creds handler.
 *
 * Compared to the prereq-C stub, this adds `accountSigningKey` + `org`, plus
 * the optional `socketPath` and `credsDir` paths. All paths accept `~` and
 * are expanded internally.
 */
export interface CredsHandlerOpts {
  /** Bus runtime — reserved for the v2 NATS request/reply path. v1 doesn't
   *  use this but the field stays so cortex.ts wiring is forward-compatible. */
  runtime: MyelinRuntime;
  /** Agent registry — source of truth for `agent.runtime.capabilities`. */
  registry: AgentRegistry;
  /** Operator account signing key — loaded via `loadAccountSigningKey()` in
   *  cortex.ts. Used as the issuer for every minted user JWT. */
  accountSigningKey: KeyPair;
  /** Org slug — used as the `{org}` segment in minted JWT subjects
   *  (`local.{org}.…`). Matches `operator.id` from cortex.yaml /
   *  `agent.operatorId` from bot.yaml. */
  org: string;
  /** Optional UNIX socket path. Defaults to `~/.config/cortex/cortex.sock`. */
  socketPath?: string;
  /** Optional creds output directory. Defaults to `~/.config/nats/creds/`. */
  credsDir?: string;
}

/**
 * Lifecycle handle for the creds handler. Shape matches the prereq-C stub so
 * cortex.ts wiring stays unchanged.
 */
export interface CredsHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Request envelope — shared between transport surfaces.
 *
 * `verb` is the action. `agent_id` is the target agent. All other fields are
 * verb-specific and reserved.
 */
export interface CredsRequest {
  verb: "issue" | "revoke" | "rotate";
  agent_id: string;
}

/**
 * Response envelope — shared between transport surfaces. All fields are
 * optional except `ok` + `verb`; per-verb fields populate the rest.
 *
 * Note on the JWT summary: we ONLY include the subject pubkey + capability
 * scope, never the JWT body or the user seed. Operators who want the full
 * decoded JWT can run `nats jwt decode` on the file at `creds_path`.
 */
export interface CredsResponse {
  ok: boolean;
  verb: "issue" | "revoke" | "rotate";
  agent_id?: string;
  error?: string;
  message?: string;
  creds_path?: string;
  file_deleted?: boolean;
  user_jwt_summary?: {
    /** Subject — the user's NKey public key (UA…). Public, safe to log. */
    sub: string;
    /** Issuer — the account signing key's public key (A…). Public. */
    iss: string;
    /** Capabilities scope echoed back (operator-readable). */
    capabilities: string[];
  };
}

// =============================================================================
// Path expansion + creds-dir helpers
// =============================================================================

/**
 * Expand a leading `~` to `$HOME`. Mirrors `expandTilde` in
 * `src/common/config/loader.ts` but kept private here so the handler stays
 * dependency-free of the config loader (the loader pulls Zod + YAML, which
 * the handler doesn't need).
 */
function expandTilde(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = process.env.HOME ?? "~";
  return path.replace(/^~/, home);
}

/**
 * Resolve the absolute path for a given agent's creds file.
 *
 * The filename is `{agentId}.creds`, matching the F-4 CLI's `list`
 * convention (filename stem → agent id, see `cli/cortex/commands/creds.ts`).
 */
function credsPathFor(credsDir: string, agentId: string): string {
  return join(expandTilde(credsDir), `${agentId}.creds`);
}

// =============================================================================
// Handler core — transport-agnostic
// =============================================================================

/**
 * Dispatch a parsed `CredsRequest` to the right verb handler. Returns the
 * response envelope. Pure function over the registry + signing key + paths;
 * the only side effects are file I/O.
 *
 * Surfaced as an exported function so future v2 transports (NATS
 * request/reply, HTTP, gRPC, ...) can reuse the same dispatcher without
 * re-implementing the parse-validate-execute flow.
 */
export async function handleRequest(
  request: CredsRequest,
  opts: {
    registry: AgentRegistry;
    accountSigningKey: KeyPair;
    org: string;
    credsDir: string;
  },
): Promise<CredsResponse> {
  switch (request.verb) {
    case "issue":
      return await handleIssue(request.agent_id, opts);
    case "revoke":
      return handleRevoke(request.agent_id, opts.credsDir);
    case "rotate":
      return await handleRotate(request.agent_id, opts);
    default: {
      // Exhaustive check — caller validates `verb` against the union before
      // dispatch, so reaching here is a bug. The cast keeps TS strict-null
      // happy without `as never`.
      const verb: string = (request as { verb: string }).verb;
      return {
        ok: false,
        verb: verb as CredsRequest["verb"],
        error: `unknown verb "${verb}"`,
      };
    }
  }
}

/**
 * `issue {agent_id}`: full end-to-end.
 *
 *   1. Look up the agent in the registry — reject if not found.
 *   2. Read `agent.runtime.capabilities`. The runtime block is optional on
 *      cortex.yaml v0.1 (`AgentSchema.runtime` is `.optional()`). If absent,
 *      we default to an empty capability list — the bot still gets baseline
 *      perms (capability self-register + creds back-channel) per
 *      `buildUserPermissions()`.
 *   3. Mint a fresh user JWT via `mintUserCreds()`.
 *   4. Ensure the creds directory exists; write `{agentId}.creds`; chmod 600.
 *   5. Return `{ok: true, agent_id, creds_path, user_jwt_summary}`.
 */
async function handleIssue(
  agentId: string,
  opts: {
    registry: AgentRegistry;
    accountSigningKey: KeyPair;
    org: string;
    credsDir: string;
  },
): Promise<CredsResponse> {
  const agent = opts.registry.tryGetById(agentId);
  if (!agent) {
    return {
      ok: false,
      verb: "issue",
      agent_id: agentId,
      error: `unknown agent "${agentId}" — not in cortex agent registry`,
    };
  }

  // Capabilities from the agent's runtime block. Optional per cortex-config
  // schema; default to [] so a v0.1 cortex.yaml without `runtime:` still
  // issues a usable cred (baseline perms only).
  const capabilities = agent.runtime?.capabilities ?? [];

  let minted;
  try {
    minted = await mintUserCreds({
      accountSigningKey: opts.accountSigningKey,
      agentId,
      capabilities,
      org: opts.org,
    });
  } catch (err) {
    // mintUserCreds throws on subject-token validation. Surface the message
    // to the operator so a malformed agent id at the daemon side is visible.
    return {
      ok: false,
      verb: "issue",
      agent_id: agentId,
      error: `mint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Ensure the creds dir exists. `mkdirSync` is idempotent with `recursive`.
  const credsPath = credsPathFor(opts.credsDir, agentId);
  const credsDir = dirname(credsPath);
  try {
    mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      verb: "issue",
      agent_id: agentId,
      error: `failed to create creds dir ${credsDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write the file owner-only (chmod 600). `writeFileSync` with `mode` works
  // on POSIX; on Windows the mode bits are advisory but writeFileSync still
  // succeeds. Same approach as `account-signing-key.ts`'s Windows note.
  try {
    writeFileSync(credsPath, minted.credsFile, { mode: 0o600 });
    // Defensive re-chmod: on some filesystems / umasks the `mode` arg is
    // masked by `process.umask()`. An explicit chmodSync removes the umask
    // dependency. Same belt-and-braces pattern as `loadAccountSigningKey`.
    if (process.platform !== "win32") {
      chmodSync(credsPath, 0o600);
    }
  } catch (err) {
    return {
      ok: false,
      verb: "issue",
      agent_id: agentId,
      error: `failed to write creds file ${credsPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build the JWT summary. We decode the just-minted JWT to recover the
  // public subject — that's what `nats jwt decode` would show, and it's
  // public material (the user's NKey pubkey).
  let sub = "(unknown)";
  let iss = "(unknown)";
  try {
    const decoded = decode<User>(minted.userJwt);
    sub = decoded.sub ?? "(unset)";
    iss = decoded.iss ?? "(unset)";
  } catch {
    // Decode failure is anomalous (we just minted the JWT) but non-fatal —
    // the file is on disk, the operator can re-decode it locally. Leave the
    // summary placeholders so the response shape stays predictable.
  }

  return {
    ok: true,
    verb: "issue",
    agent_id: agentId,
    creds_path: credsPath,
    user_jwt_summary: { sub, iss, capabilities },
  };
}

/**
 * `revoke {agent_id}`: **NARROWER STUB**. Server-side NATS account-JWT revoke
 * (the proper revoke) is pending system-account topology design and is
 * deliberately out of scope for v1. We document the limitation in the
 * response so operators see exactly what happened.
 *
 * What v1 does: delete the local `.creds` file if present. This is the
 * minimum useful behaviour — it stops the bot on the same host from
 * re-loading the credentials, even though the JWT is still cryptographically
 * valid on any NATS server that doesn't have the revocation entry.
 */
function handleRevoke(
  agentId: string,
  credsDir: string,
): CredsResponse {
  const credsPath = credsPathFor(credsDir, agentId);
  const existed = existsSync(credsPath);
  if (existed) {
    try {
      unlinkSync(credsPath);
    } catch (err) {
      return {
        ok: false,
        verb: "revoke",
        agent_id: agentId,
        error: `failed to unlink ${credsPath}: ${err instanceof Error ? err.message : String(err)}`,
        file_deleted: false,
      };
    }
  }

  // We return `ok: false` to keep the contract honest: "revoke" did not
  // actually revoke (server-side). Operators / scripts can branch on
  // `error === "server_side_revoke_not_implemented"` to distinguish this
  // from a hard failure.
  return {
    ok: false,
    verb: "revoke",
    agent_id: agentId,
    error: "server_side_revoke_not_implemented",
    message:
      "Server-side NATS account-JWT revoke is pending system-account topology " +
      "design. v1 only deletes the local .creds file. File deleted: " + String(existed),
    file_deleted: existed,
    creds_path: credsPath,
  };
}

/**
 * `rotate {agent_id}`: **NARROWER STUB** for server-side revoke; full
 * re-mint of the local file.
 *
 *   1. Delete the local creds file if present (same behaviour as `revoke`).
 *   2. Issue a fresh creds file with new keys.
 *   3. Return `ok: true` with a message flagging that the OLD JWT is still
 *      valid on the bus until the operator re-deploys account-JWT
 *      revocation manually.
 *
 * Errors during step 2 (mint failure, disk write failure) propagate as
 * `ok: false` with the upstream error message — same shape as `issue`.
 */
async function handleRotate(
  agentId: string,
  opts: {
    registry: AgentRegistry;
    accountSigningKey: KeyPair;
    org: string;
    credsDir: string;
  },
): Promise<CredsResponse> {
  const credsPath = credsPathFor(opts.credsDir, agentId);
  const fileDeleted = existsSync(credsPath);
  if (fileDeleted) {
    try {
      unlinkSync(credsPath);
    } catch (err) {
      return {
        ok: false,
        verb: "rotate",
        agent_id: agentId,
        error: `failed to unlink old creds at ${credsPath}: ${err instanceof Error ? err.message : String(err)}`,
        file_deleted: false,
      };
    }
  }

  // Reuse `handleIssue` for the mint side — single source of truth for the
  // mint + write flow.
  const issued = await handleIssue(agentId, opts);
  if (!issued.ok) {
    // Pass through the underlying error but stamp the verb as `rotate` so
    // the operator-facing message is unambiguous about which call failed.
    return {
      ...issued,
      verb: "rotate",
    };
  }

  return {
    ...issued,
    verb: "rotate",
    file_deleted: fileDeleted,
    message:
      "v1: local file rotated; server-side revoke of the old JWT is pending " +
      "system-account topology design. The old JWT remains valid on the bus " +
      "until account-JWT revocation is deployed manually.",
  };
}

// =============================================================================
// UNIX-socket transport
// =============================================================================

/**
 * Parse the inbound buffer as JSON and validate the verb + agent_id shape.
 * Returns `{ ok: true, request }` on success; `{ ok: false, error }` with a
 * `CredsResponse`-ready error otherwise.
 *
 * Exported for the test fixture so unit tests can exercise the parse layer
 * without standing up a socket.
 */
export function parseCredsRequest(
  raw: string,
): { ok: true; request: CredsRequest } | { ok: false; response: CredsResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      response: {
        ok: false,
        verb: "issue", // placeholder — caller hasn't seen a verb yet
        error: `malformed request: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: {
        ok: false,
        verb: "issue",
        error: "malformed request: expected JSON object",
      },
    };
  }

  const obj = parsed as Record<string, unknown>;
  const verb = obj.verb;
  const agentId = obj.agent_id;

  if (verb !== "issue" && verb !== "revoke" && verb !== "rotate") {
    return {
      ok: false,
      response: {
        ok: false,
        verb: "issue",
        error: `malformed request: verb must be one of "issue" | "revoke" | "rotate", got ${JSON.stringify(verb)}`,
      },
    };
  }

  if (typeof agentId !== "string" || agentId.length === 0) {
    return {
      ok: false,
      response: {
        ok: false,
        verb,
        error: "malformed request: agent_id must be a non-empty string",
      },
    };
  }

  return { ok: true, request: { verb, agent_id: agentId } };
}

/**
 * Open the UNIX socket and wire a per-connection request/reply loop. Returns
 * the live `Server` so `stop()` can close it; throws on listen failure (the
 * caller decides whether to swallow or propagate).
 *
 * We use Node's `net.createServer` rather than `Bun.listen({ unix })`
 * because:
 *   - The spec's STOP+REPORT trigger flagged it as an acceptable fallback.
 *   - `net.createServer` is on the standard library, works under both Bun
 *     and Node, and has the `unref()` semantics tests want.
 *
 * The socket inherits the daemon's umask. We explicitly chmod 600 after
 * listen to guarantee owner-only access regardless of umask.
 */
function listenOnUnixSocket(
  socketPath: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Defensive cleanup: an orphaned socket from a prior crash would
    // EADDRINUSE on `listen()`. Unlink the path if it exists AND it's a
    // socket (not a regular file — refuse to clobber an unrelated file).
    if (existsSync(socketPath)) {
      try {
        const stat = statSync(socketPath);
        if (stat.isSocket()) {
          unlinkSync(socketPath);
        } else {
          reject(
            new Error(
              `refusing to listen on ${socketPath} — path exists and is not a socket (mode ${stat.mode.toString(8)})`,
            ),
          );
          return;
        }
      } catch (err) {
        // statSync can race with another process unlinking the file; we
        // log + proceed because the subsequent `listen` will surface a
        // clear error if the path is actually unusable.
        process.stderr.write(
          `[creds-handler] socket stat ${socketPath} failed (continuing): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Ensure the socket's parent dir exists (mode 0o700 for the dir is
    // mirrored from `creds-dir` handling above — keeps the daemon's
    // private state owner-only).
    const parentDir = dirname(socketPath);
    try {
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      reject(
        new Error(
          `failed to create socket dir ${parentDir}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const server = createServer(onConnection);

    server.once("error", (err) => {
      reject(err);
    });

    server.listen(socketPath, () => {
      // Owner-only access. Same belt-and-braces pattern as the writeFileSync
      // mode arg above — chmod after listen removes the umask dependency.
      try {
        if (process.platform !== "win32") {
          chmodSync(socketPath, 0o600);
        }
      } catch (err) {
        // Logging + continuing here: the listen succeeded, but our chmod
        // didn't. The operator can re-chmod the file manually. A future
        // hardening pass might tear the socket down here, but for v1 a
        // visible warning is enough.
        process.stderr.write(
          `[creds-handler] failed to chmod 600 ${socketPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      resolve(server);
    });
  });
}

/**
 * Per-connection handler. Reads inbound bytes until a newline (`\n`)
 * delimiter, parses the preceding JSON, dispatches, writes the response
 * followed by `\n`, half-closes the write side.
 *
 * Each connection is one request/reply cycle — no keep-alive. This matches
 * how the cortex CLI talks: short-lived, one-shot.
 *
 * **Why newline-delimited framing instead of half-close framing?**
 * Bun's `net` shim does not reliably surface the server-side `'end'` event
 * when the client half-closes — empirically the server `'data'` handlers
 * fire but `'end'` never does, leading to a stalled request/reply where the
 * server reads forever waiting for EOF (see Bun 1.3.x net.Server behaviour).
 * Newline framing avoids the issue entirely: the server can detect the end
 * of the request without depending on `'end'`. CLI and tests use the same
 * convention.
 */
function handleConnection(
  socket: Socket,
  opts: {
    registry: AgentRegistry;
    accountSigningKey: KeyPair;
    org: string;
    credsDir: string;
  },
): void {
  socket.setEncoding("utf-8");
  let buffer = "";
  let total = 0;
  let timedOut = false;
  let replied = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    socket.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
  }, REQUEST_TIMEOUT_MS);

  const writeReply = async (raw: string): Promise<void> => {
    if (replied) return;
    replied = true;
    clearTimeout(timeout);

    const parsed = parseCredsRequest(raw);
    let response: CredsResponse;
    if (parsed.ok) {
      try {
        response = await handleRequest(parsed.request, opts);
        process.stderr.write(
          `[creds-handler] ${parsed.request.verb} agent="${parsed.request.agent_id}" ok=${response.ok}` +
            (response.creds_path ? ` creds_path=${response.creds_path}` : "") +
            (response.error ? ` error=${response.error}` : "") +
            "\n",
        );
      } catch (err) {
        // handleRequest itself shouldn't throw — its per-verb handlers
        // already wrap errors. Belt-and-braces: catch anyway so a bug
        // there doesn't kill the socket without a reply.
        response = {
          ok: false,
          verb: parsed.request.verb,
          agent_id: parsed.request.agent_id,
          error: `internal error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      response = parsed.response;
    }

    try {
      // Write + end. Newline-terminate the response so a future
      // multi-request transport (or a debug `nc(1)` client) can frame
      // replies the same way the server frames requests.
      socket.write(JSON.stringify(response) + "\n");
      socket.end();
    } catch {
      // Best-effort cleanup — peer may have closed already.
      socket.destroy();
    }
  };

  socket.on("data", (chunk: string) => {
    if (replied) return;
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      // Reject oversized requests with a structured error envelope.
      replied = true;
      clearTimeout(timeout);
      const response: CredsResponse = {
        ok: false,
        verb: "issue",
        error: `request too large (>${MAX_REQUEST_BYTES} bytes)`,
      };
      try {
        socket.write(JSON.stringify(response) + "\n");
        socket.end();
      } catch {
        socket.destroy();
      }
      return;
    }
    buffer += chunk;
    const idx = buffer.indexOf("\n");
    if (idx >= 0) {
      const line = buffer.slice(0, idx);
      // Don't await — the data callback isn't async-aware. The writeReply
      // closure handles `replied` so a follow-up chunk after the newline
      // doesn't double-reply.
      void writeReply(line);
    }
  });

  // Belt-and-braces: if the client somehow manages to half-close without
  // sending a newline (e.g. raw `nc` test, garbage probe), fall back to
  // EOF framing. Treats the entire pre-EOF buffer as one request.
  socket.on("end", () => {
    if (replied) return;
    void writeReply(buffer);
  });

  socket.on("error", (err) => {
    // Per-connection errors are common (peer hangs up, etc.). Log to
    // stderr without escalating — the daemon shouldn't crash because a
    // client misbehaved.
    process.stderr.write(
      `[creds-handler] socket error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Build the creds handler. Pure factory — does not start anything; the
 * caller invokes `handle.start()` once it's ready to accept requests.
 *
 * Compared to the prereq-C stub, this returns a live handle whose
 * `start()` opens the UNIX socket and `stop()` closes it + unlinks the
 * socket file. Both are idempotent.
 */
export function createCredsHandler(opts: CredsHandlerOpts): CredsHandler {
  const socketPath = expandTilde(opts.socketPath ?? DEFAULT_SOCKET_PATH);
  const credsDir = expandTilde(opts.credsDir ?? DEFAULT_CREDS_DIR);

  const handlerOpts = {
    registry: opts.registry,
    accountSigningKey: opts.accountSigningKey,
    org: opts.org,
    credsDir,
  };

  let server: Server | null = null;
  let started = false;
  let stopped = false;

  return {
    async start() {
      if (started) return;
      started = true;
      try {
        server = await listenOnUnixSocket(socketPath, (socket) =>
          handleConnection(socket, handlerOpts),
        );
        process.stderr.write(
          `[creds-handler] listening on ${socketPath} (creds_dir=${credsDir}, org=${opts.org})\n`,
        );
      } catch (err) {
        // Log + re-throw. cortex.ts catches this and surfaces a non-fatal
        // startup error — the bot keeps running, but `cortex creds issue`
        // won't work until the operator fixes the socket-path problem.
        process.stderr.write(
          `[creds-handler] failed to listen on ${socketPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        started = false;
        throw err;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (!server) return;

      // Best-effort close. `server.close()` waits for existing connections
      // to drain. For UNIX-local request/reply that's milliseconds. We
      // don't impose an explicit timeout — cortex.ts's shutdown drain
      // already bounds the overall stop at 15 s.
      await new Promise<void>((resolve) => {
        server!.close((err) => {
          if (err) {
            process.stderr.write(
              `[creds-handler] close error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
          resolve();
        });
      });
      server = null;

      // Unlink the socket file. Defensive: if a future daemon instance
      // listens on the same path, the leftover socket would EADDRINUSE.
      try {
        if (existsSync(socketPath)) {
          unlinkSync(socketPath);
        }
      } catch (err) {
        process.stderr.write(
          `[creds-handler] unlink ${socketPath} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}
