/**
 * `cortex network doctor` — PURE orchestration (cortex#1484, epic #1479).
 *
 * Verifies the WHOLE federation path from the joining member's own machine —
 * config → local monitor → leaf established → leaf account binding → a real
 * echoed round-trip per configured peer — and reports pass/fail/warn/skip +
 * a fix + the responsible role, PER LEG. On a working link every leg is
 * green, including the peer's echo reply; on a broken one it pinpoints the
 * failing leg + who owns fixing it.
 *
 * Pure over {@link NetworkDoctorPorts}: no fs, no NATS, no HTTP here — the
 * live adapters (`network-doctor-adapters.ts`) wire those; tests inject
 * fakes. READ-ONLY except for the ONE bounded probe echo per peer (the
 * SAME transport `cortex network ping` uses — `pingPeer`/`derivePingInputs`
 * are the SAME functions, not re-implemented — so the peer-reachable leg
 * reuses `ping`'s exact probe transport, called with count:1 and doctor's own
 * timeout and re-mapped to a DoctorCheck).
 *
 * Later checks `skip` when a hard prerequisite failed (spec's check matrix):
 *   1. config-network              — the network is configured, has peers + accept_subjects
 *   2. registered-vs-fed-account   — cortex#1482 Pair 1 (informational — legit divergence, never fails)
 *   3. resolver-preload-account    — cortex#1482 Pair 2 (fails on a real preload mismatch)
 *   4. sealed-secret-hub-authorized — cortex#1482 Pair 3 (documented stub — always skip)
 *   5. monitor-reachable           — the local nats-server HTTP monitor answers `/leafz`
 *   6. leaf-established            — `/leafz` shows an established leaf for this network
 *   7. leaf-account-bound          — the established leaf's account matches config (best-effort)
 *   8. peer-reachable:<p>          — one check per configured peer, a real echo round-trip
 *
 * Legs 2-4 (cortex#1482, epic #1479, join-3) surface the THREE representation
 * pairs that nothing checked before: (1) registered/PoP pubkey ⟷ FED account
 * (these can LEGITIMATELY differ — seal-target ≠ leaf-account, ADR-0018 — so
 * this leg is informational, never a `fail`); (2) local `resolver_preload`
 * accounts ⟷ leaf remote `account:` (a REAL mismatch here is a boot/auth
 * failure waiting to happen — this leg DOES fail); (3) registry sealed-secret
 * ⟷ hub authorization (needs hub-side visibility this command doesn't have —
 * a documented stub, not a fabricated check). They are STATIC/config-only
 * (no live NATS needed), so they run right after config-network and degrade
 * gracefully (warn/skip) rather than block downstream legs.
 */

import type { Envelope } from "../../../bus/myelin/envelope-validator";
import {
  evaluateFederationGate,
  type FederationGateDecision,
} from "../../../bus/surface-router";
import type { LoadedConfig } from "../../../common/config/loader";
import { stackSlugFromStackId } from "../../../common/stack-id";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import { samePubkey } from "../../../common/registry/pubkey-normalize";
import {
  derivePingInputs,
  pingPeer,
  type PingResult,
} from "./network-ping-lib";
import type {
  DoctorConfigPort,
  LeafzEntry,
  LeafzResponse,
  NetworkDoctorPorts,
  PeerHearingPorts,
} from "./network-doctor-ports";

// ---------------------------------------------------------------------------
// Check taxonomy
// ---------------------------------------------------------------------------

export type DoctorCheckStatus = "pass" | "fail" | "warn" | "skip";
export type DoctorCheckOwner = "member" | "hub-owner" | "admin" | "peer";

/** One leg of the doctor report — pass/fail/warn/skip + a fix + the owner. */
export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  detail: string;
  /** Actionable remediation. Present on `fail`/`warn`; omitted on `pass`/`skip`. */
  fix?: string;
  owner: DoctorCheckOwner;
}

export type DoctorVerdict = "healthy" | "degraded" | "broken";

/** Exit-code taxonomy (mirrors `ping`'s VERDICT_EXIT_CODE convention). */
export const DOCTOR_EXIT_CODE: Record<DoctorVerdict, number> = {
  healthy: 0,
  degraded: 1,
  broken: 2,
};

/** Checks whose failure means the federation path is fundamentally down for
 *  this network (not just degraded) — a hard prerequisite for everything after it. */
const CRITICAL_CHECK_IDS = new Set(["config-network", "leaf-established"]);

/** Default per-probe echo wait budget (ms) for the peer-reachable leg. */
export const DEFAULT_DOCTOR_PROBE_TIMEOUT_MS = 6000;

/**
 * cortex#1482 — id + title for the three representation-pair legs, in ONE
 * place so the check bodies and the config-network-failed skip path can never
 * drift apart (Sage review, nit 4).
 */
const PAIR_LEGS = {
  registeredVsFedAccount: {
    id: "registered-vs-fed-account",
    title: "registered pubkey vs FED account (Pair 1)",
  },
  resolverPreloadAccount: {
    id: "resolver-preload-account",
    title: "leaf account preloaded on this bus (Pair 2)",
  },
  sealedSecretHubAuthorized: {
    id: "sealed-secret-hub-authorized",
    title: "registry sealed-secret ⟷ hub authorization (Pair 3)",
  },
} as const;

