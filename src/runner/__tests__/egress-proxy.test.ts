/**
 * EBH-4 (cortex#2346) — tests for the L3 egress-filtering `CONNECT` proxy.
 *
 * These are REAL socket tests (no mocking of `Bun.listen`/`Bun.connect`):
 * a real destination TCP server, a real `EgressProxy` bound to
 * `127.0.0.1:<ephemeral>`, and a real raw client socket speaking the
 * `CONNECT` protocol — because the entire point of this module is that it
 * genuinely tunnels/denies real bytes, not a simulation of doing so. Every
 * test is 127.0.0.1-only; nothing here touches the network.
 *
 * Acceptance shape the design/EBH-4 brief calls for explicitly: "allowlisted
 * destination succeeds, non-allowlisted is denied" — both directions are
 * covered, plus the fail-closed-on-ambiguity discipline (a malformed
 * request denies in EVERY mode, not just `enforce`) and the `audit` mode's
 * report-only semantics (denies are observed but the connection still goes
 * through).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  EgressProxy,
  isHostAllowed,
  tryParseConnect,
  type EgressDenial,
} from "../egress-proxy";

// -----------------------------------------------------------------------------
// Pure-function tests — no sockets involved
// -----------------------------------------------------------------------------

describe("isHostAllowed — exact, case-insensitive, no wildcards", () => {
  test("exact match allowed", () => {
    expect(isHostAllowed("api.anthropic.com", new Set(["api.anthropic.com"]))).toBe(true);
  });

  test("case-insensitive", () => {
    expect(isHostAllowed("API.Anthropic.COM", new Set(["api.anthropic.com"]))).toBe(true);
  });

  test("trailing-dot FQDN normalizes the same as without", () => {
    expect(isHostAllowed("api.anthropic.com.", new Set(["api.anthropic.com"]))).toBe(true);
  });

  test("host not in allowlist is denied", () => {
    expect(isHostAllowed("evil.example", new Set(["api.anthropic.com"]))).toBe(false);
  });

  test("no suffix/wildcard matching — a subdomain of an allowed host is NOT allowed", () => {
    expect(isHostAllowed("evil.api.anthropic.com", new Set(["api.anthropic.com"]))).toBe(false);
    expect(isHostAllowed("anthropic.com", new Set(["api.anthropic.com"]))).toBe(false);
  });

  test("empty allowlist denies everything", () => {
    expect(isHostAllowed("api.anthropic.com", new Set())).toBe(false);
  });
});

describe("tryParseConnect — pure parser", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  test("incomplete header (no terminator yet) returns undefined", () => {
    expect(tryParseConnect(enc("CONNECT api.anthropic.com:443 HTTP/1.1\r\n"))).toBeUndefined();
  });

  test("well-formed CONNECT parses host/port and captures trailing bytes", () => {
    const result = tryParseConnect(
      enc("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\nTRAILING"),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.host).toBe("api.anthropic.com");
      expect(result.port).toBe(443);
      expect(new TextDecoder().decode(result.trailing)).toBe("TRAILING");
    }
  });

  test("non-CONNECT verb is a parse failure (plain-HTTP forward-proxying is out of scope)", () => {
    const result = tryParseConnect(enc("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"));
    expect(result?.ok).toBe(false);
  });

  test("non-numeric / out-of-range port is a parse failure", () => {
    expect(tryParseConnect(enc("CONNECT example.com:notaport HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
    expect(tryParseConnect(enc("CONNECT example.com:70000 HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
    expect(tryParseConnect(enc("CONNECT example.com:0 HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
  });

  test("garbage before the terminator is a parse failure, not a crash", () => {
    expect(tryParseConnect(enc("\x00\x01\x02 not http at all\r\n\r\n"))?.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Real-socket integration tests
// -----------------------------------------------------------------------------

/** A trivial echo server: whatever a client sends, it sends back. Used as
 *  the "allowed destination" the proxy tunnels to. */
function startEchoServer(): { port: number; connections: number; stop: () => void } {
  let connections = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections += 1;
      },
      data(socket, chunk) {
        socket.write(chunk);
      },
      close() {},
      error() {},
    },
  });
  return {
    port: listener.port,
    get connections() {
      return connections;
    },
    stop: () => listener.stop(true),
  };
}

/** Raw client that speaks the proxy protocol directly — mirrors the
 *  `connectRaw` helper pattern in `daemon-socket-auth.test.ts`. */
