/**
 * IAW D.4 — Operator route tests (POST register + GET).
 *
 * Drives the Worker via `app.fetch(request, env)` so the full Hono
 * pipeline + middleware + signing path are exercised. Each test resets
 * module-scoped store/nonce-cache singletons in beforeEach.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makeOperatorKey,
  makeRegistryKey,
  makeSignedRegistration,
  randomNonce,
  resetStores,
  type OperatorKey,
} from "./helpers";
import {
  canonicalJSON,
  signEd25519,
  verifyEd25519,
} from "../src/signing";
import type { SignedAssertion, OperatorRecord } from "../src/types";

let env: Env;
let opKey: OperatorKey;

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  };
  opKey = await makeOperatorKey();
});

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

describe("POST /operators/:id/register — happy path", () => {
  test("registers a new operator and returns signed assertion", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "andreas/laptop", display_name: "Laptop" }],
      capabilities: [
        { id: "tasks.code-review", description: "Reviews TS", networks: ["research-collab"] },
      ],
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as SignedAssertion<OperatorRecord>;
    expect(json.payload.operator_id).toBe("andreas");
    expect(json.payload.operator_pubkey).toBe(opKey.publicKeyB64);
    expect(json.payload.stacks).toHaveLength(1);
    expect(json.payload.capabilities).toHaveLength(1);
    expect(json.signature.length).toBeGreaterThan(0);
    expect(json.registry).toBe(env.REGISTRY_PUBLIC_KEY ?? "");

    // Verify the registry's signature is structurally correct.
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
});

describe("POST /operators/:id/register — validation failures", () => {
  test("rejects invalid operator_id in path", async () => {
    const body = await makeSignedRegistration("andreas", opKey);
    const res = await post("/operators/INVALID_CAPS/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects body operator_id mismatch with path", async () => {
    const body = await makeSignedRegistration("not-andreas", opKey);
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { details: { field: string }[] };
    expect(json.details.some((d) => d.field === "operator_id")).toBe(true);
  });

  test("rejects stack_id whose operator prefix doesn't match", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "someoneelse/laptop" }],
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects duplicate stack_id within same claim", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "andreas/laptop" }, { stack_id: "andreas/laptop" }],
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects malformed pubkey", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      pubkeyOverride: "short",
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects capability id violating <domain>.<entity> grammar", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      capabilities: [{ id: "no-dot-here" }],
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects missing nonce", async () => {
    const body = await makeSignedRegistration("andreas", opKey, { nonce: "" });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON body", async () => {
    const res = await app.fetch(
      new Request("http://localhost/operators/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /operators/:id/register — auth failures", () => {
  test("rejects signature signed by wrong key", async () => {
    const otherKey = await makeOperatorKey();
    const body = await makeSignedRegistration("andreas", otherKey, {
      pubkeyOverride: opKey.publicKeyB64, // claim pubkey from someone else
    });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(401);
  });

  test("rejects tampered claim after signing", async () => {
    const body = await makeSignedRegistration("andreas", opKey);
    // Tamper: add an extra stack post-signature.
    body.claim.stacks.push({ stack_id: "andreas/sneaked-in" });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(401);
  });

  test("rejects issued_at outside skew window", async () => {
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const body = await makeSignedRegistration("andreas", opKey, { issuedAt: old });
    const res = await post("/operators/andreas/register", body);
    expect(res.status).toBe(400);
  });

  test("rejects replayed nonce", async () => {
    const nonce = randomNonce();
    const body1 = await makeSignedRegistration("andreas", opKey, { nonce });
    const res1 = await post("/operators/andreas/register", body1);
    expect(res1.status).toBe(201);

    // Same nonce, different claim (different stacks list to bypass any other gates)
    const body2 = await makeSignedRegistration("andreas", opKey, { nonce });
    const res2 = await post("/operators/andreas/register", body2);
    expect(res2.status).toBe(409);
  });

  test("rejects silent pubkey rotation", async () => {
    const body1 = await makeSignedRegistration("andreas", opKey);
    const res1 = await post("/operators/andreas/register", body1);
    expect(res1.status).toBe(201);

    const newKey = await makeOperatorKey();
    const body2 = await makeSignedRegistration("andreas", newKey);
    const res2 = await post("/operators/andreas/register", body2);
    expect(res2.status).toBe(409);
  });

  test("permits re-register with same pubkey (replaces stacks, no leftover)", async () => {
    // Echo cortex#225 nit: tighten the symmetric "old stacks gone" assertion.
    const body1 = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "andreas/laptop" }],
    });
    const res1 = await post("/operators/andreas/register", body1);
    expect(res1.status).toBe(201);

    const body2 = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "andreas/server" }],
    });
    const res2 = await post("/operators/andreas/register", body2);
    expect(res2.status).toBe(201);
    const json = (await res2.json()) as SignedAssertion<OperatorRecord>;
    expect(json.payload.stacks).toHaveLength(1);
    expect(json.payload.stacks[0]!.stack_id).toBe("andreas/server");
    // Confirm the old `andreas/laptop` is fully gone — not just that
    // the new list has length 1.
    const ids = json.payload.stacks.map((s) => s.stack_id);
    expect(ids).not.toContain("andreas/laptop");
  });
});

describe("POST /operators/:id/register — unconfigured registry", () => {
  // Echo cortex#225 issue #1: refuse to mutate state when the Worker
  // cannot produce a signed receipt.
  test("returns 503 and does not mutate state when REGISTRY_SIGNING_KEY is absent", async () => {
    const body = await makeSignedRegistration("andreas", opKey);
    const unconfigured: Env = { ENVIRONMENT: "test" };
    const res = await app.fetch(
      new Request("http://localhost/operators/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      unconfigured,
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("registry_unconfigured");

    // Switch to a configured env on the same module-shared store and
    // confirm the operator was NOT silently persisted by the 503 path.
    const getRes = await app.fetch(
      new Request("http://localhost/operators/andreas"),
      env,
    );
    expect(getRes.status).toBe(404);
  });
});

describe("GET /operators/:id", () => {
  test("returns 404 for unknown operator", async () => {
    const res = await get("/operators/nobody");
    expect(res.status).toBe(404);
  });

  test("returns signed assertion for registered operator", async () => {
    const body = await makeSignedRegistration("andreas", opKey, {
      stacks: [{ stack_id: "andreas/laptop" }],
    });
    await post("/operators/andreas/register", body);

    const res = await get("/operators/andreas");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<OperatorRecord>;
    expect(json.payload.operator_pubkey).toBe(opKey.publicKeyB64);
    expect(json.signature.length).toBeGreaterThan(0);

    // Verify registry signature.
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

  test("invalid operator_id in path returns 400", async () => {
    const res = await get("/operators/CAPS_INVALID");
    expect(res.status).toBe(400);
  });
});

describe("GET /registry/pubkey", () => {
  test("returns registry pubkey", async () => {
    const res = await get("/registry/pubkey");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { algorithm: string; public_key: string };
    expect(json.algorithm).toBe("Ed25519");
    expect(json.public_key).toBe(env.REGISTRY_PUBLIC_KEY ?? "");
  });

  test("returns 503 when unconfigured", async () => {
    const unconfigured: Env = { ENVIRONMENT: "test" };
    const res = await app.fetch(new Request("http://localhost/registry/pubkey"), unconfigured);
    expect(res.status).toBe(503);
  });
});

describe("GET /api/health", () => {
  test("returns ok", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ok");
  });
});
