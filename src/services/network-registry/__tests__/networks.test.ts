/**
 * IAW D.4 — Network roster route tests.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, verifyEd25519 } from "../src/signing";
import type {
  NetworkDescriptor,
  NetworkRoster,
  SignedAssertion,
} from "../src/types";

let env: Env;

async function post(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`), env);
}

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  };
});

describe("GET /networks/:id/roster", () => {
  test("rejects invalid network_id", async () => {
    const res = await get("/networks/INVALID_CAPS/roster");
    expect(res.status).toBe(400);
  });

  test("returns empty roster when no principals are in the network", async () => {
    const res = await get("/networks/research-collab/roster");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    expect(json.payload.network_id).toBe("research-collab");
    expect(json.payload.members).toEqual([]);
  });

  test("aggregates principals whose capabilities target the network", async () => {
    const pA: PrincipalKey = await makePrincipalKey();
    const pB: PrincipalKey = await makePrincipalKey();
    const pC: PrincipalKey = await makePrincipalKey();

    await post(
      "/principals/alpha/register",
      await makeSignedRegistration("alpha", pA, {
        capabilities: [
          { id: "tasks.code-review", networks: ["research-collab"] },
          { id: "tasks.docs-edit", networks: ["docs-net"] },
        ],
      }),
    );
    await post(
      "/principals/beta/register",
      await makeSignedRegistration("beta", pB, {
        capabilities: [{ id: "tasks.code-review", networks: ["research-collab"] }],
      }),
    );
    // Gamma announces to a different network only — should be excluded.
    await post(
      "/principals/gamma/register",
      await makeSignedRegistration("gamma", pC, {
        capabilities: [{ id: "tasks.code-review", networks: ["other-net"] }],
      }),
    );

    const res = await get("/networks/research-collab/roster");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    const ids = json.payload.members.map((m) => m.principal_id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
    const alpha = json.payload.members.find((m) => m.principal_id === "alpha");
    expect(alpha?.capabilities).toEqual(["tasks.code-review"]);
    expect(alpha?.principal_pubkey).toBe(pA.publicKeyB64);
  });

  test("returns signed assertion verifiable with registry pubkey", async () => {
    const res = await get("/networks/research-collab/roster");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkRoster>;
    expect(json.signature.length).toBeGreaterThan(0);
    expect(json.registry).toBe(env.REGISTRY_PUBLIC_KEY ?? "");
  });
});

// =============================================================================
// S2.5 (#745, DD-12) — GET /networks/:id descriptor + POST register
// =============================================================================

/** Seed a network's topology via the register route. */
async function seedNetwork(
  networkId: string,
  hubUrl: string,
  leafPort: number,
): Promise<Response> {
  return post(`/networks/${networkId}/register`, {
    network_id: networkId,
    hub_url: hubUrl,
    leaf_port: leafPort,
  });
}

