/**
 * FLG-7 (`docs/plan-mc-future-state.md` §4.D + §6 invariant 7) — the MC-side
 * hub-locality guard.
 *
 * ## Why this exists
 *
 * Hub-HALF federation ops — sealing a member's leaf PSK (writes the hub
 * nats-server `authorization` user), the revoke hub-cut (drops that user +
 * SIGHUP), and a rotate-K re-seal (SIGHUP) — are valid ONLY when the executing
 * daemon's host actually RUNS the network's hub. That is the whole lesson of the
 * 2026-07-03/04 wrong-hub-seal Authorization-Violation storm (`CONTEXT.md`
 * §"Leaf secret", operational trap): `cortex network secret add-member` writes the
 * PSK to whatever `--hub-config` points at (default = the LOCAL nats), so when the
 * network's hub is run by ANOTHER principal the seal silently lands on the wrong
 * server and the joiner's leaf is rejected with `Authorization Violation`.
 *
 * The CLI made that a two-party responsibility the principal had to remember
 * (`--hub-config`). A GOVERN button on the glass has no human-at-a-terminal to
 * remember it — so the FUTURE glass
 * deciders (FLG-6 seal, FLG-8 rotate-K, FLG-9 revoke — NOT built yet) MUST call
 * this guard and REFUSE a hub-half verb when this daemon is not the hub, or MC
 * reintroduces the exact same class FROM THE GLASS (invariant 7).
 *
 * ## What it does (and does not) decide
 *
 * This is a PURE, synchronous decision over two already-resolved inputs:
 *
 *   1. the **registry network descriptor** (`hub_url` + `leaf_port`, DD-12) — the
 *      AUTHORITATIVE location of the network's hub, signature-verified upstream
 *      (DD-9); the caller MUST pass a verified descriptor (see residual risks).
 *   2. this daemon's **self-declared hub identity** — a POSITIVE, per-network
 *      declaration resolved from the daemon's own (trusted, local) config by an
 *      adapter (the {@link LocalHubIdentityResolver} seam; the production adapter
 *      is FLG-6/8/9 wiring, deliberately NOT built here).
 *
 * The daemon is the hub for network N iff it POSITIVELY declares it hosts N's hub
 * AND that declared endpoint MATCHES the registry descriptor's hub location. Any
 * other state — no declaration, a declaration that disagrees with the registry, or
 * an input that cannot be parsed — is a DENY.
 *
 * It decides LOCALITY (authorization to run the hub-half op here), NOT LIVENESS:
 * it does not prove the local nats-server is up or actually bound — the downstream
 * conf-write / SIGHUP (`hub-reload-target.ts`) already fails loud if it isn't.
 *
 * ## Fail-closed is the whole point
 *
 * If hub-locality cannot be determined — a missing/malformed descriptor, a
 * malformed declared endpoint, no resolver output — the result is DENY
 * (`code: "indeterminate"`). An indeterminate result must NEVER authorize a
 * hub-half op. In particular an empty/garbage endpoint on EITHER side can never
 * "match" (each side is validated before comparison, so `"" === ""` is caught as
 * indeterminate, never as a hub match).
 *
 * ## Pattern provenance (mirrors, does not reinvent)
 *
 * The shape follows the #1240/#1317 seal-only work rather than inventing a new
 * one: the discriminated-union result + fail-LOUD-never-mis-act philosophy of
 * `src/common/nats/hub-reload-target.ts` (`resolveHubReloadTarget` returns
 * `{ ok:false; reason }` rather than signalling a wrong server), and the
 * pure-core-over-an-injected-port seam of `network-secret-lib.ts` /
 * `network-secret-ports.ts` (I/O in the adapter, the decision pure and directly
 * unit-testable). The 403 denial shape mirrors the `AdmissionDecider` failure
 * convention in `src/surface/mc/api/networks-admission.ts`
 * (`{ ok:false; reason; detail }` → `failureStatus` → 403) so the FLG deciders
 * emit hub-locality refusals the same way they emit admission refusals.
 */

import type { NetworkDescriptor } from "../../../common/registry/types";

/**
 * A normalized leaf-node hub endpoint. `host` is lowercased + trailing-dot
 * stripped so registry and config values compare canonically; `port` is a valid
 * TCP port (1..65535). Comparison is on this normalized pair only.
 */
export interface HubEndpoint {
  host: string;
  port: number;
}

/**
 * This daemon's self-declared hub role, resolved from the daemon's OWN (trusted,
 * local) config by the caller. Network-keyed and POSITIVE: an entry exists for
 * network N iff the config deliberately declares this daemon hosts N's hub, and
 * carries the endpoint it advertises for N.
 *
 * Fail-closed by construction: a network ABSENT from `hubbedNetworks` is one this
 * daemon does not hub (the common member case) → deny. An `undefined`
 * {@link LocalHubIdentity} (no hub role at all) is the strongest deny.
 */
export interface LocalHubIdentity {
  /** networkId → the hub endpoint this daemon advertises as that network's hub. */
  hubbedNetworks: Record<string, HubEndpoint>;
}

