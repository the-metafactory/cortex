/**
 * FND-6 — daemon mutation-surface hardening (docs/plan-mc-future-state.md §4.0).
 *
 * The MC daemon HTTP surface previously had **zero Host/Origin validation** and
 * `isLoopbackBind()` keyed on the *bind*, not the *request*. On the dominant
 * loopback deployment that let **DNS-rebinding** browser JS become same-origin
 * to the daemon and drive its mutating routes — including `POST /api/sessions`
 * / `/requeue` / `/abandon`, which spawn **principal-credentialed** CC sessions
 * with no auth at all. This module is the single hardened checkpoint every
 * mutating route passes through, closing that class before any new verb mounts.
 *
 * Four composed controls (all fail-closed — absent config ⇒ DENY):
 *
 *  (a) **Host-header allowlist** — a mutating request whose `Host` is not
 *      `127.0.0.1:<port>` / `localhost:<port>` / `::1` / the configured
 *      hostname is 403. This is the primary anti-DNS-rebinding control: the
 *      browser sends the *original* hostname (`evil.com`) in `Host` even after
 *      a rebind to 127.0.0.1, so a foreign `Host` unmasks the attack.
 *  (b) **Foreign-Origin rejection** — a mutating request bearing an `Origin`
 *      outside the allowlist is 403 (anti-CSRF / anti-rebinding second line).
 *  (c) **Identity gate (Gate 1)** — governed glass mutations resolve a
 *      CF-Access principal through the SAME bind-conditioned resolver the
 *      admission route uses ({@link resolveRequestPrincipal}). No principal ⇒
 *      401. There is no unauthenticated mutation tier (invariant 3).
 *  (d) **Authorization binding** — the resolved principal must appear in the
 *      configured `mc.governance.principals` allowlist, else 403. Fail-closed
 *      off loopback when the allowlist is unset; on loopback an unset allowlist
 *      stays permissive so legit local callers (the CF-fronted dashboard, the
 *      CLI) keep working — the loopback boundary + Host/Origin are the gate
 *      there.
 *
 * NOTE: typed-confirm is an **intent** control (human deliberateness), never a
 * security control — it is trivially satisfiable programmatically and is NOT
 * enforced here (invariant 3).
 */

import {
  CF_ACCESS_EMAIL_HEADER,
  CF_ACCESS_JWT_HEADER,
  resolveRequestPrincipal,
  type AdmissionAuthContext,
} from "./networks-admission";

/** HTTP methods that mutate state — the guard applies to these only. */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Wildcard / unspecified binds carry no single meaningful hostname, so they
 * contribute nothing to the Host allowlist (a principal exposing MC on a
 * wildcard bind must front it with a real hostname + `mc.governance.principals`
 * — the off-loopback authorization path is then the gate).
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*", ""]);

/**
 * Build the set of hostnames a mutating request's `Host` / `Origin` may carry:
 * the loopback interfaces plus the configured bind hostname (when it is a real
 * name, not a wildcard). Lowercased for case-insensitive comparison.
 */
export function buildAllowedHostnames(configHostname: string): Set<string> {
  const hosts = new Set<string>(["127.0.0.1", "::1", "localhost"]);
  const h = configHostname.trim().toLowerCase();
  if (!WILDCARD_HOSTS.has(h)) hosts.add(h);
  return hosts;
}

/**
 * The per-server, per-request-invariant inputs the guard needs. Computed once
 * in `startServer` (the bind + config are fixed for the server's lifetime);
 * `listenPort` is the ACTUAL bound port (`server.port`), which differs from
 * `config.port` when the config asks for an ephemeral bind (port 0, tests).
 */