export interface DoctorOptions {
  /** The already-loaded LOCAL stack config — the #753 seam. Supplies
   *  principal/stack/assistant for deriving each peer-reachable probe's
   *  inputs (the SAME `derivePingInputs` `ping` uses). */
  cfg: LoadedConfig;
  /** The network to doctor. */
  networkId: string;
  /** Per-probe echo wait budget (ms), overridable; defaults to
   *  {@link DEFAULT_DOCTOR_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
}

export interface DoctorRunResult {
  checks: DoctorCheck[];
  verdict: DoctorVerdict;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function check(
  id: string,
  title: string,
  status: DoctorCheckStatus,
  detail: string,
  owner: DoctorCheckOwner,
  fix?: string,
): DoctorCheck {
  return { id, title, status, detail, owner, ...(fix !== undefined && { fix }) };
}

function skipCheck(id: string, title: string, detail: string, owner: DoctorCheckOwner): DoctorCheck {
  return check(id, title, "skip", detail, owner);
}

/** Truncate a pubkey for display in a check detail (never the full key —
 *  these legs deal in PUBLIC keys, so truncation is for READABILITY, not
 *  secrecy). */
function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 12)}…`;
}

// ---------------------------------------------------------------------------
// Leg 1 — config-network
// ---------------------------------------------------------------------------

function checkConfigNetwork(
  config: DoctorConfigPort,
  networkId: string,
): { result: DoctorCheck; network?: PolicyFederatedNetwork } {
  const snapshot = config.readNetworks();
  const network = snapshot.networks.find((n) => n.id === networkId);
  const id = "config-network";
  const title = `network "${networkId}" configured`;

  if (network === undefined) {
    return {
      result: check(
        id,
        title,
        "fail",
        `network "${networkId}" is not present in policy.federated.networks[]`,
        "member",
        `join the network (\`cortex network join ${networkId}\`) or pass the correct --config/--stack`,
      ),
    };
  }
  if (network.peers.length === 0) {
    return {
      result: check(
        id,
        title,
        "fail",
        `network "${networkId}" has no peers[] configured`,
        "member",
        "add at least one peer to policy.federated.networks[].peers[] (re-join, or ask the hub owner for the roster)",
      ),
      network,
    };
  }
  if (network.accept_subjects.length === 0) {
    return {
      result: check(
        id,
        title,
        "fail",
        `network "${networkId}" has an empty accept_subjects[] — inbound federated envelopes will be rejected`,
        "member",
        "set policy.federated.networks[].accept_subjects[] (re-join to re-derive it)",
      ),
      network,
    };
  }
  return {
    result: check(
      id,
      title,
      "pass",
      `${network.peers.length.toString()} peer(s), ${network.accept_subjects.length.toString()} accept_subjects`,
      "member",
    ),
    network,
  };
}

// ---------------------------------------------------------------------------
// Leg 1.4 — leafnode-authorization crash bomb (cortex#1728 Guard 1)
// ---------------------------------------------------------------------------

/**
 * cortex#1728 Guard 1 (doctor leg) — flag the armed F4 crash bomb: an
 * operator-mode `leafnodes { authorization { users … } }` block in the resolved
 * local nats config. This is the ONLY pre-restart signal a member gets — the
 * block is startup-fatal on the next restart and `nats-server -t` passes it. A
 * clean/non-operator-mode config yields no bomb → `pass`. Static/config-only, so
 * it runs early and gates nothing downstream.
 */
function checkLeafnodeAuthorizationBomb(config: DoctorConfigPort): DoctorCheck {
  const id = "leafnode-authorization-bomb";
  const title = "no operator-mode leafnode authorization block (crash bomb)";
  const bombs = config.scanLeafnodeAuthorizationBomb();
  if (bombs.length === 0) {
    return check(id, title, "pass", "no operator-mode-fatal leafnode authorization block found", "member");
  }
  const first = bombs[0];
  return check(
    id,
    title,
    "fail",
    `the resolved nats config carries an operator-mode-FATAL \`leafnodes { authorization { users … } }\` ` +
      `block in ${bombs.map((b) => b.path).join(", ")} — it crashes nats-server on the NEXT restart ` +
      `("operator-mode does not allow specifying users in leafnode config") and \`nats-server -t\` does ` +
      `NOT catch it (cortex#1728/#1491)`,
    "member",
    first?.fix ?? "remove the leafnodes authorization block from the operator-mode nats config",
  );
}

// ---------------------------------------------------------------------------
// Leg 1.5 — registered-vs-fed-account (cortex#1482, Pair 1 — informational)
// ---------------------------------------------------------------------------

/**
 * cortex#1482 Pair 1 — surface the stack's registered/PoP pubkey ALONGSIDE
 * this network's FED account so whoever runs `cortex network doctor` can see,
 * at a glance, that they are (correctly) two DIFFERENT keys — seal-target ≠
 * leaf-account, ADR-0018.
 * Divergence is the EXPECTED, healthy state, so this leg NEVER fails; the
 * worst outcome is `warn` (can't determine one side yet, or — a real red
 * flag — the two are the SAME key material, which would mean the account was
 * provisioned by reusing the registered identity key).
 *
 * Representation handling (what this leg ACTUALLY does — no conversion):
 *   - DISPLAY: each key is shown AS-STORED, via a 12-char prefix
 *     ({@link shortKey}). Whatever encoding the config carries (the
 *     registered pubkey is typically base64; the FED account a `U…`/`A…`
 *     nkey) is what you see — this leg does NOT convert base64↔nkey for
 *     display.
 *   - COMPARISON: {@link samePubkey} decodes BOTH sides to their raw 32
 *     ed25519 bytes and compares those, so it is representation- AND
 *     role-agnostic — a base64 pubkey and an nkey of the same underlying key
 *     compare EQUAL without either being re-encoded here.
 */
