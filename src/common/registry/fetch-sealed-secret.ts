/**
 * ADR-0018 PR5b (#1240) — member-side fetch + unseal of the leaf secret.
 *
 * The plug-and-play half (#1240 locked constraint): `cortex network join`
 * AUTO-fetches the sealed blob from the member PoP-read endpoint
 * (`GET /admission-requests/mine`), decrypts it with the joiner's OWN seed, and
 * renders the leaf — the user never copies/pastes a secret.
 *
 * This module is that primitive, transport-injectable so the join wiring + the
 * tests drive it without a live registry. It:
 *   1. signs a proof-of-possession read claim with the member's seed (the
 *      signature IS the authorization — no admin key),
 *   2. GETs `/admission-requests/mine`,
 *   3. selects the ADMITTED row for the target network that carries a sealed
 *      blob,
 *   4. opens the `crypto_box_seal` with the member's raw ed25519 seed
 *      ({@link openSealed}) and decodes the envelope — VERSION-AWARE (#1597,
 *      epic #1595): a v1 envelope yields the PSK path, a v2 envelope yields the
 *      per-member `.creds` file text the join installs on disk.
 *
 * Returns a `kind`-discriminated payload (the M3 payload key rides BOTH kinds
 * from the SAME envelope). Fails SOFT-CLOSED: every failure is a typed
 * `{ ok: false, reason }` so the join can fall through to its existing
 * config/flag/oob behaviour rather than aborting.
 */

import { openSealed } from "../crypto/seal-to-principal";
import { decodeAnyLeafSecretEnvelope, isLeafSecretEnvelopeV2 } from "./sealed-leaf-secret";
import {
  rawEd25519SeedFromNkeySeed,
  type StackIdentityMaterial,
} from "../../bus/stack-provisioning";
import { fetchOwnAdmissionRows } from "./admission-state";

/** Injectable fetch (defaults to `globalThis.fetch`) so tests stay hermetic. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface FetchSealedLeafSecretInput {
  /** Registry base URL (e.g. the descriptor host). */
  registryUrl: string;
  /** The network whose leaf PSK we want. */
  networkId: string;
  /** The joining principal id (echoed into the signed claim). */
  principalId: string;
  /** The member's identity material — pubkey + seed (used to sign + unseal). */
  material: StackIdentityMaterial;
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Injected clock (tests). Production omits → `Date`. */
  now?: () => Date;
  /**
   * #1597 (red-team R7) — the member's OWN identities a v2 envelope's
   * `leaf_user` (the subject the credential was minted FOR) must match, e.g.
   * `["{principal}/{stack}", "{principal}"]`. FAIL-CLOSED for v2: when a v2
   * envelope arrives and this is absent/empty, the fetch refuses — a caller
   * that cannot state its own identity must not install a credential that may
   * have been minted for someone else (a hostile courier sealing ANOTHER
   * member's real creds to this member). v1 is unaffected: its `leaf_user` is
   * the userinfo USER the hub pairs with the PSK, not an identity claim.
   */
  expectedLeafUsers?: readonly string[];
}

export type FetchSealedLeafSecretResult =
  /** v1 envelope — the sovereign-model shared-string secret-auth pipe (ADR-0013). */
  | { ok: true; kind: "psk"; leafPsk: string; leafUser: string; payloadKey?: string; payloadKeyKid?: string }
  /**
   * v2 envelope (#1597, epic #1595) — the per-member NSC user `.creds` file
   * text for an operator-mode hub. The caller writes `creds` to disk (0600)
   * and renders the EXISTING creds-file leaf-remote branch. `mintedAt` is the
   * seal-time stamp, surfaced for observability; staleness is deliberately NOT
   * enforced here — a legitimate join may happen days after admission, and
   * there is no rotation story until #1599.
   */
  | { ok: true; kind: "creds"; creds: string; leafUser: string; mintedAt: string; payloadKey?: string; payloadKeyKid?: string }
  | { ok: false; reason: string };

