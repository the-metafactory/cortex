/**
 * C-1348 — `cortex network reject <request-id>` CLI tests.
 *
 * The admission-denial verb, the mirror of `admit`. Orchestration under test
 * (runReject):
 *   1. Load + chmod-600-gate the admin seed
 *   2. Dry-run path: print the plan (decision: reject), touch nothing
 *   3. Apply path: build a signed admission decision (decision: "reject") and
 *      POST it directly to /admission-requests/:id/reject. NO admin-signed GET
 *      pre-check (unlike admit) — admit reads the row only to seal; reject seals
 *      nothing, and the admin READ gate is global-admin-only (ADR-0020), so a
 *      GET would 403 a per-network admin BEFORE the POST that authorises them.
 *
 * Two layers:
 *   - Usage + dry-run: fast, no registry (fetch is asserted un-called).
 *   - Apply E2E: driven through the REAL in-process network-registry Hono app
 *     via the e2e-lifecycle harness's fetch router (PENDING → reject → REJECTED,
 *     non-PENDING → 409, per-network-admin authority, stranger → 403).
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { join } from "path";

import {
  dispatchNetwork,
  __setDiscordRemoveClientForTests,
  type DiscordRemoveClient,
} from "../network";
import { dispatchProvisionStack } from "../provision-stack";
import {
  REGISTRY_BASE,
  type Env,
  makeRegistryEnv,
  resetRegistry,
  installRegistryFetchRouter,
  freshDir,
  cleanupDirs,
} from "./e2e-lifecycle/harness";
import { getIssuanceStore } from "../../../../services/network-registry/src/store";

// =============================================================================
// Helpers
// =============================================================================

function setMockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
}

const realFetch = globalThis.fetch;

/** Read `pubkey_b64` out of a `provision-stack generate --json` envelope. */
function pubkeyFromGenerate(stdout: string): string {
  const pk = (JSON.parse(stdout) as { data?: { pubkey_b64?: string } }).data?.pubkey_b64;
  if (typeof pk !== "string" || pk.length === 0) {
    throw new Error(`provision-stack generate --json produced no pubkey_b64: ${stdout}`);
  }
  return pk;
}

/** Mint an admin nkey seed (chmod 600) and return its path + base64 pubkey. */
async function mintSeed(principal: string, slug: string): Promise<{ seedPath: string; pubkey: string }> {
  const seedPath = join(freshDir("c1348-seed-"), `${principal}.nk`);
  const res = await dispatchProvisionStack([
    "generate", principal,
    "--seed-path", seedPath,
    "--stack-id", `${principal}/${slug}`,
    "--json",
  ]);
  expect(res.exitCode).toBe(0);
  return { seedPath, pubkey: pubkeyFromGenerate(res.stdout) };
}

// =============================================================================
// Usage + dry-run (no registry — fetch must NOT be called)
// =============================================================================

