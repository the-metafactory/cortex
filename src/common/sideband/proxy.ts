/**
 * Sideband server-side proxy (P-14 U0.1).
 *
 * MC's browser dashboard NEVER talks to the sideband directly — that would
 * either require a CORS opening on a loopback-only daemon (impossible) or a
 * non-loopback bind (forbidden, §3/§8). Instead the MC server proxies
 * `/api/observability/*` → the configured sideband base URL **server-side**.
 * The browser only ever talks to MC (same origin); MC talks to
 * `127.0.0.1:9092`.
 *
 * Responsibilities:
 *  - Re-check the loopback invariant at the request boundary (cheap; the config
 *    value could in theory have mutated since parse). Fail CLOSED.
 *  - Allowlist the exact endpoint surface the contract defines (§2): the
 *    `/traces`, `/logs`, `/traces/{id}/timeline`, `/healthz` reads. Anything
 *    else is refused (the sideband is read-only; never forward an unknown path).
 *  - Forward GET only (the sideband has no write endpoints — §9 non-goals).
 *  - Bound the request with a timeout and the response body with a size cap, so
 *    a slow or chatty sideband can't hang or OOM the MC process.
 *  - Never forward auth-sensitive headers — the sideband is tokenless (§3); MC
 *    sends a bare GET. Cookies / Authorization the browser sent to MC stay at
 *    MC and are NOT relayed.
 *  - Map every failure to a structured {@link SidebandError} body (NOT a 500
 *    splat) so the frontend (#933) can render "interior capture not available"
 *    honestly and surface the `deep_link` when the sideband supplied one.
 */

import { checkLoopbackSideband } from "./loopback";

/**
 * Uniform error body for non-2xx responses, mirroring signal's
 * `SidebandError` (`signal/src/lib/sideband/types.ts`). Cortex renders
 * `deep_link` as the "Tier 3 unavailable — open in {backend}" affordance
 * (contract §4). The `code` set is pinned to the contract enum so the #933
 * renderer can switch on it.
 */
export interface SidebandError {
  code:
    | "invalid_correlation_id"
    | "backend_unavailable"
    | "backend_timeout"
    | "internal_error";
  message: string;
  deep_link?: string;
  retry_after_seconds?: number;
}

export interface SidebandProxyConfig {
  /** Configured sideband base URL (`mc.sideband`). Loopback-enforced. */
  baseUrl: string;
  /** Per-request timeout in ms. Mirrors the contract consumer's 8s budget (§8). */
  timeoutMs?: number;
  /** Max bytes to read from a sideband response body. Guards against OOM. */
  maxBodyBytes?: number;
  /**
   * Fetch override for tests. Production uses the global `fetch`. Typed loosely
   * to match the global's signature without dragging in DOM lib types.
   */
  fetchImpl?: typeof fetch;
}

/** Default per-request timeout — the contract consumer pseudocode uses 8s (§8). */
export const DEFAULT_TIMEOUT_MS = 8_000;
/** Default response body cap — Tier-3 single-task payloads are small; 8 MiB is generous. */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Endpoints the proxy is allowed to forward, expressed as the suffix AFTER the
 * `/api/observability` prefix. The contract's read surface (§2):
 *   GET /traces?correlation_id=…
 *   GET /logs?correlation_id=…
 *   GET /traces/{trace_id}/timeline
 *   GET /healthz
 *
 * `traces` and `logs` are exact (query carries the id); `traces/{id}/timeline`
 * is a 3-segment shape validated structurally. Everything else is refused.
 */
function mapAllowedPath(suffix: string): string | null {
  // Strip a single leading slash for matching.
  const s = suffix.startsWith("/") ? suffix.slice(1) : suffix;

  if (s === "traces") return "/traces";
  if (s === "logs") return "/logs";
  if (s === "healthz") return "/healthz";

  // traces/{trace_id}/timeline — exactly 3 segments, middle is the id.
  const segs = s.split("/");
  if (segs.length === 3 && segs[0] === "traces" && segs[2] === "timeline") {
    const id = segs[1] ?? "";
    // The id is reflected into the upstream path; keep it to a hex-ish token so
    // a hostile suffix can't inject extra path/query. The sideband itself does
    // full `invalid_correlation_id` validation (§4); this is a cheap shape gate.
    if (/^[0-9a-fA-F]{1,64}$/.test(id)) {
      return `/traces/${id}/timeline`;
    }
    return null;
  }

  return null;
}

