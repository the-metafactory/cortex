/**
 * S1 (Network Join Control Plane, #735 · epic #733 · spec
 * `docs/design-network-join-control-plane.md` §6 F1) — typed registry client
 * for the network **descriptor** + **roster**.
 *
 * This is the F1 client: the registry-mediated half of `cortex network join`
 * (DD-3/DD-4). It extends the existing cortex registry consumers
 * (`RegistryClient`, `PrincipalPubkeyResolver`) with the two network-scoped
 * endpoints the join path needs, and it folds in the three S1 design
 * decisions:
 *
 *   - **DD-12** — `getNetworkDescriptor(id)` resolves `GET /networks/{id}` to
 *     a typed {@link NetworkDescriptor} (`hub_url` / `leaf_port` / `members`),
 *     so the hub is registry-served and relocatable, never hand-pinned.
 *   - **DD-9**  — EVERY response is a `SignedAssertion` verified against a
 *     PINNED registry pubkey (config `policy.federated.registry.pubkey`, or
 *     TOFU). An unverified response is rejected (a typed error / negative);
 *     it is NEVER returned and NEVER cached.
 *   - **DD-10** — a verified descriptor + roster pair is persisted to disk
 *     (after verification only) so S2's config-load resolver can fall back to
 *     the last-known-good when the registry is unreachable.
 *
 * **Crypto is reused, not hand-rolled.** Signature verification goes through
 * the shared {@link verifySignedAssertion} (same `canonicalJSON` +
 * `verifyEd25519` primitives the principal client + resolver use); the DD-8
 * pubkey-encoding bridge lives in `./encoding.ts`.
 *
 * **Failure model.** Unlike the boot-time `RegistryClient` (which swallows
 * every failure to `undefined` because a background refresh must never crash
 * the bot), this client is called from the foreground join/resolve path where
 * the caller needs to DISTINGUISH "not found" (a real "no such network") from
 * "could not verify" (fall back to cache, DD-10) from a successful fetch. So
 * `getNetworkDescriptor` / `getNetworkRoster` return a discriminated
 * {@link NetworkFetchResult}, never throw, and let the caller branch. A
 * thrown error is reserved for a programmer mistake (no pinned key AND no
 * TOFU configured at construction).
 */

import { NetworkCache, type NetworkCacheOptions } from "./network-cache";
import type {
  NetworkDescriptor,
  NetworkRosterPeer,
  NetworkRosterResult,
} from "./types";
import { verifySignedAssertion } from "./verify-assertion";

/** Base64 Ed25519 grammar: 43 standard-alphabet chars + one `=` of padding. */
const BASE64_ED25519 = /^[A-Za-z0-9+/]{43}=$/;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Discriminated outcome of a descriptor / roster fetch. NEVER thrown — the
 * caller branches.
 *
 * - `ok`         — verified payload of the requested shape.
 * - `not_found`  — the registry returned 404 (no such network). Stable.
 * - `unverified` — a response arrived but failed the DD-9 pin+verify gate
 *                  (bad signature, wrong/sentinel registry pubkey, or a
 *                  malformed envelope). The load-bearing rejection — the
 *                  payload is NOT returned. `reason` carries the precise class
 *                  for audit.
 * - `unreachable`— transport failure (network error, timeout, non-404 HTTP,
 *                  unparseable body) OR no pinned pubkey available. The
 *                  caller's DD-10 cache fallback hangs off this branch.
 */
export type NetworkFetchResult<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "unverified"; reason: string }
  | { status: "unreachable"; reason: string };

/** Construction options for {@link NetworkRegistryClient}. */
export interface NetworkRegistryClientOptions {
  /**
   * Registry base URL (`policy.federated.registry.url`). Trailing slashes are
   * normalised away before path joining.
   */
  url: string;
  /**
   * Pinned registry pubkey (`policy.federated.registry.pubkey`, base64
   * Ed25519, 44 chars w/ padding). When absent, the client performs TOFU via
   * `GET {url}/registry/pubkey` on first I/O and pins the response for its
   * lifetime — the documented Phase-B caveat shared with the other registry
   * consumers. Supplying it (out-of-band) is the recommended zero-TOFU
   * posture (DD-9).
   */
  pubkey?: string;
  /** Per-request timeout (ms). Default 10s. Wraps each `fetch` via abort. */
  requestTimeoutMs?: number;
  /** `fetch` implementation. Defaults to `globalThis.fetch`. Tests inject. */
  fetch?: typeof globalThis.fetch;
  /**
   * Logger seam — defaults to `process.stderr.write` (CLAUDE.md "no empty
   * catches"). Tests inject a spy / no-op.
   */
  logError?: (msg: string) => void;
  /**
   * Disk-cache options (DD-10). `cacheDir` defaults to
   * `~/.config/cortex/network-cache/`; tests pass a tmp dir. An injected
   * {@link NetworkCache} (e.g. a shared instance) can be supplied instead.
   */
  cache?: NetworkCache;
  cacheOptions?: NetworkCacheOptions;
}

