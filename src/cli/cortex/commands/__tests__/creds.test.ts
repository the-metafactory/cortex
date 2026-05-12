// F-4 — cortex creds CLI tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type Server } from "net";

import {
  parseCredsArgs,
  runCredsList,
  runCredsIssue,
  runCredsRevoke,
  runCredsRotate,
  dispatchCreds,
  DEFERRED_SUBCOMMAND_MESSAGE,
} from "../creds";
import { CliArgsError } from "../_shared/arg-error";

// =============================================================================
// Mock daemon fixture
// =============================================================================
//
// The CLI talks to the daemon over a UNIX socket; for IPC tests we spin up
// a tiny fake server that reads one JSON line and replies with a programmable
// response. Matches the daemon's newline-delimited framing exactly
// (see `src/runner/creds-handler.ts` — `handleConnection`).
//
// We DO NOT import the real `createCredsHandler` here — the CLI tests assert
// the CLI behaviour against the daemon's wire contract, not the daemon's
// internals. The end-to-end test in `src/runner/__tests__/creds-handler.test.ts`
// already exercises the real handler.

interface MockDaemonReply {
  ok: boolean;
  verb?: "issue" | "revoke" | "rotate";
  agent_id?: string;
  error?: string;
  message?: string;
  creds_path?: string;
  file_deleted?: boolean;
  user_jwt_summary?: { sub: string; iss: string; capabilities: string[] };
}

interface MockDaemon {
  socketPath: string;
  /** Most recent request the daemon received — for assertions. */
  lastRequest: { verb: string; agent_id: string } | null;
  stop: () => Promise<void>;
}

function startMockDaemon(reply: MockDaemonReply | ((req: { verb: string; agent_id: string }) => MockDaemonReply)): Promise<MockDaemon> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "f4-mock-daemon-"));
  const socketPath = join(tmpRoot, "cortex.sock");

  const state: { lastRequest: { verb: string; agent_id: string } | null } = {
    lastRequest: null,
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer((sock) => {
      sock.setEncoding("utf-8");
      let buffer = "";
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        try {
          const parsed = JSON.parse(line) as { verb: string; agent_id: string };
          state.lastRequest = parsed;
          const response = typeof reply === "function" ? reply(parsed) : reply;
          sock.write(JSON.stringify(response) + "\n");
          sock.end();
        } catch (err) {
          // Forward parse-failure to client so the client's
          // "malformed-reply" path is testable too.
          sock.write(
            JSON.stringify({ ok: false, error: `mock-daemon-parse-fail: ${err}` }) + "\n",
          );
          sock.end();
        }
      });
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        get lastRequest() {
          return state.lastRequest;
        },
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => {
              try {
                rmSync(tmpRoot, { recursive: true, force: true });
              } catch {
                // best-effort
              }
              res();
            });
          }),
      });
    });
  });
}

// =============================================================================
// parseCredsArgs
// =============================================================================