function errorResponse(err: SidebandError, status: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof err.retry_after_seconds === "number") {
    headers["retry-after"] = String(err.retry_after_seconds);
  }
  return new Response(JSON.stringify(err), { status, headers });
}

/**
 * Proxy a `/api/observability/*` request to the configured sideband.
 *
 * @param suffix the path AFTER `/api/observability` (e.g. `/traces`,
 *   `/traces/abc.../timeline`). The caller strips the prefix.
 * @param search the original query string (without `?`), forwarded verbatim
 *   for the allowlisted query-carrying endpoints.
 */
export async function proxySideband(
  method: string,
  suffix: string,
  search: string,
  config: SidebandProxyConfig,
): Promise<Response> {
  // §9 non-goals: the sideband is read-only. GET only.
  if (method !== "GET") {
    return errorResponse(
      { code: "internal_error", message: `method ${method} not allowed; sideband is read-only` },
      405,
    );
  }

  // Re-enforce loopback at the request boundary — fail closed. Config could in
  // theory have mutated since parse; the proxy must never reach a non-loopback host.
  const loopback = checkLoopbackSideband(config.baseUrl);
  if (!loopback.ok) {
    return errorResponse(
      {
        code: "backend_unavailable",
        message: `interior capture not available — sideband endpoint refused: ${loopback.reason}`,
      },
      503,
    );
  }

  const upstreamPath = mapAllowedPath(suffix);
  if (upstreamPath === null) {
    return errorResponse(
      { code: "internal_error", message: `unknown observability endpoint: ${suffix}` },
      404,
    );
  }

  // Build the upstream URL from the validated base + allowlisted path. Preserve
  // the base URL's own path prefix (a reverse-proxy mount, §8) by joining on it.
  const base = loopback.url;
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const upstream = new URL(`${basePath}${upstreamPath}`, base.origin);
  if (search !== "") {
    upstream.search = search;
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const doFetch = config.fetchImpl ?? fetch;

  let upstreamResp: Response;
  try {
    upstreamResp = await doFetch(upstream.toString(), {
      method: "GET",
      // NEVER forward auth-sensitive headers — the sideband is tokenless (§3).
      // We send a bare GET; the browser's cookies/Authorization stay at MC.
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Distinguish timeout (504, retryable) from connection refusal/down (503).
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    if (isTimeout) {
      return errorResponse(
        {
          code: "backend_timeout",
          message: "interior capture not available — sideband timed out",
          retry_after_seconds: 5,
        },
        504,
      );
    }
    return errorResponse(
      {
        code: "backend_unavailable",
        message:
          "interior capture not available — sideband unreachable " +
          "(is the signal sideband daemon running?)",
      },
      503,
    );
  }

  // Read the body with a hard size cap. We buffer (Tier-3 payloads are small
  // and bounded — §9 "no pagination; single-task queries return everything")
  // but refuse to let an unbounded body OOM the daemon.
  const bodyText = await readCapped(upstreamResp, maxBodyBytes);
  if (bodyText === null) {
    return errorResponse(
      {
        code: "backend_unavailable",
        message: `interior capture not available — sideband response exceeded ${maxBodyBytes} bytes`,
      },
      503,
    );
  }

  // Pass the sideband's own response through. On a non-2xx the body is already
  // a SidebandError (with `deep_link` when known, §4) — relay it verbatim so the
  // frontend gets the contract shape + deep-link. On 2xx relay the payload.
  const passHeaders: Record<string, string> = { "content-type": "application/json" };
  const retryAfter = upstreamResp.headers.get("retry-after");
  if (retryAfter !== null) {
    passHeaders["retry-after"] = retryAfter;
  }
  return new Response(bodyText, { status: upstreamResp.status, headers: passHeaders });
}

/**
 * Read a response body as text, refusing once it exceeds `maxBytes`. Returns
 * `null` on overflow. Streams chunk-by-chunk so an oversized body is rejected
 * without first buffering the whole thing.
 */
async function readCapped(resp: Response, maxBytes: number): Promise<string | null> {
  // Fast reject via Content-Length when the server declares an oversized body.
  const declared = resp.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      // Drain to free the socket, then signal overflow.
      try {
        await resp.body?.cancel();
      } catch {
        // Best-effort cancel; the socket closes regardless. Safe to ignore.
      }
      return null;
    }
  }

  if (resp.body === null) {
    return "";
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `value` is a Uint8Array for every non-final read of a byte stream.
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort; ignore.
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
