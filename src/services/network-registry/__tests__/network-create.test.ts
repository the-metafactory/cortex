/**
 * #747 — `POST /networks/:network_id` signed-admin create/update tests.
 *
 * The SECURE replacement for the descoped anonymous network write (S2.5 #745 →
 * #747). Drives the Worker via `app.fetch(request, env)` so the full Hono
 * pipeline + admin allowlist + signing path are exercised. Mirrors the
 * principals-register test style.
 *
 * Threat coverage:
 *   - valid admin claim (allowlisted)            → 201 created + signed receipt
 *   - forged signature (wrong key)               → 401
 *   - valid sig from non-allowlisted key         → 403
 *   - NO allowlist configured                    → 503 fail-closed, NO write
 *   - replayed nonce                             → 409
 *   - leaf_port out of range / bad shape         → 400
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedNetworkCreate,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, verifyEd25519 } from "../src/signing";
import { getStore } from "../src/store";
import type { NetworkDescriptor, NetworkRecord, SignedAssertion } from "../src/types";

let env: Env;
let admin: PrincipalKey;

async function post(path: string, body: unknown, e: Env = env): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
  );
}

async function get(path: string, e: Env = env): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), e);
}

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    // The admin's pubkey is on the allowlist for the happy path.
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Happy path
// =============================================================================

describe("POST /networks/:id — happy path (signed allowlisted admin)", () => {
  test("creates the network and returns a signed receipt", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin, {
      hubUrl: "tls://hub.meta-factory.ai:7422",
      leafPort: 7422,
    });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<NetworkRecord>;
    expect(json.payload.network_id).toBe("research-collab");
    expect(json.payload.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(json.payload.leaf_port).toBe(7422);
    expect(json.signature.length).toBeGreaterThan(0);
    expect(json.registry).toBe(env.REGISTRY_PUBLIC_KEY ?? "");

    // The receipt's registry signature verifies.
    const bound = canonicalJSON({
      payload: json.payload,
      issued_at: json.issued_at,
      registry: json.registry,
    });
    const ok = await verifyEd25519(
      env.REGISTRY_PUBLIC_KEY!,
      json.signature,
      new TextEncoder().encode(bound),
    );
    expect(ok).toBe(true);

    // The descriptor GET now serves the written topology.
    const getRes = await get("/networks/research-collab");
    expect(getRes.status).toBe(200);
    const desc = (await getRes.json()) as SignedAssertion<NetworkDescriptor>;
    expect(desc.payload.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(desc.payload.leaf_port).toBe(7422);
  });

  test("UPSERT — a second admin write updates the topology", async () => {
    await post(
      "/networks/research-collab",
      await makeSignedNetworkCreate("research-collab", admin, { hubUrl: "tls://old:7422", leafPort: 7422 }),
    );
    const res = await post(
      "/networks/research-collab",
      await makeSignedNetworkCreate("research-collab", admin, { hubUrl: "tls://new:7500", leafPort: 7500 }),
    );
    expect(res.status).toBe(201);
    const getRes = await get("/networks/research-collab");
    const desc = (await getRes.json()) as SignedAssertion<NetworkDescriptor>;
    expect(desc.payload.hub_url).toBe("tls://new:7500");
    expect(desc.payload.leaf_port).toBe(7500);
  });
});

// =============================================================================
// Auth failures
// =============================================================================

describe("POST /networks/:id — auth failures", () => {
  test("forged signature (signed by a different key) → 401", async () => {
    const otherKey = await makePrincipalKey();
    const body = await makeSignedNetworkCreate("research-collab", admin, {
      signWith: otherKey, // signature won't verify against admin.publicKeyB64
    });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("tampered claim after signing → 401", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin);
    body.claim.hub_url = "tls://attacker:7422"; // tamper post-signature
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(401);
  });

  test("valid signature from a NON-allowlisted admin key → 403", async () => {
    // A key that is real + correctly signs, but is NOT in REGISTRY_ADMIN_PUBKEYS.
    const rogue = await makePrincipalKey();
    const body = await makeSignedNetworkCreate("research-collab", rogue);
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_authorized");

    // And NOTHING was persisted.
    const getRes = await get("/networks/research-collab");
    expect(getRes.status).toBe(404);
  });

  test("issued_at outside skew window → 400", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const body = await makeSignedNetworkCreate("research-collab", admin, { issuedAt: old });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });

  test("replayed nonce → 409", async () => {
    const nonce = randomNonce();
    const body1 = await makeSignedNetworkCreate("research-collab", admin, { nonce });
    const res1 = await post("/networks/research-collab", body1);
    expect(res1.status).toBe(201);

    // Same nonce, fresh signature (different hub_url) — replay rejected.
    const body2 = await makeSignedNetworkCreate("research-collab", admin, { nonce, hubUrl: "tls://x:7422" });
    const res2 = await post("/networks/research-collab", body2);
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as { error: string }).error).toBe("nonce_replayed");
  });
});

// =============================================================================
// Fail-closed: no admin allowlist configured
// =============================================================================

describe("POST /networks/:id — fail-closed (no admin allowlist)", () => {
  test("returns 503 admin_not_configured and writes NOTHING when REGISTRY_ADMIN_PUBKEYS is absent", async () => {
    const reg = await makeRegistryKey();
    const unconfigured: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      // REGISTRY_ADMIN_PUBKEYS deliberately unset.
      ENVIRONMENT: "test",
    };
    const body = await makeSignedNetworkCreate("research-collab", admin);
    const res = await post("/networks/research-collab", body, unconfigured);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");

    // No anonymous hub_url write happened — the network does not exist.
    const getRes = await get("/networks/research-collab", env);
    expect(getRes.status).toBe(404);
  });

  test("empty/whitespace-only REGISTRY_ADMIN_PUBKEYS also fails closed (503, no write)", async () => {
    const reg = await makeRegistryKey();
    const blank: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      REGISTRY_ADMIN_PUBKEYS: "  , ,  ",
      ENVIRONMENT: "test",
    };
    const body = await makeSignedNetworkCreate("research-collab", admin);
    const res = await post("/networks/research-collab", body, blank);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("admin_not_configured");
    const getRes = await get("/networks/research-collab", env);
    expect(getRes.status).toBe(404);
  });
});

// =============================================================================
// Shape validation
// =============================================================================

describe("POST /networks/:id — shape validation", () => {
  test("leaf_port out of range → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin, { leafPort: 70000 });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });

  test("leaf_port zero → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin, { leafPort: 0 });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });

  test("empty hub_url → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin, { hubUrl: "" });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });

  test("body network_id mismatch with path → 400", async () => {
    const body = await makeSignedNetworkCreate("other-net", admin);
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { details: { field: string }[] };
    expect(json.details.some((d) => d.field === "network_id")).toBe(true);
  });

  test("invalid network_id in path → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin);
    const res = await post("/networks/INVALID_CAPS", body);
    expect(res.status).toBe(400);
  });

  test("missing nonce → 400", async () => {
    const body = await makeSignedNetworkCreate("research-collab", admin, { nonce: "" });
    const res = await post("/networks/research-collab", body);
    expect(res.status).toBe(400);
  });

  test("invalid JSON body → 400", async () => {
    const res = await app.fetch(
      new Request("http://localhost/networks/research-collab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  test("multi-key allowlist: a second listed admin is accepted", async () => {
    const admin2 = await makePrincipalKey();
    const multi: Env = {
      ...env,
      REGISTRY_ADMIN_PUBKEYS: `${admin.publicKeyB64}, ${admin2.publicKeyB64}`,
    };
    const body = await makeSignedNetworkCreate("research-collab", admin2);
    const res = await post("/networks/research-collab", body, multi);
    expect(res.status).toBe(201);
  });
});
