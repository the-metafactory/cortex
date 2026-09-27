/**
 * Shared NATS JWT helpers (read-only, public claim material only). Used by the
 * bus-safety creds check (issuer account of a user JWT), by provision's
 * agents-account JetStream probe (cortex#2534), and by the MC sibling-observer
 * scope check (cortex#2536).
 */

/**
 * Pull the user-JWT body out of a decorated `.creds` file. Reads only the JWT
 * block, never the seed block. `undefined` when no JWT block is present.
 */
export function extractUserJwt(credsText: string): string | undefined {
  const m =
    /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----?END NATS USER JWT-----?/.exec(
      credsText,
    );
  const body = m?.[1];
  if (body === undefined) return undefined;
  // The JWT may be wrapped across lines in the block; collapse whitespace.
  const jwt = body.replace(/\s+/g, "");
  return jwt.length > 0 ? jwt : undefined;
}

/**
 * Decode a JWT's middle (claims) segment as JSON. `undefined` on any failure,
 * so callers fail closed: they cannot vouch for claims they could not read.
 * Never verifies the signature.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(base64ToBytes(b64));
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch (_err) {
    // Malformed base64url / JSON — no decodable claims; the caller treats the
    // JWT as unverifiable.
    return undefined;
  }
}

/** base64 (standard alphabet, `+`/`/`) → bytes, tolerating missing padding. */
function base64ToBytes(b64: string): Uint8Array {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
