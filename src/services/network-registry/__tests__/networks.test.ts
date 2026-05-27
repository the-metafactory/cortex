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
import type { NetworkRoster, SignedAssertion } from "../src/types";

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
