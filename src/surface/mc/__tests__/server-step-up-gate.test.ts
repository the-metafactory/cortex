import { describe, it, expect, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTHORIZE_PATH, type Authorizer } from "../api/networks-authorize";
import { createEnrollment, writeEnrollment } from "../../../common/step-up/enrollment";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { startServer, type ServerContext } from "../server";

const PRINCIPAL = "principal@example.com";

interface Ctx {
  db: Database;
  ctx: ServerContext;
  baseUrl: string;
  tmpDir: string;
  secretPath: string;
  authorizeCalls: string[];
}

function start(): Ctx {
  const tmpDir = join(tmpdir(), `mc-step-up-${Date.now()}-${Math.random()}`);
  const secretPath = join(tmpDir, "step-up-totp.json");
  const db = initDatabase(join(tmpDir, "test.db"));
  const authorizeCalls: string[] = [];
  const authorizer: Authorizer = {
    authorize(requestId) {
      authorizeCalls.push(requestId);
      return Promise.reject(new Error("the authorizer must not be reached"));
    },
  };
  const ctx = startServer(
    {
      ...DEFAULT_CONFIG,
      port: 0,
      governance: { principals: [PRINCIPAL], stepUp: { secretPath } },
    },
    db,
    { authorizer: () => authorizer },
  );
  const port = ctx.server.port;
  if (port === undefined) throw new Error("server.port unresolved after start");
  return { db, ctx, baseUrl: `http://localhost:${port}`, tmpDir, secretPath, authorizeCalls };
}

function postAuthorize(c: Ctx, email: string): Promise<Response> {
  return fetch(`${c.baseUrl}${AUTHORIZE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: c.baseUrl,
      "Cf-Access-Authenticated-User-Email": email,
    },
    body: JSON.stringify({ request_id: "req-1", confirm: "req-1" }),
  });
}

describe("handleApi gate order on a step-up control verb", () => {
  let c: Ctx;
  afterEach(() => {
    c.ctx.stop(true);
    c.db.close();
    rmSync(c.tmpDir, { recursive: true, force: true });
  });

  it("runs the identity gate before the step-up gate", async () => {
    c = start();
    const res = await postAuthorize(c, "unlisted@example.com");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_authorized");
    expect(c.authorizeCalls).toEqual([]);
  });

  it("refuses an un-enrolled daemon before the route handler runs", async () => {
    c = start();
    const res = await postAuthorize(c, PRINCIPAL);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("step_up_not_configured");
    expect(c.authorizeCalls).toEqual([]);
  });

  it("loads the enrollment per request, so enrolling needs no restart", async () => {
    c = start();
    const before = await postAuthorize(c, PRINCIPAL);
    expect((await before.json()).error).toBe("step_up_not_configured");

    writeEnrollment(c.secretPath, createEnrollment("2026-10-16T00:00:00.000Z"));

    const after = await postAuthorize(c, PRINCIPAL);
    expect(after.status).toBe(403);
    expect((await after.json()).error).toBe("step_up_required");
    expect(c.authorizeCalls).toEqual([]);
  });
});
