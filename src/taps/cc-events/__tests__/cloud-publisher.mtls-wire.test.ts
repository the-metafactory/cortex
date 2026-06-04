/**
 * TC-4e (review FIX-FIRST) — WIRE-LEVEL mTLS test for the cloud-publisher.
 *
 * THE GAP THAT HID THE DEFECT. The mocked-fetch tests in
 * `cloud-publisher.test.ts` only prove `init.tls` is ATTACHED to the request —
 * they cannot see whether the runtime actually puts the client certificate on
 * the wire. The security review's premise was that Bun's `fetch` SILENTLY
 * DROPS the client cert/key, so the cloud→Worker leg runs server-auth-only
 * HTTPS while the principal believes `require` is enforcing mutual TLS. This
 * test settles it empirically against a REAL mTLS-enforcing server.
 *
 * WHY A NODE SUBPROCESS SERVER. Bun 1.3.2's own `node:https` server does NOT
 * implement client-cert verification: it neither enforces `requestCert` /
 * `rejectUnauthorized` nor exposes `socket.getPeerCertificate()`. An in-process
 * (Bun-hosted) server therefore cannot observe presentation — it would falsely
 * pass. Node's `https` server does both, and it faithfully mirrors production
 * (the Cloudflare Worker is a real mTLS-enforcing endpoint). So we run the
 * server under Node (`mtls-wire-server.mjs`) and drive it with the
 * cloud-publisher's Bun `fetch` client.
 *
 * ASSERTIONS:
 *   (a) WITH mtls material → the Node server sees the client CN and reports
 *       `authorized: true` ⇒ the cert IS presented on the wire (real mutual
 *       auth). Health probe too.
 *   (b) WITHOUT mtls material → the `requestCert: true` server REJECTS the
 *       handshake (tlsClientError; the request never reaches the handler) ⇒
 *       proving the server genuinely enforces, so (a) is not a false pass. The
 *       cloud-publisher swallows the error (events stay in local JSONL).
 *
 * If a Node binary cannot be located the suite is skipped (CI always has one;
 * `bun test` under fnm/asdf resolves it). It does NOT silently pass.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudPublisher } from "../cloud-publisher";
import type { PublishedEvent } from "../hooks/lib/event-types";
import type { NetworkResolver, NetworkConfig } from "../../../common/types/config";
import {
  TEST_CA,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_CLIENT_CERT,
  TEST_CLIENT_KEY,
  TEST_CLIENT_CN,
} from "./mtls-fixtures";

// ---------------------------------------------------------------------------

function makeEvent(): PublishedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: "agent.task.started",
    timestamp: new Date().toISOString(),
    session_id: "wire-session",
    agent_id: "luna",
    agent_name: "Luna",
    payload: { task: "wire" },
  };
}

function resolverFor(endpoint: string): NetworkResolver {
  return (networkId: string | undefined): NetworkConfig | null => ({
    id: networkId ?? "default",
    endpoint,
    apiKey: "grove_sk_wire",
    principalId: "andreas",
  });
}

/**
 * Resolve a Node binary path, or null when none is available. (Under `bun
 * test`, `process.execPath` is the bun binary, so we must locate node on PATH;
 * the test server needs Node's real client-cert-verifying https server.)
 */
function findNode(): string | null {
  try {
    const p = execSync("command -v node", { encoding: "utf-8" }).trim();
    return p.length > 0 ? p : null;
  } catch {
    // No node on PATH — the wire suite skips (it never silently passes).
    return null;
  }
}

interface ServerHandle {
  port: number;
  lines: () => Record<string, unknown>[];
  stop: () => void;
}

const SERVER_SCRIPT = join(import.meta.dir, "mtls-wire-server.mjs");

function startNodeServer(
  nodeBin: string,
  certDir: string,
): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(nodeBin, [SERVER_SCRIPT], {
      env: {
        ...process.env,
        CA_PATH: join(certDir, "ca.crt"),
        SERVER_CERT_PATH: join(certDir, "server.crt"),
        SERVER_KEY_PATH: join(certDir, "server.key"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines: Record<string, unknown>[] = [];
    let buf = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        const portMatch = /^PORT=(\d+)$/.exec(line);
        if (portMatch && !settled) {
          settled = true;
          resolve({
            port: Number(portMatch[1]),
            lines: () => lines.slice(),
            stop: () => {
              child.stdin.end();
              child.kill("SIGTERM");
            },
          });
          continue;
        }
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // non-JSON diagnostic line — ignore.
        }
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.stderr.on("data", () => {
      // Node may print TLS warnings; the JSON lines on stdout are the contract.
    });
  });
}

