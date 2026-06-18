/**
 * G2 — `cortex creds grant <request-id>` CLI tests.
 *
 * Orchestration flow under test:
 *   1. Fetch PENDING request via admin-signed GET (mock registry)
 *   2. Issue scoped creds via arc (injected ArcRunner)
 *   3. Assemble PUBLIC leaf package (no credsPath/secret)
 *   4. Sign + POST the IssuanceDecisionClaimWithPackage (mock registry)
 *   5. Assign Discord role (injected fetch) when --discord-member is given
 *
 * All live surfaces (registry HTTP, arc binary, Discord API) are mocked.
 * Tests exercise the wiring, the no-secret guarantee, dry-run default,
 * partial-success on Discord failure, and error paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchCreds, __setArcRunnerForTests, __setDiscordGrantClientForTests } from "../creds";
import { dispatchProvisionStack } from "../provision-stack";
import type { ArcRunner, ArcRunResult, DiscordGrantClient } from "../creds";

/** Type-safe helper to assign a mock to globalThis.fetch without hitting Bun's
 *  `preconnect` property requirement. Mirrors the pattern in network-create.test.ts. */
function setMockFetch(fn: (input: RequestInfo | URL, init?: RequestInit | BunFetchRequestInit) => Promise<Response>): void {
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
}

// =============================================================================
// Test helpers
// =============================================================================

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "g2-creds-grant-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  __setArcRunnerForTests(null);
  __setDiscordGrantClientForTests(null);
  // Restore real fetch
  globalThis.fetch = realFetch;
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;

/**
 * Mint a real admin nkey seed file (chmod 600) via provision-stack and return
 * its path + the derived base64 pubkey. Reuses the same helper pattern as
 * network-create tests.
 */
async function mintAdminSeed(): Promise<{ seedPath: string; adminPubkey: string }> {
  const seedPath = join(freshDir(), "admin.nk");
  const res = await dispatchProvisionStack([
    "generate", "andreas",
    "--seed-path", seedPath,
    "--json",
  ]);
  expect(res.exitCode).toBe(0);
  const env = JSON.parse(res.stdout) as { data: { pubkey_b64: string } };
  return { seedPath, adminPubkey: env.data.pubkey_b64 };
}

/**
 * Build a valid IssuanceRequest fixture in PENDING state. `peer_pubkey` is a
 * placeholder base64 string — the tests don't verify it, the registry mock owns
 * the state machine.
 */
function pendingRequestFixture(requestId: string, opts: { scope?: string } = {}) {
  return {
    request_id: requestId,
    principal_id: "echo",
    peer_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    requested_scope: opts.scope ?? "federated.echo.>",
    status: "PENDING",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    granted_by: null,
    leaf_package: null,
  };
}

/** Build an arc.nats.v1 add-bot success envelope. */
function arcAddBotOk(opts: {
  bot: string;
  account?: string;
  credsPath?: string;
  pubKey?: string;
  jwt?: string;
}): string {
  return JSON.stringify({
    schema: "arc.nats.v1",
    ok: true,
    bot: opts.bot,
    account: opts.account ?? "OP_TEST",
    credsPath: opts.credsPath ?? `/tmp/${opts.bot}.creds`,
    jwt: opts.jwt ?? "eyJ-fake-account-jwt",
    pubKey: opts.pubKey ?? "UAFAKEPUBKEY",
  });
}

/** Minimal operator JWT (base64url encoded — not cryptographically valid, just structurally shaped). */
const FAKE_OPERATOR_JWT = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJvcCJ9.fakesig";
/** Minimal account JWT. */
const FAKE_ACCOUNT_JWT = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJhY2MifQ.fakesig2";

/**
 * Build a mock fetch that handles:
 *   - GET  /issuance-requests/{id}  → returns the fixture (admin-signed header OK)
 *   - POST /issuance-requests/{id}/grant → 200 granted
 *   - GET  /guilds/{gid}/roles → discord role list
 *   - PUT  /guilds/{gid}/members/{uid}/roles/{rid} → 204
 */
