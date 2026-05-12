/**
 * cortex#67 — creds-handler tests.
 *
 * Two layers:
 *
 *   1. **Surface + idempotence** (carried from the prereq-C stub) — the
 *      factory shape and lifecycle invariants stay intact. Tests pinned at
 *      this layer protect the public type from accidental regressions.
 *   2. **End-to-end fake-daemon** — spin up the real handler against a
 *      tmp socket path + tmp creds dir + a fresh `nkeys.createAccount()`
 *      signing key, then drive `issue` / `revoke` / `rotate` via a local
 *      UNIX-socket client. Asserts the cred file lands at the expected
 *      path with chmod 600, that the JWT decodes back to the agent's
 *      capabilities, that the narrower stubs return the documented
 *      responses, and that error paths produce structured envelopes.
 *
 * We do NOT stand up a real `nats-server` here — the handler's JWT-minting
 * is pure crypto. The integration test that verifies a real `nats-server`
 * accepts these creds lives downstream of cortex#67.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { connect, createServer, type Socket } from "net";
import { createAccount, type KeyPair } from "nkeys.js";
import { decode, type User } from "@nats-io/jwt";

import {
  createCredsHandler,
  handleRequest,
  parseCredsRequest,
  type CredsHandlerOpts,
  type CredsRequest,
  type CredsResponse,
} from "../creds-handler";
import { AgentRegistry } from "../../common/agents/registry";
import type { Agent } from "../../common/types/cortex-config";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

// =============================================================================
// Fixture builders
// =============================================================================

/**
 * Disabled MyelinRuntime — the v1 handler doesn't reach into the runtime
 * (UNIX-socket only); the field exists for v2 forward-compat. We pass a
 * disabled stub so the type satisfies without any side effects.
 */
function fakeRuntime(): MyelinRuntime {
  return {
    enabled: false,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
}

/**
 * Build a fake agent with the given id + capabilities. The runtime block is
 * populated so `agent.runtime.capabilities` flows into the minted JWT.
 *
 * Other fields (persona, presence) are set to minimal-valid placeholders so
 * `AgentRegistry.fromAgents` accepts the entry. None of them factor into
 * the creds handler's behaviour.
 */
function fakeAgent(id: string, capabilities: string[]): Agent {
  return {
    id,
    displayName: id,
    persona: `/tmp/${id}-persona.md`,
    roles: [],
    trust: [],
    presence: {
      discord: {
        enabled: false,
        token: "fake",
        guildId: "0",
        agentChannelId: "1",
        logChannelId: "2",
        contextDepth: 10,
        enableAgentLog: false,
        roles: [],
        defaultRole: "allow-all",
        dm: {
          operatorRole: {
            features: ["chat", "async", "team"],
            disallowedTools: [],
            bashGuard: true,
          },
          defaultRole: "denied",
          userRoles: [],
        },
      },
    },
    runtime: {
      substrate: "claude-code",
      mode: "in-process",
      capabilities,
    },
  } as Agent;
}

/** Default single-agent registry. */
function fakeRegistry(): AgentRegistry {
  return AgentRegistry.fromAgents([fakeAgent("scout", ["research"])]);
}

/**
 * Build CredsHandlerOpts with a fresh signing key + tmp creds dir + tmp
 * socket path. Returns the opts plus the temp paths so tests can assert
 * against / clean up the temp state.
 */
interface FakeOptsResult {
  opts: CredsHandlerOpts;
  socketPath: string;
  credsDir: string;
  signingKey: KeyPair;
  cleanup: () => void;
}
function fakeOpts(overrides?: { registry?: AgentRegistry; org?: string }): FakeOptsResult {
  const tmpRoot = mkdtempSync(join(tmpdir(), "cortex-creds-test-"));
  const socketPath = join(tmpRoot, "cortex.sock");
  const credsDir = join(tmpRoot, "creds");
  const signingKey = createAccount();
  const opts: CredsHandlerOpts = {
    runtime: fakeRuntime(),
    registry: overrides?.registry ?? fakeRegistry(),
    accountSigningKey: signingKey,
    org: overrides?.org ?? "acme",
    socketPath,
    credsDir,
  };
  return {
    opts,
    socketPath,
    credsDir,
    signingKey,
    cleanup: () => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// =============================================================================
// Surface shape + idempotence (carried from prereq-C stub)
// =============================================================================

describe("createCredsHandler — surface", () => {
  test("returns a handle with async start and stop methods", () => {
    const fixture = fakeOpts();
    try {
      const handle = createCredsHandler(fixture.opts);
      expect(handle).toBeDefined();
      expect(typeof handle.start).toBe("function");
      expect(typeof handle.stop).toBe("function");
    } finally {
      fixture.cleanup();
    }
  });

  test("stop() returns a Promise even before start()", () => {
    const fixture = fakeOpts();
    try {
      const handle = createCredsHandler(fixture.opts);
      const result = handle.stop();
      expect(result).toBeInstanceOf(Promise);
      return result.finally(fixture.cleanup);
    } catch (err) {
      fixture.cleanup();
      throw err;
    }
  });
});

describe("createCredsHandler — idempotent lifecycle", () => {
  test("start() can be called twice without throwing", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      await handle.start();
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("stop() can be called twice without throwing", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      await handle.stop();
      await handle.stop();
    } finally {
      fixture.cleanup();
    }
  });

  test("stop() before start() is a safe no-op", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.stop();
    } finally {
      fixture.cleanup();
    }
  });
});

