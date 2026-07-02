/**
 * ADR-0015 — `cortex network admit <request-id>` CLI tests.
 *
 * Orchestration flow under test (runAdmit):
 *   1. Load + chmod-600-gate the admin seed
 *   2. Dry-run path: print plan, touch nothing
 *   3. Apply path:
 *      a. Admin-signed GET /admission-requests/:id — fetch PENDING request
 *      b. Build + POST signed admission decision (decision: "admit") to
 *         /admission-requests/:id/admit
 *      c. Optionally assign Discord role (O-5 via --discord-member)
 *
 * All live surfaces (registry HTTP, Discord API) are mocked via globalThis.fetch
 * and the DiscordAdmitClient injection seam. No arc binary is called — ADR-0015
 * retires Model-A credential minting.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  dispatchNetwork,
  __setDiscordAdmitClientForTests,
  type DiscordAdmitClient,
  type SecretPortsFactory,
} from "../network";
import type { NetworkSecretPorts } from "../network-secret-ports";
import { dispatchProvisionStack } from "../provision-stack";

/** Type-safe mock-fetch helper */
function setMockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// =============================================================================
// Fixtures and helpers
// =============================================================================

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "admit-test-"));
  tmpDirs.push(d);
  return d;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  __setDiscordAdmitClientForTests(null);
  globalThis.fetch = realFetch;
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * Mint a real admin nkey seed file (chmod 600) via provision-stack and return
 * its path + the derived base64 pubkey.
 */
async function mintAdminSeed(): Promise<{ seedPath: string; adminPubkey: string }> {
  const seedPath = join(freshDir(), "admin.nk");
  const res = await dispatchProvisionStack([
    "generate", "andreas",
    "--seed-path", seedPath,
    "--stack-id", "andreas/test",
    "--json",
  ]);
  expect(res.exitCode).toBe(0);
  const envelope = JSON.parse(res.stdout) as { data: { pubkey_b64: string } };
  return { seedPath, adminPubkey: envelope.data.pubkey_b64 };
}

/** Minimal PENDING admission request fixture */
function pendingRequest(overrides: Partial<{ principal_id: string; peer_pubkey: string; network_id: string }> = {}) {
  return {
    request_id: "req-abc-123",
    principal_id: overrides.principal_id ?? "peer-principal",
    peer_pubkey: overrides.peer_pubkey ?? "A" + "B".repeat(55),
    requested_scope: "federated.peer-principal.>",
    network_id: overrides.network_id ?? "metafactory-community",
    status: "PENDING",
    created_at: "2026-06-18T00:00:00.000Z",
    updated_at: "2026-06-18T00:00:00.000Z",
    granted_by: null,
  };
}

// =============================================================================
// Dry-run (default — no --apply)
// =============================================================================

describe("cortex network admit — dry-run (default)", () => {
  test("dry-run prints plan and exits 0 without calling registry", async () => {
    const { seedPath } = await mintAdminSeed();
    let fetchCalled = false;
    setMockFetch(async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
    ]);

    expect(res.exitCode).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("req-abc-123");
  });

  test("dry-run --json emits applied:false envelope", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () => new Response("", { status: 500 }));

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { applied: string; request_id: string } };
    expect(env.data.applied).toBe("false");
    expect(env.data.request_id).toBe("req-abc-123");
  });

  test("--apply and --dry-run together is a usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply", "--dry-run",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });
});

// =============================================================================
// Usage errors
// =============================================================================

describe("cortex network admit — usage errors", () => {
  test("missing request-id is exit 2", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "admit",
      "--admin-seed", seedPath,
      "--apply",
    ]);
    expect(res.exitCode).toBe(2);
  });

  test("missing --admin-seed is exit 2", async () => {
    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--apply",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
  });

  test("seed file does not exist → exit 1", async () => {
    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", "/nonexistent/path/admin.nk",
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not found");
  });

  test("seed file with wrong permissions → exit 1", async () => {
    const dir = freshDir();
    const seedPath = join(dir, "admin.nk");
    writeFileSync(seedPath, "SUAM...", "utf-8");
    chmodSync(seedPath, 0o644); // wrong perms
    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/600|permission/i);
  });
});

// =============================================================================
// Apply path — happy path
// =============================================================================