/**
 * The resolver seam (the ports pattern). The production adapter reads the daemon's
 * config to build the {@link LocalHubIdentity}; tests inject a fake. Kept as an
 * interface here so FLG-6/8/9 can wire a real adapter without this pure lib ever
 * touching config I/O. **Intentionally NOT implemented in this slice** — building
 * the config-reading adapter belongs with the deciders that consume it, and the
 * resolver contract is load-bearing (see residual risks in the module doc / PR).
 *
 * Contract for any production resolver: declare a network as hubbed ONLY on an
 * explicit config hub declaration, and advertise the host VERBATIM as declared —
 * never substitute a machine hostname for a `0.0.0.0`/`localhost` listen, or the
 * cross-check against the registry is defeated.
 */
export interface LocalHubIdentityResolver {
  resolve(): LocalHubIdentity | undefined;
}

/** Why a hub-half op is refused. Each maps to an honest 403. */
export type HubLocalityDenyCode =
  /** This daemon does not host this network's hub (member, or no hub role). */
  | "not-hub"
  /** Declared hub endpoint disagrees with the registry — the wrong-hub-seal class. */
  | "hub-endpoint-drift"
  /** An input was missing/unparseable — fail-closed deny (never authorize). */
  | "indeterminate";

/** The guard's verdict. `isHub:true` alone authorizes a hub-half op. */
export type HubLocalityResult =
  | { isHub: true; endpoint: HubEndpoint }
  | { isHub: false; code: HubLocalityDenyCode; reason: string };

/** Result of parsing/normalizing an endpoint. Non-throwing (keeps the core pure). */
export type ParsedEndpoint =
  | { ok: true; endpoint: HubEndpoint }
  | { ok: false; reason: string };

/**
 * Parse a `hub_url` (+ its `leaf_port` fallback) into a normalized
 * {@link HubEndpoint}. Mirrors `leaf-remote-renderer.ts:resolveLeafUrl` (scheme
 * optional; the URL's own port wins, else `leaf_port` is authoritative) but
 * NON-THROWING and returning host+port rather than a dial URL.
 *
 * Fails (never authorizes) on: empty/whitespace url, unparseable url, empty host,
 * or a missing url-port with an invalid `leaf_port`.
 */
