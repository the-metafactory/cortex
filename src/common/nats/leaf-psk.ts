/**
 * ADR-0018 PR5b (#1240) — per-member leaf PSK minting.
 *
 * The leaf shared secret (ADR-0013) is a TRANSPORT PSK, not an identity
 * credential: it authenticates a member's nats-server leaf link to the hub
 * (presented as URL userinfo `tls://<user>:<secret>@host`, matched by the hub's
 * `leafnodes { authorization { users: [{ user, password }] } }`). ADR-0018 Q2
 * makes it PER-MEMBER (its own hub `authorization` user) so revoke is targeted
 * and leaks are attributable.
 *
 * This module mints that PSK. It is the ONLY thing in the leaf-secret path that
 * generates secret material; everything downstream (seal, hub-config write,
 * registry delivery) carries it. The PSK is HIGH-ENTROPY (32 CSPRNG bytes) and
 * URL/HOCON-safe (base64url, no `@`/`:`/`/`/`+` that would need escaping in the
 * dial URL userinfo or the hub config). It is never logged.
 */

import { base64UrlNoPad } from "../encoding/base64url";

/** Length of a minted leaf PSK in raw bytes (256 bits of entropy). */
const PSK_BYTES = 32;

/**
 * Mint a fresh per-member leaf PSK: 32 CSPRNG bytes, base64url-encoded (no
 * padding). base64url keeps the secret free of characters that are significant
 * in the leaf dial URL userinfo or in HOCON, so it round-trips cleanly through
 * both the rendered hub config and the member's leaf remote without escaping
 * surprises. NEVER log the return value — surface only a fingerprint if needed.
 */
export function mintLeafPsk(): string {
  const bytes = new Uint8Array(PSK_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlNoPad(bytes);
}

/**
 * A short, LOG-SAFE fingerprint of a PSK (or any secret) — the first 8 chars of
 * its SHA-256, hex. Use this in report output INSTEAD of the secret so a
 * rotate/deliver can be correlated in logs without the secret ever appearing.
 * Async (WebCrypto digest); callers in the leaf-secret path are already async.
 */
export async function pskFingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const bytes = new Uint8Array(digest).slice(0, 4);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