// =============================================================================
// handleRequest — transport-agnostic core
// =============================================================================

describe("handleRequest — issue", () => {
  test("issue mints + writes a chmod-600 creds file at credsDir/{agentId}.creds", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "issue", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(true);
      expect(response.verb).toBe("issue");
      expect(response.agent_id).toBe("scout");
      expect(response.creds_path).toBe(join(fixture.credsDir, "scout.creds"));

      // File exists and has chmod 600.
      const stat = statSync(response.creds_path!);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== "win32") {
        // mode & 0o777 to mask off the file-type bits.
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("issue rejects unknown agent_id", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "issue", agent_id: "ghost" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/unknown agent "ghost"/);
      expect(response.agent_id).toBe("ghost");
    } finally {
      fixture.cleanup();
    }
  });

  test("issued JWT scopes pub+sub to agent's runtime.capabilities", async () => {
    const fixture = fakeOpts({
      registry: AgentRegistry.fromAgents([fakeAgent("multi", ["code-review", "typescript"])]),
    });
    try {
      const response = await handleRequest(
        { verb: "issue", agent_id: "multi" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(true);
      expect(response.user_jwt_summary).toBeDefined();
      expect(response.user_jwt_summary?.capabilities).toEqual(["code-review", "typescript"]);

      // Decode the .creds file contents to recover the JWT and assert the
      // capability subjects landed on the allow lists.
      //
      // `@nats-io/jwt`'s `fmtCreds` emits dash count `-----BEGIN...-----`
      // (5 dashes each side) for the BEGIN line and `------END...------`
      // (6 dashes each side) for the END line. We don't pin the exact
      // dash count here — match BEGIN with `>=3` dashes either side and
      // capture the body up to the matching END marker. Keeps the
      // assertion forward-compat with formatter tweaks.
      const credsFile = readFileSync(response.creds_path!, "utf-8");
      const jwtMatch = credsFile.match(
        /-{3,}\s*BEGIN NATS USER JWT\s*-{3,}\s+([A-Za-z0-9._-]+)\s+-{3,}\s*END NATS USER JWT\s*-{3,}/,
      );
      expect(jwtMatch).toBeTruthy();
      const decoded = decode<User>(jwtMatch![1]!);
      expect(decoded.nats.pub?.allow).toContain("local.acme.code-review.>");
      expect(decoded.nats.pub?.allow).toContain("local.acme.typescript.>");
      expect(decoded.nats.sub?.allow).toContain("local.acme.code-review.>");
      expect(decoded.nats.sub?.allow).toContain("local.acme.typescript.>");
    } finally {
      fixture.cleanup();
    }
  });

  test("issue accepts agent with no runtime block (defaults to empty caps)", async () => {
    const noRuntimeAgent = fakeAgent("bare", []);
    delete (noRuntimeAgent as { runtime?: unknown }).runtime;
    const fixture = fakeOpts({
      registry: AgentRegistry.fromAgents([noRuntimeAgent]),
    });
    try {
      const response = await handleRequest(
        { verb: "issue", agent_id: "bare" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(true);
      expect(response.user_jwt_summary?.capabilities).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("issue user_jwt_summary contains sub + iss public keys", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "issue", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      // sub starts with `U` (user nkey pubkey), iss with `A` (account
      // signing key pubkey).
      expect(response.user_jwt_summary?.sub).toMatch(/^U/);
      expect(response.user_jwt_summary?.iss).toMatch(/^A/);
      expect(response.user_jwt_summary?.iss).toBe(fixture.signingKey.getPublicKey());
    } finally {
      fixture.cleanup();
    }
  });
});

describe("handleRequest — revoke (narrower stub)", () => {
  test("revoke returns ok=false with server_side_revoke_not_implemented", async () => {
    const fixture = fakeOpts();
    try {
      // Pre-seed an existing creds file so the unlink path runs.
      writeFileSync(join(fixture.credsDir, "scout.creds"), "stub-creds", {
        mode: 0o600,
      });
      // Ensure the dir exists first — writeFileSync above will fail if not.
      // Use mkdir + write in two steps.
    } catch {
      // expected on first run when dir doesn't exist; create it
      const fs = await import("fs");
      fs.mkdirSync(fixture.credsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(fixture.credsDir, "scout.creds"), "stub-creds", {
        mode: 0o600,
      });
    }
    try {
      const response = await handleRequest(
        { verb: "revoke", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(false);
      expect(response.error).toBe("server_side_revoke_not_implemented");
      expect(response.file_deleted).toBe(true);
      expect(response.message).toMatch(/v1 only deletes the local \.creds file/);
    } finally {
      fixture.cleanup();
    }
  });

  test("revoke on a non-existent file reports file_deleted=false but still narrower-stub error", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "revoke", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(false);
      expect(response.error).toBe("server_side_revoke_not_implemented");
      expect(response.file_deleted).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("handleRequest — rotate (narrower stub)", () => {
  test("rotate deletes old + writes new creds + signals deferred server-side revoke", async () => {
    const fixture = fakeOpts();
    try {
      // First, issue to land an initial file.
      await handleRequest(
        { verb: "issue", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      const before = readFileSync(join(fixture.credsDir, "scout.creds"), "utf-8");

      const response = await handleRequest(
        { verb: "rotate", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(true);
      expect(response.verb).toBe("rotate");
      expect(response.file_deleted).toBe(true);
      expect(response.message).toMatch(/server-side revoke of the old JWT is pending/);
      expect(response.creds_path).toBe(join(fixture.credsDir, "scout.creds"));

      const after = readFileSync(join(fixture.credsDir, "scout.creds"), "utf-8");
      expect(after).not.toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  test("rotate on agent with no prior file still mints fresh + reports file_deleted=false", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "rotate", agent_id: "scout" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(true);
      expect(response.file_deleted).toBe(false);
      expect(response.creds_path).toBe(join(fixture.credsDir, "scout.creds"));
    } finally {
      fixture.cleanup();
    }
  });

  test("rotate on unknown agent returns ok=false from underlying issue", async () => {
    const fixture = fakeOpts();
    try {
      const response = await handleRequest(
        { verb: "rotate", agent_id: "ghost" },
        {
          registry: fixture.opts.registry,
          accountSigningKey: fixture.signingKey,
          org: "acme",
          credsDir: fixture.credsDir,
        },
      );
      expect(response.ok).toBe(false);
      expect(response.verb).toBe("rotate");
      expect(response.error).toMatch(/unknown agent/);
    } finally {
      fixture.cleanup();
    }
  });
});

// =============================================================================
// parseCredsRequest
// =============================================================================

describe("parseCredsRequest", () => {
  test("accepts well-formed envelope", () => {
    const result = parseCredsRequest(JSON.stringify({ verb: "issue", agent_id: "scout" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.verb).toBe("issue");
      expect(result.request.agent_id).toBe("scout");
    }
  });

  test("rejects non-JSON", () => {
    const result = parseCredsRequest("not-json{");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.error).toMatch(/not valid JSON/);
    }
  });

  test("rejects JSON arrays", () => {
    const result = parseCredsRequest(JSON.stringify(["issue"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.error).toMatch(/expected JSON object/);
    }
  });

  test("rejects unknown verb", () => {
    const result = parseCredsRequest(JSON.stringify({ verb: "delete", agent_id: "scout" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.error).toMatch(/verb must be one of/);
    }
  });

  test("rejects missing agent_id", () => {
    const result = parseCredsRequest(JSON.stringify({ verb: "issue" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.error).toMatch(/agent_id must be a non-empty string/);
    }
  });

  test("rejects empty agent_id", () => {
    const result = parseCredsRequest(JSON.stringify({ verb: "issue", agent_id: "" }));
    expect(result.ok).toBe(false);
  });
});

// =============================================================================
// End-to-end fake-daemon — UNIX socket transport
// =============================================================================

/**
 * Send a single JSON request over a UNIX socket and read the JSON reply.
 *
 * Wire format is newline-delimited JSON: `{...request...}\n` → `{...reply...}\n`.
 * The newline framing avoids a Bun-specific issue where the server's `'end'`
 * event doesn't fire on client half-close (see `handleConnection`'s comment).
 */
function unixSocketRequest(
  socketPath: string,
  request: CredsRequest | unknown,
): Promise<CredsResponse> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    client.setEncoding("utf-8");

    client.on("connect", () => {
      // Newline-terminated send — the server frames on newline.
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
    });

    client.on("end", () => {
      const raw = buffer.trim();
      try {
        resolve(JSON.parse(raw) as CredsResponse);
      } catch (err) {
        reject(new Error(`unixSocketRequest: bad reply "${raw}": ${err}`));
      }
    });

    client.on("error", reject);
  });
}

describe("end-to-end fake-daemon — UNIX socket transport", () => {
  test("issue → list (file landed chmod 600) → revoke (narrower stub) → rotate (new file)", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();

      // 1) issue
      const issueResp = await unixSocketRequest(fixture.socketPath, {
        verb: "issue",
        agent_id: "scout",
      });
      expect(issueResp.ok).toBe(true);
      expect(issueResp.creds_path).toBe(join(fixture.credsDir, "scout.creds"));

      // 2) verify file landed with chmod 600
      const stat = statSync(issueResp.creds_path!);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }

      // 3) revoke — narrower stub
      const revokeResp = await unixSocketRequest(fixture.socketPath, {
        verb: "revoke",
        agent_id: "scout",
      });
      expect(revokeResp.ok).toBe(false);
      expect(revokeResp.error).toBe("server_side_revoke_not_implemented");
      expect(revokeResp.file_deleted).toBe(true);

      // 4) issue again so rotate has a prior file to delete
      await unixSocketRequest(fixture.socketPath, {
        verb: "issue",
        agent_id: "scout",
      });
      const before = readFileSync(join(fixture.credsDir, "scout.creds"), "utf-8");

      // 5) rotate — new file, narrower-stub message
      const rotateResp = await unixSocketRequest(fixture.socketPath, {
        verb: "rotate",
        agent_id: "scout",
      });
      expect(rotateResp.ok).toBe(true);
      expect(rotateResp.file_deleted).toBe(true);
      expect(rotateResp.message).toMatch(/server-side revoke of the old JWT is pending/);
      const after = readFileSync(join(fixture.credsDir, "scout.creds"), "utf-8");
      expect(after).not.toBe(before);
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("issue on unknown agent returns structured error envelope", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      const response = await unixSocketRequest(fixture.socketPath, {
        verb: "issue",
        agent_id: "nobody",
      });
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/unknown agent "nobody"/);
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("malformed request envelope (non-JSON) returns structured error", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      // Send raw garbage bytes followed by the newline framer so the
      // server doesn't have to wait for EOF.
      const garbageReply: string = await new Promise((resolve, reject) => {
        const client = connect(fixture.socketPath);
        let buf = "";
        client.setEncoding("utf-8");
        client.on("connect", () => {
          client.write("not-json{\n");
        });
        client.on("data", (c: string) => {
          buf += c;
        });
        client.on("end", () => resolve(buf.trim()));
        client.on("error", reject);
      });
      const parsed = JSON.parse(garbageReply) as CredsResponse;
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/not valid JSON/);
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("malformed request envelope (unknown verb) returns structured error", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      const response = await unixSocketRequest(fixture.socketPath, {
        verb: "delete",
        agent_id: "scout",
      });
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/verb must be one of/);
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("socket file has chmod 600 after listen", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      const stat = statSync(fixture.socketPath);
      expect(stat.isSocket()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("stop() unlinks the socket file", async () => {
    const fixture = fakeOpts();
    const handle = createCredsHandler(fixture.opts);
    try {
      await handle.start();
      expect(() => statSync(fixture.socketPath)).not.toThrow();
      await handle.stop();
      // After stop, the socket file should be gone.
      let stillThere = true;
      try {
        statSync(fixture.socketPath);
      } catch {
        stillThere = false;
      }
      expect(stillThere).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("start() recovers from a stale socket file left by a prior crash", async () => {
    const fixture = fakeOpts();
    // Simulate a prior crash by listening on the path and tearing down the
    // server without unlinking. We use a raw net.createServer fake here
    // because we want a real `isSocket()`-true leftover.
    const orphan = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      const fs = require("fs");
      fs.mkdirSync(dirname(fixture.socketPath), { recursive: true });
      orphan.once("error", reject);
      orphan.listen(fixture.socketPath, () => resolve());
    });
    // Close the listener but DO NOT unlink. On POSIX, server.close()
    // removes the inode for an AF_UNIX listener — so to truly simulate
    // a crash, we force-leave a socket file behind by re-creating it.
    await new Promise<void>((resolve) => orphan.close(() => resolve()));
    // Re-create the leftover socket file by listening + crashing-by-unref.
    // Simpler: just write an empty file at the path and chmod it to look
    // socket-ish — but statSync().isSocket() requires an actual socket.
    // So instead, we listen a second time and let our handler clean it up.
    const orphan2 = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      orphan2.once("error", reject);
      orphan2.listen(fixture.socketPath, () => resolve());
    });
    // Now our handler should clean it up on start.
    const handle = createCredsHandler(fixture.opts);
    try {
      // Drop the orphan listener WITHOUT awaiting close-callback so the
      // socket file may still be present on POSIX when our handler starts.
      orphan2.close();
      // tiny yield so the orphan close has a chance to schedule cleanup
      await new Promise((r) => setTimeout(r, 10));
      await handle.start();
      // If start succeeded, the handler is now listening.
      const response = await unixSocketRequest(fixture.socketPath, {
        verb: "issue",
        agent_id: "scout",
      });
      expect(response.ok).toBe(true);
    } finally {
      await handle.stop();
      fixture.cleanup();
    }
  });

  test("refuses to clobber a non-socket file at the socket path", async () => {
    const fixture = fakeOpts();
    // Plant a regular file at the socket path so the handler must refuse.
    const fs = require("fs");
    fs.mkdirSync(dirname(fixture.socketPath), { recursive: true });
    writeFileSync(fixture.socketPath, "i am not a socket");
    chmodSync(fixture.socketPath, 0o600);
    const handle = createCredsHandler(fixture.opts);
    try {
      let threw: unknown = null;
      try {
        await handle.start();
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeTruthy();
      expect(threw instanceof Error && threw.message).toMatch(/not a socket/);
    } finally {
      // The handler refused to start, so stop is a safe no-op.
      await handle.stop();
      fixture.cleanup();
    }
  });
});
