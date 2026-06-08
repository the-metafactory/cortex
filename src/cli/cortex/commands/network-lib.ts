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
  /**
   * Non-fatal warnings surfaced during the join (#762). The empty-roster
   * hand-pin-preservation warning lands here (and in {@link steps}) so the CLI
   * can render it and a caller can assert on it without scraping prose.
   */
  warnings?: string[];
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
 *   (e) restart nats-server so it reloads local.conf + the new leaf (#757),
 *       THEN restart the cortex daemon so it reconnects to the bus.
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

  // (b.5) #794 — FAIL FAST: never render a leaf that would CRASH the stack's
  // bus. The leaf remote binds `stack.account` (nkey-U); nats-server resolves
  // that account against the LOCAL nats config's account tree on startup. If
  // the config is anonymous + hard-isolated (no operator-mode account tree —
  // the halden/community pattern) or is operator-mode but doesn't define THIS
  // account, nats-server crashes (`cannot find local account "<A…>" specified
  // in leafnode remote`) and the whole bus goes DOWN. So pre-validate the
  // resolved config BEFORE any mutation (no leaf write, no include, no
  // restart) — a READ, so dry-run surfaces the same refusal. Recoverable: the
  // operator converts the bus to operator-mode (define the account) or passes a
  // config that does. Refusing here is strictly safer than a crashed server.
  const bind = ports.leafFile.canBindAccount(stack.account);
  if (!bind.canBind) {
    const configPath = ports.leafFile.natsConfigPath();
    return {
      ok: false,
      steps,
      reason:
        `nats config ${configPath} cannot bind account ${stack.account} ` +
        `(${bind.reason ?? "unknown"}) — this bus is anonymous/isolated and ` +
        `cannot federate. Convert it to operator-mode (define the account; see ` +
        `docs/sop-stack-onboarding.md §Part 2) or pass a config that defines the ` +
        `account (--nats-config). Refusing to render a leaf that would crash ` +
        `nats-server (cortex#794).`,
    };
  }

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
  const resolvedPeers = buildPeers(stack.principalId, roster);
  const acceptSubject = `federated.${stack.principalId}.${stack.stackSlug}.>`;
  const warnings: string[] = [];

  // (d-pre) #762 — never clobber a working hand-pin with 0 resolved peers.
  //
  // The registry roster is populated implicitly: a principal is "in" a network
  // only if one of its announced capabilities lists that network in
  // `capability.networks[]`. If nobody has announced into the network yet (the
  // exact bug found in clawbox dry-runs — `jc` registered but announced no caps
  // into `metafactory`), the roster is EMPTY and `buildPeers` yields 0 peers.
  //
  // Writing those 0 peers over an existing entry would wipe a hand-pinned peer
  // (the DD-5 offline fallback) that is actively carrying federated traffic. So
  // when the roster resolves no peers, we PRESERVE the existing hand-pins for
  // this network rather than overwriting them, and warn loudly. When the roster
  // DOES resolve peers we use them as-is (registry is source of truth, DD-5).
  const existing = ports.configStore.readNetworks();
  const priorEntry = existing.find((n) => n.id === networkId);
  const priorPeers = priorEntry?.peers ?? [];
  let peers = resolvedPeers;
  if (resolvedPeers.length === 0 && priorPeers.length > 0) {
    // Preserve every existing hand-pin (the roster named nobody, so there is no
    // registry peer to merge or supersede). The hand-pins stay verbatim.
    peers = priorPeers.map((p) => ({ ...p }));
    const warn =
      `registry roster for "${networkId}" resolved 0 peers — ` +
      `preserved ${priorPeers.length.toString()} existing hand-pinned peer(s) ` +
      `(${priorPeers.map((p) => p.principal_id).join(", ")}) rather than wiping them. ` +
      `Peers join the roster by announcing a capability with networks:["${networkId}"].`;
    warnings.push(warn);
    steps.push(`WARN: ${warn}`);
  }

  const entry: PolicyFederatedNetwork = {
    id: networkId,
    leaf_node: stack.leafNode ?? networkId,
    peers,
    accept_subjects: [acceptSubject],
    deny_subjects: [],
    // #762 — PRESERVE the hand-authored announce_capabilities for this network.
    // `deriveJoinInputs` sources the caps the join announces INTO the roster from
    // exactly this config block, so blanking it to [] here would make a re-join
    // (or any later config-derived join) announce nothing → the roster empties
    // again, defeating the fix above. Carry the prior entry's value verbatim
    // (default [] only on a first join where no block exists yet).
    announce_capabilities: priorEntry?.announce_capabilities ?? [],
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

  // (e.1) Restart nats-server so it RELOADS local.conf + the freshly-included
  // leaf (#757). nats-server is the process that actually reads local.conf; the
  // config writes above + the plist ensure are dormant until it restarts. Order
  // matters: bring the bus up with the leaf FIRST, then reconnect cortex (e.2)
  // so it attaches to a leaf that is already established. Kept inside the
  // never-throws contract — a failed nats restart is a recoverable `{ ok: false }`.
  // Skipped only when no nats-server port is wired (a caller that doesn't mutate
  // the leaf); the live `join` path always supplies one.
  if (ports.natsServer !== undefined) {
    const natsRestart = await ports.natsServer.restart();
    if (!natsRestart.ok) {
      return {
        ok: false,
        steps,
        reason: `config written but nats-server restart failed: ${natsRestart.reason}`,
        network: entry,
        usedCache,
        resolvedPeers: peers.map((p) => p.principal_id),
        ...(warnings.length > 0 && { warnings }),
      };
    }
    steps.push("restarted nats-server to load leaf config");
  }

  // (e.2) Restart the cortex daemon so it reconnects to the bus (now carrying
  // the leaf).
  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `config written but daemon restart failed: ${restart.reason}`,
      network: entry,
      usedCache,
      resolvedPeers: peers.map((p) => p.principal_id),
      ...(warnings.length > 0 && { warnings }),
    };
  }
  steps.push("restarted stack daemon");

  return {
    ok: true,
    steps,
    network: entry,
    usedCache,
    resolvedPeers: peers.map((p) => p.principal_id),
    ...(warnings.length > 0 && { warnings }),
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
    // C-797 — `/leafz` keys each connection by the leaf-node (remote) name, which
    // is NOT necessarily the network id (two networks may share one `leaf_node`,
    // or it may be named independently). Join on `leaf_node` first so a connected
    // leaf reports `established` (up); fall back to the network-id key for the
    // common case where they coincide, then to "unknown" when leafz has no row
    // (monitor genuinely unreachable).
    link: linkStates[n.leaf_node] ?? linkStates[n.id] ?? { state: "unknown" },
  }));

  return { ok: true, networks: rows };
}