describe("cortex network reject — usage + dry-run", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    cleanupDirs();
  });

  test("no request-id → usage error, exit 2, touches no registry", async () => {
    const { seedPath } = await mintSeed("andreas", "test");
    let fetchCalled = false;
    setMockFetch(async () => { fetchCalled = true; return new Response("nope", { status: 500 }); });

    const res = await dispatchNetwork(["reject", "--admin-seed", seedPath]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("missing request-id");
    expect(fetchCalled).toBe(false);
  });

  test("no --admin-seed → usage error, exit 2", async () => {
    let fetchCalled = false;
    setMockFetch(async () => { fetchCalled = true; return new Response("nope", { status: 500 }); });

    const res = await dispatchNetwork(["reject", "req-abc-123"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
    expect(fetchCalled).toBe(false);
  });

  test("dry-run (default) renders decision:reject and touches nothing", async () => {
    const { seedPath } = await mintSeed("andreas", "test");
    let fetchCalled = false;
    setMockFetch(async () => { fetchCalled = true; return new Response("nope", { status: 500 }); });

    const res = await dispatchNetwork(["reject", "req-abc-123", "--admin-seed", seedPath]);

    expect(res.exitCode).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("req-abc-123");
    expect(res.stdout).toContain("reject");
  });

  test("dry-run --json emits applied:false, decision:reject, no fetch", async () => {
    const { seedPath } = await mintSeed("andreas", "test");
    let fetchCalled = false;
    setMockFetch(async () => { fetchCalled = true; return new Response("nope", { status: 500 }); });

    const res = await dispatchNetwork(["reject", "req-abc-123", "--admin-seed", seedPath, "--json"]);

    expect(res.exitCode).toBe(0);
    expect(fetchCalled).toBe(false);
    const env = JSON.parse(res.stdout) as { data: { applied: string; decision: string; request_id: string } };
    expect(env.data.applied).toBe("false");
    expect(env.data.decision).toBe("reject");
    expect(env.data.request_id).toBe("req-abc-123");
  });

  test("--apply and --dry-run together → usage error, exit 2", async () => {
    const { seedPath } = await mintSeed("andreas", "test");
    const res = await dispatchNetwork(["reject", "req-abc-123", "--admin-seed", seedPath, "--apply", "--dry-run"]);
    expect(res.exitCode).toBe(2);
  });
});

// =============================================================================
// Apply E2E — through the REAL in-process registry
// =============================================================================

const NETWORK_ID = "testnet";

interface RejectCtx {
  env: Env;
  restoreFetch: () => void;
  globalAdminSeed: string;
  perNetAdminSeed: string;
  strangerSeed: string;
}
const ctx = {} as RejectCtx;

/** Register a fresh joiner against NETWORK_ID → its PENDING request-id + pubkey. */
async function registerJoiner(principal: string): Promise<{ requestId: string; pubkey: string }> {
  const { seedPath, pubkey } = await mintSeed(principal, "work");
  const res = await dispatchProvisionStack([
    "register", principal,
    "--seed-path", seedPath,
    "--stack-id", `${principal}/work`,
    "--registry-url", REGISTRY_BASE,
    "--network", NETWORK_ID,
    "--json",
  ]);
  expect(res.exitCode).toBe(0);
  const pending = await getIssuanceStore(ctx.env).listIssuanceRequests("PENDING");
  const mine = pending.filter((r) => r.peer_pubkey === pubkey);
  expect(mine.length).toBe(1);
  return { requestId: mine[0]!.request_id, pubkey };
}

describe("cortex network reject — apply E2E (real in-process registry)", () => {
  beforeAll(async () => {
    resetRegistry();

    // Mint the three admin identities BEFORE the network exists.
    const globalAdmin = await mintSeed("netadmin", "hub");
    const perNetAdmin = await mintSeed("subadmin", "hub");
    const stranger = await mintSeed("stranger", "hub");
    ctx.globalAdminSeed = globalAdmin.seedPath;
    ctx.perNetAdminSeed = perNetAdmin.seedPath;
    ctx.strangerSeed = stranger.seedPath;

    // Registry env: ONLY the global admin is on REGISTRY_ADMIN_PUBKEYS. The
    // per-network admin gets authority purely via the network's admin_pubkeys.
    ctx.env = await makeRegistryEnv([globalAdmin.pubkey]);
    ctx.restoreFetch = installRegistryFetchRouter(ctx.env);

    // Create the network with the per-network admin on its allowlist (#1321).
    const created = await dispatchNetwork([
      "create", NETWORK_ID,
      "--hub", "tls://127.0.0.1:17422",
      "--leaf-port", "17422",
      "--admin-seed", ctx.globalAdminSeed,
      "--network-admins", perNetAdmin.pubkey,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);
    expect(created.exitCode).toBe(0);
  });

  afterAll(() => {
    ctx.restoreFetch?.();
    cleanupDirs();
    resetRegistry();
  });

  // Reset any injected Discord removal client between tests so the non-discord
  // cases above/below never see a stale mock.
  afterEach(() => __setDiscordRemoveClientForTests(null));

  test("reject <id> --apply (global admin) → row REJECTED, exit 0", async () => {
    const { requestId } = await registerJoiner("joinerone");

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("rejected");
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("REJECTED");
  });

  test("reject --apply --json → applied:true, decision:reject, principal_id", async () => {
    const { requestId } = await registerJoiner("joinertwo");

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply", "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { applied: string; decision: string; principal_id: string } };
    expect(env.data.applied).toBe("true");
    expect(env.data.decision).toBe("reject");
    expect(env.data.principal_id).toBe("joinertwo");
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("REJECTED");
  });

  test("reject on an already-decided (non-PENDING) row → clear 409 error, exit 1", async () => {
    const { requestId } = await registerJoiner("joinerthree");

    // First reject succeeds → REJECTED.
    const first = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);
    expect(first.exitCode).toBe(0);

    // Second reject on the now-REJECTED row → registry 409 already_decided,
    // surfaced as a clear, actionable line naming the current status.
    const second = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already");
    expect(second.stderr).toContain("REJECTED");
  });

  test("per-network admin rejects a request for THEIR OWN network → REJECTED", async () => {
    const { requestId } = await registerJoiner("joinerfour");

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.perNetAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("REJECTED");
  });

  test("stranger admin (neither global nor per-network) → readable 403, row stays PENDING", async () => {
    const { requestId } = await registerJoiner("joinerfive");

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.strangerSeed,
      "--registry-url", REGISTRY_BASE,
      "--apply",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain("not authorised");
    expect(res.stderr).toContain("403");
    // The registry refused the decision — the row is untouched.
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("PENDING");
  });

  // ===========================================================================
  // C-1350 S3 — Tier-1 de-admission pairing: --discord-member removes the role.
  // Discord ids are non-numeric placeholder labels (never a live snowflake).
  // ===========================================================================
  test("reject --apply --discord-member → removeRole called after REJECTED, exit 0", async () => {
    const { requestId } = await registerJoiner("joinersix");
    let resolvedRole = false;
    let removedRole = false;

    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId(_token, _guildId, roleName) {
        resolvedRole = true;
        expect(roleName).toBe("community-fleet");
        return "role-id-123";
      },
      async removeRole(_token, _guildId, userId, roleId) {
        removedRole = true;
        expect(userId).toBe("member-snowflake-999");
        expect(roleId).toBe("role-id-123");
        return { success: true };
      },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--discord-member", "member-snowflake-999",
      "--discord-guild", "guild-123",
      "--apply", "--json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(resolvedRole).toBe(true);
    expect(removedRole).toBe(true);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string } };
    expect(env.data.discord_status).toBe("removed");
    // The reject itself committed regardless.
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("REJECTED");
  });

  test("Discord role removal failure → exit 0 with warning (reject already committed)", async () => {
    const { requestId } = await registerJoiner("joinerseven");

    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId() { return "role-id-123"; },
      async removeRole() { return { success: false, error: "missing_permissions" }; },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--discord-member", "member-999",
      "--discord-guild", "guild-123",
      "--apply", "--json",
    ]);

    // Reject committed → exit 0. The removal failure is a warning, never fatal.
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string; discord_warning?: string } };
    expect(env.data.discord_status).toBe("failed");
    expect(env.data.discord_warning).toContain("missing_permissions");
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(requestId);
    expect(row?.status).toBe("REJECTED");
  });

  test("custom --discord-role is forwarded to resolveRoleId (flag-resolution parity with admit)", async () => {
    const { requestId } = await registerJoiner("joinereight");
    let capturedRole = "";

    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId(_token, _guildId, roleName) {
        capturedRole = roleName;
        return "custom-role-id";
      },
      async removeRole() { return { success: true }; },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork([
      "reject", requestId,
      "--admin-seed", ctx.globalAdminSeed,
      "--registry-url", REGISTRY_BASE,
      "--discord-member", "member-999",
      "--discord-guild", "guild-123",
      "--discord-role", "custom-fleet",
      "--apply",
    ]);

    expect(res.exitCode).toBe(0);
    expect(capturedRole).toBe("custom-fleet");
  });
});