function checkRegisteredVsFedAccount(
  config: DoctorConfigPort,
  networkId: string,
  registeredPubkey: string | undefined,
): DoctorCheck {
  const { id, title } = PAIR_LEGS.registeredVsFedAccount;

  if (registeredPubkey === undefined) {
    return skipCheck(
      id,
      title,
      "skipped — no registered/PoP pubkey on this stack's config (stack.nkey_pub)",
      "member",
    );
  }
  const fedAccount = config.expectedFedAccount(networkId);
  if (fedAccount === undefined) {
    return check(
      id,
      title,
      "warn",
      `registered pubkey ${shortKey(registeredPubkey)} — FED account not derivable yet (no rendered leaf include; join first)`,
      "member",
    );
  }
  if (samePubkey(registeredPubkey, fedAccount)) {
    return check(
      id,
      title,
      "warn",
      `registered pubkey and FED account decode to the SAME key material (${shortKey(registeredPubkey)}) — ` +
        `these should be TWO DIFFERENT keys (seal-target ≠ leaf-account, ADR-0018); double-check the account ` +
        `wasn't provisioned by reusing the registered identity key`,
      "admin",
      "provision a DEDICATED federation account for this stack rather than reusing the registered identity key",
    );
  }
  return check(
    id,
    title,
    "pass",
    `registered pubkey ${shortKey(registeredPubkey)} and FED account ${shortKey(fedAccount)} are different keys, as expected (seal-target ≠ leaf-account, ADR-0018)`,
    "member",
  );
}

// ---------------------------------------------------------------------------
// Leg 1.6 — resolver-preload-account (cortex#1482, Pair 2)
// ---------------------------------------------------------------------------

/**
 * cortex#1482 Pair 2 — the leaf remote binds an account that MUST be present
 * in this bus's OWN `resolver_preload { … }`, or the bus can't authenticate
 * the leaf at boot. Unlike Pair 1, a real mismatch here IS a failure — it is
 * exactly the class of bug that otherwise only surfaces as a cryptic
 * Authorization Violation at boot/reload time.
 */
function checkResolverPreloadAccount(
  config: DoctorConfigPort,
  fedAccount: string | undefined,
): DoctorCheck {
  const { id, title } = PAIR_LEGS.resolverPreloadAccount;

  if (fedAccount === undefined) {
    return skipCheck(
      id,
      title,
      "skipped — no FED account derivable for this network yet (see registered-vs-fed-account / join first)",
      "member",
    );
  }
  const present = config.resolverPreloadHasAccount(fedAccount);
  if (present === undefined) {
    return check(
      id,
      title,
      "warn",
      `could not read this bus's resolver_preload (no local nats config found, or the bus declares no ` +
        `resolver_preload block at all — expected for a non-operator-mode bus) — cannot verify account ` +
        `${shortKey(fedAccount)} is preloaded`,
      "member",
    );
  }
  if (!present) {
    return check(
      id,
      title,
      "fail",
      `leaf remote binds account ${shortKey(fedAccount)} but this bus's resolver_preload does NOT declare ` +
        `it — the bus cannot authenticate this leaf (boot/auth failure)`,
      "member",
      `add account "${fedAccount}" to this bus's resolver_preload (arc nats export-account / cortex network ` +
        `make-live) and restart the bus — a SIGHUP reload does not pick up resolver_preload changes`,
    );
  }
  return check(id, title, "pass", `account ${shortKey(fedAccount)} is preloaded on this bus`, "member");
}

// ---------------------------------------------------------------------------
// Leg 1.7 — sealed-secret-hub-authorized (cortex#1482, Pair 3 — stub)
// ---------------------------------------------------------------------------

/**
 * cortex#1482 Pair 3 — is the sealed leaf PSK on the registry's admission row
 * ACTUALLY authorized (an `authorization` user) on the hub? This is a
 * genuinely hub-side question this command cannot answer from the joining
 * member's own machine: the registry carries only an OPAQUE ciphertext
 * sealed to the member's pubkey (ADR-0018 Q1) — nobody but the member can
 * decrypt it, so there is no PSK to fingerprint-compare against the hub's
 * `authorization` entries from here, even on a local hub. A "does the hub
 * declare AN authorization user for this member" check would prove nothing
 * about whether the SEALED SECRET matches it, so implementing that partial
 * signal would be actively misleading (an outdated PSK still hits `pass`).
 * Rather than fabricate a check this command can't back, this leg documents
 * the gap: always `skip`, owner `hub-owner` (only they can verify it — e.g.
 * fingerprint-comparing the decrypted PSK against the hub's live
 * `authorization` users), with a fix pointing at the follow-up.
 */
function checkSealedSecretHubAuthorized(): DoctorCheck {
  return skipCheck(
    PAIR_LEGS.sealedSecretHubAuthorized.id,
    PAIR_LEGS.sealedSecretHubAuthorized.title,
    "not implemented from the member side — the registry holds only an opaque ciphertext sealed to the " +
      "member's own pubkey (ADR-0018 Q1), so there is no plaintext PSK here to compare against the hub's " +
      "authorization users. Verifying this pair needs HUB-SIDE visibility (the hub owner decrypting + " +
      "fingerprint-comparing against their own nats config) — tracked as a follow-up, not fabricated here.",
    "hub-owner",
  );
}

// ---------------------------------------------------------------------------
// Leg 2 — monitor-reachable
// ---------------------------------------------------------------------------

