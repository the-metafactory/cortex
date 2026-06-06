/**
 * S4 (#738) — the join/leave/status orchestration, pure over {@link NetworkPorts}.
 *
 * This is the executable form of the §1 friction table (DD-4: what was done by
 * hand on 2026-06-06 becomes one command). The flows never touch a real
 * filesystem, plist, launchctl, or registry directly — every effect is a port.
 *
 * ## Wire-protocol contract (federation-wire-protocol SOP /wire-check)
 *
 * S4 writes the federation config, so it must be on-contract:
 *
 *   - **accept_subjects** = the stack's OWN `federated.{me}.{stack}.>` ONLY.
 *     A network never names itself on the wire; accept-lists gate by the
 *     stack's own principal/stack segment. We NEVER write the network id into
 *     a subject.
 *   - **peers[]** declare by `principal_id` (+ `stack_id`), pubkey
 *     registry-resolved (DD-5) — the local principal is never in its own
 *     peers[].
 *   - **max_hop** is a conscious value (schema has no default); join writes a
 *     conservative `1` (direct hub + one relay), which the principal can edit.
 *
 * ## Idempotency
 *
 * `join` converges: re-running replaces the network's entry in
 * `policy.federated.networks[]` (keyed by network id) rather than appending,
 * re-writes the (byte-stable) leaf include, and re-ensures the plist `-c` arg
 * (a no-op when already present). `leave` removes exactly what `join` added and
 * is a no-op when the network was never joined.
 */

import type {
  PolicyFederatedNetwork,
  PolicyFederatedPeer,
} from "../../../common/types/cortex-config";
import type { NetworkRosterResult } from "../../../common/registry/types";
import { base64PubkeyToNkey } from "../../../common/registry/encoding";

import {
  brandVerified,
  type NetworkPorts,
  type LeafLinkState,
} from "./network-ports";

// =============================================================================
// Identity of the joining stack — who "me" is on the wire.
// =============================================================================

/**
 * The local stack's wire identity + leaf binding, supplied by the CLI from the
 * loaded config. `principalId`/`stackSlug` build the OWN accept-subject; the
 * `account` (nkey-U) + `credentials` path are the leaf binding S3 needs.
 */
export interface JoiningStack {
  /** Local principal id — the `{me}` segment of `federated.{me}.{stack}.>`. */
  principalId: string;
  /** Local stack slug — the `{stack}` segment (the part after the `/`). */
  stackSlug: string;
  /** Path to the leaf `.creds` file (absolute). */
  credentials: string;
  /** Local nkey-U account the leaf binds to (DD-8 already in nkey-U). */
  account: string;
  /**
   * The `leaf_node` connection name to write on the network entry. Defaults to
   * the network id when unset (one leaf per network, OQ3-clean).
   */
  leafNode?: string;
  /** max_hop to write (schema has no default). Conservative default: 1. */
  maxHop?: number;
}

// =============================================================================
// Flow results — discriminated so the CLI renders + sets exit codes.
// =============================================================================

export interface JoinResult {
  ok: boolean;
  /** Human-readable step log (ordered). Rendered by the CLI. */
  steps: string[];
  /** The network entry that was written (on success). */
  network?: PolicyFederatedNetwork;
  /** Failure reason (on `ok: false`). */
  reason?: string;
  /** True when the registry was unreachable and a cached descriptor was used (DD-10). */
  usedCache?: boolean;
  /** Peers that resolved (principal ids) — for the CLI summary. */
  resolvedPeers?: string[];
}

export interface LeaveResult {
  ok: boolean;
  steps: string[];
  reason?: string;
  /** True when the network was not joined (no-op leave). */
  notJoined?: boolean;
  /** Networks still joined after leave (for plist teardown decision). */
  remaining?: string[];
}

export interface StatusResult {
  ok: boolean;
  networks: StatusNetworkRow[];
  reason?: string;
}

export interface StatusNetworkRow {
  networkId: string;
  leafNode: string;
  peers: string[];
  acceptSubjects: string[];
  maxHop: number;
  link: LeafLinkState;
}

// =============================================================================
// join
// =============================================================================

/**
 * Join `networkId`, idempotently (DD-4). Steps mirror §1's friction table:
 *   (a) register the stack pubkey,
 *   (b) pull the VERIFIED descriptor + roster (DD-9; cached fallback DD-10),
 *   (c) render + write the leaf include and ensure the plist loads it (DD-6),
 *   (d) merge the network into policy.federated.networks[] with registry-
 *       resolved peers (DD-5) + the OWN accept-subject,
 *   (e) restart the daemon.
 *
 * Never throws — every failure becomes a `{ ok: false, reason }`.
 */