interface MockFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function buildMockFetch(opts: {
  requestId: string;
  requestFixture: ReturnType<typeof pendingRequestFixture>;
  grantedFixture?: object;
  discordGuildId?: string;
  discordRoleId?: string;
  /** If set, POST /grant returns this status (defaults to 200) */
  grantStatus?: number;
  /** If set, Discord PUT returns this status (defaults to 204) */
  discordPutStatus?: number;
}): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => (headers[k] = v));
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headers[k] = v;
    } else {
      Object.assign(headers, rawHeaders);
    }

    let body: unknown;
    try {
      if (init?.body) body = JSON.parse(init.body as string);
    } catch (_err) {
      // ignore parse errors — body may not be JSON
    }

    calls.push({ url, method, headers, body });

    // Registry GET /issuance-requests/{id}
    if (method === "GET" && url.includes(`/issuance-requests/${opts.requestId}`) && !url.includes("/package")) {
      return new Response(JSON.stringify(opts.requestFixture), { status: 200 });
    }

    // Registry POST /issuance-requests/{id}/grant
    if (method === "POST" && url.includes(`/issuance-requests/${opts.requestId}/grant`)) {
      const status = opts.grantStatus ?? 200;
      const body = status === 200
        ? JSON.stringify(opts.grantedFixture ?? { ...opts.requestFixture, status: "GRANTED", granted_by: "admin-pubkey" })
        : JSON.stringify({ error: "already_decided" });
      return new Response(body, { status });
    }

    // Discord GET /guilds/{gid}/roles
    if (method === "GET" && url.includes("/guilds/") && url.endsWith("/roles") && opts.discordGuildId) {
      return new Response(
        JSON.stringify([{ id: opts.discordRoleId ?? "99999", name: "community-fleet" }]),
        { status: 200 },
      );
    }

    // Discord PUT /guilds/{gid}/members/{uid}/roles/{rid}
    if (method === "PUT" && url.includes("/guilds/") && url.includes("/roles/") && opts.discordGuildId) {
      return new Response(null, { status: opts.discordPutStatus ?? 204 });
    }

    // Fallthrough — should not happen in well-formed tests
    return new Response(JSON.stringify({ error: "unexpected call" }), { status: 500 });
  };

  return { fetch: mockFetch, calls };
}

// =============================================================================
// Usage validation (exit 2)
// =============================================================================