/**
 * Typed network descriptor + roster client. Single-process; no background
 * timers (unlike `RegistryClient`) — the join/resolve path calls it on demand.
 */
export class NetworkRegistryClient {
  private readonly url: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logError: (msg: string) => void;
  private readonly cache: NetworkCache;

  /** Pinned registry pubkey. Set in ctor (config) or via TOFU on first I/O. */
  private pinnedPubkey: string | undefined;
  /** Whether the pin must be discovered via TOFU (no config pin). */
  private readonly tofuMode: boolean;

  constructor(options: NetworkRegistryClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logError =
      options.logError ??
      ((msg: string) => {
        process.stderr.write(`network-registry-client: ${msg}\n`);
      });
    this.cache = options.cache ?? new NetworkCache(options.cacheOptions);
    this.pinnedPubkey = options.pubkey;
    this.tofuMode = options.pubkey === undefined;
  }

  /**
   * Resolve `GET /networks/{networkId}` to a verified {@link NetworkDescriptor}
   * (DD-12). The response is pin+verified (DD-9) and, when it AND a roster
   * fetch both succeed via {@link fetchAndCache}, persisted to disk (DD-10).
   * This bare getter does NOT write the cache (a descriptor without its roster
   * is an incomplete pair); use {@link fetchAndCache} to refresh the cache.
   */
  async getNetworkDescriptor(
    networkId: string,
  ): Promise<NetworkFetchResult<NetworkDescriptor>> {
    const verified = await this.fetchVerified(
      `/networks/${encodeURIComponent(networkId)}`,
    );
    if (verified.status !== "ok") return verified;
    const descriptor = parseDescriptor(verified.value, networkId);
    if (descriptor === undefined) {
      this.logError(
        `getNetworkDescriptor(${networkId}): verified payload is not a valid descriptor; rejecting`,
      );
      return { status: "unverified", reason: "descriptor payload shape invalid" };
    }
    return { status: "ok", value: descriptor };
  }

  /**
   * Resolve `GET /networks/{networkId}/roster` to a verified
   * {@link NetworkRosterResult}. Pin+verified (DD-9); peer pubkeys are
   * grammar-gated as base64 Ed25519 before the roster is trusted.
   */
  async getNetworkRoster(
    networkId: string,
  ): Promise<NetworkFetchResult<NetworkRosterResult>> {
    const verified = await this.fetchVerified(
      `/networks/${encodeURIComponent(networkId)}/roster`,
    );
    if (verified.status !== "ok") return verified;
    const roster = parseRoster(verified.value, networkId);
    if (roster === undefined) {
      this.logError(
        `getNetworkRoster(${networkId}): verified payload is not a valid roster; rejecting`,
      );
      return { status: "unverified", reason: "roster payload shape invalid" };
    }
    return { status: "ok", value: roster };
  }

  /**
   * Fetch BOTH the descriptor and the roster, verify both (DD-9), and on
   * success persist the pair to disk (DD-10) — the refresh path the join
   * command + S2 resolver drive. Returns the verified pair on success; on any
   * non-`ok` for either half, returns that negative WITHOUT writing the cache
   * (a half-pair is never cached). The previously-cached pair, if any, is left
   * untouched so a transient failure never blanks last-known-good.
   */
  async fetchAndCache(
    networkId: string,
  ): Promise<
    NetworkFetchResult<{ descriptor: NetworkDescriptor; roster: NetworkRosterResult }>
  > {
    const descriptorResult = await this.getNetworkDescriptor(networkId);
    if (descriptorResult.status !== "ok") return descriptorResult;
    const rosterResult = await this.getNetworkRoster(networkId);
    if (rosterResult.status !== "ok") return rosterResult;

    // BOTH halves verified — only now is it safe to cache (DD-10: cache only
    // after signature verification).
    this.cache.store(networkId, descriptorResult.value, rosterResult.value);
    return {
      status: "ok",
      value: { descriptor: descriptorResult.value, roster: rosterResult.value },
    };
  }