// ---------------------------------------------------------------------------

/**
 * Poll `condition` every 50ms for up to `timeoutMs` (default 2000ms), resolving
 * true when condition first holds or false after the deadline. Replaces bare
 * setTimeout(100) waits that proved racy on loaded CI runners: the Node server
 * subprocess writes its stdout JSON asynchronously, and 100ms was not always
 * enough under ubuntu GitHub Actions concurrency (cortex#699).
 */
async function pollUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return condition();
}

// ---------------------------------------------------------------------------

const nodeBin = findNode();
const describeWire = nodeBin ? describe : describe.skip;

describeWire("CloudPublisher — wire-level mTLS (Node https server, requestCert)", () => {
  let certDir: string;

  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), "cp-mtls-wire-"));
    writeFileSync(join(certDir, "ca.crt"), TEST_CA);
    writeFileSync(join(certDir, "server.crt"), TEST_SERVER_CERT);
    writeFileSync(join(certDir, "server.key"), TEST_SERVER_KEY);
  });

  afterAll(() => {
    rmSync(certDir, { recursive: true, force: true });
  });

  const mtlsMaterial = { cert: TEST_CLIENT_CERT, key: TEST_CLIENT_KEY, ca: TEST_CA };

  test("POST presents the client cert on the wire (server observes the CN, authorized)", async () => {
    const srv = await startNodeServer(nodeBin!, certDir);
    try {
      const pub = new CloudPublisher({
        networkResolver: resolverFor(`https://localhost:${srv.port}`),
        batchIntervalMs: 60_000,
        mtls: mtlsMaterial,
      });
      pub.publish(makeEvent());
      await pub.flush();
      await pub.close();
      // Poll until the server has logged the ingest line (cortex#699 — 100ms
      // fixed wait proved racy under loaded CI; poll for up to 2 s instead).
      await pollUntil(() => srv.lines().some((l) => l.path === "/api/ingest"));

      const ingest = srv.lines().find((l) => l.path === "/api/ingest");
      expect(ingest).toBeDefined();
      expect(ingest!.clientCN).toBe(TEST_CLIENT_CN);
      expect(ingest!.authorized).toBe(true);
    } finally {
      srv.stop();
    }
  });

  test("health probe presents the client cert on the wire", async () => {
    const srv = await startNodeServer(nodeBin!, certDir);
    try {
      await CloudPublisher.checkEndpoints(
        resolverFor(`https://localhost:${srv.port}`),
        ["default"],
        mtlsMaterial,
      );
      // Poll until the server has logged the health line (cortex#699).
      await pollUntil(() => srv.lines().some((l) => l.path === "/api/health"));

      const health = srv.lines().find((l) => l.path === "/api/health");
      expect(health).toBeDefined();
      expect(health!.clientCN).toBe(TEST_CLIENT_CN);
      expect(health!.authorized).toBe(true);
    } finally {
      srv.stop();
    }
  });

  test("WITHOUT mtls material the requestCert server REJECTS the handshake (no cert on wire)", async () => {
    const srv = await startNodeServer(nodeBin!, certDir);
    try {
      const pub = new CloudPublisher({
        networkResolver: resolverFor(`https://localhost:${srv.port}`),
        batchIntervalMs: 60_000,
        maxRetries: 1,
        // mtls omitted ⇒ server-auth-only HTTPS.
      });
      pub.publish(makeEvent());
      await pub.flush(); // must NOT throw — error is swallowed, events kept locally
      await pub.close();
      // Poll until the server has logged a tlsClientError line (cortex#699 —
      // the Node subprocess writes its tlsClientError event asynchronously; a
      // fixed 100ms wait proved racy under loaded CI runners).
      await pollUntil(() => srv.lines().some((l) => typeof l.tlsClientError === "string"));

      const allLines = srv.lines();
      // No request reached the handler presenting our client CN.
      const presented = allLines.some((l) => l.clientCN === TEST_CLIENT_CN);
      expect(presented).toBe(false);
      // The enforcing server rejected the cert-less handshake.
      const rejected = allLines.some((l) => typeof l.tlsClientError === "string");
      expect(rejected).toBe(true);
    } finally {
      srv.stop();
    }
  });
});
