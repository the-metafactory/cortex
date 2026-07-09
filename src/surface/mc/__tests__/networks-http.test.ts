/**
 * MC-A1 (cortex#1275) — `GET /api/networks` end-to-end route tests.
 *
 * Drives the route through the real Bun.serve HTTP stack with stub
 * `NetworksView` + `AgentPresenceView` getters — confirming the route is wired,
 * the lazy getter resolves per request, the no-view path serves an empty list,
 * and non-GET methods are rejected.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import type { NetworksView } from "../api/networks";
import type { AgentPresenceView } from "../api/agents";
import type { Database } from "bun:sqlite";

const PORT_BIND_ANY = 0;

function boundPort(ctx: ServerContext): number {
  const port = ctx.server.port;
  if (port === undefined) throw new Error("server.port unresolved after start");
  return port;
}

interface Ctx {
  db: Database;
  ctx: ServerContext;
  baseUrl: string;
  tmpDir: string;
}

function startWith(opts: {
  networks?: () => NetworksView | null;
  agentPresence?: () => AgentPresenceView | null;
}): Ctx {
  const tmpDir = join(tmpdir(), `mc-networks-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: PORT_BIND_ANY }, db, {
    ...(opts.networks ? { networks: opts.networks } : {}),
    ...(opts.agentPresence ? { agentPresence: opts.agentPresence } : {}),
  });
  return { db, ctx, baseUrl: `http://localhost:${boundPort(ctx)}`, tmpDir };
}

function teardown(c: Ctx): void {
  c.ctx.stop(true);
  c.db.close();
  rmSync(c.tmpDir, { recursive: true, force: true });
}

describe("GET /api/networks (HTTP)", () => {
  let c: Ctx;
  afterEach(() => {
    teardown(c);
  });

  it("returns an empty list when no networks view is wired", async () => {
    c = startWith({});
    const res = await fetch(`${c.baseUrl}/api/networks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ networks: [] });
  });

  it("returns an empty list when the getter resolves to null", async () => {
    c = startWith({ networks: () => null });
    const res = await fetch(`${c.baseUrl}/api/networks`);
    expect(res.status).toBe(200);
    expect((await res.json()).networks).toEqual([]);
  });

  it("serves the reconciled membership through the wired view", async () => {
    const view: NetworksView = {
      localPrincipal: "andreas",
      networks: () => [
        {
          networkId: "research-collab",
          leafNode: "rc-leaf",
          confidentiality: { mode: "off", keyPresent: false, keyId: null },
        },
      ],
      resolveAdmittedRoster: () =>
        Promise.resolve({
          ok: true,
          roster: { admitted: ["jc"], pending: [], authoritative: true },
        }),
    };
    const presence: AgentPresenceView = {
      getAgents: () => [
        {
          key: "andreas/main/luna",
          origin: "local",
          agentId: "luna",
          nkeyPublicKey: "NL",
          assistantName: "Luna",
          principal: "andreas",
          stack: "main",
          capabilities: [],
          state: "online",
          lastSeenAt: 1,
        },
      ],
    };
    c = startWith({ networks: () => view, agentPresence: () => presence });
    const res = await fetch(`${c.baseUrl}/api/networks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.networks).toHaveLength(1);
    expect(body.networks[0].network_id).toBe("research-collab");
    expect(body.networks[0].leaf_node).toBe("rc-leaf");
    expect(body.networks[0].roster_scope).toBe("complete");
    const byPrincipal = Object.fromEntries(
      body.networks[0].members.map((m: { principal: string; verdict: string }) => [
        m.principal,
        m.verdict,
      ]),
    );
    // FS-6 — the view stub exposes no `receivedPresenceFrom`, so the absent
    // family collapses to the conservative `absent-offline` (never over-claim
    // "unheard" without the receipt ledger).
    expect(byPrincipal).toEqual({ andreas: "admitted-present", jc: "absent-offline" });
  });

  it("rejects non-GET methods", async () => {
    c = startWith({ networks: () => null });
    const res = await fetch(`${c.baseUrl}/api/networks`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