describe("cortex network admit — apply path", () => {
  test("successful admit: GET then POST /admit; exit 0; no arc called", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();
    const req = pendingRequest();
    let postedUrl = "";
    let postedBody: unknown = null;

    setMockFetch(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("/admission-requests/req-abc-123/admit")) {
        // POST admit
        postedUrl = url;
        if (init?.body) {
          postedBody = JSON.parse(init.body as string);
        }
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/admission-requests/req-abc-123")) {
        // GET — return PENDING request
        return new Response(JSON.stringify(req), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 404 });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    expect(postedUrl).toContain("/admission-requests/req-abc-123/admit");

    // Verify decision claim shape (ADR-0015: decision="admit", no leaf_package)
    const body = postedBody as { claim: { decision: string; admin_pubkey: string; request_id: string }; signature: string };
    expect(body.claim.decision).toBe("admit");
    expect(body.claim.request_id).toBe("req-abc-123");
    expect(body.claim.admin_pubkey).toBe(adminPubkey);
    expect(body.signature).toBeTruthy();

    // CRITICAL: No leaf_package in the body — Model-A retired
    const wireStr = JSON.stringify(body);
    expect(wireStr).not.toContain("leaf_package");
    expect(wireStr).not.toContain("credsPath");
    expect(wireStr).not.toContain(".creds");
  });

  test("successful admit with --json emits applied:true envelope", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { applied: string; request_id: string; principal_id: string } };
    expect(env.data.applied).toBe("true");
    expect(env.data.request_id).toBe("req-abc-123");
    expect(env.data.principal_id).toBe("peer-principal");
  });

  test("registry GET returns 404 → exit 1", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () => new Response("", { status: 404 }));

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("404");
  });

  test("request status is not PENDING → exit 1 with status in message", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = { ...pendingRequest(), status: "ADMITTED" };

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("ADMITTED");
  });

  test("registry POST /admit fails → exit 1", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response(JSON.stringify({ error: "admin_not_authorized" }), {
          status: 403, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("403");
  });
});

// =============================================================================
// Apply path — Discord O-5 role assignment
// =============================================================================

describe("cortex network admit — Discord O-5 role", () => {
  test("--discord-member with successful role assign → discord_status=assigned", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();
    let resolvedRole = false;
    let assignedRole = false;

    const mockDiscord: DiscordAdmitClient = {
      async resolveRoleId(_token, _guildId, roleName) {
        resolvedRole = true;
        expect(roleName).toBe("community-fleet");
        return "role-id-123";
      },
      async assignRole(_token, _guildId, userId, roleId) {
        assignedRole = true;
        expect(userId).toBe("user-snowflake-999");
        expect(roleId).toBe("role-id-123");
        return { success: true };
      },
    };
    __setDiscordAdmitClientForTests(mockDiscord);

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-snowflake-999",
      "--discord-guild", "guild-123",
      "--apply",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(resolvedRole).toBe(true);
    expect(assignedRole).toBe(true);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string } };
    expect(env.data.discord_status).toBe("assigned");
  });

  test("Discord role assign failure → exit 0 with warning (admission already committed)", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();

    const mockDiscord: DiscordAdmitClient = {
      async resolveRoleId() { return "role-id-123"; },
      async assignRole() { return { success: false, error: "missing_permissions" }; },
    };
    __setDiscordAdmitClientForTests(mockDiscord);

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-999",
      "--discord-guild", "guild-123",
      "--apply",
      "--json",
    ]);

    // Admission committed → exit 0. Discord partial failure is a warning.
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string; discord_warning?: string } };
    expect(env.data.discord_status).toBe("failed");
    expect(env.data.discord_warning).toContain("missing_permissions");
  });

  test("custom --discord-role is forwarded to resolveRoleId", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();
    let capturedRoleName = "";

    const mockDiscord: DiscordAdmitClient = {
      async resolveRoleId(_token, _guildId, roleName) {
        capturedRoleName = roleName;
        return "custom-role-id";
      },
      async assignRole() { return { success: true }; },
    };
    __setDiscordAdmitClientForTests(mockDiscord);

    setMockFetch(async (input) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-999",
      "--discord-guild", "guild-123",
      "--discord-role", "sovereign-member",
      "--apply",
    ]);

    expect(capturedRoleName).toBe("sovereign-member");
  });
});

// =============================================================================
// C-1316 — admit-and-seal (fold the leaf-secret seal into admit)
// =============================================================================

interface SealCalls {
  reads: number;
  writes: number;
  reloads: number;
  posted: string[];
  minted: string[];
}

/**
 * A recording fake secret-ports factory injected into `dispatchNetwork` so the
 * seal folded into admit is exercised without touching the live hub / registry.
 * `admitted` is what `findAdmittedRow` returns (undefined ⇒ the seal lib fails
 * with "no ADMITTED row"); `readThrows` simulates a non-local / unreadable hub.
 */
