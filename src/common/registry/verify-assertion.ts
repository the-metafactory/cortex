/**
 * S1 (Network Join Control Plane, #735) — shared registry signed-assertion
 * verification.
 *
 * **DD-9 (pin + verify the registry).** Every registry GET response is a
 * `SignedAssertion<T>` = `{ payload, issued_at, registry, signature }`, where
 * `signature` is Ed25519 over `canonicalJSON({ payload, issued_at, registry })`.
 * A consumer MUST verify that signature against a **pinned** registry pubkey
 * before trusting `payload` — a spoofed/compromised registry (or a path
 * attacker) otherwise injects arbitrary hub URLs and peer pubkeys.
 *
 * This helper is the one place that gate lives for the S1 network-descriptor +
 * roster client. It mirrors — and is kept in lock-step with — the inline
 * verification already in `RegistryClient.verifyAssertion` (`./client.ts`) and
 * `PrincipalPubkeyResolver.verifyAssertion` (`./resolve-pubkey.ts`); those two
 * predate this extraction and were not folded in to avoid a drive-by refactor
 * of already-reviewed hot paths (CLAUDE.md). New registry consumers (the S1
 * client) use THIS shared helper rather than adding a third copy.
 *
 * The helper does the encoding-agnostic envelope work (shape gate →
 * registry-pubkey pin check → canonical-JSON Ed25519 verify) and returns the
 * verified `payload` as `unknown`. Payload-shape validation (descriptor vs
 * roster) is the caller's concern — the caller knows what `T` it asked for.
 *
 * NEVER throws: a verification failure returns a discriminated negative so
 * federation/registry problems can be turned into "use cache + warn" (DD-10)
 * by the caller rather than crashing a boot path.
 */

import { canonicalJSON, verifyEd25519 } from "./signing";

/**
 * Outcome of {@link verifySignedAssertion}. Discriminated so a caller can log
 * the precise failure class AND decide its fallback (DD-10 cache reuse) per
 * reason.
 *
 * - `ok`            — signature verified against the pinned pubkey; `payload`
 *                     is the verified (but not yet shape-validated) body.
 * - `malformed`     — the response is not a well-formed `SignedAssertion`
 *                     envelope (missing/typed-wrong fields).
 * - `unconfigured`  — the assertion's `registry` field is the `"unconfigured"`
 *                     sentinel (registry has no signing key) — never trusted.
 * - `pubkey_mismatch` — the assertion's `registry` pubkey differs from the
 *                     pinned one (wrong/rotated/spoofed registry).
 * - `bad_signature` — the envelope is well-formed and the registry pubkey
 *                     matches, but the Ed25519 signature does not verify. THE
 *                     load-bearing DD-9 rejection.
 */
export type VerifyAssertionResult =
  | { kind: "ok"; payload: unknown }
  | { kind: "malformed"; detail: string }
  | { kind: "unconfigured" }
  | { kind: "pubkey_mismatch"; got: string }
  | { kind: "bad_signature" };

/**
 * Verify a raw (untrusted, off-the-wire) value as a registry
 * `SignedAssertion` against `pinnedPubkey`. Accepts `unknown` deliberately:
 * the input is JSON straight off `fetch`, and the shape checks here ARE the
 * validation — trusting a static type at the boundary would defeat DD-9.
 *
 * @param raw          the parsed JSON body of a registry GET
 * @param pinnedPubkey base64 Ed25519 registry pubkey, pinned from config
 *                     (`policy.federated.registry.pubkey`) or TOFU
 */
export async function verifySignedAssertion(
  raw: unknown,
  pinnedPubkey: string,
): Promise<VerifyAssertionResult> {
  // Shape gate first — cheaper than crypto and gives a precise failure class.
  if (raw === null || typeof raw !== "object") {
    return { kind: "malformed", detail: "assertion is not an object" };
  }
  const assertion = raw as Record<string, unknown>;
  if (
    typeof assertion.signature !== "string" ||
    typeof assertion.issued_at !== "string" ||
    typeof assertion.registry !== "string" ||
    assertion.payload === null ||
    typeof assertion.payload !== "object"
  ) {
    return { kind: "malformed", detail: "assertion envelope fields missing or wrong type" };
  }

  const registry = assertion.registry;
  if (registry === "unconfigured") {
    // The registry has no signing key — no signature path can verify a
    // sentinel value. Refuse rather than trust an unsigned payload.
    return { kind: "unconfigured" };
  }
  if (registry !== pinnedPubkey) {
    return { kind: "pubkey_mismatch", got: registry };
  }

  // Reconstruct the canonical bound triple and verify the registry signature.
  const bound = canonicalJSON({
    payload: assertion.payload,
    issued_at: assertion.issued_at,
    registry,
  });
  const message = new TextEncoder().encode(bound);
  let ok: boolean;
  try {
    ok = await verifyEd25519(pinnedPubkey, assertion.signature, message);
  } catch (_err) {
    // verifyEd25519 is documented never-throw, but a thrown error here is
    // indistinguishable (security-wise) from a failed verify — treat as a bad
    // signature, the fail-closed direction.
    return { kind: "bad_signature" };
  }
  if (!ok) return { kind: "bad_signature" };

  return { kind: "ok", payload: assertion.payload };
}