describe("creds grant — usage validation", () => {
  test("missing request-id (exit 2)", async () => {
    const res = await dispatchCreds(["grant"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("request-id");
  });

  test("missing --admin-seed (exit 2)", async () => {
    const res = await dispatchCreds(["grant", "req-abc123"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
  });

  test("--admin-seed file not found (exit 1)", async () => {
    const res = await dispatchCreds([
      "grant", "req-abc123",
      "--admin-seed", "/tmp/no-such-seed-file-g2.nk",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not found");
  });

  test("--apply and --dry-run together is a usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchCreds([
      "grant", "req-abc123",
      "--admin-seed", seedPath,
      "--apply",
      "--dry-run",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/mutually exclusive/i);
  });
});

// =============================================================================
// Dry-run (DEFAULT) — no registry writes, no arc calls, no Discord calls
// =============================================================================

describe("creds grant — dry-run (default)", () => {
  test("dry-run prints what WOULD happen without contacting registry", async () => {
    const { seedPath } = await mintAdminSeed();

    // arc should NOT be called in dry-run
    let arcCalled = false;
    __setArcRunnerForTests(async () => {
      arcCalled = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    // Registry should NOT be fetched in dry-run
    let fetchCalled = false;
    setMockFetch(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const res = await dispatchCreds([
      "grant", "req-dryrun01",
      "--admin-seed", seedPath,
    ]);

    expect(res.exitCode).toBe(0);
    expect(arcCalled).toBe(false);
    expect(fetchCalled).toBe(false);
    // Should mention dry-run
    expect(res.stdout).toMatch(/dry.run/i);
    // Should mention the request id
    expect(res.stdout).toContain("req-dryrun01");
  });

  test("dry-run with --json emits structured envelope with applied:false", async () => {
    const { seedPath } = await mintAdminSeed();
    __setArcRunnerForTests(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    setMockFetch(async () => new Response("{}", { status: 200 }));

    const res = await dispatchCreds([
      "grant", "req-dryrun02",
      "--admin-seed", seedPath,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
    expect(env.status).toBe("ok");
    expect(env.data.applied).toBe("false");
    expect(env.data.request_id).toBe("req-dryrun02");
  });
});

// =============================================================================
// --apply: full orchestration (fetch → arc → assemble package → POST → Discord)
// =============================================================================

describe("creds grant --apply — full orchestration", () => {
  test("fetches PENDING request, issues creds, posts grant with PUBLIC leaf package", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();
    const requestId = "req-apply-001";
    const fixture = pendingRequestFixture(requestId, { scope: "federated.echo.>" });

    // Arc returns a valid add-bot result
    const arcArgvLog: (readonly string[])[] = [];
    __setArcRunnerForTests(async (argv) => {
      arcArgvLog.push(argv);
      return {
        exitCode: 0,
        stdout: arcAddBotOk({
          bot: "echo",
          credsPath: "/tmp/echo.creds",
          jwt: FAKE_ACCOUNT_JWT,
          pubKey: "UECHOPUBKEY",
        }),
        stderr: "",
      };
    });

    const { fetch: mockFetch, calls } = buildMockFetch({
      requestId,
      requestFixture: fixture,
      discordGuildId: undefined, // no Discord in this test
    });
    setMockFetch(mockFetch);

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);

    // Arc was called
    expect(arcArgvLog.length).toBe(1);
    const arcArgv = arcArgvLog[0]!;
    expect(arcArgv).toContain("nats");
    expect(arcArgv).toContain("add-bot");

    // Registry GET was called (admin read)
    const getCall = calls.find((c) => c.method === "GET" && c.url.includes("/issuance-requests/"));
    expect(getCall).toBeTruthy();
    expect(getCall!.headers["x-admin-signed"]).toBeTruthy();

    // Registry POST /grant was called
    const postCall = calls.find((c) => c.method === "POST" && c.url.includes("/grant"));
    expect(postCall).toBeTruthy();
    const postBody = postCall!.body as { claim: { request_id: string; decision: string; admin_pubkey: string; leaf_package?: { operatorJwt: string; account: string; accountJwt: string } }; signature: string };
    expect(postBody.claim.request_id).toBe(requestId);
    expect(postBody.claim.decision).toBe("grant");
    expect(postBody.claim.admin_pubkey).toBe(adminPubkey);
    // Leaf package MUST be present
    expect(postBody.claim.leaf_package).toBeTruthy();
    // Leaf package MUST have operatorJwt, account, accountJwt
    expect(postBody.claim.leaf_package!.operatorJwt).toBe(FAKE_OPERATOR_JWT);
    expect(postBody.claim.leaf_package!.account).toBe("OP_TEST");
    expect(postBody.claim.leaf_package!.accountJwt).toBe(FAKE_ACCOUNT_JWT);
    // Signature over canonical-JSON(claim) must be present
    expect(typeof postBody.signature).toBe("string");
    expect(postBody.signature.length).toBeGreaterThan(10);

    // Summary output
    expect(res.stdout).toMatch(/granted/i);
    expect(res.stdout).toContain(requestId);
  });

  test("no-secrets guarantee: credsPath NEVER appears in the POST body", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-no-secret-001";
    const fixture = pendingRequestFixture(requestId);
    const SECRET_CREDS_PATH = "/home/admin/.config/nats/creds/echo.creds";

    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: arcAddBotOk({ bot: "echo", credsPath: SECRET_CREDS_PATH }),
      stderr: "",
    }));

    const { fetch: mockFetch, calls } = buildMockFetch({
      requestId,
      requestFixture: fixture,
    });
    setMockFetch(mockFetch);

    await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    // The POST body must NOT contain the local creds path
    const postCall = calls.find((c) => c.method === "POST" && c.url.includes("/grant"));
    expect(postCall).toBeTruthy();
    const postBodyStr = JSON.stringify(postCall!.body);
    expect(postBodyStr).not.toContain("credsPath");
    expect(postBodyStr).not.toContain(SECRET_CREDS_PATH);
    expect(postBodyStr).not.toContain(".creds");
  });

  test("leaf package missing required field fails before POST (exit 1)", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-badpkg-001";
    const fixture = pendingRequestFixture(requestId);

    // Arc returns a result missing the JWT
    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema: "arc.nats.v1",
        ok: true,
        bot: "echo",
        account: "OP_TEST",
        credsPath: "/tmp/echo.creds",
        jwt: "", // empty — invalid
        pubKey: "UAFAKEPUBKEY",
      }),
      stderr: "",
    }));

    let postCalled = false;
    const { fetch: mockFetch } = buildMockFetch({
      requestId,
      requestFixture: fixture,
    });
    setMockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url;
      if ((init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/grant")) {
        postCalled = true;
      }
      return mockFetch(input, init);
    });

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    // Should fail before POSTing an invalid package
    expect(res.exitCode).toBe(1);
    expect(postCalled).toBe(false);
    expect(res.stderr).toMatch(/accountJwt|jwt|leaf.package/i);
  });

  test("non-PENDING request fails with clear error (exit 1)", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-already-granted";
    const grantedFixture = { ...pendingRequestFixture(requestId), status: "GRANTED" };

    __setArcRunnerForTests(async () => ({ exitCode: 0, stdout: arcAddBotOk({ bot: "echo" }), stderr: "" }));

    setMockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url;
      if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/issuance-requests/")) {
        return new Response(JSON.stringify(grantedFixture), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not PENDING|already.*granted|status.*GRANTED/i);
  });

  test("registry returns 404 for unknown request-id (exit 1)", async () => {
    const { seedPath } = await mintAdminSeed();

    setMockFetch(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));

    const res = await dispatchCreds([
      "grant", "req-nonexistent",
      "--admin-seed", seedPath,
      "--apply",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not.found|404/i);
  });

  test("arc failure exits 1 with clear message, no POST", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-arc-fail";
    const fixture = pendingRequestFixture(requestId);

    __setArcRunnerForTests(async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        schema: "arc.nats.v1",
        ok: false,
        error: { code: "NSC_NOT_INSTALLED", message: "nsc binary not found" },
      }),
      stderr: "",
    }));

    let postCalled = false;
    setMockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input).url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/issuance-requests/")) {
        return new Response(JSON.stringify(fixture), { status: 200 });
      }
      if (method === "POST" && url.includes("/grant")) {
        postCalled = true;
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    expect(res.exitCode).toBe(1);
    expect(postCalled).toBe(false);
    expect(res.stderr).toMatch(/arc|creds|issue/i);
  });
});