export interface MutationGuardContext {
  /** True when MC is bound to a loopback interface. */
  isLoopback: boolean;
  /** Allowed `Host` / `Origin` hostnames (see {@link buildAllowedHostnames}). */
  allowedHostnames: ReadonlySet<string>;
  /** The actual bound port — `Host`/`Origin` port, when present, must match. */
  listenPort: number;
  /**
   * `mc.governance.principals` — lowercased principal emails allowed to mutate.
   * EMPTY = unset (fail-closed off loopback; permissive on loopback).
   */
  principals: ReadonlySet<string>;
  /** CF-Access JWT verifier, present iff `cfAccess.aud` is configured. */
  verifyJwt?: AdmissionAuthContext["verifyJwt"];
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Split a `Host` (or `Origin` authority) header into host + optional port.
 * Handles bracketed IPv6 (`[::1]:8767`), `host:port`, and bare host. Returns
 * `null` for a syntactically invalid value (→ the caller fails closed).
 */
export function parseHostHeader(
  value: string,
): { host: string; port: string | null } | null {
  const v = value.trim();
  if (v === "") return null;

  // Bracketed IPv6 literal: [::1] or [::1]:port
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end === -1) return null;
    const host = v.slice(1, end).toLowerCase();
    if (host === "") return null;
    const rest = v.slice(end + 1);
    if (rest === "") return { host, port: null };
    if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) {
      return { host, port: rest.slice(1) };
    }
    return null;
  }

  const colonCount = (v.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const idx = v.indexOf(":");
    const host = v.slice(0, idx).toLowerCase();
    const port = v.slice(idx + 1);
    if (host === "" || !/^\d+$/.test(port)) return null;
    return { host, port };
  }
  // Zero colons (bare host) or >1 (unbracketed bare IPv6, no port).
  return { host: v.toLowerCase(), port: null };
}

/**
 * (a) — is the request's `Host` header in the allowlist? A `null` Host (absent
 * — malformed under HTTP/1.1) fails closed. A present port must match the
 * actual listening port.
 */
export function isHostAllowed(
  hostHeader: string | null,
  ctx: MutationGuardContext,
): boolean {
  if (hostHeader === null) return false;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null) return false;
  if (!ctx.allowedHostnames.has(parsed.host)) return false;
  if (parsed.port !== null && parsed.port !== String(ctx.listenPort)) {
    return false;
  }
  return true;
}

/**
 * (b) — is the request's `Origin` acceptable for a mutation? Absent/empty
 * Origin is allowed (non-browser clients — the CLI, server-to-server — and
 * same-origin navigations legitimately omit it; the Host allowlist is the
 * anti-rebinding gate there). A literal `null` origin (opaque: sandboxed
 * iframe, `file://`) is rejected. A present Origin must resolve to an allowed
 * hostname (and matching port when specified).
 */
export function isOriginAllowed(
  originHeader: string | null,
  ctx: MutationGuardContext,
): boolean {
  if (originHeader === null) return true;
  const o = originHeader.trim();
  if (o === "") return true;
  if (o.toLowerCase() === "null") return false;

  let parsed: URL;
  try {
    parsed = new URL(o);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!ctx.allowedHostnames.has(host)) return false;
  if (parsed.port !== "" && parsed.port !== String(ctx.listenPort)) {
    return false;
  }
  return true;
}

/**
 * (a)+(b) — anti-DNS-rebinding + anti-CSRF for EVERY mutating request. Returns
 * a 403 `Response` to send verbatim, or `null` when the request may proceed.
 * Applied to all mutating routes except HMAC-authed M2M (see
 * {@link isRebindExempt}) — a browser cannot forge the HMAC, so rebinding a
 * signed webhook is inert.
 */
