/**
 * C-1398 (#1398) — the register response ECHOES the admission `request_id`.
 *
 * Follow-up from #1315: previously `POST /principals/:id/register` returned
 * only the signed principal assertion and DISCARDED `upsertPending`'s return,
 * so a client had to do a SECOND, PoP-signed `GET /admission-requests/mine`
 * round-trip just to learn the id of the admission request it had created.
 * This route now echoes `request_id` (+ `admission_status`) in the register
 * success body. These tests pin:
 *   - the echoed `request_id` is present, a string, and matches the id the
 *     admin sees via the admin list / the member sees via `/mine` EXACTLY,
 *   - `admission_status` is the raw `AdmissionRequest.status` ("PENDING"),
 *   - the echo is idempotent (re-register → SAME id),
 *   - it survives across per-network rows (two networks → two distinct ids),
 *   - the additive fields do NOT disturb the signed assertion (back-compat).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedAdminRead,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let principal: PrincipalKey;

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

async function get(path: string, headers: Record<string, string> = {}, e: Env = env): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/** Admin-list PENDING admission requests — the id source of truth to match. */
async function listPending(): Promise<AdmissionRequest[]> {
  const read = await makeSignedAdminRead(admin);
  const res = await get("/admission-requests?status=PENDING", {
    "x-admin-signed": JSON.stringify(read),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AdmissionRequest[];
}

/** Member PoP read for `GET /admission-requests/mine` (mirror the field name). */
async function makeSignedMineRead(
  principalId: string,
  memberKey: PrincipalKey,
): Promise<{ claim: { principal_id: string; peer_pubkey: string; issued_at: string }; signature: string }> {
  const claim = {
    principal_id: principalId,
    peer_pubkey: memberKey.publicKeyB64,
    issued_at: new Date().toISOString(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signEd25519(memberKey.privateKeyB64, message);
  return { claim, signature };
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  principal = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

describe("C-1398 — register response echoes request_id", () => {
  test("a successful register echoes request_id (string) + admission_status PENDING", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.request_id).toBe("string");
    expect((body.request_id as string).length).toBeGreaterThan(0);
    expect(body.admission_status).toBe("PENDING");
  });

  test("the echoed request_id EXACTLY matches the admin-listed row id", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    const body = (await res.json()) as { request_id: string };

    const pending = (await listPending()).filter((r) => r.principal_id === "alice");
    expect(pending.length).toBe(1);
    // Same opaque id, same format — the round-trip the echo replaces.
    expect(body.request_id).toBe(pending[0]!.request_id);
  });

  test("the echoed request_id EXACTLY matches the /mine (AdmissionRequest) id", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    const body = (await res.json()) as { request_id: string };

    const read = await makeSignedMineRead("alice", principal);
    const mineRes = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(read) });
    expect(mineRes.status).toBe(200);
    const rows = (await mineRes.json()) as AdmissionRequest[];
    expect(rows.length).toBe(1);
    // Field name AND value line up with what /mine returns.
    expect(body.request_id).toBe(rows[0]!.request_id);
  });

  test("re-registering the SAME network echoes the SAME request_id (idempotent)", async () => {
    const first = (await (
      await post(
        "/principals/alice/register",
        await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
      )
    ).json()) as { request_id: string };

    const second = (await (
      await post(
        "/principals/alice/register",
        await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
      )
    ).json()) as { request_id: string };

    expect(second.request_id).toBe(first.request_id);
  });

  test("two networks echo two DISTINCT request_ids, each matching its row", async () => {
    const a = (await (
      await post(
        "/principals/alice/register",
        await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
      )
    ).json()) as { request_id: string };
    const b = (await (
      await post(
        "/principals/alice/register",
        await makeSignedRegistration("alice", principal, { networkId: "net-b" }),
      )
    ).json()) as { request_id: string };

    expect(a.request_id).not.toBe(b.request_id);

    const pending = (await listPending()).filter((r) => r.principal_id === "alice");
    const byNet = new Map(pending.map((r) => [r.network_id, r.request_id]));
    expect(byNet.get("net-a")!).toBe(a.request_id);
    expect(byNet.get("net-b")!).toBe(b.request_id);
  });

  test("a network-less register also echoes a request_id", async () => {
    const res = await post("/principals/alice/register", await makeSignedRegistration("alice", principal));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.request_id).toBe("string");
    expect(body.admission_status).toBe("PENDING");
  });

  test("back-compat: the additive echo does NOT disturb the signed assertion", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    // The signed fields a peer verifies are all still present + well-formed.
    expect(body).toHaveProperty("payload");
    expect(body).toHaveProperty("issued_at");
    expect(body).toHaveProperty("registry");
    expect(typeof body.signature).toBe("string");
    expect((body.signature as string).length).toBeGreaterThan(0);
    // The failure-path flag is NOT set on a success.
    expect(body.admission_request).toBeUndefined();
  });
});