export function parseHubEndpoint(hubUrl: string, leafPort: number): ParsedEndpoint {
  if (typeof hubUrl !== "string") {
    return { ok: false, reason: "hub_url is not a string" };
  }
  const raw = hubUrl.trim();
  if (raw.length === 0) {
    return { ok: false, reason: "hub_url is empty" };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `tls://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: `unparseable hub_url ${JSON.stringify(hubUrl)}` };
  }

  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) {
    return { ok: false, reason: `hub_url ${JSON.stringify(hubUrl)} has no host` };
  }

  let port: number;
  if (parsed.port.length > 0) {
    // URL carries an explicit port — it wins over leaf_port.
    port = Number(parsed.port);
  } else {
    port = leafPort;
  }
  if (!isValidPort(port)) {
    return {
      ok: false,
      reason:
        parsed.port.length > 0
          ? `hub_url ${JSON.stringify(hubUrl)} has an invalid port ${JSON.stringify(parsed.port)}`
          : `hub_url ${JSON.stringify(hubUrl)} has no port and leaf_port ${String(leafPort)} is invalid`,
    };
  }

  return { ok: true, endpoint: { host, port } };
}

/**
 * Validate + normalize a caller-supplied {@link HubEndpoint} (the declared side).
 * Defends the comparison against a resolver that hands back a garbage endpoint:
 * an empty host or an out-of-range port normalizes to a DENY, so it can never
 * spuriously equal the registry side.
 */
function normalizeDeclared(endpoint: unknown): ParsedEndpoint {
  // `unknown` on purpose: this value crosses the resolver seam from a config
  // adapter, so it is validated as untrusted data even though its static type is
  // HubEndpoint. Garbage (null, missing host, bad port) normalizes to a DENY.
  if (endpoint === null || typeof endpoint !== "object") {
    return { ok: false, reason: "declared hub endpoint is not an object" };
  }
  const ep = endpoint as Partial<HubEndpoint>;
  const host = normalizeHost(ep.host);
  if (host.length === 0) {
    return { ok: false, reason: "declared hub endpoint has an empty host" };
  }
  if (!isValidPort(ep.port)) {
    return { ok: false, reason: `declared hub endpoint has an invalid port ${String(ep.port)}` };
  }
  return { ok: true, endpoint: { host, port: ep.port } };
}

function normalizeHost(host: unknown): string {
  if (typeof host !== "string") return "";
  // Lowercase (host comparison is case-insensitive) + strip a single trailing
  // dot (FQDN root) so `hub.example.` and `hub.example` compare equal. NOTE:
  // comparison is on the LITERAL host — we deliberately do NOT resolve DNS or
  // alias `localhost`↔`127.0.0.1`. Distinct spellings therefore DENY, which is
  // the fail-closed direction (never silently treat a local bind as a public hub).
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * The core decision. PURE and total (never throws — an un-decidable input returns
 * an `indeterminate` DENY).
 *
 * Order matters and is all fail-closed:
 *   1. Parse the REGISTRY descriptor (authoritative hub location). Bad ⇒ indeterminate.
 *   2. No hub role / not declared for this network ⇒ not-hub.
 *   3. Re-validate the DECLARED endpoint. Malformed ⇒ indeterminate.
 *   4. Cross-check declared == registry. Mismatch ⇒ hub-endpoint-drift.
 *   5. Only a positive, agreeing declaration ⇒ isHub.
 */
export function evaluateHubLocality(
  descriptor: Pick<NetworkDescriptor, "network_id" | "hub_url" | "leaf_port">,
  local: LocalHubIdentity | undefined,
): HubLocalityResult {
  const networkId = descriptor.network_id;

  // 1. The registry descriptor is the authoritative hub location (DD-12).
  const want = parseHubEndpoint(descriptor.hub_url, descriptor.leaf_port);
  if (!want.ok) {
    return {
      isHub: false,
      code: "indeterminate",
      reason: `registry descriptor for network "${networkId}" has an unusable hub location: ${want.reason}`,
    };
  }

  // 2. Does this daemon POSITIVELY declare it hosts this network's hub?
  if (local === undefined) {
    return {
      isHub: false,
      code: "not-hub",
      reason: `this daemon declares no hub role — it is not the hub for network "${networkId}"`,
    };
  }
  const declared = local.hubbedNetworks[networkId];
  if (declared === undefined) {
    return {
      isHub: false,
      code: "not-hub",
      reason: `this daemon does not host the hub for network "${networkId}"`,
    };
  }

  // 3. The declared endpoint must itself be well-formed (guards resolver garbage).
  const have = normalizeDeclared(declared);
  if (!have.ok) {
    return {
      isHub: false,
      code: "indeterminate",
      reason: `this daemon's declared hub endpoint for network "${networkId}" is malformed: ${have.reason}`,
    };
  }

  // 4. Cross-check the local belief against the registry (the anti-wrong-hub-seal
  //    check). A mismatch is the 2026-07-04 class: this daemon thinks it hubs the
  //    network, but the registry says the hub lives elsewhere — refuse rather than
  //    seal to the wrong machine.
  if (have.endpoint.host !== want.endpoint.host || have.endpoint.port !== want.endpoint.port) {
    return {
      isHub: false,
      code: "hub-endpoint-drift",
      reason:
        `this daemon declares it hosts network "${networkId}" at ` +
        `${have.endpoint.host}:${String(have.endpoint.port)}, but the registry descriptor ` +
        `places the hub at ${want.endpoint.host}:${String(want.endpoint.port)} — ` +
        `refusing the hub-half op (it would target the wrong server)`,
    };
  }

  // 5. Positive declaration that agrees with the registry ⇒ this daemon is the hub.
  return { isHub: true, endpoint: want.endpoint };
}

/**
 * An honest 403 for a hub-locality refusal. Mirrors the `AdmissionDecider`
 * failure convention (`{ error, detail }` at a mapped status) so a decider can
 * return it the same way it returns an admission refusal.
 */
export interface HubLocalityDenial {
  status: 403;
  error: "not_the_hub";
  code: HubLocalityDenyCode;
  /** The network the refused hub-half op targeted — carried for the invariant-18 audit record. */
  network: string;
  detail: string;
}

/**
 * The helper the deciders use: turn a {@link HubLocalityResult} into a 403 denial,
 * or `null` when the daemon IS the hub (no denial — proceed). Deciders call this
 * and, on a non-null return, emit the 403 without executing the hub-half op.
 */
export function hubLocalityDenial(
  networkId: string,
  result: HubLocalityResult,
): HubLocalityDenial | null {
  if (result.isHub) return null;
  return buildDenial(networkId, result.code, result.reason);
}

/** The single source of truth for the 403 denial shape (no nullable to assert away). */
function buildDenial(
  networkId: string,
  code: HubLocalityDenyCode,
  detail: string,
): HubLocalityDenial {
  return { status: 403, error: "not_the_hub", code, network: networkId, detail };
}

/**
 * One-call convenience for a decider: evaluate locality and return either the
 * green-light endpoint or the ready-to-emit 403 denial. Fail-closed: anything
 * that is not a positive, agreeing hub declaration comes back as `authorized:false`.
 */
export function guardHubLocality(
  descriptor: Pick<NetworkDescriptor, "network_id" | "hub_url" | "leaf_port">,
  local: LocalHubIdentity | undefined,
):
  | { authorized: true; endpoint: HubEndpoint }
  | { authorized: false; denial: HubLocalityDenial } {
  const result = evaluateHubLocality(descriptor, local);
  if (result.isHub) {
    return { authorized: true, endpoint: result.endpoint };
  }
  return {
    authorized: false,
    denial: buildDenial(descriptor.network_id, result.code, result.reason),
  };
}