async function checkMonitorReachable(
  ports: NetworkDoctorPorts,
): Promise<{ result: DoctorCheck; leafz?: LeafzResponse }> {
  const id = "monitor-reachable";
  const title = "local NATS monitor reachable";
  const resolved = ports.monitor.resolve();

  // FS-5a (cortex#1814) — PROBE the resolved monitor even when it is the
  // unconfigured `DEFAULT_MONITOR_URL` fallback, so `doctor` reaches the SAME
  // verdict as `status`/C-797. `status`'s `buildLeafStatePort` always fetches
  // `resolveMonitorBase(cfg).url` — default `127.0.0.1:8222` included — and only
  // degrades to "unknown" on a genuine fetch failure; the pre-FS-5a doctor
  // instead SHORT-CIRCUITED to WARN on `!configured` and never probed, so a
  // HEALTHY leaf on a bus with no explicit monitor knob read `broken` (the leaf
  // legs skipped for want of `/leafz`). We now always attempt the probe.
  const leafz = await ports.monitor.fetchLeafz();
  if (leafz !== undefined) {
    return {
      result: check(id, title, "pass", `${resolved.url}/leafz responded`, "member"),
      leafz,
    };
  }

  // Probe failed. #831 — an UNCONFIGURED monitor (bus declares no
  // `--monitor-url` / `http_port` / `monitor_port`; we probed the upstream
  // default) is INCONCLUSIVE, not a failure: WARN and let the leaf legs skip
  // (they have no `/leafz`). This is the graceful path the FS-5a acceptance
  // demands — a genuinely-down monitor ⇒ WARN/unknown, never `broken`-by-default
  // and never a crash (the fetch catch already swallowed the error to
  // `undefined`).
  if (!resolved.configured) {
    return {
      result: check(
        id,
        title,
        "warn",
        `no monitor reachable for this bus (probed ${resolved.url}; no --monitor-url / http_port / monitor_port configured)`,
        "member",
        "enable http_port/monitor_port on the local bus for full leaf verification",
      ),
    };
  }

  // A CONFIGURED monitor (explicit flag or derived from the nats config) that
  // did not respond is a genuine FAIL — the principal asked for this monitor and
  // it is down.
  return {
    result: check(
      id,
      title,
      "fail",
      `monitor at ${resolved.url} did not respond to /leafz`,
      "member",
      "confirm the local nats-server is running and its monitor port is reachable",
    ),
  };
}

// ---------------------------------------------------------------------------
// Leg 3 — leaf-established
// ---------------------------------------------------------------------------

/**
 * How a `/leafz` entry was attributed to a network's `leaf_node`:
 *   - `named`         — a `name`/`account` match against the configured leaf_node;
 *   - `lone-fallback` — no name match, but the bus has exactly ONE leaf, so it
 *                       necessarily carries this network's traffic.
 */
export type LeafMatchKind = "named" | "lone-fallback";

export interface LeafMatch {
  leaf: LeafzEntry;
  match: LeafMatchKind;
}

/**
 * cortex#1728 (guard 4) — select the SINGLE `/leafz` entry attributable to a
 * network's `leaf_node`, or `undefined` when it cannot be uniquely identified.
 *
 * The leaves on a host share ip:port (they all dial the same hub) and the leaf
 * `account` is the field config famously disagrees with (guard 3), so the
 * ONLY reliable key is the rendered leaf-remote `name` cortex controls when it
 * writes `leafnodes-<network>.conf`. Match on `name` (or `account` as a
 * secondary), else fall back to the lone leaf on a single-leaf bus. On a
 * MULTI-leaf bus with no name match we return `undefined` — we must NEVER
 * attribute another network's leaf (e.g. summing community's heartbeat traffic
 * onto metafactory's dead egress would mask the exact break guard 4 exists to
 * catch, #1731 review BLOCK).
 *
 * PURE — the caller supplies the `/leafz` snapshot. Shared by `doctor`'s
 * leaf-established leg and the ping leafz sampler so both attribute identically.
 */
export function selectNetworkLeaf(
  leafz: LeafzResponse,
  leafNode: string,
): LeafMatch | undefined {
  const leafs = leafz.leafs ?? [];
  const named = leafs.find((l) => l.name === leafNode || l.account === leafNode);
  if (named !== undefined) return { leaf: named, match: "named" };
  // Single-leaf bus (the common creds-only case): one leaf carries every
  // network's federated traffic and `/leafz` often doesn't echo our configured
  // `leaf_node` name. We attribute the lone leaf to this network — but flag it
  // as an ASSUMPTION (not a name match), because with 2+ leaves we canNOT tell
  // which is this network's, so we do NOT fall back there (returns undefined).
  return leafs.length === 1 && leafs[0] !== undefined
    ? { leaf: leafs[0], match: "lone-fallback" }
    : undefined;
}

function findEstablishedLeaf(
  leafz: LeafzResponse,
  leafNode: string,
): LeafMatch | undefined {
  return selectNetworkLeaf(leafz, leafNode);
}

/**
 * cortex#1485 — the pure BOOLEAN form of the leaf-established leg, for reuse by
 * `cortex network handoff`'s leaf-up leg. `true` iff `/leafz` shows an
 * established leaf attributable to this network (a name/account match, or the
 * lone-leaf fallback on a single-leaf bus — the SAME attribution
 * {@link findEstablishedLeaf} applies for `doctor`'s leaf-established check).
 * `undefined` leafz (no monitor data) ⇒ `false` (not established). Pure — no
 * I/O; the caller supplies the `/leafz` snapshot.
 */
export function isLeafEstablished(
  leafz: LeafzResponse | undefined,
  network: PolicyFederatedNetwork,
): boolean {
  if (leafz === undefined) return false;
  return findEstablishedLeaf(leafz, network.leaf_node) !== undefined;
}

