/**
 * Shared CF Access JWT verifier (cortex#1410).
 *
 * WebCrypto-only (no external dependency) so it runs UNCHANGED in both:
 *   - the CF Worker runtime (dashboard read-endpoint gating), and
 *   - the local Bun daemon (Mission Control admission-decision Gate 1).
 *
 * It relies only on primitives present in both runtimes: `crypto.subtle`,
 * `fetch`, `atob`, `TextEncoder`/`TextDecoder`.
 *
 * Verification is FAIL-CLOSED: any malformed / unsigned / wrong-`aud` /
 * wrong-`iss` / expired / not-yet-valid token — and any JWKS-fetch failure —
 * returns `null`. Callers MUST treat `null` as "reject", never as "fall
 * through to a weaker trust path".
 *
 * Extracted from the two near-duplicate copies that previously lived in the
 * worker (`worker/src/user-auth/middleware/cf-access.ts` and `worker/src/
 * auth.ts`); both now delegate here. This copy additionally verifies `iss`
 * (the team issuer) and `nbf`/`iat` that the originals skipped.
 */

/** CF Access JWKs carry a `kid` that the base `JsonWebKey` type omits. */
type CfAccessJwk = JsonWebKey & { kid?: string };

export interface CfAccessVerifyOptions {
  /** The Access application AUD tag the token's `aud` must contain. */
  readonly aud: string;
  /** CF Access team slug (e.g. "metafactory") → derives issuer + JWKS URL. */
  readonly teamDomain: string;
  /** Clock override (seconds since epoch) for deterministic tests. */
  readonly nowSeconds?: number;
  /** Clock-skew tolerance, in seconds (default 60). */
  readonly clockSkewSeconds?: number;
  /** `fetch` override for tests (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
}

const KEY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — CF rotates keys slowly.
const jwksCache = new Map<string, { keys: CfAccessJwk[]; fetchedAt: number }>();

/** CF Access certs (JWKS) endpoint for a team. */
export function cfAccessCertsUrl(teamDomain: string): string {
  return `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
}

/** CF Access token issuer (`iss`) for a team. */
export function cfAccessIssuer(teamDomain: string): string {
  return `https://${teamDomain}.cloudflareaccess.com`;
}

/** Test seam: drop the module-scoped JWKS cache between cases. */
export function resetCfAccessJwksCache(): void {
  jwksCache.clear();
}

async function getCfAccessKeys(
  teamDomain: string,
  fetchImpl: typeof fetch,
): Promise<CfAccessJwk[]> {
  const url = cfAccessCertsUrl(teamDomain);
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
    return cached.keys;
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`CF Access JWKS fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as { keys: CfAccessJwk[] };
  jwksCache.set(url, { keys: data.keys, fetchedAt: Date.now() });
  return data.keys;
}

async function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

// Returns an ArrayBuffer-backed view (not the bare `Uint8Array`, which widens
// to `ArrayBufferLike` under bun-types and fails `crypto.subtle` typing).
function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment)));
}

/**
 * Verify a CF Access JWT and return its decoded payload, or `null` when the
 * token is not a valid, current, correctly-scoped CF Access assertion.
 *
 * Checks (all must pass): three-part shape, `alg === "RS256"`, `aud` contains
 * the configured audience, `iss` equals the team issuer, `exp` present and not
 * past, `nbf`/`iat` (when present) not in the future — then the RS256 signature
 * against the team's JWKS.
 */
export async function verifyCfAccessJwt(
  token: string,
  opts: CfAccessVerifyOptions,
): Promise<Record<string, unknown> | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const skew = opts.clockSkewSeconds ?? 60;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  try {
    header = decodeJsonSegment(headerB64) as { alg?: unknown; kid?: unknown };
  } catch (_err: unknown) {
    return null; // Unparseable header ⇒ reject (fail closed).
  }
  if (header.alg !== "RS256") return null;
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  let payload: Record<string, unknown>;
  try {
    payload = decodeJsonSegment(payloadB64) as Record<string, unknown>;
  } catch (_err: unknown) {
    return null; // Unparseable payload ⇒ reject.
  }

  // Audience — the Access application this token was minted for.
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.aud) : aud === opts.aud;
  if (!audOk) return null;

  // Issuer — the team domain that signed it.
  if (payload.iss !== cfAccessIssuer(opts.teamDomain)) return null;

  // Expiry — REQUIRED. Absent or past (beyond skew) ⇒ reject.
  const exp = payload.exp;
  if (typeof exp !== "number" || exp + skew < now) return null;

  // Not-before — if present, must not be in the future (beyond skew).
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nbf - skew > now) return null;

  // Issued-at — if present, must not be in the future (beyond skew).
  const iat = payload.iat;
  if (typeof iat === "number" && iat - skew > now) return null;

  let keys: CfAccessJwk[];
  try {
    keys = await getCfAccessKeys(opts.teamDomain, fetchImpl);
  } catch (err: unknown) {
    // FAIL CLOSED: without the signing keys we cannot verify, so we must NOT
    // authenticate. Log for ops visibility (`console.*` is cross-runtime).
    console.error(
      `cf-access-jwt: JWKS unavailable, failing closed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
  // Copy the signed bytes into a length-allocated (ArrayBuffer-backed) view so
  // it is a `BufferSource` under every lib resolution — TextEncoder.encode's
  // `ArrayBufferLike` generic otherwise trips crypto.subtle.verify's typing.
  const encoded = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signed = new Uint8Array(encoded.length);
  signed.set(encoded);
  const signature = base64urlToBytes(signatureB64);

  for (const jwk of candidates) {
    try {
      const key = await importVerifyKey(jwk);
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)) {
        return payload;
      }
    } catch (_err: unknown) {
      continue; // This key didn't import/verify; try the next candidate.
    }
  }
  return null;
}