/**
 * Fetch + unseal this member's leaf secret for `networkId`. SOFT-CLOSED on every
 * failure path (no throw): the join caller treats `{ ok: false }` as "no sealed
 * secret available — fall through".
 */
export async function fetchSealedLeafSecret(
  input: FetchSealedLeafSecretInput,
): Promise<FetchSealedLeafSecretResult> {
  // 1-2. PoP-sign + GET /admission-requests/mine (shared read — C-1315).
  const readRes = await fetchOwnAdmissionRows({
    registryUrl: input.registryUrl,
    principalId: input.principalId,
    material: input.material,
    ...(input.fetchImpl !== undefined && { fetchImpl: input.fetchImpl }),
    ...(input.now !== undefined && { now: input.now }),
  });
  if (!readRes.ok) return { ok: false, reason: readRes.reason };
  const rows = readRes.rows;

  // 3. Select the ADMITTED row for this network carrying a sealed blob.
  const row = rows.find(
    (r) => r.network_id === input.networkId && r.status === "ADMITTED" && typeof r.sealed_secret === "string" && r.sealed_secret.length > 0,
  );
  if (!row?.sealed_secret) {
    return {
      ok: false,
      reason: `no admitted+sealed admission row for network "${input.networkId}" (not yet admitted, or no secret delivered)`,
    };
  }

  // 4. Open the sealed box with the member's raw seed + decode the envelope —
  //    VERSION-AWARE (#1597): the payload variant is pinned by `v` (design
  //    §5.2 / R9/R12 — never an either-field relaxation).
  try {
    const rawSeed = rawEd25519SeedFromNkeySeed(input.material.seed);
    const plaintextBytes = await openSealed(row.sealed_secret, rawSeed);
    const env = decodeAnyLeafSecretEnvelope(new TextDecoder().decode(plaintextBytes));
    if (isLeafSecretEnvelopeV2(env)) {
      // R7 identity binding — refuse a credential minted for a DIFFERENT
      // subject. FAIL-CLOSED when the caller supplied no expected identities.
      // `leaf_user` is an identity label, not secret material — safe to name
      // in the reason (the creds text itself is NEVER echoed).
      const expected = input.expectedLeafUsers ?? [];
      if (expected.length === 0) {
        return {
          ok: false,
          reason:
            `sealed envelope for "${input.networkId}" carries a v2 per-member credential, but the caller ` +
            `supplied no expected identities to bind it to (R7) — refusing to install it`,
        };
      }
      if (!expected.includes(env.leaf_user)) {
        return {
          ok: false,
          reason:
            `sealed v2 credential for "${input.networkId}" was minted for subject "${env.leaf_user}", ` +
            `not this member (expected one of: ${expected.join(", ")}) — refusing to install it (R7)`,
        };
      }
      return {
        ok: true,
        kind: "creds",
        creds: env.creds,
        leafUser: env.leaf_user,
        mintedAt: env.minted_at,
        ...payloadKeyFields(env),
      };
    }
    return {
      ok: true,
      kind: "psk",
      leafPsk: env.leaf_psk,
      leafUser: env.leaf_user,
      ...payloadKeyFields(env),
    };
  } catch (err) {
    // Generic — never echo seed/ciphertext/plaintext.
    return { ok: false, reason: `failed to open sealed leaf secret: ${errText(err)}` };
  }
}

/** The optional ADR-0019 payload-key rider, in result-field casing (one site). */
function payloadKeyFields(env: {
  payload_key?: string;
  payload_key_kid?: string;
}): { payloadKey?: string; payloadKeyKid?: string } {
  return {
    ...(env.payload_key !== undefined && { payloadKey: env.payload_key }),
    ...(env.payload_key_kid !== undefined && { payloadKeyKid: env.payload_key_kid }),
  };
}

/** Error → message, never echoing secret-bearing inputs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