function checkLeafEstablished(
  leafz: LeafzResponse | undefined,
  network: PolicyFederatedNetwork,
): { result: DoctorCheck; established?: LeafzEntry } {
  const id = "leaf-established";
  const title = `leaf "${network.leaf_node}" established`;

  if (leafz === undefined) {
    return {
      result: skipCheck(id, title, "skipped — no /leafz data (see monitor-reachable)", "member"),
    };
  }
  const found = findEstablishedLeaf(leafz, network.leaf_node);
  if (found === undefined) {
    const seen = (leafz.leafs ?? []).map((l) => l.name ?? l.account ?? "?").join(", ");
    return {
      result: check(
        id,
        title,
        "fail",
        `no established leaf found for "${network.leaf_node}" in /leafz (leafs seen: ${seen === "" ? "none" : seen})`,
        "hub-owner",
        "leaf not up: creds/hub-authorization/hub-partition — check the legs below and the hub authorization",
      ),
    };
  }
  const { leaf: established, match } = found;
  const traffic = `in=${(established.in_msgs ?? 0).toString()}, out=${(established.out_msgs ?? 0).toString()}`;
  // A name/account match is a confident pass; a lone-leaf fallback is an
  // honest WARN — the leaf is up, but /leafz didn't confirm it's THIS
  // network's (it could belong to another network on a multi-leaf bus).
  if (match === "lone-fallback") {
    return {
      result: check(
        id,
        title,
        "warn",
        `assumed the sole leaf on this bus (name/account "${established.name ?? established.account ?? "?"}" did not match the configured leaf_node "${network.leaf_node}") — correct for a single-leaf bus, unverifiable if you run multiple leaves; ${traffic}`,
        "member",
        "if this bus carries multiple leaves, ensure the leaf name matches leaf_node so doctor can attribute it to this network",
      ),
      established,
    };
  }
  return {
    result: check(id, title, "pass", `established (${traffic})`, "hub-owner"),
    established,
  };
}

// ---------------------------------------------------------------------------
// Leg 4 — leaf-account-bound
// ---------------------------------------------------------------------------

function checkLeafAccountBound(
  config: DoctorConfigPort,
  networkId: string,
  established: LeafzEntry | undefined,
): DoctorCheck {
  const id = "leaf-account-bound";
  const title = "leaf account binding";

  if (established === undefined) {
    return skipCheck(id, title, "skipped — no established leaf (see leaf-established)", "member");
  }
  const expected = config.expectedFedAccount(networkId);
  const actual = established.account;
  if (expected === undefined) {
    return check(
      id,
      title,
      "warn",
      `leaf reports account "${actual ?? "(none)"}" — could not derive the EXPECTED account from config to verify (no rendered leaf-include account: line found)`,
      "member",
    );
  }
  if (actual !== expected) {
    return check(
      id,
      title,
      "fail",
      `leaf is bound to account "${actual ?? "(none)"}" but config expects "${expected}"`,
      "member",
      "re-render the leaf include (rejoin) or fix the stack's operator-mode account config",
    );
  }
  return check(id, title, "pass", `leaf bound to expected account "${expected}"`, "member");
}

// ---------------------------------------------------------------------------
// Leg 5 — peer-reachable (one per configured peer)
// ---------------------------------------------------------------------------

function peerCheckFromPingResult(label: string, pr: PingResult): DoctorCheck {
  const id = `peer-reachable:${label}`;
  const title = `peer reachable: ${label}`;
  switch (pr.verdict) {
    case "reachable": {
      const rtt = pr.stats.rttAvgMs !== undefined ? `${pr.stats.rttAvgMs.toFixed(0)}ms` : "?ms";
      return check(id, title, "pass", `echo round-trip ok, rtt=${rtt}`, "peer");
    }
    case "timeout": {
      // cortex#1728 (guard 4) — when the local `/leafz` counter delta localised
      // the timeout to a half, fold it into the detail + remediation so doctor
      // points at the broken leg instead of the undifferentiated peer/hub guess.
      const detail =
        pr.leafz !== undefined
          ? `${pr.detail ?? `no echo from ${label} within the probe timeout`} — ${pr.leafz.line}`
          : (pr.detail ?? `no echo from ${label} within the probe timeout`);
      const remediation =
        pr.leafz?.half === "remote"
          ? "peer/echo leg — probes crossed OUR leaf but no echo returned; the failure is on the peer side (their responder/leaf). Check the peer's own `cortex network doctor`"
          : pr.leafz?.half === "local-egress"
            ? "local egress — no probes left OUR leaf; the failure is on OUR side (leaf account/binding, not the peer). Check `leaf-account-bound` above and our leaf remote"
            : "peer/hub — peer offline, its leaf is down, or the hub is partitioned; check the peer's own `cortex network doctor` and the hub authorization";
      return check(id, title, "fail", detail, "peer", remediation);
    }
    case "no-responder":
      return check(
        id,
        title,
        "fail",
        pr.detail ?? `${label} routed the probe but did not echo a conformant reply`,
        "peer",
        "the peer's probe-responder is absent or too old — ask them to upgrade/restart their cortex daemon",
      );
    case "refused":
      return check(
        id,
        title,
        "fail",
        pr.detail ?? `${label} refused the probe`,
        "peer",
        "peer gate — the peer's signing posture rejected us; confirm we're in their peers[] / enforce-posture allowlist",
      );
    case "not-configured":
      return check(
        id,
        title,
        "fail",
        pr.detail ?? `no leaf route to ${label}`,
        "member",
        "member roster — check OUR policy.federated.networks[].peers[] and leaf link; the route to this peer isn't resolvable from here",
      );
  }
}

