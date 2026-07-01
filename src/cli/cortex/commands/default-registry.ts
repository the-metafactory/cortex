/**
 * cortex#1228 (PR3.5) — the baked-in **default registry trust anchor**.
 *
 * Root-CA model: cortex ships the metafactory network-registry as a pinned,
 * well-known anchor so a *fresh install trusts the default network with zero
 * paste and zero TOFU*. This removes the one un-TCP/IP step from the join flow
 * ("step 3: pin the registry") — it disappears for the metafactory network
 * (pre-pinned) and reappears only when deliberately joining a NON-default
 * (custom) network. Part of EPIC #1142.
 *
 * ## Trust model
 *
 *   - **Default registry** → ALWAYS pre-pinned. The `pubkey` below is the
 *     compiled-in anchor, so a join/boot against `DEFAULT_REGISTRY.url` verifies
 *     against this key WITHOUT a TOFU window. More secure (no first-use
 *     substitution window) AND zero-config.
 *   - **Custom registry** (any URL ≠ the default) → TOFU is retained, but it is
 *     surfaced with an explicit warning, never silent. A principal pinning a
 *     custom anchor (`--registry-pubkey` / `policy.federated.registry.pubkey`)
 *     gets that pin; an UNpinned custom registry trusts-on-first-use behind the
 *     warning.
 *
 * ## Rotation
 *
 * `next` carries the NEXT anchor pubkey during a key-rotation overlap window.
 * The intent (issue #1228) is that a verifier accepts a registry assertion
 * signed by EITHER `pubkey` (current) OR `next` so a rotation does not break
 * pinned clients mid-flight. `next` is `undefined` whenever no rotation is in
 * progress (the steady state today). NOTE: the join/boot derive pins the
 * CURRENT `pubkey`; the dual-accept `{current, next}` verification belongs to
 * the registry client/resolver and is tracked as a follow-up (see
 * {@link RegistryAnchor.next}).
 *
 * ## Defense-in-depth (the arc-populate half)
 *
 * `arc upgrade cortex` is intended to also WRITE `policy.federated.registry.
 * {url,pubkey}` from this anchor so the pin is both compiled into the binary
 * AND visible in config. That arc-side populate is NOT in this repo — see the
 * TODO in `docs/config-layout/network/example-network.yaml`. The in-cortex
 * fallback implemented here means the pin is correct EVEN WHEN config omits it.
 */

/** A pinned registry trust anchor: a URL + its Ed25519 pubkey (base64). */
export interface RegistryAnchor {
  /** Registry base URL (no trailing slash, by convention). */
  url: string;
  /**
   * Pinned Ed25519 pubkey (base64, 44 chars incl. the trailing `=`). An EMPTY
   * string means "anchor not pinned" — callers MUST treat that as unpinned and
   * fall back to TOFU rather than pinning an empty/garbage key (secure-by-
   * default: never pin an unverified value).
   */
  pubkey: string;
  /**
   * Rotation overlap — the NEXT pubkey, accepted alongside {@link pubkey} during
   * a key-rotation window. `undefined` in steady state. See module JSDoc.
   */
  next?: string;
}

/**
 * The compiled-in metafactory registry anchor.
 *
 * `pubkey` VERIFIED 2026-06-27 against the live endpoint:
 *   `curl -s https://network.meta-factory.ai/registry/pubkey`
 *   → {"algorithm":"Ed25519","public_key":"ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk="}
 * cross-checked against `docs/sop-onboard-peer-principal.md` (the pinned 44-char
 * trust anchor) and `docs/sop-network-registry.md`.
 *
 * Host is `network.meta-factory.ai` — the host that actually serves
 * `/registry/pubkey` and that the registry `wrangler.toml` route points at.
 * (`registry.meta-factory.ai` does NOT resolve; the old config-layout template
 * used it by mistake — aligned in #1228.)
 */
export const DEFAULT_REGISTRY: RegistryAnchor = {
  url: "https://network.meta-factory.ai",
  pubkey: "ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk=",
  // next: undefined — no rotation in progress.
};

/** First non-empty string in the list, or undefined. */
function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Strip trailing slash(es) for a stable URL identity comparison. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Is `url` the default (pre-pinned) registry? Trailing-slash-insensitive so
 * `https://network.meta-factory.ai` and `…/` compare equal. `undefined` ⇒ no
 * url given ⇒ NOT the default (the caller will fall back to the default url
 * separately).
 */
export function isDefaultRegistryUrl(
  url: string | undefined,
  anchor: RegistryAnchor = DEFAULT_REGISTRY,
): boolean {
  if (url === undefined || url === "") return false;
  return normalizeUrl(url) === normalizeUrl(anchor.url);
}

/** Which trust path produced the resolved registry. */
export type RegistryTrust =
  | "flag-pinned" // an explicit --registry-pubkey flag
  | "config-pinned" // policy.federated.registry.pubkey
  | "default-pinned" // the compiled-in DEFAULT_REGISTRY anchor (no TOFU)
  | "tofu"; // custom registry, no pin → trust-on-first-use

export interface ResolvedRegistry {
  /** The resolved registry URL — ALWAYS present (falls back to the anchor). */
  url: string;
  /** The pinned pubkey, or `undefined` when TOFU applies. */
  pubkey?: string;
  /**
   * `true` ⇒ no pubkey could be pinned and the registry is NOT the default —
   * the caller will trust-on-first-use and MUST surface a warning.
   */
  tofu: boolean;
  trust: RegistryTrust;
}

/**
 * Resolve the registry URL + pubkey from (in precedence) flags → config →
 * the compiled-in {@link DEFAULT_REGISTRY} anchor. This is the single chokepoint
 * the join derive AND the boot path use so the trust posture is identical
 * everywhere:
 *
 *   1. URL: flag → config → `anchor.url` (so it ALWAYS resolves — closes the
 *      `network-derive.ts:320` hard-error gap).
 *   2. pubkey, in order:
 *      a. explicit pin (flag or config) → use it (`flag-pinned`/`config-pinned`).
 *      b. else, if the resolved URL IS the default registry AND the anchor is
 *         pinned (non-empty pubkey) → pin the baked key (`default-pinned`, NO
 *         TOFU).
 *      c. else (custom registry, or default-but-anchor-unpinned) → no pin,
 *         `tofu: true` (`tofu`).
 */
export function resolveRegistryAnchor(opts: {
  flagUrl?: string;
  flagPubkey?: string;
  configUrl?: string;
  configPubkey?: string;
  anchor?: RegistryAnchor;
}): ResolvedRegistry {
  const anchor = opts.anchor ?? DEFAULT_REGISTRY;
  const url = firstNonEmpty(opts.flagUrl, opts.configUrl) ?? anchor.url;

  const flagPubkey = firstNonEmpty(opts.flagPubkey);
  if (flagPubkey !== undefined) {
    return { url, pubkey: flagPubkey, tofu: false, trust: "flag-pinned" };
  }
  const configPubkey = firstNonEmpty(opts.configPubkey);
  if (configPubkey !== undefined) {
    return { url, pubkey: configPubkey, tofu: false, trust: "config-pinned" };
  }

  // No explicit pin — is this the pre-pinned default registry?
  const anchorPubkey = firstNonEmpty(anchor.pubkey);
  if (isDefaultRegistryUrl(url, anchor) && anchorPubkey !== undefined) {
    return { url, pubkey: anchorPubkey, tofu: false, trust: "default-pinned" };
  }

  // Custom registry with no pin (or default registry whose anchor is unpinned)
  // → trust-on-first-use. The caller surfaces the warning.
  return { url, tofu: true, trust: "tofu" };
}