export function checkRebindGuard(
  req: Request,
  ctx: MutationGuardContext,
): Response | null {
  if (!isHostAllowed(req.headers.get("host"), ctx)) {
    return json(
      {
        error: "forbidden_host",
        detail:
          "the Host header is not in the Mission Control allowlist " +
          "(127.0.0.1 / localhost / ::1 / the configured hostname). This blocks " +
          "DNS-rebinding: a browser sends the original hostname in Host even after " +
          "a rebind to a loopback address.",
      },
      403,
    );
  }
  if (!isOriginAllowed(req.headers.get("origin"), ctx)) {
    return json(
      {
        error: "forbidden_origin",
        detail:
          "the Origin header is outside the Mission Control allowlist — a mutating " +
          "request from a foreign origin is refused (anti-CSRF / anti-rebinding).",
      },
      403,
    );
  }
  return null;
}

/**
 * (d) — authorization binding. The resolved principal must appear in the
 * configured `mc.governance.principals` allowlist. Unset allowlist:
 * fail-closed (403) off loopback; permissive on loopback (preserve legit local
 * callers — the loopback boundary + Host/Origin are the gate).
 */
export function checkAuthorization(
  principal: string,
  ctx: MutationGuardContext,
): Response | null {
  const id = principal.trim().toLowerCase();
  if (ctx.principals.size > 0) {
    if (!ctx.principals.has(id)) {
      return json(
        {
          error: "not_authorized",
          detail:
            "the authenticated principal is not in the mc.governance.principals " +
            "allowlist for this Mission Control daemon.",
        },
        403,
      );
    }
    return null;
  }
  // Unset allowlist.
  if (!ctx.isLoopback) {
    return json(
      {
        error: "not_authorized",
        detail:
          "mc.governance.principals is unset — control-plane mutations are refused " +
          "on a non-loopback bind (fail-closed). Configure the principal allowlist.",
      },
      403,
    );
  }
  return null;
}

/**
 * (c)+(d) — identity gate + authorization for a governed glass mutation.
 * Resolves the CF-Access principal (bind-conditioned; the SAME resolver the
 * admission route uses) then checks the authorization binding. Returns either a
 * `Response` to send verbatim (401/403/503) or the resolved principal.
 */
export async function enforceMutationAuth(
  req: Request,
  ctx: MutationGuardContext,
): Promise<Response | { principal: string }> {
  const auth: AdmissionAuthContext = {
    isLoopback: ctx.isLoopback,
    emailHeader: req.headers.get(CF_ACCESS_EMAIL_HEADER) ?? undefined,
    jwtAssertion: req.headers.get(CF_ACCESS_JWT_HEADER) ?? undefined,
    ...(ctx.verifyJwt ? { verifyJwt: ctx.verifyJwt } : {}),
  };
  const who = await resolveRequestPrincipal(auth);
  if (who instanceof Response) return who;

  const denial = checkAuthorization(who, ctx);
  if (denial) return denial;

  return { principal: who };
}

/**
 * Which mutating routes carry the full identity+authorization gate (c)+(d).
 * The governed glass-mutation set: local session spawn/control (strictly higher
 * blast than dispatch-to-peer — must not be the least-gated route), the Tier-2
 * federation admission decision, and the attention lifecycle (CK-6a).
 */
export function isIdentityGatedMutation(
  method: string,
  pathname: string,
): boolean {
  if (!MUTATING_METHODS.has(method)) return false;
  if (pathname === "/api/sessions") return true;
  if (pathname === "/api/networks/admission-decision") return true;
  if (/^\/api\/assignments\/[^/]+\/(requeue|abandon|handoff|input)$/.test(pathname)) {
    return true;
  }
  if (/^\/api\/attention\/[^/]+\/(resolve|dismiss)$/.test(pathname)) {
    return true;
  }
  return false;
}

/**
 * Routes exempt from the Host/Origin anti-rebinding guard: HMAC-authed M2M
 * only. `POST /api/github/webhook` authenticates by an HMAC signature over a
 * shared secret a browser cannot forge, so rebinding it is inert — and it is
 * legitimately reached cross-origin by the webhook proxy. Every other mutating
 * route is guarded.
 */
export function isRebindExempt(pathname: string): boolean {
  return pathname === "/api/github/webhook";
}