async function checkPeerReachable(
  ports: NetworkDoctorPorts,
  opts: DoctorOptions,
  peer: PolicyFederatedNetwork["peers"][number],
): Promise<DoctorCheck> {
  const targetStack = stackSlugFromStackId(peer.stack_id);
  const label = `${peer.principal_id}/${targetStack}`;
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_DOCTOR_PROBE_TIMEOUT_MS;

  const derived = derivePingInputs({
    cfg: opts.cfg,
    targetPrincipal: peer.principal_id,
    targetStack,
    network: opts.networkId,
    count: 1,
    timeoutMs,
  });
  if (!derived.ok || derived.inputs === undefined) {
    return check(
      `peer-reachable:${label}`,
      `peer reachable: ${label}`,
      "fail",
      derived.reason ?? "could not derive probe inputs",
      "member",
      "check --principal / cortex.yaml principal.id",
    );
  }

  const pr = await pingPeer(derived.inputs, ports.probe);
  return peerCheckFromPingResult(label, pr);
}

// ---------------------------------------------------------------------------
// Leg 5b — per-peer "can I hear X?" staged chain (FS-5b, cortex#1842)
// ---------------------------------------------------------------------------

/**
 * FS-5b (cortex#1842) — decompose the one-directional presence path (X → me)
 * into FIVE ordered stages so the FIRST failing stage names WHERE the break is,
 * instead of a broken fold looking identical to a broken cred:
 *
 *   1. cred-perms          — my leaf cred's allow-sub permits X's scope?
 *   2. import              — the live leaf is actually subscribed to X's scope?
 *   3. envelopes-arriving  — X's presence physically reaches my bus? (the ONE
 *                            bounded live subscribe per peer — see the seam note)
 *   4. gate                — evaluateFederationGate ACCEPTS an envelope from X?
 *   5. fold                — X's presence actually folds onto the roster?
 *
 * ## Stage-3 transport seam (option a — live bounded subscribe)
 *
 * envelopes-arriving PREFERS a live bounded subscribe on
 * `federated.{X.principal}.{X.stack}.agent.>` for `probeTimeoutMs`, reusing the
 * SAME runtime transport `ping`'s probe rides (`wrapRuntimeAsPresenceListener`,
 * network-ping-adapters.ts) — self-contained (no daemon dependency), matching
 * the doctor's read-only + one-probe-per-peer contract. The rejected
 * alternative (option b) — querying a running daemon's
 * `FederatedPresenceReceipts.everReceived(X)` via an MC endpoint — is more
 * faithful to what the daemon actually heard but couples the CLI to a live
 * daemon + a new read endpoint; option a keeps the doctor standalone. The
 * `undefined` (no-runtime) path degrades to `warn`, never a false `fail`.
 *
 * ## Chain semantics
 *
 * A stage FAIL stops the chain — every later stage is `skip` (running a probe a
 * broken prerequisite can't support is noise; the first failing stage IS the
 * diagnosis). A `warn` (undeterminable, e.g. `hearing` port absent) does NOT
 * stop the chain. The `gate` stage is computed PURELY (no injected port) via the
 * real {@link evaluateFederationGate}; the other four ride {@link PeerHearingPorts}.
 */
type HearingStage =
  | "cred-perms"
  | "import"
  | "envelopes-arriving"
  | "gate"
  | "fold";

function hearingCheckId(stage: HearingStage, label: string): string {
  return `peer-hearing:${stage}:${label}`;
}

function hearingTitle(stage: HearingStage, label: string): string {
  return `can I hear ${label}? — ${stage}`;
}

/**
 * The gate stage, computed PURELY by calling the REAL
 * {@link evaluateFederationGate} against a representative presence envelope from
 * peer X — the doctor exercises the exact accept-list/deny/hop logic the live
 * federated subscriber runs (reuse, not reinvent).
 *
 * `sourceLink` is deliberately left undefined: the anti-spoof cross-check is a
 * LIVE delivering-link property, not a config one — supplying a synthetic link
 * would test something other than "would my posture accept X's presence". The
 * gate skips that check when `sourceLink` is undefined, matching an
 * un-attributed / primary-routed inbound.
 */
function evaluatePeerPresenceGate(
  ports: NetworkDoctorPorts,
  targetPrincipal: string,
  targetStack: string,
): FederationGateDecision {
  const networksById = new Map<string, PolicyFederatedNetwork>();
  for (const n of ports.config.readNetworks().networks) networksById.set(n.id, n);

  const subject = `federated.${targetPrincipal}.${targetStack}.agent.presence`;
  const envelope: Envelope = {
    id: "00000000-0000-4000-8000-000000000000",
    // `source` leads with the SOURCE PRINCIPAL — the gate resolves the source
    // network from `principalFromEnvelope(envelope)` (the first `source` segment).
    source: `${targetPrincipal}.${targetStack}.presence`,
    type: "agent.presence.online",
    timestamp: "1970-01-01T00:00:00.000Z",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {},
  };
  return evaluateFederationGate(subject, envelope, networksById);
}

/**
 * Run the five-stage "can I hear X?" chain for ONE configured peer, returning
 * one {@link DoctorCheck} per stage (owner `"peer"`), in order. Read-only apart
 * from the ONE bounded presence subscribe (stage 3), matching Leg 5's contract.
 */