describe("POST /networks/:id/register — seed topology", () => {
  test("seeds a network and returns a signed descriptor", async () => {
    const res = await seedNetwork(
      "research-collab",
      "tls://hub.meta-factory.ai:7422",
      7422,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<NetworkDescriptor>;
    expect(json.payload.network_id).toBe("research-collab");
    expect(json.payload.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(json.payload.leaf_port).toBe(7422);
    expect(json.payload.members).toEqual([]);
    expect(json.signature.length).toBeGreaterThan(0);
  });

  test("rejects invalid network_id in path", async () => {
    const res = await post("/networks/INVALID_CAPS/register", {
      network_id: "INVALID_CAPS",
      hub_url: "tls://h:7422",
      leaf_port: 7422,
    });
    expect(res.status).toBe(400);
  });

  test("rejects body network_id mismatch with path", async () => {
    const res = await post("/networks/research-collab/register", {
      network_id: "other-net",
      hub_url: "tls://h:7422",
      leaf_port: 7422,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { details: { field: string }[] };
    expect(json.details.some((d) => d.field === "network_id")).toBe(true);
  });

  test("rejects empty hub_url", async () => {
    const res = await post("/networks/research-collab/register", {
      network_id: "research-collab",
      hub_url: "",
      leaf_port: 7422,
    });
    expect(res.status).toBe(400);
  });

  test("rejects out-of-range / non-integer leaf_port", async () => {
    const bad = await post("/networks/research-collab/register", {
      network_id: "research-collab",
      hub_url: "tls://h:7422",
      leaf_port: 70000,
    });
    expect(bad.status).toBe(400);
    const float = await post("/networks/research-collab/register", {
      network_id: "research-collab",
      hub_url: "tls://h:7422",
      leaf_port: 74.22,
    });
    expect(float.status).toBe(400);
  });

  test("re-seed UPSERTs the topology in place", async () => {
    await seedNetwork("research-collab", "tls://old:7422", 7422);
    const res = await seedNetwork("research-collab", "tls://new:7500", 7500);
    expect(res.status).toBe(201);

    const get1 = await get("/networks/research-collab");
    const json = (await get1.json()) as SignedAssertion<NetworkDescriptor>;
    expect(json.payload.hub_url).toBe("tls://new:7500");
    expect(json.payload.leaf_port).toBe(7500);
  });

  test("returns 503 and does not mutate when REGISTRY_SIGNING_KEY is absent", async () => {
    const unconfigured: Env = { ENVIRONMENT: "test" };
    const res = await app.fetch(
      new Request("http://localhost/networks/research-collab/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network_id: "research-collab",
          hub_url: "tls://h:7422",
          leaf_port: 7422,
        }),
      }),
      unconfigured,
    );
    expect(res.status).toBe(503);

    // Confirm nothing was persisted via the 503 path (configured env, 404).
    const getRes = await get("/networks/research-collab");
    expect(getRes.status).toBe(404);
  });
});

describe("GET /networks/:id — descriptor (DD-12)", () => {
  test("rejects invalid network_id", async () => {
    const res = await get("/networks/INVALID_CAPS");
    expect(res.status).toBe(400);
  });

  test("returns 404 (not_found) for an unseeded network", async () => {
    const res = await get("/networks/never-seeded");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_found");
  });

  test("returns a signed descriptor matching the S1 client contract", async () => {
    await seedNetwork("research-collab", "tls://hub.meta-factory.ai:7422", 7422);

    const res = await get("/networks/research-collab");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<NetworkDescriptor>;

    // Shape the S1 client's parseDescriptor reads.
    expect(json.payload.network_id).toBe("research-collab");
    expect(typeof json.payload.hub_url).toBe("string");
    expect(json.payload.hub_url.length).toBeGreaterThan(0);
    expect(Number.isInteger(json.payload.leaf_port)).toBe(true);
    expect(Array.isArray(json.payload.members)).toBe(true);
    expect(json.registry).toBe(env.REGISTRY_PUBLIC_KEY ?? "");
    expect(json.signature.length).toBeGreaterThan(0);
  });

  test("signature verifies against the registry pubkey (mirrors principals route)", async () => {
    await seedNetwork("research-collab", "tls://hub.meta-factory.ai:7422", 7422);
    const res = await get("/networks/research-collab");
    const json = (await res.json()) as SignedAssertion<NetworkDescriptor>;

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
  });

  test("members[] is derived from the roster (implicit membership)", async () => {
    await seedNetwork("research-collab", "tls://hub:7422", 7422);

    const pA: PrincipalKey = await makePrincipalKey();
    const pB: PrincipalKey = await makePrincipalKey();
    const pC: PrincipalKey = await makePrincipalKey();

    await post(
      "/principals/alpha/register",
      await makeSignedRegistration("alpha", pA, {
        capabilities: [{ id: "tasks.code-review", networks: ["research-collab"] }],
      }),
    );
    await post(
      "/principals/beta/register",
      await makeSignedRegistration("beta", pB, {
        capabilities: [{ id: "tasks.docs-edit", networks: ["research-collab"] }],
      }),
    );
    // Gamma targets a different network — must NOT appear in members.
    await post(
      "/principals/gamma/register",
      await makeSignedRegistration("gamma", pC, {
        capabilities: [{ id: "tasks.code-review", networks: ["other-net"] }],
      }),
    );

    const res = await get("/networks/research-collab");
    const json = (await res.json()) as SignedAssertion<NetworkDescriptor>;
    // Sorted, de-duplicated principal ids.
    expect(json.payload.members).toEqual(["alpha", "beta"]);
  });
});
