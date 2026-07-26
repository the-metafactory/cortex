/**
 * EBH-4 (cortex#2346, epic #2341) — the L3 **egress allowlist**: a local,
 * deny-by-default forward proxy filtering both HTTP `CONNECT` (TLS tunnels)
 * and plain-HTTP absolute-URI requests (cortex#2412 follow-up — see the
 * module doc's "Mechanism" section below).
 *
 * ## What this closes
 *
 * `docs/design-session-sandbox.md` §4.3 and `docs/design-session-sandbox-platforms.md`
 * name Layer 3 directly: even a session whose filesystem confinement (L1/L2)
 * holds can still **exfiltrate** anything it legitimately read, over the
 * network, to an attacker-controlled host — unless egress itself is bounded.
 * `SandboxProfile.egressAllow` (`session-sandbox.ts`) has carried that
 * allowlist since EBH-2, seeded but **unenforced**. This module is what
 * finally reads it: every hostname a session's child process may reach,
 * enumerated, everything else denied by default.
 *
 * ## THE central claim-hygiene point — read this before trusting the boundary
 *
 * **This is a cooperating-client proxy, not a kernel boundary.** It works
 * ONLY because `cc-session.ts` points the spawned `claude` child at it via
 * `HTTP_PROXY`/`HTTPS_PROXY` env vars, and because well-behaved HTTP clients
 * (the `claude` CLI's own networking, `git`, `gh`, `curl` with default
 * behavior, Node/Bun's `fetch`/`undici` when the env vars are honored)
 * respect those variables. **A process that ignores `HTTP_PROXY`/`HTTPS_PROXY`
 * and opens a raw TCP/TLS socket directly bypasses this proxy completely** —
 * there is no OS-level rule forcing egress through it. That is a REAL,
 * documented gap, not an oversight:
 *
 *   - **macOS** (this build's only target platform — see the module's HARD
 *     HOLD below): no PF anchor, no per-uid firewall rule is installed.
 *     Doing that requires root and is explicitly out of scope
 *     (`docs/design-session-sandbox-platforms.md` calls this the same
 *     "weaker than Linux" limitation for the FS backend's own posture).
 *   - **Linux network-namespace containment** (the design doc's stronger
 *     "physically unable to reach anything but the proxy" story, §4.3) is
 *     NOT built here — that needs `unshare`/veth plumbing, which is
 *     `linux-bwrap`/EBH-3b territory and explicitly excluded by this repo's
 *     "no Linux-specific dependency" constraint for this slice.
 *
 * So: **what this DOES stop** — a cooperating child (the `claude` CLI itself,
 * and any subprocess that inherits/honors the proxy env vars) from reaching
 * a host outside the allowlist; every such attempt is denied and observable
 * (`system.security.egress-denial`). **What this does NOT stop** — a
 * deliberately adversarial process inside the session that opens its own
 * socket (e.g. `python -c "import socket; …"`, a raw `nc`, a custom binary)
 * ignoring the proxy env entirely. Do not describe this as "egress is
 * contained" without that qualifier — it is "egress is contained for
 * proxy-respecting clients." Closing the raw-socket gap needs either a
 * kernel-level filter (PF anchor / netns, deferred) or an L1-style
 * exec-time block on raw-socket-capable interpreters, neither of which is
 * this slice.
 *
 * ## Mechanism
 *
 * A per-session `Bun.listen` TCP server on `127.0.0.1:0` (OS-assigned
 * ephemeral port — never a fixed/predictable port). It speaks TWO proxy
 * shapes:
 *
 *   - HTTP `CONNECT host:port HTTP/1.1` — the TLS-tunnel form every
 *     HTTPS-over-proxy client uses. On a well-formed CONNECT whose `host`
 *     is on the allowlist (exact, case-insensitive match — see "no
 *     wildcards" below), it dials the target and becomes a raw byte tunnel.
 *   - The plain-HTTP absolute-URI forward-proxy form (`POST
 *     http://host[:port]/path HTTP/1.1`, per RFC 7230 §5.3.2 — any of
 *     `GET`/`POST`/`PUT`/`DELETE`/`PATCH`/`HEAD`/`OPTIONS`/`TRACE`). This
 *     is what `HTTP_PROXY` (as opposed to `HTTPS_PROXY`) actually sends —
 *     cortex's OWN hook telemetry (`event-logger.hook.ts` et al. POSTing to
 *     `http://localhost:8766/...`) takes exactly this shape, not CONNECT
 *     (cortex#2412 follow-up). On a well-formed request whose `host` is on
 *     the allowlist, the proxy dials the target and forwards the request
 *     rewritten to origin-form (path only, `Host` header added if the
 *     client didn't send one — RFC 7230 §5.3.2's proxy obligation), then
 *     relays the response back verbatim; no synthetic reply is sent to the
 *     client the way CONNECT's "200 Connection Established" is, because the
 *     client is expecting a real HTTP response from the target, not a
 *     tunnel handshake.
 *
 * Both forms funnel through the SAME allow/deny-by-mode decision (see
 * "Fail-closed discipline" below) — a host not on the allowlist, or a
 * request this parser cannot make sense of at all (no verb it recognizes,
 * no destination it can extract), is a deny.
 *
 * **No wildcard/suffix matching, deliberately.** `api.anthropic.com` matches
 * only `api.anthropic.com`, never `*.anthropic.com`. This is the SAFER
 * simple choice for a deny-by-default allowlist: a suffix rule is one typo
 * away from silently admitting an attacker-registered look-alike
 * (`anthropic.com.evil.example` would NOT match a suffix check written
 * carelessly, but `evil-anthropic.com` style abuse of a naive `.includes()`
 * check is exactly the kind of bug this avoids by only ever doing an exact
 * `Set.has()` lookup). A config that needs a subdomain lists it explicitly.
 *
 * ## Fail-closed discipline (repo CLAUDE.md hard constraint)
 *
 * The dividing line is NOT "which mode" — it's "does this request have a
 * destination at all":
 *
 *   - A request with **no determinable destination** — garbage bytes, a
 *     verb this parser doesn't recognize in either shape above, a CONNECT
 *     with a non-numeric/out-of-range port, an absolute-URI request with an
 *     unparseable host/port, or a header that never terminates within
 *     {@link MAX_HEADER_BYTES} — is **always denied, in EVERY mode
 *     including `audit`**. This is NOT a policy choice `audit` could relax:
 *     there is no host to dial, so there is no "traffic" for `audit` to
 *     "let proceed." `enforce` would refuse this identically (an
 *     unaddressable request isn't a destination *enforce* would reach
 *     either), so `audit` denying it too is `audit` correctly PREDICTING
 *     `enforce` — not a departure from DD-5's report-only contract, which
 *     is specifically about mode-governed ALLOWLIST decisions, not about
 *     requests with no destination to evaluate one against.
 *   - A request WITH a determinable destination (CONNECT or the plain-HTTP
 *     absolute-URI form) whose host is recognized but NOT on the allowlist
 *     follows {@link SandboxMode}: `audit` logs the would-be-denial and
 *     STILL connects/forwards through — no error response, no socket
 *     termination (DD-5's report-only semantics — unlike the macOS FS
 *     backend, this mechanism genuinely CAN report without blocking, so it
 *     does); `enforce` blocks with `403`/`400` and never dials the target.
 *     This is the ONLY axis `audit` vs `enforce` actually differ on — see
 *     cortex#2412's follow-up fix, which closed a bug where an unparseable
 *     plain-HTTP request (a shape this module simply didn't parse yet) was
 *     wrongly routed into the no-destination branch above and killed even
 *     under `audit`, defeating `audit`'s entire dry-run purpose.
 *   - If the proxy itself fails to bind, the caller (`cc-session.ts`)
 *     decides: `enforce` refuses to launch the session at all (fail closed);
 *     `audit` logs a loud warning and launches WITHOUT the proxy (no worse
 *     than `mode: "off"` — matches `MacosSbplSandbox`'s audit-canary-fail
 *     precedent).
 *
 * ## HARD HOLD (mirrors EBH-2/EBH-3a's posture — cortex#2346)
 *
 * This module is reachable ONLY when a caller passes `mode: "audit"` or
 * `mode: "enforce"` — and, exactly like `system.sandbox.mode`
 * (`cortex-config.ts`), **no live dispatch path threads a config-resolved
 * mode into `CCSessionOpts.sandboxMode` yet**. The default everywhere is
 * `"off"`, under which `cc-session.ts` never constructs an `EgressProxy` at
 * all — zero behaviour change for every session that exists today. Flipping
 * that default is a principal decision (design doc §6 rollout), not
 * something this slice does.
 */