  /**
   * DD-10 fallback read — the last verified descriptor + roster for
   * `networkId`, or `undefined` if nothing is cached. S2 calls this when a
   * live fetch returns `unreachable`, so federation stays up across a
   * transient registry outage. NEVER throws.
   */
  loadCached(
    networkId: string,
  ): { descriptor: NetworkDescriptor; roster: NetworkRosterResult } | undefined {
    const cached = this.cache.load(networkId);
    if (cached === undefined) return undefined;
    return { descriptor: cached.descriptor, roster: cached.roster };
  }

  // ===========================================================================
  // Private — verified fetch + TOFU
  // ===========================================================================

  /**
   * Fetch a registry path and verify the `SignedAssertion` against the pinned
   * pubkey (DD-9). Returns the verified, still-untyped `payload` on success;
   * a discriminated negative otherwise. The shared {@link verifySignedAssertion}
   * is the single DD-9 gate.
   */
  private async fetchVerified(path: string): Promise<NetworkFetchResult<unknown>> {
    // TOFU the registry pubkey on first I/O if it wasn't config-pinned.
    // Retried on every call until it succeeds — a transient outage on the
    // first attempt must not leave the client permanently unable to verify.
    if (this.pinnedPubkey === undefined && this.tofuMode) {
      await this.fetchAndPinRegistryPubkey();
    }
    if (this.pinnedPubkey === undefined) {
      this.logError(
        `fetch ${path}: no pinned registry pubkey (TOFU failing or never supplied); cannot verify`,
      );
      return { status: "unreachable", reason: "no pinned registry pubkey" };
    }

    const fetched = await this.fetchJson(`${this.url}${path}`);
    if (fetched.kind === "not_found") return { status: "not_found" };
    if (fetched.kind === "error") {
      return { status: "unreachable", reason: fetched.reason };
    }

    const result = await verifySignedAssertion(fetched.body, this.pinnedPubkey);
    switch (result.kind) {
      case "ok":
        return { status: "ok", value: result.payload };
      case "bad_signature":
        this.logError(`fetch ${path}: signature did not verify; rejecting (DD-9)`);
        return { status: "unverified", reason: "bad_signature" };
      case "pubkey_mismatch":
        this.logError(
          `fetch ${path}: registry pubkey mismatch (got ${result.got.slice(0, 8)}…, pinned ${this.pinnedPubkey.slice(0, 8)}…); rejecting (DD-9)`,
        );
        return { status: "unverified", reason: "registry_pubkey_mismatch" };
      case "unconfigured":
        this.logError(`fetch ${path}: registry assertion says "unconfigured"; rejecting`);
        return { status: "unverified", reason: "registry_unconfigured" };
      case "malformed":
        this.logError(`fetch ${path}: malformed assertion (${result.detail}); rejecting`);
        return { status: "unverified", reason: `malformed_assertion: ${result.detail}` };
    }
  }

