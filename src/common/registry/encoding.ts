/**
 * S1 (Network Join Control Plane, #735 / epic #733) — pubkey-encoding
 * bridge between the two surfaces of one Ed25519 key.
 *
 * **DD-8 (one canonical pubkey encoding per surface).** Config + peers use
 * NATS NKey-U (`U…`, 56-char base32); the registry stores base64 raw
 * ed25519 (32 bytes → 44 chars w/ padding). The join control plane is the
 * single place these translate so humans never hand-convert (the §1
 * bring-up "encoding confusion" trap, design doc step 4).
 *
 * Both encodings cover the SAME 32-byte ed25519 pubkey underneath:
 *
 *   - nkey-U  = `U` prefix-byte + 32 raw bytes + 2-byte CRC, crockford-
 *               base32-encoded (56 ASCII chars total).
 *   - base64  = the 32 raw bytes, standard-base64-encoded (44 chars).
 *
 * The decode direction (nkey-U → base64) already exists as
 * `nkeyToBase64Pubkey` in `src/bus/verify-signed-by-chain.ts` — re-exported
 * here so the registry layer has one import for both directions. This module
 * adds the inverse (`base64PubkeyToNkey`), needed by S2's config-load peer
 * resolver: the registry roster serves base64, but `policy.federated.
 * networks[].peers[].principal_pubkey` is declared in nkey-U, so a
 * registry-resolved peer must be re-encoded to nkey-U before it can be
 * compared against (or merged into) the config surface.
 *
 * **Crypto is NOT hand-rolled** — both directions go through
 * `@nats-io/nkeys`'s `Codec` (the same internal base32 + CRC16 + prefix
 * codec the bus-side verifier already trusts), per the S1 brief.
 */

import { Prefix } from "@nats-io/nkeys";
// `Codec` is the internal NKey base32 + CRC + prefix-byte codec. Marked
// `@ignore` in @nats-io/nkeys but stable; it is the SAME subpath the
// bus-side verifier uses (`src/bus/verify-signed-by-chain.ts`) to decode an
// NKey to raw bytes — we use its `encode` for the inverse here so both
// directions share one crockford-base32 + CRC16 implementation.
import { Codec } from "@nats-io/nkeys/lib/codec";

// Re-export the existing decode helper so callers in the registry layer have
// a single import surface for the DD-8 translation pair. The implementation
// stays in the bus module (it is consumed there by the crypto-verify
// registry bridge) — moving it would be an out-of-scope refactor.
export { nkeyToBase64Pubkey } from "../../bus/verify-signed-by-chain";

/** Base64 Ed25519 grammar: 43 standard-alphabet chars + one `=` of padding. */
const BASE64_ED25519 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Decode a standard-base64 raw ed25519 pubkey (44 chars w/ padding) to its
 * 32 raw bytes. Returns `undefined` if the input is not valid base64 or does
 * not decode to exactly 32 bytes — a malformed key must fail loudly at the
 * boundary, never silently produce a wrong nkey.
 */
function base64PubkeyToBytes(b64: string): Uint8Array | undefined {
  if (!BASE64_ED25519.test(b64)) return undefined;
  let bin: string;
  try {
    bin = atob(b64);
  } catch (_err) {
    // atob throws on a non-base64 alphabet; the regex above should have
    // caught it, so this is defensive only. Safe to swallow — we return the
    // negative outcome the caller branches on, not a thrown error.
    return undefined;
  }
  if (bin.length !== 32) return undefined;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Convert a base64 raw ed25519 pubkey (the registry surface, 44 chars w/
 * padding) to a NATS NKey-U public key (the config/peers surface, `U…`,
 * 56-char base32) — the **DD-8** encode direction.
 *
 * Round-trips with `nkeyToBase64Pubkey`:
 *   `nkeyToBase64Pubkey(base64PubkeyToNkey(b64)) === b64` for any valid key
 *   (pinned by the encoding round-trip test).
 *
 * Returns `undefined` (never throws) if the input is not a valid base64
 * 32-byte ed25519 pubkey, so a poison registry value cannot crash the
 * config-load resolver that consumes this in S2.
 */
export function base64PubkeyToNkey(b64: string): string | undefined {
  const raw = base64PubkeyToBytes(b64);
  if (raw === undefined) return undefined;
  try {
    // `Codec.encode(Prefix.User, raw)` prepends the `U` prefix byte, appends
    // a 2-byte CRC16, and crockford-base32-encodes the lot → the 56-char
    // `U…` NKey string. `TextDecoder` turns the ASCII bytes into the string.
    const encoded = Codec.encode(Prefix.User, raw);
    return new TextDecoder().decode(encoded);
  } catch (_err) {
    // Codec rejected the input (should not happen for a validated 32-byte
    // key); return the negative outcome rather than throwing.
    return undefined;
  }
}