function fakeSealFactory(
  opts: { admitted?: { request_id: string; principal_id: string }; readThrows?: boolean } = {},
): { factory: SecretPortsFactory; calls: SealCalls } {
  const calls: SealCalls = { reads: 0, writes: 0, reloads: 0, posted: [], minted: [] };
  const ports: NetworkSecretPorts = {
    hub: {
      confPath: "/fake/hub.conf",
      readConf: async () => {
        calls.reads += 1;
        if (opts.readThrows) throw new Error("hub config not found at /fake/hub.conf (set --hub-config)");
        return "leafnodes {\n  listen: 0.0.0.0:7422\n}\n";
      },
      writeConf: async () => { calls.writes += 1; },
      reload: async () => { calls.reloads += 1; },
    },
    admission: { findAdmittedRow: async () => opts.admitted },
    delivery: {
      postSealedSecret: async (requestId: string) => { calls.posted.push(requestId); },
      revoke: async () => {},
    },
    crypto: {
      mintPsk: () => { const p = "PSK-secret-x"; calls.minted.push(p); return p; },
      seal: async (plaintext: string, pubkey: string) => `SEALED(${pubkey.slice(0, 4)}:${plaintext})`,
    },
  };
  return { factory: () => ports, calls };
}

/** Mock fetch that serves the admit GET (PENDING req) + POST /admit (ADMITTED). */
function mockAdmitFetch(req: unknown): void {
  setMockFetch(async (input) => {
    const url = urlOf(input);
    if (url.includes("/admit")) {
      return new Response(JSON.stringify({ status: "ADMITTED" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(req), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
}

describe("cortex network admit — admit-and-seal (C-1316)", () => {
  test("--apply seals the just-admitted member → connectable; hub written + reloaded + blob posted", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; connectable: string } };
    expect(env.data.seal_status).toBe("sealed");
    expect(env.data.connectable).toBe("true");
    expect(calls.writes).toBe(1);
    expect(calls.reloads).toBe(1);
    expect(calls.posted).toEqual(["req-abc-123"]);
  });

  test("--apply human output states CONNECTABLE and never leaks the PSK", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("CONNECTABLE");
    expect(res.stdout).not.toContain(calls.minted[0]!);
  });

  test("--roster-only skips the seal → peer INERT, no hub mutation, fallback surfaced", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--roster-only", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; connectable: string; seal_fallback: string } };
    expect(env.data.seal_status).toBe("skipped");
    expect(env.data.connectable).toBe("false");
    expect(env.data.seal_fallback).toContain("secret add-member");
    expect(calls.reads).toBe(0);
    expect(calls.writes).toBe(0);
    expect(calls.posted.length).toBe(0);
  });

  test("seal failure (no ADMITTED row) NEVER fails the committed admit → exit 0 + fallback", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory } = fakeSealFactory({ admitted: undefined });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; connectable: string; seal_fallback: string } };
    expect(env.data.seal_status).toBe("fallback");
    expect(env.data.connectable).toBe("false");
    expect(env.data.seal_fallback).toContain("secret add-member");
  });

  test("non-local / unreadable hub config → fallback, admit still exit 0", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" }, readThrows: true });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; seal_reason: string } };
    expect(env.data.seal_status).toBe("fallback");
    expect(env.data.seal_reason).toContain("hub config");
    // The seal aborted at readConf, before any hub write/reload.
    expect(calls.writes).toBe(0);
    expect(calls.reloads).toBe(0);
  });

  test("network-less admission row (null network_id) → fallback, seal ports never touched", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch({ ...pendingRequest(), network_id: null });
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; seal_fallback: string } };
    expect(env.data.seal_status).toBe("fallback");
    expect(env.data.seal_fallback).toContain("<network>");
    expect(calls.reads).toBe(0);
  });
});

// =============================================================================
// Signature verification — decision vocabulary
// =============================================================================