describe("parseCredsArgs", () => {
  test("parses 'list' subcommand", () => {
    expect(parseCredsArgs(["list"]).subcommand).toBe("list");
  });

  test("parses 'issue <id>' subcommand", () => {
    const args = parseCredsArgs(["issue", "echo"]);
    expect(args.subcommand).toBe("issue");
    expect(args.agentId).toBe("echo");
  });

  test("parses 'revoke <id>' subcommand", () => {
    const args = parseCredsArgs(["revoke", "echo"]);
    expect(args.subcommand).toBe("revoke");
    expect(args.agentId).toBe("echo");
  });

  test("parses 'rotate <id>' subcommand", () => {
    const args = parseCredsArgs(["rotate", "echo"]);
    expect(args.subcommand).toBe("rotate");
    expect(args.agentId).toBe("echo");
  });

  test("--help yields subcommand=help", () => {
    expect(parseCredsArgs(["--help"]).subcommand).toBe("help");
    expect(parseCredsArgs(["-h"]).subcommand).toBe("help");
  });

  test("no args → unknown", () => {
    expect(parseCredsArgs([]).subcommand).toBe("unknown");
  });

  test("unknown subcommand → unknown", () => {
    expect(parseCredsArgs(["status"]).subcommand).toBe("unknown");
    expect(parseCredsArgs(["status"]).rawSubcommand).toBe("status");
  });

  test("parses --creds-dir flag", () => {
    const args = parseCredsArgs(["list", "--creds-dir", "/tmp/foo"]);
    expect(args.credsDir).toBe("/tmp/foo");
  });

  test("parses --json flag", () => {
    expect(parseCredsArgs(["list", "--json"]).json).toBe(true);
  });

  test("parses --config flag", () => {
    const args = parseCredsArgs(["issue", "echo", "--config", "/tmp/cortex.yaml"]);
    expect(args.config).toBe("/tmp/cortex.yaml");
  });

  test("parses --socket flag for issue/revoke/rotate", () => {
    const issueArgs = parseCredsArgs(["issue", "echo", "--socket", "/tmp/my.sock"]);
    expect(issueArgs.socket).toBe("/tmp/my.sock");
    const revokeArgs = parseCredsArgs(["revoke", "echo", "--socket", "/tmp/my.sock"]);
    expect(revokeArgs.socket).toBe("/tmp/my.sock");
    const rotateArgs = parseCredsArgs(["rotate", "echo", "--socket", "/tmp/my.sock"]);
    expect(rotateArgs.socket).toBe("/tmp/my.sock");
  });

  test("--socket is rejected on list", () => {
    expect(() => parseCredsArgs(["list", "--socket", "/tmp/x.sock"])).toThrow(CliArgsError);
  });

  describe("CliArgsError throws", () => {
    test("throws when --creds-dir is missing its value", () => {
      expect(() => parseCredsArgs(["list", "--creds-dir"])).toThrow(CliArgsError);
    });

    test("throws when --config is missing its value", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--config"])).toThrow(CliArgsError);
    });

    test("throws on unknown flag", () => {
      expect(() => parseCredsArgs(["list", "--verbose"])).toThrow(CliArgsError);
    });

    test("throws on extra positional argument for list", () => {
      expect(() => parseCredsArgs(["list", "extra"])).toThrow(CliArgsError);
    });

    test("throws on extra positional for issue beyond <id>", () => {
      expect(() => parseCredsArgs(["issue", "echo", "extra"])).toThrow(CliArgsError);
    });
  });

  // Echo M3 on cortex#64 — per-subcommand flag allowlist.
  describe("per-subcommand flag scoping (Echo M3)", () => {
    test("--creds-dir is rejected on issue", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--creds-dir is rejected on revoke", () => {
      expect(() => parseCredsArgs(["revoke", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--creds-dir is rejected on rotate", () => {
      expect(() => parseCredsArgs(["rotate", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--config is rejected on list", () => {
      expect(() => parseCredsArgs(["list", "--config", "/tmp/c.yaml"])).toThrow(
        CliArgsError,
      );
    });

    test("--json is universal", () => {
      // Should not throw for any subcommand
      expect(parseCredsArgs(["list", "--json"]).json).toBe(true);
      expect(parseCredsArgs(["issue", "echo", "--json"]).json).toBe(true);
    });
  });
});

// =============================================================================
// runCredsList
// =============================================================================

describe("runCredsList", () => {
  test("lists creds files in a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-list-"));
    writeFileSync(join(dir, "echo.creds"), "-----BEGIN NATS USER JWT-----\n...\n");
    writeFileSync(join(dir, "holly.creds"), "-----BEGIN NATS USER JWT-----\n...\n");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
    expect(r.stdout).toContain("holly");
  });

  test("output is sorted alphabetically by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-sort-"));
    writeFileSync(join(dir, "zeta.creds"), "x");
    writeFileSync(join(dir, "alpha.creds"), "x");
    writeFileSync(join(dir, "mike.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    const lines = r.stdout.trim().split("\n");
    // First three lines should be the alphabetical order
    expect(lines[0]).toContain("alpha");
    expect(lines[1]).toContain("mike");
    expect(lines[2]).toContain("zeta");
  });

  test("empty dir → exit 0 with friendly message", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-empty-"));
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/0 creds/);
  });

  test("nonexistent dir → exit 0 with 'no creds dir' message", () => {
    const r = runCredsList(
      parseCredsArgs(["list", "--creds-dir", "/tmp/nonexistent-f4-xyz"]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/0 creds/);
  });

  test("skips dotfiles silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-dotfiles-"));
    writeFileSync(join(dir, ".DS_Store"), "");
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.stdout).toContain("echo");
    expect(r.stdout).not.toContain("DS_Store");
  });

  test("--json emits envelope with creds array", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-list-json-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items[0].id).toBe("echo");
    expect(parsed.items[0].path).toContain("echo.creds");
    expect(parsed.items[0].issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("--json on empty dir emits envelope with creds: []", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-empty-json-"));
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.items).toEqual([]);
  });

  test("strips multiple extensions (e.g. echo.creds.json → echo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-multi-ext-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    writeFileSync(join(dir, "holly.nats.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.stdout).toContain("echo");
  });

  // Echo M1 on cortex#64 — id derivation now validates against agent-id
  // regex and detects collisions.
  describe("filesystem id hygiene (Echo M1)", () => {
    test("skips files whose stem doesn't match /^[a-z0-9-]+$/", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-bad-stem-"));
      writeFileSync(join(dir, "Echo!.creds"), "x"); // uppercase + special char
      writeFileSync(join(dir, "ok-agent.creds"), "x");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok-agent");
      expect(r.stdout).not.toContain("Echo!");
      // Warning on stderr names the skipped file
      expect(r.stderr).toContain("Echo!.creds");
      expect(r.stderr).toMatch(/doesn't match agent-id regex/);
    });

    test("skips id collisions and warns naming both files", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-collide-"));
      writeFileSync(join(dir, "echo.creds"), "first");
      writeFileSync(join(dir, "echo.nats.creds"), "second");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
      // Only one "echo" in output (the first one alphabetically) — collision warned
      const lines = r.stdout.trim().split("\n").filter((l) => l.startsWith("echo"));
      expect(lines).toHaveLength(1);
      expect(r.stderr).toContain("echo.creds");
      expect(r.stderr).toContain("echo.nats.creds");
      expect(r.stderr).toMatch(/already taken/);
    });

    test("malformed stems are reported in JSON mode via stderr (not envelope)", () => {
      // JSON envelope is for machine-readable success/items shape; warnings
      // are diagnostic information for humans + log scrapers. They live on
      // stderr regardless of --json.
      const dir = mkdtempSync(join(tmpdir(), "f4-bad-stem-json-"));
      writeFileSync(join(dir, "BadName.creds"), "x");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.items).toEqual([]);
      expect(r.stderr).toContain("BadName.creds");
    });
  });

  // cortex#65 — Echo round-2 H1 nit on cortex#64: cap was enforced in
  // code but not exercised by a test. Closes the regression risk if
  // someone flips `>` to `>=`.
  describe("hardening cap (Echo H1)", () => {
    test("refuses to enumerate when directory has > 10_000 entries", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-h1-cap-"));
      for (let i = 0; i < 10_001; i++) {
        writeFileSync(join(dir, `agent-${i}.creds`), "x");
      }
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/refusing to enumerate/);
      expect(r.stderr).toContain("10001");
      expect(r.stderr).toContain("10000");
    });

    test("accepts exactly 10_000 entries (boundary)", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-h1-boundary-"));
      for (let i = 0; i < 10_000; i++) {
        writeFileSync(join(dir, `agent-${i}.creds`), "x");
      }
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
    });
  });
});