import type { Socket, TCPSocketListener } from "bun";
import type { SandboxMode } from "./session-sandbox";

/** The two modes an {@link EgressProxy} can actually be constructed under —
 *  `"off"` never reaches this module (see the HARD HOLD above): `cc-session.ts`
 *  does not construct an `EgressProxy` at all when the resolved
 *  `SandboxProfile.mode` is `"off"`. */
export type EgressProxyMode = Exclude<SandboxMode, "off">;

/** One observed egress decision worth surfacing (DD-6-style observability —
 *  mirrors {@link SandboxDenial}'s shape). `blocked: false` means this was an
 *  `audit`-mode "would have denied" — the connection was still allowed
 *  through; `blocked: true` means the connection was actually refused
 *  (either a real `enforce` denial, or a fail-closed malformed-request
 *  refusal, which is `blocked: true` in EVERY mode — see the module doc's
 *  fail-closed discipline). */
export interface EgressDenial {
  host: string;
  port: number;
  reason: string;
  blocked: boolean;
  timestamp: string;
}

/** `system.security.egress-denial` — HYPHEN, not underscore, in the leaf
 *  (cortex#1935's regression gate, `src/bus/__tests__/envelope-type-no-underscore.test.ts`,
 *  scans every non-test source file for exactly this mistake). Mirrors
 *  {@link SandboxDenialEvent}'s shape/naming discipline (`session-sandbox.ts`)
 *  but is its own event type — a proxy-layer denial is a distinct
 *  observation from a kernel FS denial, and conflating the two types would
 *  make "which layer caught this" unrecoverable from the event alone. Not
 *  yet a myelin wire envelope — same "plain EventEmitter payload for now,
 *  a future bus publisher upgrades this" scoping as `SandboxDenialEvent`
 *  (see that type's doc comment; applies here verbatim). Emitted by
 *  `CCSession` as it drains {@link EgressProxy.denials}. */