// =============================================================================
// C-1314 — `cortex network admit --list-pending` (admission-queue discovery)
// =============================================================================
describe("cortex network admit --list-pending (C-1314)", () => {
  /** A list row as the registry `GET /admission-requests` returns it. */
  function row(overrides: Partial<{ request_id: string; principal_id: string; network_id: string | null; status: string }> = {}) {
    return {
      request_id: overrides.request_id ?? "req-abc-123",
      principal_id: overrides.principal_id ?? "peer-principal",
      peer_pubkey: "A" + "B".repeat(43), // 44-char base64-ish
      requested_scope: "federated.peer-principal.>",
      network_id: overrides.network_id === undefined ? "metafactory-community" : overrides.network_id,
      status: overrides.status ?? "PENDING",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
      granted_by: null,
    };
  }

  test("usage error without --admin-seed (exit 2)", async () => {
    let fetchCalled = false;
    setMockFetch(async () => {
      fetchCalled = true;
      return new Response("[]", { status: 200 });
    });
    const res = await dispatchNetwork(["admit", "--list-pending"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
    expect(fetchCalled).toBe(false); // never hit the network on a usage error
  });

  test("renders a table from the mocked list response; admin-signs GET ?status=PENDING", async () => {
    const { seedPath } = await mintAdminSeed();
    let gotUrl = "";
    let gotAdminHeader = "";
    setMockFetch(async (input, init) => {
      gotUrl = urlOf(input);
      const hdrs = new Headers(init?.headers);
      gotAdminHeader = hdrs.get("x-admin-signed") ?? "";
      return new Response(
        JSON.stringify([
          row({ request_id: "req-111", principal_id: "chuvala" }),
          row({ request_id: "req-222", principal_id: "jc", network_id: "metafactory" }),
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
      "--registry-url", "http://registry.test",
    ]);

    expect(res.exitCode).toBe(0);
    // Hit the LIST endpoint (not the single-request GET) with the signed header.
    expect(gotUrl).toContain("/admission-requests?status=PENDING");
    expect(gotAdminHeader.length).toBeGreaterThan(0);
    const signed = JSON.parse(gotAdminHeader) as { claim: { admin_pubkey: string }; signature: string };
    expect(signed.signature.length).toBeGreaterThan(0);
    // Table carries both rows + their principals + networks + status.
    expect(res.stdout).toContain("req-111");
    expect(res.stdout).toContain("chuvala");
    expect(res.stdout).toContain("req-222");
    expect(res.stdout).toContain("metafactory");
    expect(res.stdout).toContain("PENDING");
    expect(res.stdout).toContain("2 PENDING request(s)");
  });

  test("--json emits the rows as items + count/status metadata", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () =>
      new Response(JSON.stringify([row({ request_id: "req-json-1" })]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      status: string;
      items: { request_id: string }[];
      data: { mode: string; status: string; count: string };
    };
    expect(env.status).toBe("ok");
    expect(env.data.mode).toBe("list-pending");
    expect(env.data.status).toBe("PENDING");
    expect(env.data.count).toBe("1");
    expect(env.items[0]!.request_id).toBe("req-json-1");
  });

  test("empty queue renders the (none) line, not a bare header (exit 0)", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("0 PENDING request(s)");
    expect(res.stdout).toContain("(none)");
  });

  test("--network filters the returned rows client-side", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () =>
      new Response(
        JSON.stringify([
          row({ request_id: "req-a", network_id: "metafactory" }),
          row({ request_id: "req-b", network_id: "research-collab" }),
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
      "--network", "research-collab",
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { items: { request_id: string }[]; data: { count: string; network: string } };
    expect(env.data.network).toBe("research-collab");
    expect(env.data.count).toBe("1");
    expect(env.items.map((r) => r.request_id)).toEqual(["req-b"]);
  });

  test("403 from the registry is surfaced readably (ADR-0020 read-scoping), exit 1", async () => {
    const { seedPath } = await mintAdminSeed();
    setMockFetch(async () =>
      new Response(JSON.stringify({ error: "admin_not_authorized" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
      "--network", "research-collab",
    ]);
    expect(res.exitCode).toBe(1);
    // Readable, not a silent empty table.
    expect(res.stderr).toContain("403");
    expect(res.stderr).toMatch(/GLOBAL-admin-only/i);
    expect(res.stderr).toContain("ADR-0020");
    expect(res.stderr).toContain("research-collab");
  });

  test("invalid --status is a usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    let fetchCalled = false;
    setMockFetch(async () => {
      fetchCalled = true;
      return new Response("[]", { status: 200 });
    });
    const res = await dispatchNetwork([
      "admit", "--list-pending",
      "--admin-seed", seedPath,
      "--status", "BOGUS",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--status");
    expect(fetchCalled).toBe(false);
  });
});

describe("cortex network admit — signed claim shape", () => {
  test("claim carries decision=admit (NOT grant)", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();
    let capturedClaim: { decision: string } | null = null;

    setMockFetch(async (input, init) => {
      const url = urlOf(input);
      if (url.includes("/admit")) {
        if (init?.body) {
          const body = JSON.parse(init.body as string) as { claim: { decision: string } };
          capturedClaim = body.claim;
        }
        return new Response(JSON.stringify({ status: "ADMITTED" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(req), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });

    const res = await dispatchNetwork([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    expect(capturedClaim).not.toBeNull();
    expect(capturedClaim!.decision).toBe("admit");
    // Explicitly NOT "grant" — the old Model-A vocabulary
    expect(capturedClaim!.decision).not.toBe("grant");
  });
});