// =============================================================================
// Discord role assignment (O-5)
// =============================================================================

describe("creds grant --apply — Discord role assignment", () => {
  test("assigns community-fleet role when --discord-member is given", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-discord-001";
    const fixture = pendingRequestFixture(requestId);

    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: arcAddBotOk({ bot: "echo", jwt: FAKE_ACCOUNT_JWT }),
      stderr: "",
    }));

    const discordMemberId = "123456789012345678";
    const discordGuildId = "987654321098765432";
    const discordRoleId = "111111111111111111";

    // Track Discord client calls via the injected seam — no real fetch,
    // no filesystem config required. This is what was missing on CI.
    const discordCalls: { method: string; userId?: string; guildId?: string; roleId?: string }[] = [];
    const mockDiscordClient: DiscordGrantClient = {
      async resolveRoleId(_token, guildId, _roleName) {
        discordCalls.push({ method: "resolveRoleId", guildId });
        return discordRoleId;
      },
      async assignRole(_token, guildId, userId, roleId) {
        discordCalls.push({ method: "assignRole", guildId, userId, roleId });
        return { success: true };
      },
    };
    __setDiscordGrantClientForTests(mockDiscordClient);

    const { fetch: mockFetch } = buildMockFetch({
      requestId,
      requestFixture: fixture,
    });
    setMockFetch(mockFetch);

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--discord-member", discordMemberId,
      "--discord-guild", discordGuildId,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);

    // Injected client was called for role resolution and assignment
    const resolveCall = discordCalls.find((c) => c.method === "resolveRoleId");
    expect(resolveCall).toBeTruthy();
    const assignCall = discordCalls.find((c) => c.method === "assignRole");
    expect(assignCall).toBeTruthy();
    expect(assignCall!.userId).toBe(discordMemberId);
    expect(assignCall!.guildId).toBe(discordGuildId);
    expect(assignCall!.roleId).toBe(discordRoleId);

    // Output mentions role assignment
    expect(res.stdout).toMatch(/role|discord/i);
  });

  test("partial success: grant OK but Discord fails → exit 0 with warning", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-partial-001";
    const fixture = pendingRequestFixture(requestId);

    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: arcAddBotOk({ bot: "echo", jwt: FAKE_ACCOUNT_JWT }),
      stderr: "",
    }));

    // Inject a Discord client that fails on assignRole
    const mockDiscordClient: DiscordGrantClient = {
      async resolveRoleId(_token, _guildId, _roleName) {
        return "roleId-fake";
      },
      async assignRole(_token, _guildId, _userId, _roleId) {
        return { success: false, error: "Missing Permissions" };
      },
    };
    __setDiscordGrantClientForTests(mockDiscordClient);

    const { fetch: mockFetch } = buildMockFetch({
      requestId,
      requestFixture: fixture,
    });
    setMockFetch(mockFetch);

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--discord-member", "111122223333444455",
      "--discord-guild", "999999999999999999",
      "--apply",
    ]);

    // Grant succeeded; Discord failed → partial success
    expect(res.exitCode).toBe(0);
    // Must warn about Discord failure
    expect(res.stdout).toMatch(/discord.*fail|role.*fail|assign.*manual|partial/i);
    // Must indicate grant was committed (don't roll back)
    expect(res.stdout).toMatch(/granted/i);
  });

  test("no Discord calls when --discord-member is absent", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-no-discord-001";
    const fixture = pendingRequestFixture(requestId);

    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: arcAddBotOk({ bot: "echo", jwt: FAKE_ACCOUNT_JWT }),
      stderr: "",
    }));

    const { fetch: mockFetch, calls } = buildMockFetch({
      requestId,
      requestFixture: fixture,
    });
    setMockFetch(mockFetch);

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    const discordCall = calls.find((c) => c.url.includes("discord.com"));
    expect(discordCall).toBeUndefined();
  });
});