export async function joinNetwork(
  networkId: string,
  stack: JoiningStack,
  ports: NetworkPorts,
): Promise<JoinResult> {
  const steps: string[] = [];

  // (a) Register (idempotent). A registration failure is fatal: without a
  // registered pubkey the peer cannot be verified by others (DD-9 symmetric).
  const reg = await ports.registry.registerStack();
  if (!reg.ok) {
    return { ok: false, steps, reason: `register failed: ${reg.reason}` };
  }
  steps.push(`registered stack pubkey (${reg.note})`);

  // (b) Pull the verified descriptor + roster (DD-9). On unreachable, fall back
  // to the last-known-good cache (DD-10) so a join during a transient outage
  // still configures. A bad signature / not_found / shape-invalid ABORTS —
  // an unverified descriptor must NEVER reach the renderer.
  let descriptor;
  let roster: NetworkRosterResult;
  let usedCache = false;
  const fetched = await ports.registry.fetchVerified(networkId);
  if (fetched.status === "ok") {
    descriptor = fetched.value.descriptor;
    roster = fetched.value.roster;
    steps.push(`pulled verified descriptor + roster for "${networkId}"`);
  } else if (fetched.status === "unreachable") {
    const cached = ports.registry.loadCached(networkId);
    if (cached === undefined) {
      return {
        ok: false,
        steps,
        reason: `registry unreachable (${fetched.reason}) and no cached descriptor for "${networkId}" — cannot join`,
      };
    }
    descriptor = cached.descriptor;
    roster = cached.roster;
    usedCache = true;
    steps.push(
      `registry unreachable (${fetched.reason}) — using last-known-good cached descriptor + roster (DD-10)`,
    );
  } else {
    // not_found / unverified — a definitive negative. Do NOT render.
    const detail =
      fetched.status === "unverified"
        ? `descriptor failed verification (${fetched.reason}) — refusing to join (DD-9)`
        : `network "${networkId}" not found in registry`;
    return { ok: false, steps, reason: detail };
  }

  // TRUST BOUNDARY: brand only here, after the verified-fetch / verified-cache
  // path. The renderer demands a VerifiedNetworkDescriptor; a plain descriptor
  // would be a tsc error at the next line.
  const verified = brandVerified(descriptor);

  // (c) Render + write the leaf include (S3) and ensure the plist loads the
  // nats config (DD-6, closes the configured-but-dormant trap). The renderer
  // fails loud on a bad binding — surface it as a join failure, never a crash.
  try {
    ports.leafFile.write({
      descriptor: verified,
      binding: { credentials: stack.credentials, account: stack.account },
    });
  } catch (err) {
    return {
      ok: false,
      steps,
      reason: `leaf render/write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  steps.push(`wrote leaf include for "${networkId}" (hub ${verified.hub_url})`);

  // The plist + config writes hit the live filesystem in the `--apply` adapter
  // (plist XML splice + stack YAML rewrite). A failure there (permission denied,
  // an unparseable plist, a disk error) must surface as a `{ ok: false }` per
  // this function's "never throws" contract — NOT as an uncaught exception that
  // escapes with a stack trace and leaves the deployment half-mutated (leaf
  // written, config not). A failed `--apply` is recoverable: re-running join
  // converges (idempotent). `try` spans both writes so the step log records how
  // far the mutation got before the failure.
  const peers = buildPeers(stack.principalId, roster);
  const acceptSubject = `federated.${stack.principalId}.${stack.stackSlug}.>`;
  const entry: PolicyFederatedNetwork = {
    id: networkId,
    leaf_node: stack.leafNode ?? networkId,
    peers,
    accept_subjects: [acceptSubject],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: stack.maxHop ?? 1,
  };

  try {
    // (c, cont.) Ensure the plist loads the nats config (DD-6).
    ports.plist.ensureConfigLoaded(ports.leafFile.natsConfigPath());
    steps.push(`ensured nats-server plist loads ${ports.leafFile.natsConfigPath()}`);

    // (c, cont.) Ensure the nats config actually `include`s the rendered leaf
    // file (#754). Without this the plist loads a config that never references
    // the leaf → the leaf sits configured-but-dormant (the DD-6 trap). This is
    // the idempotent ensure-include step mirroring the plist ensure pattern.
    ports.leafFile.ensureInclude(networkId);
    steps.push(`ensured local.conf includes leafnodes-${networkId}.conf`);

    // (d) Merge the network into the federation config with registry-resolved
    // peers (DD-5) + the OWN accept-subject (wire contract). Idempotent: replace
    // the entry keyed by network id, never append a duplicate.
    const existing = ports.configStore.readNetworks();
    const merged = mergeNetwork(existing, entry);
    ports.configStore.writeNetworks(merged);
    steps.push(
      `wrote policy.federated.networks["${networkId}"] — ${peers.length.toString()} peer(s), accept ${acceptSubject}`,
    );
  } catch (err) {
    return {
      ok: false,
      steps,
      reason: `plist/config write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // (e) Restart the daemon so the rendered leaf takes effect.
  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `config written but daemon restart failed: ${restart.reason}`,
      network: entry,
      usedCache,
      resolvedPeers: peers.map((p) => p.principal_id),
    };
  }
  steps.push("restarted stack daemon");

  return {
    ok: true,
    steps,
    network: entry,
    usedCache,
    resolvedPeers: peers.map((p) => p.principal_id),
  };
}