// =============================================================================
// Input validation — runs before any IPC, no daemon required
// =============================================================================

describe("operator-input validation", () => {
  test("issue rejects invalid agent id (not lowercase alphanumeric)", async () => {
    const r = await runCredsIssue(parseCredsArgs(["issue", "Echo!"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/agent id/i);
  });

  test("issue rejects empty agent id", async () => {
    const r = await runCredsIssue({
      ...parseCredsArgs(["issue", "x"]),
      agentId: "",
    });
    expect(r.exitCode).toBe(2);
  });

  test("revoke rejects invalid agent id", async () => {
    const r = await runCredsRevoke(parseCredsArgs(["revoke", "BAD!"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/agent id/i);
  });

  test("rotate rejects invalid agent id", async () => {
    const r = await runCredsRotate(parseCredsArgs(["rotate", "BAD!"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/agent id/i);
  });

  test("DEFERRED_SUBCOMMAND_MESSAGE constant is still exported", () => {
    // Backward-compat: pre-cortex#67 consumers parsed this string from stderr.
    // The string survives as an exported constant; the CLI doesn't emit it as
    // the typical user-facing message anymore (the IPC client returns
    // operator-actionable errors), but the export remains for any tooling
    // that pinned against it.
    expect(typeof DEFERRED_SUBCOMMAND_MESSAGE).toBe("string");
    expect(DEFERRED_SUBCOMMAND_MESSAGE.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// IPC client — happy path with mock daemon
// =============================================================================

describe("IPC happy path — issue", () => {
  test("issue via mock daemon → exit 0 with creds_path summary", async () => {
    const daemon = await startMockDaemon({
      ok: true,
      verb: "issue",
      agent_id: "scout",
      creds_path: "/tmp/scout.creds",
      user_jwt_summary: { sub: "USCOUT", iss: "AACME", capabilities: ["research"] },
    });
    try {
      const r = await runCredsIssue(
        parseCredsArgs(["issue", "scout", "--socket", daemon.socketPath]),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok");
      expect(r.stdout).toContain("scout");
      expect(r.stdout).toContain("/tmp/scout.creds");
      expect(r.stdout).toContain("USCOUT");
      expect(r.stdout).toContain("research");
      expect(daemon.lastRequest?.verb).toBe("issue");
      expect(daemon.lastRequest?.agent_id).toBe("scout");
    } finally {
      await daemon.stop();
    }
  });

  test("issue --json → exit 0 with envelope status=ok", async () => {
    const daemon = await startMockDaemon({
      ok: true,
      verb: "issue",
      agent_id: "scout",
      creds_path: "/tmp/scout.creds",
      user_jwt_summary: { sub: "USCOUT", iss: "AACME", capabilities: ["research"] },
    });
    try {
      const r = await runCredsIssue(
        parseCredsArgs(["issue", "scout", "--socket", daemon.socketPath, "--json"]),
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.items).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });
});

describe("IPC happy path — revoke (narrower stub)", () => {
  test("revoke ok=false + server_side_revoke_not_implemented → exit 1 with message", async () => {
    const daemon = await startMockDaemon({
      ok: false,
      verb: "revoke",
      agent_id: "scout",
      error: "server_side_revoke_not_implemented",
      message:
        "Server-side NATS account-JWT revoke is pending system-account topology " +
        "design. v1 only deletes the local .creds file. File deleted: true",
      file_deleted: true,
    });
    try {
      const r = await runCredsRevoke(
        parseCredsArgs(["revoke", "scout", "--socket", daemon.socketPath]),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("server_side_revoke_not_implemented");
      expect(r.stderr).toContain("pending system-account topology design");
      expect(r.stderr).toContain("file_deleted: true");
    } finally {
      await daemon.stop();
    }
  });

  test("revoke --json → envelope context carries daemon message + file_deleted", async () => {
    const daemon = await startMockDaemon({
      ok: false,
      verb: "revoke",
      agent_id: "scout",
      error: "server_side_revoke_not_implemented",
      message: "v1 only deletes the local .creds file. File deleted: false",
      file_deleted: false,
    });
    try {
      const r = await runCredsRevoke(
        parseCredsArgs(["revoke", "scout", "--socket", daemon.socketPath, "--json"]),
      );
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("error");
      expect(parsed.error.reason).toBe("server_side_revoke_not_implemented");
      expect(parsed.error.context.subcommand).toBe("revoke");
      expect(parsed.error.context.agentId).toBe("scout");
      expect(parsed.error.context.file_deleted).toBe("false");
      expect(parsed.error.context.message).toContain("v1 only deletes");
    } finally {
      await daemon.stop();
    }
  });
});

describe("IPC happy path — rotate (narrower stub)", () => {
  test("rotate ok=true with deferred-server-side message → exit 0 + note in stdout", async () => {
    const daemon = await startMockDaemon({
      ok: true,
      verb: "rotate",
      agent_id: "scout",
      creds_path: "/tmp/scout.creds",
      file_deleted: true,
      user_jwt_summary: { sub: "USCOUT2", iss: "AACME", capabilities: ["research"] },
      message:
        "v1: local file rotated; server-side revoke of the old JWT is pending " +
        "system-account topology design.",
    });
    try {
      const r = await runCredsRotate(
        parseCredsArgs(["rotate", "scout", "--socket", daemon.socketPath]),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok");
      expect(r.stdout).toContain("note:");
      expect(r.stdout).toContain("server-side revoke of the old JWT is pending");
    } finally {
      await daemon.stop();
    }
  });
});

describe("IPC error path — daemon-reported failures", () => {
  test("unknown agent → daemon returns ok=false → CLI exit 1", async () => {
    const daemon = await startMockDaemon({
      ok: false,
      verb: "issue",
      agent_id: "ghost",
      error: 'unknown agent "ghost" — not in cortex agent registry',
    });
    try {
      const r = await runCredsIssue(
        parseCredsArgs(["issue", "ghost", "--socket", daemon.socketPath]),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('unknown agent "ghost"');
    } finally {
      await daemon.stop();
    }
  });
});

describe("IPC error path — daemon unreachable", () => {
  test("issue with no daemon listening → exit 1 with operator-actionable message", async () => {
    const r = await runCredsIssue(
      parseCredsArgs([
        "issue",
        "scout",
        "--socket",
        "/tmp/nonexistent-cortex-creds-test-socket-zzz.sock",
      ]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cortex daemon not reachable");
    expect(r.stderr).toContain("--socket");
  });

  test("revoke with no daemon → exit 1 with daemon-unreachable message", async () => {
    const r = await runCredsRevoke(
      parseCredsArgs([
        "revoke",
        "scout",
        "--socket",
        "/tmp/nonexistent-cortex-creds-test-socket-zzz2.sock",
      ]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not reachable");
  });

  test("rotate with no daemon → exit 1", async () => {
    const r = await runCredsRotate(
      parseCredsArgs([
        "rotate",
        "scout",
        "--socket",
        "/tmp/nonexistent-cortex-creds-test-socket-zzz3.sock",
      ]),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not reachable");
  });

  test("daemon-unreachable --json → envelope status=error with reason", async () => {
    const r = await runCredsIssue(
      parseCredsArgs([
        "issue",
        "scout",
        "--socket",
        "/tmp/nonexistent-cortex-creds-test-socket-zzz4.sock",
        "--json",
      ]),
    );
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.error.reason).toContain("not reachable");
  });
});

// =============================================================================
// dispatchCreds
// =============================================================================

// =============================================================================
// End-to-end — CLI ↔ real daemon
// =============================================================================
//
// Wire test: spin up a real `createCredsHandler()` against a fresh tmp
// socket + tmp creds dir + a freshly-minted account signing key, then
// drive `cortex creds issue` via `dispatchCreds`. Asserts the full path
// works: CLI parses → CLI IPC client → daemon socket → real mint →
// daemon reply → CLI exit code + formatted output.
//
// Importing from `../../../runner/...` is the deliberate boundary cross —
// the e2e test is intentionally cross-layer. The unit tests in this file
// (and in `src/runner/__tests__/creds-handler.test.ts`) exercise each side
// in isolation; this single test proves they compose correctly.

import { createCredsHandler } from "../../../../runner/creds-handler";
import { AgentRegistry } from "../../../../common/agents/registry";
import type { Agent } from "../../../../common/types/cortex-config";
import { createAccount } from "nkeys.js";

describe("end-to-end — CLI → real daemon", () => {
  test("dispatchCreds 'issue' against real handler → exit 0 + .creds file landed", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "f4-e2e-"));
    const socketPath = join(tmpRoot, "cortex.sock");
    const credsDir = join(tmpRoot, "creds");
    const signingKey = createAccount();

    const agent: Agent = {
      id: "luna",
      displayName: "Luna",
      persona: "/tmp/luna.md",
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
            operatorRole: { features: ["chat"], disallowedTools: [], bashGuard: true },
            defaultRole: "denied",
            userRoles: [],
          },
        },
      },
      runtime: { substrate: "claude-code", mode: "in-process", capabilities: ["pilot"] },
    } as Agent;

    const handle = createCredsHandler({
      runtime: {
        enabled: false,
        onEnvelope: () => ({ unregister: () => {} }),
        publish: async () => {},
        stop: async () => {},
      },
      registry: AgentRegistry.fromAgents([agent]),
      accountSigningKey: signingKey,
      org: "metafactory",
      socketPath,
      credsDir,
    });

    try {
      await handle.start();

      const r = await dispatchCreds([
        "issue",
        "luna",
        "--socket",
        socketPath,
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("luna");
      expect(r.stdout).toContain(join(credsDir, "luna.creds"));
      expect(r.stdout).toContain("pilot"); // capability echoed in summary

      // Verify the file actually landed.
      const fs = await import("fs");
      expect(fs.existsSync(join(credsDir, "luna.creds"))).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(join(credsDir, "luna.creds")).mode & 0o777).toBe(0o600);
      }
    } finally {
      await handle.stop();
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});

describe("dispatchCreds", () => {
  test("routes 'list' to runCredsList", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-dispatch-list-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = await dispatchCreds(["list", "--creds-dir", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("routes 'issue' to runCredsIssue (daemon unreachable → exit 1)", async () => {
    const r = await dispatchCreds([
      "issue",
      "echo",
      "--socket",
      "/tmp/nonexistent-cortex-creds-test-socket-disp.sock",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not reachable");
  });

  test("routes 'issue' to runCredsIssue with mock daemon → exit 0", async () => {
    const daemon = await startMockDaemon({
      ok: true,
      verb: "issue",
      agent_id: "echo",
      creds_path: "/tmp/echo.creds",
      user_jwt_summary: { sub: "U1", iss: "A1", capabilities: [] },
    });
    try {
      const r = await dispatchCreds(["issue", "echo", "--socket", daemon.socketPath]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("echo");
    } finally {
      await daemon.stop();
    }
  });

  test("--help prints top-level help", async () => {
    const r = await dispatchCreds(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cortex creds");
    expect(r.stdout).toContain("issue");
    expect(r.stdout).toContain("revoke");
    expect(r.stdout).toContain("rotate");
    expect(r.stdout).toContain("list");
  });

  test("unknown subcommand → exit 2", async () => {
    const r = await dispatchCreds(["status"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown");
    expect(r.stderr).toContain("status");
  });

  test("no subcommand → exit 2 with help", async () => {
    const r = await dispatchCreds([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage");
  });

  test("CliArgsError → exit 2 with named flag", async () => {
    const r = await dispatchCreds(["list", "--verbose"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--verbose");
  });

  test("issue without <id> arg → exit 2 usage error", async () => {
    const r = await dispatchCreds(["issue"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/missing.*agent id|requires.*id/i);
  });
});
