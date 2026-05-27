/**
 * IAW D.4.2 — Network endpoints.
 *
 *   GET /networks/{network_id}/roster
 *     Query who's in this network. Membership is implicit: a principal
 *     is "in" a network if any of their announced capabilities lists
 *     that network. Returns a registry-signed assertion so the caller
 *     can pin the registry pubkey and verify the chain before
 *     mutating its local peer registry.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { signAssertion } from "./principals";
import { getStore, rosterFromPrincipals } from "../store";
import { isValidNetworkId } from "../validate";

export function networkRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/networks/:network_id/roster", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }
    const store = getStore();
    const principals = await store.listPrincipals();
    const roster = rosterFromPrincipals(principals, networkId);
    const assertion = await signAssertion(c.env, roster);
    return c.json(assertion);
  });

  return app;
}