// =============================================================================
// --scope flag
// =============================================================================

describe("creds grant — scope flag", () => {
  test("--scope overrides the inferred scope passed to arc", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-scope-001";
    const fixture = pendingRequestFixture(requestId);

    const arcArgvLog: (readonly string[])[] = [];
    __setArcRunnerForTests(async (argv) => {
      arcArgvLog.push(argv);
      return {
        exitCode: 0,
        stdout: arcAddBotOk({ bot: "echo", jwt: FAKE_ACCOUNT_JWT }),
        stderr: "",
      };
    });

    const { fetch: mockFetch } = buildMockFetch({ requestId, requestFixture: fixture });
    setMockFetch(mockFetch);

    await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--scope", "federated.echo.> _INBOX.>",
      "--apply",
    ]);

    expect(arcArgvLog.length).toBe(1);
    const arcArgv = arcArgvLog[0]!;
    expect(arcArgv.join(" ")).toContain("federated.echo.>");
  });
});

// =============================================================================
// --json output
// =============================================================================

describe("creds grant --apply --json", () => {
  test("success emits structured envelope with local_creds_path and grant details", async () => {
    const { seedPath } = await mintAdminSeed();
    const requestId = "req-json-001";
    const fixture = pendingRequestFixture(requestId);

    __setArcRunnerForTests(async () => ({
      exitCode: 0,
      stdout: arcAddBotOk({ bot: "echo", credsPath: "/home/admin/.nats/echo.creds", jwt: FAKE_ACCOUNT_JWT }),
      stderr: "",
    }));

    const { fetch: mockFetch } = buildMockFetch({ requestId, requestFixture: fixture });
    setMockFetch(mockFetch);

    const res = await dispatchCreds([
      "grant", requestId,
      "--admin-seed", seedPath,
      "--operator-jwt", FAKE_OPERATOR_JWT,
      "--apply",
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      status: string;
      data: Record<string, string>;
    };
    expect(env.status).toBe("ok");
    expect(env.data.applied).toBe("true");
    expect(env.data.request_id).toBe(requestId);
    // local_creds_path is surfaced as local context for the admin, NOT sent to registry
    expect(env.data.local_creds_path).toBe("/home/admin/.nats/echo.creds");
  });
});
