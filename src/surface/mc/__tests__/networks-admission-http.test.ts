/**
 * MC-B2 (cortex#1279) — loopback-invariant guard for the mutating
 * `POST /api/networks/admission-decision` route.
 *
 * ## Why this test exists (review nit adv-N1)
 *
 * Gate 1 of the admission-decision handler trusts the
 * `Cf-Access-Authenticated-User-Email` header AS-IS — it never validates the
 * `Cf-Access-Jwt-Assertion`. That is only safe because the daemon binds
 * **loopback-only** (server.ts SEV-2): the sole path on which a request can both
 * (a) carry that header and (b) reach the local signer is the principal's own
 * CF-Access tunnel to their own daemon. A future regression that binds the server
 * beyond loopback (e.g. `0.0.0.0`) would make the un-validated header trivially
 * forgeable from the network — turning admission-signing into a remote-forge.
 *
 * These cases lock that trust boundary: they boot the REAL Bun.serve stack with a
 * stub {@link AdmissionDecider} wired and assert the route is served on the
 * loopback interface, and that Gate 1 (401 without the header) is enforced there.
 * If the default bind ever moves off loopback, the hostname assertion fails loud.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import type {
  AdmissionDecider,
  AdmissionDecisionInput,
  AdmissionDecisionResult,
} from "../api/networks-admission";
import type { Database } from "bun:sqlite";

const PORT_BIND_ANY = 0;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
  calls: AdmissionDecisionInput[];
}

/**
 * Boot the real server with a recording {@link AdmissionDecider} stub — no seed,
 * no registry, no crypto; just enough to prove the route is wired and reachable.
 */
function startWithDecider(): Ctx {
  const tmpDir = join(tmpdir(), `mc-admission-http-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  const calls: AdmissionDecisionInput[] = [];
  const decider: AdmissionDecider = {
    decide: (input): Promise<AdmissionDecisionResult> => {
      calls.push(input);
      return Promise.resolve({ ok: true, status: "ADMITTED", requestId: input.requestId });
    },
  };
  const ctx = startServer({ ...DEFAULT_CONFIG, port: PORT_BIND_ANY }, db, {
    admissionDecider: () => decider,
  });
  return { db, ctx, baseUrl: `http://localhost:${boundPort(ctx)}`, tmpDir, calls };
}

function teardown(c: Ctx): void {
  c.ctx.stop(true);
  c.db.close();
  rmSync(c.tmpDir, { recursive: true, force: true });
}

describe("POST /api/networks/admission-decision — loopback invariant", () => {
  let c: Ctx;
  afterEach(() => {
    teardown(c);
  });

  it("binds the admission-decision route to a loopback interface only", () => {
    c = startWithDecider();
    // The signing route's ONLY safety for the un-validated CF-Access header is
    // that it is unreachable off loopback. If a regression binds beyond loopback
    // (e.g. 0.0.0.0), this fails — do NOT relax it without re-designing Gate 1.
    expect(LOOPBACK_HOSTS.has(c.ctx.server.hostname ?? "")).toBe(true);
    expect(DEFAULT_CONFIG.hostname).toBe("127.0.0.1");
  });

  it("enforces Gate 1 (401 without the CF-Access header) on the loopback bind", async () => {
    c = startWithDecider();
    const res = await fetch(`${c.baseUrl}/api/networks/admission-decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        network_id: "acme",
        request_id: "req-abc-123",
        decision: "admit",
        confirm: "req-abc-123",
      }),
    });
    expect(res.status).toBe(401);
    // The signer must NOT run when the identity header is absent.
    expect(c.calls).toHaveLength(0);
  });

  it("reaches the wired signer over loopback when the CF-Access header is present", async () => {
    c = startWithDecider();
    const res = await fetch(`${c.baseUrl}/api/networks/admission-decision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Cf-Access-Authenticated-User-Email": "principal@example.com",
      },
      body: JSON.stringify({
        network_id: "acme",
        request_id: "req-abc-123",
        decision: "admit",
        confirm: "req-abc-123",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ADMITTED", request_id: "req-abc-123" });
    // Proves the route resolved the injected decider through the loopback stack,
    // carrying the CF-Access principal for audit.
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.principal).toBe("principal@example.com");
    expect(c.calls[0]?.decision).toBe("admit");
  });
});