async function connectToProxy(proxyPort: number): Promise<{
  write: (s: string | Uint8Array) => void;
  received: () => string;
  close: () => void;
}> {
  let buf = "";
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port: proxyPort,
    socket: {
      data(_socket, chunk: Uint8Array) {
        buf += new TextDecoder().decode(chunk);
      },
      error() {},
      close() {},
    },
  });
  return {
    write: (s) => void sock.write(s),
    received: () => buf,
    close: () => sock.end(),
  };
}

/** Poll until `cond()` is true or throw after `timeoutMs` — same shape as
 *  `daemon-socket-auth.test.ts`'s `until()`. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`until() timed out waiting for condition`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Drain the first N denials off an EgressProxy without blocking forever. */
async function collectDenials(proxy: EgressProxy, count: number, timeoutMs = 2000): Promise<EgressDenial[]> {
  const out: EgressDenial[] = [];
  const iterator = proxy.denials()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (out.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collectDenials() timed out with ${out.length}/${count} collected`);
    const result = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

let activeProxies: EgressProxy[] = [];
let activeServers: { stop: () => void }[] = [];

afterEach(() => {
  for (const proxy of activeProxies) proxy.stop();
  for (const server of activeServers) server.stop();
  activeProxies = [];
  activeServers = [];
});

describe("EgressProxy — allowlisted destination (enforce mode)", () => {
  test("CONNECT to an allowed host succeeds and tunnels real bytes both ways", async () => {
    const echo = startEchoServer();
    activeServers.push(echo);

    const proxy = new EgressProxy(["127.0.0.1"], "enforce");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const client = await connectToProxy(port);
    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    await until(() => client.received().includes("200"));
    expect(client.received()).toContain("HTTP/1.1 200 Connection Established");

    client.write("ping-through-tunnel");
    await until(() => client.received().includes("ping-through-tunnel"));
    expect(client.received()).toContain("ping-through-tunnel");
    expect(echo.connections).toBe(1);

    client.close();
  });
});

describe("EgressProxy — non-allowlisted destination (enforce mode)", () => {
  test("CONNECT to a denied host is refused with 403 and NEVER reaches the destination", async () => {
    const echo = startEchoServer();
    activeServers.push(echo);

    // Allowlist names some OTHER host — 127.0.0.1 (the echo server) is not on it.
    const proxy = new EgressProxy(["allowed.example"], "enforce");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("403");
    expect(client.received()).not.toContain("200");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    expect(denials[0]?.blocked).toBe(true);
    expect(denials[0]?.host).toBe("127.0.0.1");

    // The whole point: a blocked CONNECT never dials the destination at all.
    expect(echo.connections).toBe(0);

    client.close();
  });
});

describe("EgressProxy — audit mode (DD-5 report-only)", () => {
  test("a would-be-denied host is still connected through, and the denial is observed as NOT blocked", async () => {
    const echo = startEchoServer();
    activeServers.push(echo);

    const proxy = new EgressProxy(["allowed.example"], "audit");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    await until(() => client.received().includes("200"));
    expect(client.received()).toContain("HTTP/1.1 200 Connection Established");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    expect(denials[0]?.blocked).toBe(false);

    // Audit really does let it through — the destination sees the connection.
    await until(() => echo.connections === 1);

    client.close();
  });
});

describe("EgressProxy — fail-closed on ambiguity, in EVERY mode", () => {
  test("a malformed (non-CONNECT) request is denied even in audit mode", async () => {
    const proxy = new EgressProxy(["anything.example"], "audit");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("400");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    // Fail-closed discipline: malformed requests are ALWAYS blocked, even
    // though this proxy is running in "audit" (which for a RECOGNIZED-but-
    // disallowed host would have let the connection through).
    expect(denials[0]?.blocked).toBe(true);

    client.close();
  });

  test("a malformed request is denied in enforce mode too", async () => {
    const proxy = new EgressProxy(["anything.example"], "enforce");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const client = await connectToProxy(port);
    client.write("not even an HTTP request\r\n\r\n");
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("400");

    client.close();
  });
});

describe("EgressProxy — lifecycle", () => {
  test("start() twice on the same instance throws", () => {
    const proxy = new EgressProxy([], "enforce");
    activeProxies.push(proxy);
    proxy.start();
    expect(() => proxy.start()).toThrow();
  });

  test("stop() closes the listener — a new connection attempt is refused", async () => {
    const proxy = new EgressProxy([], "enforce");
    const { port } = proxy.start();
    proxy.stop();

    let refused = false;
    try {
      await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, error() { refused = true; }, close() {} },
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