async function checkPeerHearing(
  ports: NetworkDoctorPorts,
  opts: DoctorOptions,
  network: PolicyFederatedNetwork,
  peer: PolicyFederatedNetwork["peers"][number],
): Promise<DoctorCheck[]> {
  const targetStack = stackSlugFromStackId(peer.stack_id);
  const label = `${peer.principal_id}/${targetStack}`;
  const scope = `federated.${peer.principal_id}.${targetStack}.>`;
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_DOCTOR_PROBE_TIMEOUT_MS;
  const hearing: PeerHearingPorts | undefined = ports.hearing;

  const results: DoctorCheck[] = [];
  // Once a stage FAILS, every later stage is `skip` — the first failing stage
  // names the break. A `warn` (undeterminable) does NOT stop the chain.
  let brokenBy: HearingStage | undefined;

  const hc = (
    stage: HearingStage,
    status: DoctorCheckStatus,
    detail: string,
    fix?: string,
  ): DoctorCheck =>
    check(hearingCheckId(stage, label), hearingTitle(stage, label), status, detail, "peer", fix);

  const skipStage = (stage: HearingStage): DoctorCheck =>
    check(
      hearingCheckId(stage, label),
      hearingTitle(stage, label),
      "skip",
      `skipped — an earlier hearing stage (${brokenBy ?? "?"}) failed; fix that first`,
      "peer",
    );

  // --- Stage 1: cred-perms ---------------------------------------------------
  const allowed = hearing?.credAllowsScope(scope);
  if (allowed === undefined) {
    results.push(
      hc(
        "cred-perms",
        "warn",
        `could not read my leaf cred's allow-sub to verify it permits ${scope} (cred unreadable / not operator-mode / not wired)`,
        "confirm the leaf cred named in leafnodes-<network>.conf permits sub on this peer's federated scope",
      ),
    );
  } else if (!allowed) {
    results.push(
      hc(
        "cred-perms",
        "fail",
        `my leaf credential's allow-sub does NOT permit ${scope} — I can never subscribe X's presence`,
        "widen the leaf cred's allow-sub to include this peer's federated scope, then reconnect the leaf",
      ),
    );
    brokenBy = "cred-perms";
  } else {
    results.push(hc("cred-perms", "pass", `leaf cred allow-sub permits ${scope}`));
  }

  // --- Stage 2: import -------------------------------------------------------
  if (brokenBy !== undefined) {
    results.push(skipStage("import"));
  } else {
    const imported =
      hearing !== undefined ? await hearing.scopeImported(scope, network.leaf_node) : undefined;
    if (imported === undefined) {
      results.push(
        hc(
          "import",
          "warn",
          `could not read the leaf's subscription interest to confirm ${scope} is imported`,
          "enable the nats-server monitor (http_port/monitor_port) so leaf import interest is visible to doctor",
        ),
      );
    } else if (!imported) {
      results.push(
        hc(
          "import",
          "fail",
          `the cred allows ${scope} but the live leaf "${network.leaf_node}" is NOT subscribed to it — an import/reconnect gap`,
          "reconnect the leaf (or restart the daemon) so the federated presence interest is re-imported onto the leaf",
        ),
      );
      brokenBy = "import";
    } else {
      results.push(hc("import", "pass", `${scope} is imported on leaf "${network.leaf_node}"`));
    }
  }

  // --- Stage 3: envelopes-arriving (the ONE bounded live subscribe) ----------
  if (brokenBy !== undefined) {
    results.push(skipStage("envelopes-arriving"));
  } else {
    const arriving =
      hearing !== undefined ? await hearing.presenceArriving(scope, timeoutMs) : undefined;
    if (arriving === undefined) {
      results.push(
        hc(
          "envelopes-arriving",
          "warn",
          `could not run the bounded presence subscribe on ${scope} (no runtime wired / bus disabled)`,
          "run doctor against a reachable bus so it can subscribe this peer's presence scope",
        ),
      );
    } else if (!arriving) {
      results.push(
        hc(
          "envelopes-arriving",
          "fail",
          `subscribed ${scope} but NO presence envelope arrived within ${timeoutMs.toString()}ms — nothing is reaching my bus (hub-side import/pub gap; this was the jc case)`,
          "check the HUB imports/exports X's scope onto my leaf, and that X's stack is actually publishing presence",
        ),
      );
      brokenBy = "envelopes-arriving";
    } else {
      results.push(
        hc("envelopes-arriving", "pass", `≥1 presence envelope from ${scope} arrived on my bus`),
      );
    }
  }

  // --- Stage 4: gate (PURE — the real evaluateFederationGate) ----------------
  if (brokenBy !== undefined) {
    results.push(skipStage("gate"));
  } else {
    const decision = evaluatePeerPresenceGate(ports, peer.principal_id, targetStack);
    if (decision === "allow") {
      results.push(
        hc("gate", "pass", `evaluateFederationGate ACCEPTS a presence envelope from ${label}`),
      );
    } else {
      results.push(
        hc(
          "gate",
          "fail",
          `a presence envelope from ${label} is DROPPED by evaluateFederationGate (${decision.kind}) under my current posture/accept-list/peers`,
          "fix the accept_subjects/deny_subjects/peers[]/hop budget for this network so X's presence subject is accepted",
        ),
      );
      brokenBy = "gate";
    }
  }

  // --- Stage 5: fold ---------------------------------------------------------
  if (brokenBy !== undefined) {
    results.push(skipStage("fold"));
  } else {
    const verdict = hearing?.foldVerdict(peer.principal_id);
    if (verdict === undefined) {
      results.push(
        hc(
          "fold",
          "warn",
          `the roster fold verdict for ${peer.principal_id} is not determinable from the CLI (it lives in the running daemon's memory)`,
          "check the daemon / Mission Control roster for this peer's membership verdict",
        ),
      );
    } else if (verdict !== "admitted-present") {
      results.push(
        hc(
          "fold",
          "fail",
          `${label} passes the gate but does NOT fold onto the roster (verdict "${verdict}", not "admitted-present") — source-binding/pubkey (FS-1 territory)`,
          "verify X's presence is source-bound to a pubkey I trust (FS-1 #1825): the fold drops presence whose signer pubkey is missing/wrong",
        ),
      );
    } else {
      results.push(hc("fold", "pass", `${label} folds onto the roster (admitted-present)`));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

function aggregateVerdict(checks: DoctorCheck[]): DoctorVerdict {
  const anyFail = checks.some((c) => c.status === "fail");
  if (!anyFail) return "healthy";

  const criticalFail = checks.some(
    (c) => c.status === "fail" && CRITICAL_CHECK_IDS.has(c.id),
  );
  if (criticalFail) return "broken";

  const peerChecks = checks.filter((c) => c.id.startsWith("peer-reachable:"));
  const allPeersFailed = peerChecks.length > 0 && peerChecks.every((c) => c.status === "fail");
  if (allPeersFailed) return "broken";

  return "degraded";
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * Run every doctor check for `opts.networkId`, in order, skipping downstream
 * legs when a hard prerequisite failed. Pure over {@link NetworkDoctorPorts}.
 */
export async function runDoctorChecks(
  ports: NetworkDoctorPorts,
  opts: DoctorOptions,
): Promise<DoctorRunResult> {
  const checks: DoctorCheck[] = [];

  // 1. config-network — a hard prerequisite for everything else.
  const configResult = checkConfigNetwork(ports.config, opts.networkId);
  checks.push(configResult.result);
  const network = configResult.network;
  // cortex#1728 Guard 1 — the crash-bomb scan is config-only + network-agnostic
  // (it scans THIS bus's resolved nats config, independent of whether the named
  // network is configured), so it ALWAYS runs — even on the config-network-failed
  // path, where a member most needs to know their bus is armed.
  if (configResult.result.status !== "pass" || network === undefined) {
    checks.push(checkLeafnodeAuthorizationBomb(ports.config));
    checks.push(
      skipCheck(
        PAIR_LEGS.registeredVsFedAccount.id,
        PAIR_LEGS.registeredVsFedAccount.title,
        "skipped — network not configured (see config-network)",
        "member",
      ),
    );
    checks.push(
      skipCheck(
        PAIR_LEGS.resolverPreloadAccount.id,
        PAIR_LEGS.resolverPreloadAccount.title,
        "skipped — network not configured (see config-network)",
        "member",
      ),
    );
    checks.push(checkSealedSecretHubAuthorized());
    checks.push(
      skipCheck("monitor-reachable", "local NATS monitor reachable", "skipped — network not configured (see config-network)", "member"),
    );
    checks.push(
      skipCheck("leaf-established", "leaf established", "skipped — network not configured (see config-network)", "member"),
    );
    checks.push(
      skipCheck("leaf-account-bound", "leaf account binding", "skipped — network not configured (see config-network)", "member"),
    );
    const verdict = aggregateVerdict(checks);
    return { checks, verdict, exitCode: DOCTOR_EXIT_CODE[verdict] };
  }

  // 1.4. cortex#1728 Guard 1 — the armed F4 crash-bomb scan. Config-only, so it
  // runs right after config-network and gates nothing downstream.
  checks.push(checkLeafnodeAuthorizationBomb(ports.config));

  // 1.5-1.7. cortex#1482 — the three representation-pairs. Purely
  // static/config-based (no live NATS), so they run right after
  // config-network and don't gate anything downstream.
  const registeredPubkey = opts.cfg.stack?.nkey_pub;
  const fedAccount = ports.config.expectedFedAccount(opts.networkId);
  checks.push(checkRegisteredVsFedAccount(ports.config, opts.networkId, registeredPubkey));
  checks.push(checkResolverPreloadAccount(ports.config, fedAccount));
  checks.push(checkSealedSecretHubAuthorized());

  // 2. monitor-reachable
  const monitorResult = await checkMonitorReachable(ports);
  checks.push(monitorResult.result);

  // 3. leaf-established
  const leafResult = checkLeafEstablished(monitorResult.leafz, network);
  checks.push(leafResult.result);

  // 4. leaf-account-bound
  checks.push(checkLeafAccountBound(ports.config, opts.networkId, leafResult.established));

  // 5. peer-reachable — one per configured peer, a real echo round-trip.
  // Probes are independent request-replies keyed by correlation_id, so run
  // them CONCURRENTLY — otherwise N unreachable peers cost N×probeTimeoutMs
  // wall-clock (5 offline peers ≈ 30s). Promise.all preserves peers[] order.
  const peerChecks = await Promise.all(
    network.peers.map((peer) => checkPeerReachable(ports, opts, peer)),
  );
  checks.push(...peerChecks);

  // 5b. FS-5b (cortex#1842) — per-peer "can I hear X?" staged chain. One ordered
  // five-stage sub-report per configured peer (cred-perms → import →
  // envelopes-arriving → gate → fold), so the FIRST failing stage names WHERE
  // the one-directional presence path (X → me) breaks. Read-only apart from the
  // ONE bounded presence subscribe per peer (stage 3), matching Leg 5's
  // read-only+one-probe contract. Concurrent per peer (each chain is independent).
  const peerHearing = await Promise.all(
    network.peers.map((peer) => checkPeerHearing(ports, opts, network, peer)),
  );
  for (const chain of peerHearing) checks.push(...chain);

  const verdict = aggregateVerdict(checks);
  return { checks, verdict, exitCode: DOCTOR_EXIT_CODE[verdict] };
}
