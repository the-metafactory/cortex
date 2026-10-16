import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer, type ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { DEFAULT_LOCAL_PRINCIPAL } from "../api/networks-admission";
import type {
  AdmissionDecider,
  AdmissionDecisionInput,
  AdmissionDecisionResult,
} from "../api/networks-admission";
import type { Database } from "bun:sqlite";

const PORT_BIND_ANY = 0;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface Ctx {
  db: Database;
  ctx: ServerContext;
  baseUrl: string;
  tmpDir: string;
  calls: AdmissionDecisionInput[];
}

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
  return { db, ctx, baseUrl: `http://localhost:${ctx.port}`, tmpDir, calls };
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
    expect(LOOPBACK_HOSTS.has(c.ctx.server.hostname ?? "")).toBe(true);
    expect(DEFAULT_CONFIG.hostname).toBe("127.0.0.1");
  });

  it("resolves to the local principal (FND-6 posture A) when the CF-Access header is absent on loopback — reaches the signer, no 401", async () => {
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
    expect(res.status).toBe(200);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.principal).toBe(DEFAULT_LOCAL_PRINCIPAL);
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
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.principal).toBe("principal@example.com");
    expect(c.calls[0]?.decision).toBe("admit");
  });
});
