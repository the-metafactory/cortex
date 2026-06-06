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
 *     Network topology records are seeded at the STORE level by an admin
 *     (deploy-time seed script / direct D1 write), NOT via a public HTTP write
 *     route. An unauthenticated public write that the registry then SIGNS would
 *     defeat DD-9: an anonymous caller could seed a malicious `hub_url`, the
 *     registry would sign it, and every joining peer would leaf to the attacker
 *     (descriptor-poisoning → federation MITM). Network creation is a separate
 *     admin act; the secure signed-admin write API is tracked as a follow-up.
 *
 *   GET /networks/{network_id}/roster
 *     Query who's in this network. Membership is implicit: a principal is
 *     "in" a network if any of their announced capabilities lists that network.
 *     Returns a registry-signed assertion.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { signAssertion } from "./principals";
import { getStore, membersFromPrincipals, rosterFromPrincipals } from "../store";
import { isValidNetworkId } from "../validate";
import type { NetworkDescriptor } from "../types";

export function networkRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

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