export interface EgressDenialEvent {
  type: "system.security.egress-denial";
  mode: EgressProxyMode;
  host: string;
  port: number;
  reason: string;
  blocked: boolean;
  timestamp: string;
}

// -----------------------------------------------------------------------------
// Host matching — exact, case-insensitive, no wildcards (see module doc)
// -----------------------------------------------------------------------------

/** Lowercase + strip a single trailing dot (`"Example.com."` and
 *  `"example.com"` are the same DNS name — an authored allowlist entry
 *  should not silently fail to match because of that cosmetic difference). */
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

/** Exported for unit tests — pure, no proxy/socket machinery required. */
export function isHostAllowed(host: string, allow: ReadonlySet<string>): boolean {
  return allow.has(normalizeHost(host));
}

// -----------------------------------------------------------------------------
// Denial observability — a small pull-based async queue bridging the
// synchronous Bun socket callbacks to the AsyncIterable shape `cc-session.ts`
// already drains for SessionSandbox denials (same consumption pattern).
// -----------------------------------------------------------------------------

class DenialQueue implements AsyncIterable<EgressDenial> {
  private items: EgressDenial[] = [];
  private waiters: ((result: IteratorResult<EgressDenial>) => void)[] = [];
  private closed = false;

  push(item: EgressDenial): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length-checked above
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined, done: true } as IteratorResult<EgressDenial>);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EgressDenial> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<EgressDenial>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

// -----------------------------------------------------------------------------
// Proxy-request parsing — CONNECT (TLS tunnel) and plain-HTTP absolute-URI
// forward-proxy requests (see the module doc's "Mechanism" section)
// -----------------------------------------------------------------------------

/** `CONNECT host:port HTTP/1.1` — the TLS-tunnel proxy verb. */
const CONNECT_LINE_RE = /^CONNECT\s+([^\s:/]+):(\d{1,5})\s+HTTP\/\d\.\d\s*$/i;

