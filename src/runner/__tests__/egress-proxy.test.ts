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
    if (result?.ok && result.kind === "connect") {
      expect(result.host).toBe("api.anthropic.com");
      expect(result.port).toBe(443);
      expect(new TextDecoder().decode(result.trailing)).toBe("TRAILING");
    }
  });

  test("non-numeric / out-of-range CONNECT port is a parse failure", () => {
    expect(tryParseConnect(enc("CONNECT example.com:notaport HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
    expect(tryParseConnect(enc("CONNECT example.com:70000 HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
    expect(tryParseConnect(enc("CONNECT example.com:0 HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
  });

  test("garbage before the terminator is a parse failure, not a crash", () => {
    expect(tryParseConnect(enc("\x00\x01\x02 not http at all\r\n\r\n"))?.ok).toBe(false);
  });

  test("a verb this parser doesn't recognize at all is a parse failure", () => {
    expect(tryParseConnect(enc("WHATEVER http://example.com/ HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// cortex#2412 follow-up — plain-HTTP absolute-URI forward-proxy parsing.
// `HTTP_PROXY` clients (as opposed to `HTTPS_PROXY`) send this shape, not
// CONNECT; before this fix it fell into the CONNECT parser's failure branch
// and was fail-closed denied in EVERY mode, including `audit` — defeating
// `audit`'s entire report-only purpose (see the module doc's "Fail-closed
// discipline" section for the full rationale).
// -----------------------------------------------------------------------------

describe("tryParseConnect — plain-HTTP absolute-URI forward-proxy requests", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const decode = (result: ReturnType<typeof tryParseConnect>): string => {
    if (!result || !result.ok || result.kind !== "http-forward") {
      throw new Error("expected a parsed http-forward result");
    }
    return new TextDecoder().decode(result.forwardBytes);
  };

  test("GET with an explicit port parses host/port and is no longer a failure", () => {
    const result = tryParseConnect(enc("GET http://example.com:8080/path HTTP/1.1\r\nHost: example.com:8080\r\n\r\n"));
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.kind).toBe("http-forward");
      expect(result.host).toBe("example.com");
      expect(result.port).toBe(8080);
    }
  });

  test("no explicit port defaults to 80 (plain-HTTP default)", () => {
    const result = tryParseConnect(enc("POST http://localhost/api/events/ingest HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    expect(result?.ok).toBe(true);
    if (result?.ok && result.kind === "http-forward") {
      expect(result.host).toBe("localhost");
      expect(result.port).toBe(80);
    }
  });

  test("rewrites the request line to origin-form (path only, no scheme/host)", () => {
    const text = decode(
      tryParseConnect(enc("POST http://localhost:8766/api/events/ingest HTTP/1.1\r\nHost: localhost:8766\r\n\r\n")),
    );
    expect(text.split("\r\n")[0]).toBe("POST /api/events/ingest HTTP/1.1");
  });

  test("preserves the client's Host header verbatim — does not duplicate it", () => {
    const text = decode(
      tryParseConnect(enc("POST http://localhost:8766/x HTTP/1.1\r\nHost: localhost:8766\r\nX-Foo: bar\r\n\r\n")),
    );
    const hostLines = text.split("\r\n").filter((l) => /^host:/i.test(l));
    expect(hostLines).toHaveLength(1);
    expect(hostLines[0]).toBe("Host: localhost:8766");
    expect(text).toContain("X-Foo: bar");
  });

  test("synthesizes a Host header when the client didn't send one", () => {
    const text = decode(tryParseConnect(enc("GET http://example.com:8080/path HTTP/1.1\r\n\r\n")));
    expect(text).toContain("Host: example.com:8080\r\n");
  });

  test("synthesized Host header omits :80 for the default port", () => {
    const text = decode(tryParseConnect(enc("GET http://example.com/path HTTP/1.1\r\n\r\n")));
    expect(text).toContain("Host: example.com\r\n");
    expect(text).not.toContain("Host: example.com:80");
  });

  test("no path defaults to origin-form \"/\"", () => {
    const text = decode(tryParseConnect(enc("GET http://example.com HTTP/1.1\r\n\r\n")));
    expect(text.split("\r\n")[0]).toBe("GET / HTTP/1.1");
  });

  test("body bytes already buffered past the terminator are appended after the rewritten headers", () => {
    const result = tryParseConnect(
      enc('POST http://localhost:8766/ingest HTTP/1.1\r\nHost: localhost:8766\r\nContent-Length: 11\r\n\r\n{"ok":true}'),
    );
    expect(result?.ok).toBe(true);
    if (result?.ok && result.kind === "http-forward") {
      const text = new TextDecoder().decode(result.forwardBytes);
      expect(text.endsWith('{"ok":true}')).toBe(true);
    }
  });

  test("malformed absolute-URI port is a parse failure", () => {
    expect(tryParseConnect(enc("GET http://example.com:notaport/ HTTP/1.1\r\n\r\n"))?.ok).toBe(false);
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

/** A minimal real HTTP-ish server: captures the raw bytes of every request
 *  it receives (so a test can assert the proxy rewrote the request line to
 *  origin-form, added a Host header, etc.) and answers with a real,
 *  well-formed HTTP/1.1 response. Used as the "destination" for the
 *  plain-HTTP absolute-URI forward-proxy tests — the whole point of those
 *  tests is that a REAL HTTP round trip completes, not merely that no error
 *  came back. */
function startCapturingHttpServer(): {
  port: number;
  requests: () => string[];
  connections: number;
  stop: () => void;
} {
  let connections = 0;
  const requests: string[] = [];
  const RESPONSE = "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\ngot-it!";
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        connections += 1;
      },
      data(socket, chunk) {
        requests.push(new TextDecoder().decode(chunk));
        socket.write(RESPONSE);
      },
      close() {},
      error() {},
    },
  });
  return {
    port: listener.port,
    requests: () => requests,
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

// -----------------------------------------------------------------------------
// cortex#2412 follow-up — plain-HTTP absolute-URI forward, real sockets.
//
// THE core regression: before this fix, `audit` mode responded to an
// unparseable-to-the-old-parser plain-HTTP request with `400 Bad Request`
// and closed the socket — for EVERY plain-HTTP request, allowlisted or not,
// because the old parser never even got as far as evaluating the
// allowlist. That is a `blocked=true` outcome from a mode whose entire
// contract is "never terminates, never writes an error response." The
// tests below assert the ACTUAL fix: a plain-HTTP request completes
// end-to-end (real response bytes, not just "no error") in both the
// allowed and NOT-allowed-under-audit cases, and is refused only where
// `enforce` is supposed to refuse it.
// -----------------------------------------------------------------------------

describe("EgressProxy — plain-HTTP absolute-URI forward (allowlisted destination)", () => {
  test("POST to an allowed host completes end-to-end: origin-form + Host header at the target, real response relayed to the client", async () => {
    const target = startCapturingHttpServer();
    activeServers.push(target);

    const proxy = new EgressProxy(["127.0.0.1"], "enforce");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const client = await connectToProxy(port);
    client.write(
      `POST http://127.0.0.1:${target.port}/api/events/ingest HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${target.port}\r\n` +
        `Content-Length: 2\r\n\r\nhi`,
    );

    // Real end-to-end proof: the client actually gets the target's real
    // HTTP response body, not merely "no 400/403 came back".
    await until(() => client.received().includes("got-it!"));
    expect(client.received()).toContain("HTTP/1.1 200 OK");
    expect(client.received()).toContain("got-it!");

    await until(() => target.connections === 1);
    const [request] = target.requests();
    expect(request).toBeDefined();
    // The target sees origin-form, not the absolute-URI the client sent.
    expect(request?.startsWith("POST /api/events/ingest HTTP/1.1\r\n")).toBe(true);
    expect(request).toContain(`Host: 127.0.0.1:${target.port}`);

    client.close();
  });
});

describe("EgressProxy — plain-HTTP absolute-URI forward, NOT-allowlisted destination, audit mode (the bug)", () => {
  test("a plain-HTTP POST to a non-allowlisted host completes end-to-end under audit — no error response, no termination — and is recorded blocked:false", async () => {
    const target = startCapturingHttpServer();
    activeServers.push(target);

    // Allowlist names some OTHER host — the target is not on it, so this is
    // exactly the "would enforce deny this" case audit is supposed to
    // observe WITHOUT acting on it.
    const proxy = new EgressProxy(["allowed.example"], "audit");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write(
      `POST http://127.0.0.1:${target.port}/api/events/ingest HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${target.port}\r\n` +
        `Content-Length: 2\r\n\r\nhi`,
    );

    // THE assertion that would have failed before the fix: a REAL response
    // from the REAL destination arrives — not a 400, not a closed socket
    // with nothing on it.
    await until(() => client.received().includes("got-it!"));
    expect(client.received()).toContain("HTTP/1.1 200 OK");
    expect(client.received()).not.toContain("400 Bad Request");
    expect(client.received()).not.toContain("403 Forbidden");

    // The destination genuinely saw the request — audit really let it
    // through, exactly like it already does for CONNECT.
    await until(() => target.connections === 1);
    const [request] = target.requests();
    expect(request?.startsWith("POST /api/events/ingest HTTP/1.1\r\n")).toBe(true);

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    expect(denials[0]?.blocked).toBe(false);
    expect(denials[0]?.host).toBe("127.0.0.1");

    client.close();
  });
});

describe("EgressProxy — plain-HTTP absolute-URI forward, NOT-allowlisted destination, enforce mode", () => {
  test("a plain-HTTP POST to a non-allowlisted host is refused with 403 and NEVER reaches the destination", async () => {
    const target = startCapturingHttpServer();
    activeServers.push(target);

    const proxy = new EgressProxy(["allowed.example"], "enforce");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write(
      `POST http://127.0.0.1:${target.port}/api/events/ingest HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${target.port}\r\n` +
        `Content-Length: 2\r\n\r\nhi`,
    );
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("403");
    expect(client.received()).not.toContain("got-it!");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    expect(denials[0]?.blocked).toBe(true);

    // The whole point: a blocked plain-HTTP request never dials the
    // destination at all — identical guarantee to CONNECT's.
    expect(target.connections).toBe(0);

    client.close();
  });
});

describe("EgressProxy — fail-closed on ambiguity (NO determinable destination), in EVERY mode", () => {
  // cortex#2412 follow-up: this describe block used to send a well-formed
  // `GET http://example.com/ HTTP/1.1` request as its "ambiguous" example —
  // but that request is NOT ambiguous at all (it names a destination in the
  // standard plain-HTTP forward-proxy shape); the OLD parser simply didn't
  // understand that shape yet. Routing it into the no-destination fail-
  // closed branch was exactly the bug: it made `audit` kill traffic (cortex's
  // own event-ingest POSTs) that `enforce`, given the SAME allowlist,
  // wouldn't necessarily have blocked either — `audit` was blocking
  // *differently* from what `enforce` would do, not predicting it. Now that
  // the parser understands the absolute-URI shape (see the
  // "plain-HTTP absolute-URI forward" describe blocks below), these tests
  // use input that is genuinely unparseable — no verb this parser
  // recognizes in either shape, so there is truly no destination to dial in
  // ANY mode.
  test("a request with no recognizable verb/shape is denied even in audit mode", async () => {
    const proxy = new EgressProxy(["anything.example"], "audit");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write("not even an HTTP request\r\n\r\n");
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("400");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    // Fail-closed discipline: a request with NO destination is ALWAYS
    // blocked, even though this proxy is running in "audit" (which for a
    // RECOGNIZED-but-disallowed destination would have let the connection
    // through — see the "plain-HTTP absolute-URI forward" tests below).
    expect(denials[0]?.blocked).toBe(true);

    client.close();
  });

  test("a malformed CONNECT (bad port) is denied even in audit mode", async () => {
    const proxy = new EgressProxy(["anything.example"], "audit");
    activeProxies.push(proxy);
    const { port } = proxy.start();

    const denialsPromise = collectDenials(proxy, 1);

    const client = await connectToProxy(port);
    client.write("CONNECT example.com:999999 HTTP/1.1\r\n\r\n");
    await until(() => client.received().length > 0);
    expect(client.received()).toContain("400");

    const denials = await denialsPromise;
    expect(denials).toHaveLength(1);
    expect(denials[0]?.blocked).toBe(true);

    client.close();
  });

  test("a request with no recognizable verb/shape is denied in enforce mode too", async () => {
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
