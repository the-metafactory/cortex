/**
 * IAW D.4 — Capability search route tests.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makeOperatorKey,
  makeRegistryKey,
  makeSignedRegistration,
  resetStores,
} from "./helpers";
import type { CapabilityHit, SignedAssertion } from "../src/types";

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

describe("GET /capabilities", () => {
  test("rejects empty query", async () => {
    const res = await get("/capabilities");
    expect(res.status).toBe(400);
  });

  test("rejects overlong query", async () => {
    const overlong = "x".repeat(200);
    const res = await get(`/capabilities?query=${overlong}`);
    expect(res.status).toBe(400);
  });

  test("returns hits matching the id substring", async () => {
    const opA = await makeOperatorKey();
    const opB = await makeOperatorKey();
    await post(
      "/operators/alpha/register",
      await makeSignedRegistration("alpha", opA, {
        capabilities: [
          { id: "tasks.code-review", description: "TS + Rust", networks: ["n1"] },
          { id: "tasks.docs-edit", networks: ["n1"] },
        ],
      }),
    );
    await post(
      "/operators/beta/register",
      await makeSignedRegistration("beta", opB, {
        capabilities: [{ id: "infra.deploy", networks: ["n2"] }],
      }),
    );

    const res = await get("/capabilities?query=tasks");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<{ hits: CapabilityHit[]; truncated: boolean }>;
    expect(json.payload.hits).toHaveLength(2);
    expect(json.payload.truncated).toBe(false);
    expect(json.payload.hits.map((h) => h.capability_id).sort()).toEqual([
      "tasks.code-review",
      "tasks.docs-edit",
    ]);
  });

  test("matches description case-insensitively", async () => {
    const op = await makeOperatorKey();
    await post(
      "/operators/alpha/register",
      await makeSignedRegistration("alpha", op, {
        capabilities: [
          { id: "tasks.code-review", description: "TypeScript reviewer", networks: ["n1"] },
        ],
      }),
    );
    const res = await get("/capabilities?query=TYPESCRIPT");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<{ hits: CapabilityHit[] }>;
    expect(json.payload.hits).toHaveLength(1);
  });

  test("returns empty hits for no matches", async () => {
    const res = await get("/capabilities?query=nothing-here");
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<{ hits: CapabilityHit[] }>;
    expect(json.payload.hits).toEqual([]);
  });
});