/** The plain-HTTP absolute-URI forward-proxy form (RFC 7230 §5.3.2) —
 *  `POST http://host[:port][/path] HTTP/1.1`. This is what `HTTP_PROXY`
 *  clients send for non-TLS requests; `HTTPS_PROXY` clients send `CONNECT`
 *  instead (see {@link CONNECT_LINE_RE}). `https://` absolute-URIs are
 *  deliberately NOT matched here — a proxy-respecting client always
 *  CONNECTs for TLS, never sends an `https://` absolute-URI in the request
 *  line, so accepting one here would just be extra surface for no real
 *  client to ever exercise. */
const ABSOLUTE_HTTP_LINE_RE =
  /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+http:\/\/([^\s:/]+)(?::(\d{1,5}))?(\/[^\s]*)?\s+HTTP\/\d\.\d\s*$/i;

/** Hard cap on buffered pre-request header bytes — a client that never
 *  sends a terminating `\r\n\r\n` (or sends an absurdly long "header")
 *  is fail-closed denied rather than buffered forever. Generous for a
 *  CONNECT/small-request header (normally well under 1KB) while still
 *  bounding memory per connection. */
const MAX_HEADER_BYTES = 8192;

interface ParsedConnect {
  ok: true;
  kind: "connect";
  host: string;
  port: number;
  /** Bytes received AFTER the `\r\n\r\n` header terminator, if the client
   *  pipelined tunnel payload ahead of the "200 Connection Established"
   *  response (unusual for CONNECT but not disallowed) — queued and
   *  forwarded once the target connection is up. */
  trailing: Uint8Array;
}
interface ParsedHttpForward {
  ok: true;
  kind: "http-forward";
  host: string;
  port: number;
  /** The exact bytes to write to the freshly dialed target once its socket
   *  opens — the request line rewritten to origin-form (RFC 7230 §5.3.2:
   *  a proxy forwarding a request MUST NOT forward the absolute-URI form
   *  to the origin server), the original header lines (a `Host` header
   *  added if the client didn't send one), the terminator, and any body
   *  bytes the client had already sent ahead of the terminator. Built once
   *  at parse time (not re-derived per write) so `EgressProxy` never has to
   *  re-parse or mutate headers in the hot path. */
  forwardBytes: Uint8Array;
}
interface ParsedConnectFailure {
  ok: false;
  /** Best-effort host for the denial event — "?" when not even that much
   *  could be extracted from the malformed request. */
  host: string;
  port: number;
  reason: string;
}

/** Pure parse function — exported for unit tests. Returns `undefined` when
 *  the header terminator hasn't arrived yet (caller should keep buffering,
 *  up to {@link MAX_HEADER_BYTES}). Tries the CONNECT shape first, then the
 *  plain-HTTP absolute-URI shape; a request matching neither (or matching
 *  one with an unusable host/port) is a parse failure — see the module
 *  doc's fail-closed discipline for what that means per mode. */
export function tryParseConnect(
  buffered: Uint8Array,
): ParsedConnect | ParsedHttpForward | ParsedConnectFailure | undefined {
  const buf = Buffer.from(buffered.buffer, buffered.byteOffset, buffered.byteLength);
  const terminatorIdx = buf.indexOf("\r\n\r\n");
  if (terminatorIdx === -1) return undefined;

  const headerText = buf.subarray(0, terminatorIdx).toString("utf8");
  const firstLine = (headerText.split("\r\n")[0] ?? "").trim();

  const connectMatch = CONNECT_LINE_RE.exec(firstLine);
  if (connectMatch) {
    const host = connectMatch[1] ?? "";
    const portNum = Number(connectMatch[2]);
    if (host.length === 0 || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return {
        ok: false,
        host: host || "?",
        port: Number.isFinite(portNum) ? portNum : 0,
        reason: `malformed CONNECT target ("${firstLine.slice(0, 120)}")`,
      };
    }
    return {
      ok: true,
      kind: "connect",
      host,
      port: portNum,
      trailing: new Uint8Array(buf.subarray(terminatorIdx + 4)),
    };
  }

  const httpMatch = ABSOLUTE_HTTP_LINE_RE.exec(firstLine);
  if (httpMatch) {
    const method = (httpMatch[1] ?? "").toUpperCase();
    const host = httpMatch[2] ?? "";
    const portStr = httpMatch[3];
    const portNum = portStr ? Number(portStr) : 80; // absolute-URI http:// defaults to port 80
    const path = httpMatch[4] ?? "/";
    if (host.length === 0 || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return {
        ok: false,
        host: host || "?",
        port: Number.isFinite(portNum) ? portNum : 0,
        reason: `malformed absolute-URI target ("${firstLine.slice(0, 120)}")`,
      };
    }
    const body = new Uint8Array(buf.subarray(terminatorIdx + 4));
    return {
      ok: true,
      kind: "http-forward",
      host,
      port: portNum,
      forwardBytes: buildForwardRequest(headerText, method, path, host, portNum, body),
    };
  }

  return {
    ok: false,
    host: "?",
    port: 0,
    reason:
      `unparseable proxy request (only CONNECT and plain-HTTP absolute-URI ` +
      `requests are supported): "${firstLine.slice(0, 120)}"`,
  };
}

