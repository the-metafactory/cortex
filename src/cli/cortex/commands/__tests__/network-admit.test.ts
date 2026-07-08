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
 * All live surfaces (registry HTTP, Discord API) are mocked via
 * `globalThis.fetch` and — S5 (cortex#1519) — an injected fake
 * {@link AdmitPortsFactory} for the Discord assign tests (replaces the old
 * `__setDiscordAdmitClientForTests` mutable-singleton seam). No arc binary is
 * called — ADR-0015 retires Model-A credential minting.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchNetwork, type SecretPortsFactory, type AdmitPortsFactory, type ExitResult } from "../network";
import type { NetworkSecretPorts } from "../network-secret-ports";
import { buildLiveAdmitPorts } from "../network-admit-adapters";
import { dispatchProvisionStack } from "../provision-stack";
import { setMockFetch, urlOf } from "./fetch-mock-helpers";

// cortex#1517 (S3, epic #1514) — live-registry round-trip coverage. Drives the
// REAL registry Worker app so buildAdmissionReadHeader (--list-pending) and
// buildAdmissionDecisionBody (--apply admit) are exercised end-to-end through
// their ACTUAL network.ts call sites, not a hand-reconstructed claim — a
// field-name or key-ordering drift inside those functions fails these tests.
import { generateStackIdentity, buildRegistrationClaim } from "../../../../bus/stack-provisioning";
import registryApp from "../../../../services/network-registry/src/index";
import type { Env } from "../../../../services/network-registry/src/index";
import { makeRegistryKey, resetStores } from "../../../../services/network-registry/__tests__/helpers";
import { _resetRateLimitBucketsForTest } from "../../../../services/network-registry/src/rate-limit";

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
  globalThis.fetch = realFetch;
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * S5 (cortex#1519) — `dispatchNetwork` with an injected `admitPortsFactory`
 * (11th positional param, after the 9 other injectable-ports factories).
 * Used by the Discord-assign tests below to fake JUST the discord port while
 * the registry/seal ports stay live (driven by the mocked `globalThis.fetch`
 * / `secretPortsFactory`, same as every other test in this file).
 */
function dispatchWithAdmitPorts(argv: string[], admitPortsFactory: AdmitPortsFactory): Promise<ExitResult> {
  return dispatchNetwork(argv, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, admitPortsFactory);
}

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
    let assignCalled = false;

    // S5 (cortex#1519) — inject a fake discord port; registry/seal stay LIVE
    // (driven by the mocked fetch below), matching every other test here.
    const admitPortsFactory: AdmitPortsFactory = (cfg) => ({
      ...buildLiveAdmitPorts(cfg),
      discord: {
        async assignRole(inputs) {
          assignCalled = true;
          expect(inputs.role).toBe("community-fleet");
          expect(inputs.member).toBe("user-snowflake-999");
          return { status: "assigned", warning: "" };
        },
      },
    });

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

    const res = await dispatchWithAdmitPorts([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-snowflake-999",
      "--discord-guild", "guild-123",
      "--apply",
      "--json",
    ], admitPortsFactory);

    expect(res.exitCode).toBe(0);
    expect(assignCalled).toBe(true);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string } };
    expect(env.data.discord_status).toBe("assigned");
  });

  test("Discord role assign failure → exit 0 with warning (admission already committed)", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();

    // S5 (Sage review, PR #1586) — the fake returns a MINIMAL warning, not a
    // copy of production's exact message: this test asserts the CLI plumbs
    // whatever the port returns through to discord_warning verbatim; the
    // message text production actually BUILDS is covered by the adapter unit
    // test (network-admit-adapters.test.ts).
    const admitPortsFactory: AdmitPortsFactory = (cfg) => ({
      ...buildLiveAdmitPorts(cfg),
      discord: {
        async assignRole() {
          return { status: "failed", warning: "missing_permissions" };
        },
      },
    });

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

    const res = await dispatchWithAdmitPorts([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-999",
      "--discord-guild", "guild-123",
      "--apply",
      "--json",
    ], admitPortsFactory);

    // Admission committed → exit 0. Discord partial failure is a warning.
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { discord_status: string; discord_warning?: string } };
    expect(env.data.discord_status).toBe("failed");
    expect(env.data.discord_warning).toContain("missing_permissions");
  });

  test("custom --discord-role is forwarded to the discord port", async () => {
    const { seedPath } = await mintAdminSeed();
    const req = pendingRequest();
    let capturedRoleName = "";

    const admitPortsFactory: AdmitPortsFactory = (cfg) => ({
      ...buildLiveAdmitPorts(cfg),
      discord: {
        async assignRole(inputs) {
          capturedRoleName = inputs.role;
          return { status: "assigned", warning: "" };
        },
      },
    });

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

    await dispatchWithAdmitPorts([
      "admit", "req-abc-123",
      "--admin-seed", seedPath,
      "--discord-member", "user-999",
      "--discord-guild", "guild-123",
      "--discord-role", "sovereign-member",
      "--apply",
    ], admitPortsFactory);

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
  opts: {
    admitted?: { request_id: string; principal_id: string };
    readThrows?: boolean;
    // cortex#1481 — hub-locality fakes. Defaults resolve LOCAL (loopback alias)
    // so every PRE-#1481 test keeps its local-hub-write assumption unchanged.
    hubUrl?: string;
    noHubCache?: boolean;
    localHostname?: string;
    hubHostIsLocalInterface?: boolean;
  } = {},
): { factory: SecretPortsFactory; calls: SealCalls } {
  const calls: SealCalls = { reads: 0, writes: 0, reloads: 0, posted: [], minted: [] };
  const hubUrl = opts.noHubCache === true ? undefined : (opts.hubUrl ?? "tls://localhost:7422");
  const localHostname = opts.localHostname ?? "localhost";
  const hubHostIsLocalInterface = opts.hubHostIsLocalInterface ?? false;
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
    hubLocality: {
      resolveHubUrl: async () => hubUrl,
      localHostname: () => localHostname,
      hubHostIsLocalInterface: async () => hubHostIsLocalInterface,
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

  test("--apply --json output never leaks the PSK (#1316 nit — machine path)", async () => {
    // The human-path test above proves the transcript is clean; the --json
    // envelope is a SEPARATE surface (seal_status/connectable/seal_reason/
    // seal_fallback) that a caller might log or forward, so assert the minted
    // per-member PSK never rides it either.
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    // The PSK WAS minted (the seal ran)…
    expect(calls.minted.length).toBe(1);
    // …but it never appears anywhere in the machine-readable envelope.
    expect(res.stdout).not.toContain(calls.minted[0]!);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string } };
    expect(env.data.seal_status).toBe("sealed");
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
// cortex#1481 (epic #1479, join-2) — admit-and-seal hub locality gate.
// The #1 storm cause: admit's fold-in seal shares the SAME hub-write seam as
// `secret add-member` (sealAdmittedMember → runNetworkSecret), so it must
// share the SAME never-write-a-foreign-hub fix.
// =============================================================================
describe("cortex network admit — admit-and-seal hub locality (cortex#1481)", () => {
  test("external hub → seal_status sealed, NO local hub write, hub_owner_artifact present", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({
      admitted: { request_id: "req-abc-123", principal_id: "peer-principal" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; connectable: string; hub_owner_artifact?: string } };
    expect(env.data.seal_status).toBe("sealed");
    expect(env.data.connectable).toBe("true");
    // The local hub port's write/reload were NEVER called (spy assertion).
    expect(calls.writes).toBe(0);
    expect(calls.reloads).toBe(0);
    // The registry seal still POSTed (machine-independent).
    expect(calls.posted).toEqual(["req-abc-123"]);
    expect(env.data.hub_owner_artifact).toBeDefined();
    expect(env.data.hub_owner_artifact).toContain(calls.minted[0]);
  });

  test("external hub — human output prints the hub-owner artifact, still says CONNECTABLE", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({
      admitted: { request_id: "req-abc-123", principal_id: "peer-principal" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("CONNECTABLE");
    expect(res.stdout).toContain("HUB-OWNER ACTION REQUIRED");
    expect(res.stdout).toContain(calls.minted[0]!);
    expect(calls.writes).toBe(0);
  });

  test("--seal-only forces the artifact path even when the hub LOOKS local", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--seal-only", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; hub_owner_artifact?: string } };
    expect(env.data.seal_status).toBe("sealed");
    expect(calls.writes).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(env.data.hub_owner_artifact).toBeDefined();
  });

  test("local hub, no --seal-only → writes exactly as before (pre-#1481 behaviour), no artifact", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({ admitted: { request_id: "req-abc-123", principal_id: "peer-principal" } });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { seal_status: string; hub_owner_artifact?: string } };
    expect(env.data.seal_status).toBe("sealed");
    expect(calls.writes).toBe(1);
    expect(calls.reloads).toBe(1);
    expect(env.data.hub_owner_artifact).toBeUndefined();
  });

  test("no cached hub descriptor (can't determine locality) → treated as external, fail-safe", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory, calls } = fakeSealFactory({
      admitted: { request_id: "req-abc-123", principal_id: "peer-principal" },
      noHubCache: true,
    });

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--json"],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { data: { hub_owner_artifact?: string } };
    expect(calls.writes).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(env.data.hub_owner_artifact).toBeDefined();
  });

  test("--hub-account rides the printed artifact's account: field", async () => {
    const { seedPath } = await mintAdminSeed();
    mockAdmitFetch(pendingRequest());
    const { factory } = fakeSealFactory({
      admitted: { request_id: "req-abc-123", principal_id: "peer-principal" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const account = "A" + "E".repeat(55);

    const res = await dispatchNetwork(
      ["admit", "req-abc-123", "--admin-seed", seedPath, "--apply", "--hub-account", account],
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`account: "${account}"`);
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

// =============================================================================
// cortex#1517 (S3, epic #1514) — live-registry round-trip.
//
// Every other test in this file mocks `globalThis.fetch` with hand-written
// JSON responses, so it proves the CLI sends the right shape but never
// actually verifies the signature it produces. That leaves a gap: a
// field-name or key-ordering drift INSIDE `buildAdmissionReadHeader` /
// `buildAdmissionDecisionBody` (both in network.ts, both routed through
// `signAdminRequest` as of S3) could still pass every test above while
// producing a header/body the real registry would 401.
//
// These tests route `globalThis.fetch` to the REAL registry Worker app
// (`registryApp.fetch`, no re-implemented verifier) and drive the ACTUAL
// `dispatchNetwork(["admit", ...])` command path — never touching
// `buildAdmissionReadHeader` / `buildAdmissionDecisionBody` directly (neither
// is exported, and it shouldn't be just to satisfy a test). If either
// function's claim shape or signing call drifts, the registry rejects it and
// these tests fail.
// =============================================================================

describe("cortex network admit — live registry round-trip (cortex#1517 S3)", () => {
  async function liveRegistryEnv(): Promise<{ env: Env; adminSeedPath: string }> {
    resetStores();
    _resetRateLimitBucketsForTest();
    const reg = await makeRegistryKey();
    const { seedPath: adminSeedPath, adminPubkey } = await mintAdminSeed();
    return {
      env: {
        REGISTRY_SIGNING_KEY: reg.signingKey,
        REGISTRY_PUBLIC_KEY: reg.publicKey,
        REGISTRY_ADMIN_PUBKEYS: adminPubkey,
        ENVIRONMENT: "test",
      },
      adminSeedPath,
    };
  }

  /** Route `globalThis.fetch` into the live registry Worker for the duration of `fn`. */
  async function withLiveRegistry(env: Env, fn: () => Promise<void>): Promise<void> {
    setMockFetch(async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    });
    await fn();
  }

  test("READ: --list-pending's buildAdmissionReadHeader output is accepted by the live registry", async () => {
    const { env, adminSeedPath } = await liveRegistryEnv();

    await withLiveRegistry(env, async () => {
      // Register a principal against the REAL registry to create a PENDING row.
      const member = generateStackIdentity({ seedPath: join(freshDir(), "member.nk") });
      const regBody = await buildRegistrationClaim({
        principalId: "dave",
        material: member,
        stacks: [{ stack_id: "dave/main", stack_pubkey: member.pubkeyB64 }],
      });
      const regRes = await registryApp.fetch(
        new Request("http://localhost/principals/dave/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(regBody),
        }),
        env,
      );
      expect(regRes.status).toBe(201);

      // The ACTUAL CLI command — buildAdmissionReadHeader signs the read
      // claim internally; if it drifted, the registry would 401 and this
      // command would exit non-zero instead of listing the row.
      const res = await dispatchNetwork([
        "admit", "--list-pending",
        "--admin-seed", adminSeedPath,
        "--json",
      ]);

      expect(res.exitCode).toBe(0);
      const env_ = JSON.parse(res.stdout) as { items: { request_id: string; principal_id: string }[] };
      expect(env_.items.some((r) => r.principal_id === "dave")).toBe(true);
    });
  });

  // cortex#1652 — the PER-NETWORK admin read path (#1321 + FND-5). The live
  // incident: a per-network admin's `admit --apply` 403'd `admin_not_authorized`
  // on the row GET because the CLI's read claim carried no `network_id` (the
  // registry authorizes a non-global admin ONLY for a claim naming a network
  // they administer). `--network <id>` now threads into the signed read claim.
  test("READ: per-network admin is 403 unscoped, authorized with --network (cortex#1652)", async () => {
    const { env, adminSeedPath } = await liveRegistryEnv();

    // A second admin identity that is NOT on the global allowlist…
    const { seedPath: perNetSeedPath, adminPubkey: perNetPubkey } = await mintAdminSeed();
    expect(env.REGISTRY_ADMIN_PUBKEYS).not.toContain(perNetPubkey);

    await withLiveRegistry(env, async () => {
      // …but IS the per-network admin of "netx" (global admin attests it).
      const created = await dispatchNetwork([
        "create", "netx",
        "--hub", "tls://hub.example:7422", "--leaf-port", "7422",
        "--network-admins", perNetPubkey,
        "--admin-seed", adminSeedPath,
        "--apply",
      ]);
      expect(created.exitCode).toBe(0);

      // UNSCOPED read claim from the per-network admin → the registry's FND-5
      // gate refuses (a non-global admin may not read all networks).
      const unscoped = await dispatchNetwork([
        "admit", "--list-pending",
        "--admin-seed", perNetSeedPath,
        "--json",
      ]);
      expect(unscoped.exitCode).not.toBe(0);

      // SCOPED to their own network → authorized (list may be empty — the
      // assertion is the AUTH outcome, not row contents).
      const scoped = await dispatchNetwork([
        "admit", "--list-pending", "--network", "netx",
        "--admin-seed", perNetSeedPath,
        "--json",
      ]);
      expect(scoped.exitCode).toBe(0);
    });
  });

  test("WRITE: --apply admit's buildAdmissionDecisionBody output is accepted by the live registry (PENDING -> ADMITTED)", async () => {
    const { env, adminSeedPath } = await liveRegistryEnv();

    await withLiveRegistry(env, async () => {
      const member = generateStackIdentity({ seedPath: join(freshDir(), "erin.nk") });
      const regBody = await buildRegistrationClaim({
        principalId: "erin",
        material: member,
        stacks: [{ stack_id: "erin/main", stack_pubkey: member.pubkeyB64 }],
      });
      const regRes = await registryApp.fetch(
        new Request("http://localhost/principals/erin/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(regBody),
        }),
        env,
      );
      expect(regRes.status).toBe(201);

      // Find the PENDING request-id the same way an admin would (also
      // exercises buildAdmissionReadHeader, same as the READ test above).
      const listRes = await dispatchNetwork([
        "admit", "--list-pending",
        "--admin-seed", adminSeedPath,
        "--json",
      ]);
      expect(listRes.exitCode).toBe(0);
      const list = JSON.parse(listRes.stdout) as { items: { request_id: string; principal_id: string }[] };
      const requestId = list.items.find((r) => r.principal_id === "erin")?.request_id;
      expect(requestId).toBeTruthy();

      // The ACTUAL CLI command — buildAdmissionDecisionBody signs the
      // admit-decision claim internally. --roster-only skips the unrelated
      // hub-local seal step so this test stays focused on the admission
      // decision's signature round-trip. If the claim shape or signing call
      // drifted, the registry would 401 and this would exit non-zero instead
      // of committing ADMITTED.
      const admitRes = await dispatchNetwork([
        "admit", requestId!,
        "--admin-seed", adminSeedPath,
        "--apply", "--roster-only", "--json",
      ]);
      expect(admitRes.exitCode).toBe(0);
      const admitEnv = JSON.parse(admitRes.stdout) as { data: { applied: string; principal_id: string } };
      expect(admitEnv.data.applied).toBe("true");
      expect(admitEnv.data.principal_id).toBe("erin");

      // Confirm the row actually moved PENDING -> ADMITTED on the real registry.
      const listAfter = JSON.parse(
        (
          await dispatchNetwork([
            "admit", "--list-pending",
            "--admin-seed", adminSeedPath,
            "--status", "ADMITTED",
            "--json",
          ])
        ).stdout,
      ) as { items: { request_id: string; principal_id: string }[] };
      expect(listAfter.items.some((r) => r.request_id === requestId)).toBe(true);
    });
  });
});