  private async fetchAndPinRegistryPubkey(): Promise<void> {
    const fetched = await this.fetchJson(`${this.url}/registry/pubkey`);
    if (fetched.kind !== "ok") {
      this.logError(
        `TOFU failed: could not fetch /registry/pubkey; client stays unpinned and rejects until a later attempt succeeds`,
      );
      return;
    }
    const raw = fetched.body;
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { algorithm?: unknown }).algorithm !== "Ed25519" ||
      typeof (raw as { public_key?: unknown }).public_key !== "string"
    ) {
      this.logError("TOFU failed: malformed /registry/pubkey response");
      return;
    }
    const publicKey = (raw as { public_key: string }).public_key;
    if (publicKey === "" || publicKey === "unconfigured") {
      this.logError("TOFU failed: registry returned unconfigured pubkey; refusing to pin");
      return;
    }
    this.pinnedPubkey = publicKey;
  }

  /**
   * Issue a JSON GET. Distinguishes 404 (a stable "no such network") from
   * every other failure (`error`, with a reason) and success (`ok`). Wraps
   * timeout + non-2xx + parse failure into a discriminated return — NEVER
   * throws.
   */
  private async fetchJson(
    url: string,
  ): Promise<
    | { kind: "ok"; body: unknown }
    | { kind: "not_found" }
    | { kind: "error"; reason: string }
  > {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) return { kind: "not_found" };
      if (!res.ok) {
        this.logError(`GET ${url} returned ${res.status}`);
        return { kind: "error", reason: `http_${res.status}` };
      }
      try {
        return { kind: "ok", body: await res.json() };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logError(`GET ${url} JSON parse failed: ${reason}`);
        return { kind: "error", reason: "json_parse_failed" };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logError(`GET ${url} timed out after ${this.requestTimeoutMs}ms`);
        return { kind: "error", reason: "timeout" };
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.logError(`GET ${url} failed: ${reason}`);
      return { kind: "error", reason: "network_error" };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

// =============================================================================
// Payload shape parsers (private) — validate the verified payload is the shape
// we asked for. A verified-but-wrong-shape payload is treated as unverified:
// the registry signed something that isn't a descriptor/roster, which is a
// wire-contract violation, not a value to trust.
// =============================================================================

/** Parse + validate a verified payload as a {@link NetworkDescriptor}. */
function parseDescriptor(
  payload: unknown,
  networkId: string,
): NetworkDescriptor | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.network_id !== networkId) return undefined;
  if (typeof p.hub_url !== "string" || p.hub_url.length === 0) return undefined;
  if (typeof p.leaf_port !== "number" || !Number.isInteger(p.leaf_port)) {
    return undefined;
  }
  if (!Array.isArray(p.members) || !p.members.every((m) => typeof m === "string")) {
    return undefined;
  }
  const members: string[] = p.members.filter(
    (m): m is string => typeof m === "string",
  );
  // #1598 — the OPTIONAL hub/resolver-mode attestation. A present-but-invalid
  // value is a wire-contract violation on a SIGNED payload: reject the whole
  // descriptor (never degrade a malformed attestation to "unattested" — the
  // admit guards branch on it).
  if (p.hub_mode !== undefined && p.hub_mode !== "operator" && p.hub_mode !== "simple") {
    return undefined;
  }
  if (p.resolver_mode !== undefined && p.resolver_mode !== "nats" && p.resolver_mode !== "memory") {
    return undefined;
  }
  // Coherence invariant (mirrors `validate.ts` at write time): resolver_mode is
  // only meaningful on an operator hub. Re-assert it HERE so a verified reader
  // can rely on the illegal `{ hub_mode: simple, resolver_mode }` state never
  // reaching them off the signed descriptor — the enum checks above alone leave
  // that state representable.
  if (p.resolver_mode !== undefined && p.hub_mode !== "operator") {
    return undefined;
  }
  return {
    network_id: networkId,
    hub_url: p.hub_url,
    leaf_port: p.leaf_port,
    members,
    ...(p.hub_mode !== undefined && { hub_mode: p.hub_mode }),
    ...(p.resolver_mode !== undefined && { resolver_mode: p.resolver_mode }),
  };
}

/** Parse + validate a verified payload as a {@link NetworkRosterResult}. */
function parseRoster(
  payload: unknown,
  networkId: string,
): NetworkRosterResult | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.network_id !== networkId) return undefined;
  if (!Array.isArray(p.members)) return undefined;

  const members: NetworkRosterPeer[] = [];
  for (const raw of p.members) {
    if (raw === null || typeof raw !== "object") return undefined;
    const m = raw as Record<string, unknown>;
    if (typeof m.principal_id !== "string" || m.principal_id.length === 0) {
      return undefined;
    }
    if (typeof m.principal_pubkey !== "string") return undefined;
    // Grammar-gate the peer pubkey — a signed-but-malformed key is still a
    // wire-contract violation; reject the whole roster rather than cache a
    // poison value a downstream resolver would choke on.
    if (!BASE64_ED25519.test(m.principal_pubkey)) return undefined;
    // `stack_id` is optional on the roster (see NetworkRosterPeer JSDoc).
    if (m.stack_id !== undefined && typeof m.stack_id !== "string") {
      return undefined;
    }
    members.push({
      principal_id: m.principal_id,
      principal_pubkey: m.principal_pubkey,
      ...(typeof m.stack_id === "string" ? { stack_id: m.stack_id } : {}),
    });
  }
  return { network_id: networkId, members };
}