/** Rewrite a plain-HTTP absolute-URI request into the origin-form a real
 *  origin server expects (RFC 7230 §5.3.2) — `POST http://host/path
 *  HTTP/1.1` becomes `POST /path HTTP/1.1`, with every other header line
 *  preserved verbatim and a `Host` header synthesized only if the client
 *  didn't already send one. `body` is the raw bytes the client had already
 *  sent past the header terminator (untouched, never decoded as text — it
 *  may be arbitrary binary) and is appended after the rewritten headers. */
function buildForwardRequest(
  headerText: string,
  method: string,
  path: string,
  host: string,
  port: number,
  body: Uint8Array,
): Uint8Array {
  const headerLines = headerText.split("\r\n");
  const restHeaders = headerLines.slice(1);
  const hasHostHeader = restHeaders.some((line) => /^host\s*:/i.test(line));
  const rewrittenHeaders = hasHostHeader
    ? restHeaders
    : [`Host: ${port === 80 ? host : `${host}:${port}`}`, ...restHeaders];
  const rewritten = [`${method} ${path} HTTP/1.1`, ...rewrittenHeaders, "", ""].join("\r\n");
  const headBytes = new Uint8Array(Buffer.from(rewritten, "utf8"));
  if (body.length === 0) return headBytes;
  return concatChunks([headBytes, body], headBytes.length + body.length);
}

// -----------------------------------------------------------------------------
// Per-connection state
// -----------------------------------------------------------------------------

interface ConnState {
  /** Raw bytes buffered until the CONNECT header terminator arrives. */
  headerChunks: Uint8Array[];
  headerLength: number;
  /** Set once the CONNECT line has been parsed (successfully or not) — no
   *  further header parsing happens on this connection past that point. */
  resolved: boolean;
  /** The upstream target socket, once dialed. `undefined` before the dial
   *  resolves (or if the request was denied and no dial was attempted). */
  target: Socket | undefined;
  /** Client bytes that arrived before {@link target} finished connecting —
   *  flushed to the target the moment it's up. */
  preTunnelQueue: Uint8Array[];
  /** Set by `teardown()` when the CLIENT side has already closed. A target
   *  dial can still be in flight at that point (network latency); when it
   *  resolves, its `open` handler checks this flag and closes the now-
   *  orphaned upstream connection immediately instead of wiring up a tunnel
   *  nothing will ever read from — otherwise a client that disconnects
   *  mid-dial would leak a live upstream socket for the life of that
   *  connection. */
  clientClosed: boolean;
}

function newConnState(): ConnState {
  return {
    headerChunks: [],
    headerLength: 0,
    resolved: false,
    target: undefined,
    preTunnelQueue: [],
    clientClosed: false,
  };
}

// -----------------------------------------------------------------------------
// EgressProxy
// -----------------------------------------------------------------------------

const CONNECTION_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\n\r\n";
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\n\r\n";

/**
 * A per-session deny-by-default forward proxy (CONNECT tunnel + plain-HTTP
 * absolute-URI forwarding — see the module doc's "Mechanism" section). One
 * instance per spawned session (`cc-session.ts` constructs and tears one
 * down per `CCSession`, mirroring `MacosSbplSandbox`'s per-session `.sb`
 * profile lifecycle) — never shared across sessions, so one session's
 * allowlist can never leak into another's traffic.
 */
