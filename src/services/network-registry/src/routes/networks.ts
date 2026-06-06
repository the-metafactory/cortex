/**
 * IAW D.4.2 — Network endpoints.
 *
 *   GET /networks/{network_id}
 *     S2.5 (#745, spec DD-12) — the network DESCRIPTOR: the registry-served
 *     `hub_url` + `leaf_port` (admin-seeded topology) plus the lightweight
 *     `members[]` view (derived from the roster). Returns a registry-signed
 *     assertion so a joining stack can pin the registry pubkey and verify the
 *     chain before deriving its nats-server leaf remote. 404 (`not_found`) when
 *     the network has never been seeded.
 *
 *   POST /networks/{network_id}/register
 *     S2.5 (#745) — admin-seeds / updates a network's topology
 *     (`hub_url` / `leaf_port`). Idempotent UPSERT. Refuses to mutate when the
 *     registry has no signing key (same posture as principal register), and is
 *     rate-limited under the strict `register` bucket. Unlike principal
 *     register there is no per-network keypair to sign the body; this is an
 *     admin seed authenticated at the deploy/network boundary (no CF
 *     Access bypass — see wrangler.toml), tracked for a signed-admin upgrade.
 *
 *   GET /networks/{network_id}/roster
 *     Query who's in this network. Membership is implicit: a principal is
 *     "in" a network if any of their announced capabilities lists that network.
 *     Returns a registry-signed assertion.
 */

import { Hono } from "hono";
import { getRegistryPublicKey, type Env } from "../index";
import { signAssertion } from "./principals";
import { getStore, membersFromPrincipals, rosterFromPrincipals } from "../store";
import { isValidNetworkId, validateNetworkRegistration } from "../validate";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "../rate-limit";
import type { NetworkDescriptor } from "../types";

export function networkRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // S2.5 — admin-seed a network's topology. Mounted BEFORE the bare
  // `GET /networks/:id` getter; Hono routes by method so order is not strictly
  // required, but keeping the mutation surface first mirrors principals.ts.
  app.post("/networks/:network_id/register", async (c) => {
    // Refuse to mutate when we cannot produce a signed receipt — same guard
    // as principal register (the GET surface degrades to "unconfigured", but
    // the mutation surface gets stricter handling).
    if (!c.env.REGISTRY_SIGNING_KEY || !getRegistryPublicKey(c.env)) {
      return c.json(
        {
          error: "registry_unconfigured",
          details:
            "REGISTRY_SIGNING_KEY not provisioned; cannot accept a network seed without producing a signed receipt",
        },
        503,
      );
    }

    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }

    // Rate-limit BEFORE parse — reuse the strict `register` bucket, keyed by
    // (IP, network_id) so one network's seed storm can't hide behind a shared
    // egress IP and one IP can't exhaust the limit across many networks.
    const allowed = await checkRateLimit(
      c.env,
      "register",
      clientKey(c.req.raw, networkId),
    );
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("register")),
      });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err) {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const check = validateNetworkRegistration(body, networkId);
    if (!check.ok) {
      return c.json({ error: "validation_failed", details: check.errors }, 400);
    }

    const store = getStore(c.env);
    const record = await store.putNetwork(
      networkId,
      check.registration.hub_url,
      check.registration.leaf_port,
    );

    // Echo the seeded descriptor (members derived from the current roster) in
    // the same signed shape the GET surface returns.
    const principals = await store.listPrincipals();
    const descriptor: NetworkDescriptor = {
      network_id: record.network_id,
      hub_url: record.hub_url,
      leaf_port: record.leaf_port,
      members: membersFromPrincipals(principals, networkId),
    };
    const assertion = await signAssertion(c.env, descriptor);
    return c.json(assertion, 201);
  });

  // S2.5 (DD-12) — the network descriptor. 404 when the topology was never
  // seeded; otherwise a signed descriptor the S1 client parses.
  app.get("/networks/:network_id", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }
    const store = getStore(c.env);
    const record = await store.getNetwork(networkId);
    if (!record) {
      return c.json({ error: "not_found" }, 404);
    }
    const principals = await store.listPrincipals();
    const descriptor: NetworkDescriptor = {
      network_id: record.network_id,
      hub_url: record.hub_url,
      leaf_port: record.leaf_port,
      members: membersFromPrincipals(principals, networkId),
    };
    const assertion = await signAssertion(c.env, descriptor);
    return c.json(assertion);
  });

  app.get("/networks/:network_id/roster", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }
    const store = getStore(c.env);
    const principals = await store.listPrincipals();
    const roster = rosterFromPrincipals(principals, networkId);
    const assertion = await signAssertion(c.env, roster);
    return c.json(assertion);
  });

  return app;
}
