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
 *   1. config-network      — the network is configured, has peers + accept_subjects
 *   2. monitor-reachable   — the local nats-server HTTP monitor answers `/leafz`
 *   3. leaf-established    — `/leafz` shows an established leaf for this network
 *   4. leaf-account-bound  — the established leaf's account matches config (best-effort)
 *   5. peer-reachable:<p>  — one check per configured peer, a real echo round-trip
 */

import type { LoadedConfig } from "../../../common/config/loader";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
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

/** `{principal}/{slug}` → the slug (falls back to the whole string). */
function stackSlugFromStackId(stackId: string): string {
  const parts = stackId.split("/");
  return parts.length === 2 ? (parts[1] ?? stackId) : stackId;
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
// Leg 2 — monitor-reachable
// ---------------------------------------------------------------------------

async function checkMonitorReachable(
  ports: NetworkDoctorPorts,
): Promise<{ result: DoctorCheck; leafz?: LeafzResponse }> {
  const id = "monitor-reachable";
  const title = "local NATS monitor reachable";
  const resolved = ports.monitor.resolve();

  // #831 — absent monitor is INCONCLUSIVE, not a failure: warn, and let
  // downstream leaf checks skip (they have no /leafz to read).
  if (!resolved.configured) {
    return {
      result: check(
        id,
        title,
        "warn",
        "no monitor configured for this bus (no --monitor-url / http_port / monitor_port)",
        "member",
        "enable http_port/monitor_port on the local bus for full leaf verification",
      ),
    };
  }

  const leafz = await ports.monitor.fetchLeafz();
  if (leafz === undefined) {
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
  return {
    result: check(id, title, "pass", `${resolved.url}/leafz responded`, "member"),
    leafz,
  };
}

// ---------------------------------------------------------------------------
// Leg 3 — leaf-established
// ---------------------------------------------------------------------------

interface LeafMatch {
  leaf: LeafzEntry;
  match: "named" | "lone-fallback";
}

function findEstablishedLeaf(
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
    case "timeout":
      return check(
        id,
        title,
        "fail",
        pr.detail ?? `no echo from ${label} within the probe timeout`,
        "peer",
        "peer/hub — peer offline, its leaf is down, or the hub is partitioned; check the peer's own `cortex network doctor` and the hub authorization",
      );
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
  if (configResult.result.status !== "pass" || network === undefined) {
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

  const verdict = aggregateVerdict(checks);
  return { checks, verdict, exitCode: DOCTOR_EXIT_CODE[verdict] };
}