export class EgressProxy {
  private readonly allowSet: ReadonlySet<string>;
  private readonly mode: EgressProxyMode;
  private readonly queue = new DenialQueue();
  private readonly sockets = new Set<Socket<ConnState>>();
  private listener: TCPSocketListener<ConnState> | undefined;

  constructor(allow: readonly string[], mode: EgressProxyMode) {
    this.allowSet = new Set(allow.map(normalizeHost));
    this.mode = mode;
  }

  /**
   * Bind on `127.0.0.1:<ephemeral>`. Synchronous — `Bun.listen` resolves
   * the bind immediately, which matters because `cc-session.ts`'s
   * `CCSession.start()` (the whole `SessionSandbox`/spawn choke point) is
   * itself synchronous; this mirrors that constraint the same way
   * `MacosSbplSandbox.spawn()` does for its own synchronous canary gate.
   * Throws on a genuine bind failure (fail-closed handling is the caller's
   * responsibility — see the module doc's "proxy fails to bind" branch).
   */
  start(): { port: number; proxyUrl: string } {
    if (this.listener) {
      throw new Error("[egress-proxy] start() called twice on the same EgressProxy instance");
    }
    this.listener = Bun.listen<ConnState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          socket.data = newConnState();
          this.sockets.add(socket);
        },
        data: (socket, chunk) => {
          this.onClientData(socket, chunk);
        },
        close: (socket) => {
          this.teardown(socket);
        },
        error: (socket, err) => {
          process.stderr.write(`[egress-proxy] client socket error: ${err.message}\n`);
          this.teardown(socket);
        },
      },
    });
    return { port: this.listener.port, proxyUrl: `http://127.0.0.1:${this.listener.port}` };
  }

  /** Close the listener and every live connection (client + dialed target).
   *  Idempotent — safe to call more than once (e.g. once from the session's
   *  `proc.exited.finally`, and again from an error-path cleanup). */
  stop(): void {
    for (const socket of this.sockets) {
      const state = socket.data;
      if (state.target) this.closeSafely(state.target);
      this.closeSafely(socket);
    }
    this.sockets.clear();
    this.listener?.stop(true);
    this.listener = undefined;
    this.queue.close();
  }

  /** Stream of egress decisions worth surfacing — mirrors
   *  `SessionSandbox.denials()`'s AsyncIterable shape so `cc-session.ts`
   *  drains both with the identical `for await` pattern. */
  denials(): AsyncIterable<EgressDenial> {
    return this.queue;
  }

  private onClientData(socket: Socket<ConnState>, chunk: Uint8Array): void {
    const state = socket.data;
    if (!state.resolved) {
      state.headerChunks.push(chunk);
      state.headerLength += chunk.length;
      if (state.headerLength > MAX_HEADER_BYTES) {
        this.denyFailClosed(socket, "?", 0, "proxy request header exceeded size limit without a terminator");
        return;
      }
      const buffered =
        state.headerChunks.length === 1
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- length-checked above (=== 1)
            state.headerChunks[0]!
          : concatChunks(state.headerChunks, state.headerLength);
      const parsed = tryParseConnect(buffered);
      if (parsed === undefined) return; // header not complete yet — keep buffering
      state.resolved = true;
      state.headerChunks = [];

      if (!parsed.ok) {
        // Fail-closed discipline: an unparseable request is ALWAYS denied,
        // in every mode — see the module doc. There is no destination to
        // even evaluate against the allowlist.
        this.denyFailClosed(socket, parsed.host, parsed.port, parsed.reason);
        return;
      }

      // "connect"'s trailing bytes (TLS ClientHello pipelined ahead of the
      // 200 response) still need queuing here; "http-forward"'s equivalent
      // body-so-far is already folded into `parsed.forwardBytes` at parse
      // time (see `buildForwardRequest`), so there is nothing to queue.
      if (parsed.kind === "connect" && parsed.trailing.length > 0) {
        state.preTunnelQueue.push(parsed.trailing);
      }
      this.handleConnect(socket, state, parsed);
      return;
    }

    // Header already resolved — this is post-CONNECT tunnel payload.
    if (state.target) {
      this.writeSafely(state.target, chunk);
    } else {
      // Target dial still in flight (or the request was already denied and
      // the socket is on its way down) — queue; flushed on connect, dropped
      // on teardown.
      state.preTunnelQueue.push(chunk);
    }
  }

  /**
   * Common allow/deny-by-mode path for BOTH proxy shapes (CONNECT tunnel
   * and plain-HTTP absolute-URI forward). `parsed` carries a `kind`
   * discriminant that only affects what gets written once the target dial
   * succeeds — see the `open` handler below — everything about the
   * allowlist/mode decision itself is identical for both.
   */
  private handleConnect(socket: Socket<ConnState>, state: ConnState, parsed: ParsedConnect | ParsedHttpForward): void {
    const { host, port } = parsed;
    const allowed = isHostAllowed(host, this.allowSet);
    if (!allowed) {
      const blocked = this.mode === "enforce";
      this.queue.push({
        host,
        port,
        reason: `host not on egress allowlist (mode=${this.mode})`,
        blocked,
        timestamp: new Date().toISOString(),
      });
      if (blocked) {
        this.writeSafely(socket, FORBIDDEN);
        this.closeSafely(socket);
        return;
      }
      // audit — DD-5 report-only: log the would-be-denial, still connect
      // through (and, for http-forward, still relay the request through to
      // the target — see the `open` handler below), so a burn-in window
      // measures real traffic without breaking it. No error response, no
      // socket termination — that is the entire point of `audit`.
    }

    void Bun.connect({
      hostname: host,
      port,
      socket: {
        open: (targetSocket) => {
          if (state.clientClosed) {
            // The client disconnected while this dial was still in flight —
            // wiring up a tunnel now would just leak an upstream connection
            // nothing will ever read from. Close it immediately instead.
            this.closeSafely(targetSocket);
            return;
          }
          state.target = targetSocket;
          if (parsed.kind === "connect") {
            // TLS-tunnel handshake: tell the client the tunnel is up before
            // relaying anything — this IS the expected reply for CONNECT.
            this.writeSafely(socket, CONNECTION_ESTABLISHED);
          } else {
            // Plain-HTTP forward: no synthetic reply to the client — it is
            // expecting the target's real HTTP response, not a tunnel
            // handshake. Write the rewritten request FIRST so it can never
            // race behind response bytes the `data` handler below relays
            // back to the client.
            this.writeSafely(targetSocket, parsed.forwardBytes);
          }
          for (const queued of state.preTunnelQueue) this.writeSafely(targetSocket, queued);
          state.preTunnelQueue = [];
        },
        data: (_targetSocket, chunk) => {
          this.writeSafely(socket, chunk);
        },
        close: () => {
          this.closeSafely(socket);
        },
        error: (_targetSocket, err) => {
          process.stderr.write(`[egress-proxy] target socket error (${host}:${port}): ${err.message}\n`);
          this.closeSafely(socket);
        },
      },
    }).catch((err: unknown) => {
      // The target refused/was unreachable — a connectivity failure, NOT a
      // security denial (the host WAS allowed; the network just failed), so
      // this is not pushed onto the denial queue. Respond 502 like any real
      // forward proxy would (correct for both CONNECT and plain-HTTP
      // clients — both understand a raw HTTP/1.1 status line reply here).
      process.stderr.write(
        `[egress-proxy] failed to connect upstream ${host}:${port}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      this.writeSafely(socket, BAD_GATEWAY);
      this.closeSafely(socket);
    });
  }

  private denyFailClosed(socket: Socket<ConnState>, host: string, port: number, reason: string): void {
    this.queue.push({ host, port, reason, blocked: true, timestamp: new Date().toISOString() });
    this.writeSafely(socket, BAD_REQUEST);
    this.closeSafely(socket);
  }

  private teardown(socket: Socket<ConnState>): void {
    const state = socket.data;
    state.clientClosed = true;
    if (state.target) this.closeSafely(state.target);
    this.sockets.delete(socket);
  }

  private writeSafely(socket: Socket<ConnState> | Socket, data: string | Uint8Array): void {
    try {
      socket.write(data);
    } catch {
      // The peer is already gone (closed/reset mid-write) — nothing to
      // recover; the corresponding close()/error() handler cleans up state.
    }
  }

  private closeSafely(socket: Socket<ConnState> | Socket): void {
    try {
      socket.end();
    } catch {
      // Already closed — end() on a dead socket is a no-op we don't need to
      // observe.
    }
  }
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