/**
 * Build `peers[]` from the verified roster (DD-5). Excludes the LOCAL principal
 * (a stack is never in its own peers[]). Each peer declares `principal_id` +
 * `stack_id`; `principal_pubkey` is filled from the roster (re-encoded to
 * nkey-U, DD-8) when the roster carries a re-encodable key — otherwise it is
 * LEFT OFF so the S2 config-load resolver resolves it (DD-5: declare by id).
 */
function buildPeers(
  localPrincipalId: string,
  roster: NetworkRosterResult,
): PolicyFederatedPeer[] {
  const peers: PolicyFederatedPeer[] = [];
  for (const member of roster.members) {
    if (member.principal_id === localPrincipalId) continue; // never self
    const stackId =
      member.stack_id ?? `${member.principal_id}/default`;
    const nkey = base64PubkeyToNkey(member.principal_pubkey);
    const peer: PolicyFederatedPeer = nkey === undefined
      ? { principal_id: member.principal_id, stack_id: stackId }
      : {
          principal_id: member.principal_id,
          stack_id: stackId,
          principal_pubkey: nkey,
        };
    peers.push(peer);
  }
  return peers;
}

/**
 * Replace-or-append the network in the list, keyed by id (idempotency). Pure:
 * input array not mutated, order preserved, replacement in place.
 */
export function mergeNetwork(
  existing: readonly PolicyFederatedNetwork[],
  next: PolicyFederatedNetwork,
): PolicyFederatedNetwork[] {
  const out = existing.map((n) => ({ ...n }));
  const idx = out.findIndex((n) => n.id === next.id);
  if (idx >= 0) {
    out[idx] = next;
  } else {
    out.push(next);
  }
  return out;
}

// =============================================================================
// leave
// =============================================================================

/**
 * Leave `networkId` — the exact reverse of join, idempotently:
 *   - remove the network from policy.federated.networks[],
 *   - delete the leaf include file,
 *   - if NO leaf includes remain, drop the plist `-c` arg,
 *   - restart the daemon.
 *
 * A leave of a network that was never joined is a clean no-op (ok, notJoined).
 */
export async function leaveNetwork(
  networkId: string,
  ports: NetworkPorts,
): Promise<LeaveResult> {
  const steps: string[] = [];
  const existing = ports.configStore.readNetworks();
  const wasJoined = existing.some((n) => n.id === networkId);

  if (!wasJoined) {
    return {
      ok: true,
      steps: [`network "${networkId}" not joined — nothing to do`],
      notJoined: true,
      remaining: existing.map((n) => n.id),
    };
  }

  const remaining = existing.filter((n) => n.id !== networkId);
  // The config rewrite, leaf-include delete, and plist edit hit the live
  // filesystem in `--apply`. As in join, a write failure must surface as a
  // `{ ok: false }` per contract, not an uncaught throw — and the step log
  // records how far teardown got. A failed `--apply` leave is recoverable:
  // re-running converges (idempotent).
  try {
    // Remove from federation config.
    ports.configStore.writeNetworks(remaining);
    steps.push(`removed policy.federated.networks["${networkId}"]`);

    // Remove the `include` directive from the nats config (#754 — the inverse
    // of join's ensure-include) BEFORE deleting the file, so the config never
    // references a missing include.
    ports.leafFile.removeInclude(networkId);
    steps.push(`removed local.conf include for leafnodes-${networkId}.conf`);

    // Delete the leaf include file (idempotent).
    ports.leafFile.remove(networkId);
    steps.push(`deleted leaf include for "${networkId}"`);

    // If no networks have a leaf include anymore, drop the plist -c arg so the
    // server reverts to its bare invocation (clean teardown).
    const stillHaveLeaves = ports.leafFile.list().length > 0;
    if (!stillHaveLeaves) {
      ports.plist.dropConfigArg(ports.leafFile.natsConfigPath());
      steps.push("no networks remain — dropped nats-server plist -c arg");
    }
  } catch (err) {
    return {
      ok: false,
      steps,
      reason: `teardown write failed: ${err instanceof Error ? err.message : String(err)}`,
      remaining: remaining.map((n) => n.id),
    };
  }

  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `config reverted but daemon restart failed: ${restart.reason}`,
      remaining: remaining.map((n) => n.id),
    };
  }
  steps.push("restarted stack daemon");

  return { ok: true, steps, remaining: remaining.map((n) => n.id) };
}

// =============================================================================
// status
// =============================================================================

/**
 * Report joined networks: leaf link state (from the optional {@link LeafStatePort},
 * "unknown" when none wired), peers, accept-subjects, and counters. Read-only;
 * never restarts or mutates anything.
 */
export async function networkStatus(ports: NetworkPorts): Promise<StatusResult> {
  const networks = ports.configStore.readNetworks();
  const linkStates = ports.leafState
    ? await ports.leafState.linkStates()
    : {};

  const rows: StatusNetworkRow[] = networks.map((n) => ({
    networkId: n.id,
    leafNode: n.leaf_node,
    peers: n.peers.map((p) => p.principal_id),
    acceptSubjects: n.accept_subjects,
    maxHop: n.max_hop,
    link: linkStates[n.id] ?? { state: "unknown" },
  }));

  return { ok: true, networks: rows };
}
