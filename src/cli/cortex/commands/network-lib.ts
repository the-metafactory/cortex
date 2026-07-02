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
 *   - **accept_subjects** = the stack's OWN `federated.{me}.{stack}.>` ONLY
 *     (inbound dispatch, RECEIVER-addressed). cortex#1220: a persisted PEER
 *     presence subtree (`federated.{peer}.{peer-stack}.agent.>`) is OUT of the
 *     receiving stack's own scope and FAILS the boot config validator (ADR 0001),
 *     so `join` persists own-scope ONLY. Inbound peer PRESENCE is still admitted
 *     at runtime — the federation-reconciler re-derives the full own ∪ peer
 *     accept-list from the roster and applies it IN-MEMORY (never to disk). A
 *     network never names ITSELF on the wire; accept-lists gate by principal/stack
 *     segments only. We NEVER write the network id into a subject.
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
  PolicyFederatedReconcile,
} from "../../../common/types/cortex-config";
import {
  isFederatedSubjectInOwnScope,
  ownFederatedSubjectScopePrefix,
  PolicyFederatedReconcileSchema,
} from "../../../common/types/cortex-config";
import type { NetworkRosterResult } from "../../../common/registry/types";
import type { OperatorModeLeafPackage } from "../../../common/nats/leaf-remote-renderer";
import { buildRosterPeers } from "../../../bus/agent-network/roster-read";
import {
  ownAcceptSubjects,
  type FederatedWireIdentity,
} from "../../../bus/agent-network/accept-subjects";

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
  /**
   * Path to the leaf `.creds` file (absolute). OPTIONAL since C-1224: a
   * secret-authenticated leaf ({@link JoiningStack.leafSecret}) carries no creds
   * file — its credential is the URL userinfo.
   */
  credentials?: string;
  /**
   * C-1224 (ADR-0013 Model B, §Decision-1) — the **leaf shared secret** for a
   * secret-authenticated transport-pipe leaf. Present ⇒ `joinNetwork` renders a
   * leaf that authenticates via URL userinfo (`tls://user:secret@host`) and binds
   * the principal's OWN local {@link JoiningStack.account}, instead of a
   * `.creds`-file leaf. The hub authenticates the remote with the matching
   * `authorization { user, password: <leaf-secret> }`; each side binds locally,
   * no cross-operator JWT trust. Absent ⇒ the legacy `.creds` path.
   */
  leafSecret?: string;
  /**
   * C-1224 — the userinfo USER paired with {@link JoiningStack.leafSecret}
   * (matches the hub's `authorization { user, … }`). The CLI defaults it to the
   * principal id; required whenever `leafSecret` is set.
   */
  leafUser?: string;
  /**
   * Local nkey-U account the leaf binds to (DD-8 already in nkey-U) — OPTIONAL
   * (#799). Present for an operator-mode bus; OMITTED for a `$G`/default bus
   * (the binding rides in the creds JWT, so no `account:` is rendered).
   */
  account?: string;
  /**
   * The `leaf_node` connection name to write on the network entry. Defaults to
   * the network id when unset (one leaf per network, OQ3-clean).
   */
  leafNode?: string;
  /** max_hop to write (schema has no default). Conservative default: 1. */
  maxHop?: number;
  /**
   * O-3 (cortex#1053) — the operator-mode "leaf package" (operator JWT + issued
   * account + account JWT, optional SYS account). Present ⇒ when the stack's bus
   * is anonymous/hard-isolated (the #794 fail-fast input), `joinNetwork` CONVERTS
   * it to operator-mode (renders the SOP §B0.1 blocks) instead of refusing, then
   * proceeds with the existing leaf render. Absent ⇒ the #794 fail-fast stands.
   * O-4 (the register→issue handshake) SUPPLIES this; O-3 only consumes it.
   */
  operatorModePackage?: OperatorModeLeafPackage;
  /**
   * G1c (#1117, ADR-0013 Model B) — the agents NSC account (nkey-A) where the
   * stack's dispatch-listener subscribes `federated.>`. This is the
   * `--to-account` for `arc nats add-federation-export`. Optional today: when
   * absent the wiring step uses `account` for both sides (same-account path —
   * the arc primitive handles this as a no-op). A dedicated `agents_account`
   * config field that splits the federation account from the agents account is
   * tracked as G1d (cortex#1117 follow-up).
   */
  agentsAccount?: string;
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
  /**
   * C-820 — non-fatal warnings surfaced during leave. A registry
   * deregister-from-network failure lands here (and in {@link steps}): the LOCAL
   * teardown succeeded, but the principal's registry cap tags were not retagged,
   * so the principal must re-run when the registry is reachable.
   */
  warnings?: string[];
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

  // (b.5) #799 (peer-side counterpart to #794) — choose the leaf-remote BIND
  // MODE by bus type, and FAIL FAST only on a genuinely un-joinable bus.
  //
  // The leaf remote authenticates with `stack.credentials` and (in operator-mode)
  // binds `stack.account`. nats-server resolves an `account:` line against the
  // LOCAL config's account tree on startup:
  //   - operator-mode bus that defines the account → render account-bound (#794).
  //   - `$G`/default bus (no account tree) + creds → render NO-account; the
  //     creds JWT binds it (the case #794 wrongly refused → bus stayed down).
  //   - no creds, or operator-mode bus missing the account → REFUSE (rendering
  //     an account-bound leaf there crashes nats-server, taking the bus DOWN).
  // This is a READ (no mutation), so dry-run surfaces the same decision.
  const hasCreds =
    typeof stack.credentials === "string" && stack.credentials.trim().length > 0;
  // C-1224 (ADR-0013 Model B) — a leaf SECRET is an auth method on par with a
  // `.creds` file: it authenticates the secret-auth transport pipe via URL
  // userinfo. So it satisfies `resolveBindMode`'s "has an auth method" gate (the
  // function only uses this to refuse a bus with NO way to authenticate, and to
  // allow the creds-only/$G no-account render). The account-bind safety (#794:
  // an `account:` line must resolve against the local operator-mode tree) is
  // ORTHOGONAL and still enforced — a secret-auth leaf on an operator-mode bus
  // still binds (and #794-validates) the local `account`.
  const hasSecret =
    typeof stack.leafSecret === "string" && stack.leafSecret.trim().length > 0;
  const hasLeafAuth = hasCreds || hasSecret;
  let bindMode = ports.leafFile.resolveBindMode(stack.account, hasLeafAuth);

  // (b.5.1) O-3 (cortex#1053, spec §4-D2) — AUTO-CONVERT an anonymous bus.
  //
  // When the bind-mode pre-flight REFUSES (the #794 fail-fast: an anonymous /
  // hard-isolated bus has no operator-mode account tree, so the account the leaf
  // binds can never resolve) AND the joining stack carries a leaf package (O-4's
  // register→issue handshake supplies it), render the SOP §B0.1 operator-mode
  // blocks into the bus's nats config — KEEPING its own identity/ports/JS domain,
  // adding NO leaf include — THEN re-resolve. The converted bus is operator-mode,
  // so the re-resolve binds the account and the existing join flow proceeds.
  //
  // The conversion port is the single writer (live writes the rendered config;
  // dry-run is inert). `already`/`converted` both let the join continue; a
  // conversion `refuse` (incomplete package, or a bus already operator-mode under
  // a DIFFERENT operator JWT — never clobber it) ABORTS before any further mutation.
  if (bindMode.mode === "refuse" && stack.operatorModePackage !== undefined) {
    const conversion = ports.leafFile.convertToOperatorMode(
      stack.operatorModePackage,
    );
    if (conversion.status === "refuse") {
      return {
        ok: false,
        steps,
        reason:
          `cannot auto-convert the bus to operator-mode (${conversion.reason}). ` +
          `Refusing to render a leaf that would crash nats-server (cortex#794/#1053).`,
      };
    }
    steps.push(
      conversion.status === "converted"
        ? `converted the anonymous bus to operator-mode (rendered the operator/account/resolver blocks — O-3, #1053)`
        : `bus already operator-mode under this operator — no conversion needed (O-3, #1053)`,
    );
    // Re-resolve against the now-operator-mode bus. Use `hasLeafAuth` (not
    // `hasCreds`) so a secret-only Model-B leaf (C-1224) that triggered the
    // auto-convert still passes the "has an auth method" gate — otherwise it
    // would abort with a misleading "no leaf creds available" despite a valid
    // secret. Mirrors the first resolve at line 275.
    bindMode = ports.leafFile.resolveBindMode(stack.account, hasLeafAuth);
  }

  if (bindMode.mode === "refuse") {
    const configPath = ports.leafFile.natsConfigPath();
    return {
      ok: false,
      steps,
      reason:
        `nats config ${configPath} cannot federate (${bindMode.reason}). ` +
        `An operator-mode bus must DEFINE the leaf account (convert it — see ` +
        `docs/sop-stack-onboarding.md §Part 2, or supply a leaf package so join ` +
        `auto-converts — O-3/#1053 — or pass a config that does via ` +
        `--nats-config); a $G/default bus needs valid leaf creds. Refusing to ` +
        `render a leaf that would crash nats-server (cortex#794/#799).`,
    };
  }

  // The account written into the leaf remote: the nkey-U for an operator-mode
  // bus, or OMITTED (undefined) for a $G/default bus (#799 — the binding rides
  // in the creds JWT; an `account:` line there crashes nats-server).
  const leafAccount =
    bindMode.mode === "operator-account" ? bindMode.account : undefined;

  // (b.4) G1c (#1117, ADR-0013 Model B) — WIRE the local-side `federated.>`
  // export/import BEFORE writing the leaf file (fail-fast: an arc failure here
  // aborts before any mutation touches the live nats-server config). Skipped
  // when:
  //   - no `ports.federationWiring` wired (backwards-compat / pre-G1c callers),
  //   - OR the bus is not operator-mode (a $G/creds-only bus has no NSC account
  //     tree to add export/import to — no wiring is needed or possible).
  //
  // ADR-0013 Model B invariant: LOCAL accounts only — `federationAccount` is
  // the leaf-bound nkey-A from `stack.account`; `agentsAccount` is the
  // stack's own agents account (optional today — G1d tracks the split).
  // cortex NEVER passes a peer account; no network id goes on the arc call.
  if (ports.federationWiring !== undefined && leafAccount !== undefined) {
    // Read apply from the ports bundle (G1c: `NetworkPorts.apply` mirrors the
    // --apply flag from the CLI). Default: false (dry-run safe — the #794
    // "never accidentally mutate" principle).
    const wiringApply = ports.apply === true;
    let wiringResult: { ok: true; note?: string } | { ok: false; reason: string };
    try {
      wiringResult = await ports.federationWiring.wireLocalFederation({
        federationAccount: leafAccount,
        agentsAccount: stack.agentsAccount,
        apply: wiringApply,
      });
    } catch (err) {
      // The port contract says "never throws"; guard here as belt-and-braces so
      // a buggy port implementation (or a Bun.spawn ENOENT that escapes before
      // the adapter wraps it) never escapes joinNetwork's "never throws" contract.
      wiringResult = {
        ok: false,
        reason: `federation-wiring port threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!wiringResult.ok) {
      return {
        ok: false,
        steps,
        reason:
          `federation-wiring step failed — arc nats add-federation-export returned an error ` +
          `(${wiringResult.reason}). The join is aborted before any nats-server config ` +
          `was written. Ensure arc is installed (G1b / arc#243) and the NSC store is ` +
          `accessible, then re-run join.`,
      };
    }
    const wiringNote = wiringResult.note ?? "export+import wired";
    steps.push(
      `wired local-side federated.> export/import ` +
      `(federation-account=${leafAccount}, ${wiringApply ? "applied" : "dry-run"}: ${wiringNote}) ` +
      `(G1c ADR-0013 Model B)`,
    );
  } else if (ports.federationWiring !== undefined && leafAccount === undefined) {
    // $G/creds-only bus: no NSC account — federation wiring is a no-op. Log
    // so the principal can see why the step was skipped.
    steps.push(
      "skipped federation-wiring step: $G/creds-only bus has no NSC account " +
      "(no export/import needed — the creds JWT binds the leaf directly) " +
      "(G1c ADR-0013 Model B)",
    );
  }

  // (b.6) #821 — PRE-FLIGHT the creds file BEFORE any mutation. `nats-server -c
  // <cfg> -t` validates HOCON syntax but does NOT dereference the leaf remote's
  // `credentials` path, so a remote pointing at a NON-EXISTENT creds file passes
  // `-t` yet makes the leaf un-authenticatable at runtime. The community
  // incident's rendered remote pointed at a creds file that did not exist. A
  // READ (identical in live + dry-run); refuse here rather than render a leaf
  // that can never connect.
  //
  // C-1224 (ADR-0013 Model B) — SKIP this for a secret-auth leaf: it carries no
  // `.creds` file (its credential is the URL userinfo secret), so there is
  // nothing on disk to pre-flight here. The secret's presence was already
  // confirmed by `hasSecret` above.
  if (!hasSecret && !ports.leafFile.credsExist(stack.credentials ?? "")) {
    return {
      ok: false,
      steps,
      reason:
        `leaf creds file not found at ${stack.credentials} — refusing to render a ` +
        `leaf remote that cannot authenticate to the hub. Set stack.nats_infra.creds_path ` +
        `(or pass --creds) to an existing .creds file (cortex#821).`,
    };
  }

  // (b.7) #821 — SNAPSHOT the prior leaf state BEFORE any mutation, so a failed
  // nats-server restart (step e.1) can be rolled back to the exact pre-join
  // bytes. Captures the per-network include file + the base nats config. A READ.
  const snapshot = ports.leafFile.snapshotLeafState(networkId);

  // (c) Render + write the leaf include (S3) and ensure the plist loads the
  // nats config (DD-6, closes the configured-but-dormant trap). The renderer
  // fails loud on a bad binding — surface it as a join failure, never a crash.
  try {
    ports.leafFile.write({
      descriptor: verified,
      // C-1224 (ADR-0013 Model B) — render the SECRET-AUTH leaf when a leaf
      // secret is present (URL userinfo, no creds file); else the legacy
      // `.creds`-file leaf. Both still carry the local `account:` (`leafAccount`)
      // when the bus is operator-mode (#799). Mutually exclusive: the renderer
      // prefers the secret when both are somehow present.
      binding: hasSecret
        ? {
            ...(stack.leafSecret !== undefined && { leafSecret: stack.leafSecret }),
            ...(stack.leafUser !== undefined && { leafUser: stack.leafUser }),
            ...(leafAccount !== undefined && { account: leafAccount }),
          }
        : {
            ...(stack.credentials !== undefined && { credentials: stack.credentials }),
            ...(leafAccount !== undefined && { account: leafAccount }),
          },
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

  // (d) cortex#1220 — PERSIST the OWN-scope subtree ONLY. The daemon's boot
  // config validator (ADR 0001, `CortexConfigSchema` subject-scope superRefine)
  // requires every persisted `accept_subjects[]` entry to begin with the
  // RECEIVING stack's own scope `federated.{me}.{my-stack}.`. A PEER PRESENCE
  // subtree (`federated.{peer}.{peer-stack}.agent.>`) does NOT — persisting one
  // (the pre-fix `deriveAcceptSubjects` own ∪ peers behaviour) wrote a config the
  // daemon then REFUSED to boot (jc/default, 2026-06-26).
  //
  // Peer presence acceptance is NOT lost: the federation-reconciler
  // (`federation-reconciler.ts`) re-derives the FULL own ∪ peer accept-list from
  // the roster and applies it IN-MEMORY at runtime (`replaceArrayContents` on the
  // live gate object — never written to disk). So the on-disk config stays
  // boot-valid (own-scope only) while the running gate still admits each peer's
  // presence. `peers` is still written below for the gate's source-network
  // resolution; only the persisted accept-list narrows to own-scope.
  const acceptSubjects = ownAcceptSubjects({
    principal: stack.principalId,
    stack: stack.stackSlug,
  });

  // (d.0) cortex#1220 review blocker — enable / preserve the per-network
  // reconciler. Now that (d) narrows persisted `accept_subjects[]` to own-scope,
  // PEER presence is admitted ONLY by the federation-reconciler re-deriving the
  // own ∪ peer accept-list IN-MEMORY (see the comment above). But the reconciler
  // is per-network opt-in, default OFF (`federation-reconciler.ts` —
  // `if (network.reconcile?.enabled !== true) continue;`): an entry with no
  // `reconcile` block boots clean yet admits ZERO peer presence (the silent in=0
  // symptom), converting #1220's loud boot-refusal into a silent no-peers one. So:
  //   • FRESH join (no prior reconcile block) ⇒ enable it — the post-#1220 model
  //     makes the reconciler load-bearing for peer presence, and our live stacks
  //     already run it.
  //   • RE-join (a reconcile block already exists) ⇒ PRESERVE it verbatim, exactly
  //     as `announce_capabilities` is preserved below. A principal's explicit
  //     `reconcile.enabled: false` MUST survive a re-join (never forced back to
  //     true) — but we WARN loudly that peer presence will not be admitted while
  //     it stays off, so the silent-in=0 mode is at least announced.
  let reconcile: PolicyFederatedReconcile;
  if (priorEntry?.reconcile !== undefined) {
    reconcile = priorEntry.reconcile;
    if (!reconcile.enabled) {
      const warn =
        `network "${networkId}" re-joined with reconcile.enabled=false PRESERVED — the federation ` +
        `reconciler will NOT admit peer presence on this network, so roster peers will not appear ` +
        `(silent in=0). This PR persists own-scope accept_subjects only and relies on the reconciler ` +
        `to add peer presence in-memory. Set policy.federated.networks["${networkId}"].reconcile.enabled=true ` +
        `to admit peers.`;
      warnings.push(warn);
      steps.push(`WARN: ${warn}`);
    }
  } else {
    // Parse through the schema so the written block carries the canonical shape
    // (enabled:true + the schema-default interval); avoids hand-hardcoding.
    reconcile = PolicyFederatedReconcileSchema.parse({ enabled: true });
  }

  const entry: PolicyFederatedNetwork = {
    id: networkId,
    leaf_node: stack.leafNode ?? networkId,
    peers,
    accept_subjects: acceptSubjects,
    deny_subjects: [],
    // cortex#1220 review blocker — enabled on fresh join, preserved on re-join
    // (incl. an explicit enabled:false, with a loud WARN). See (d.0) above.
    reconcile,
    // #762 — PRESERVE the hand-authored announce_capabilities for this network.
    // `deriveJoinInputs` sources the caps the join announces INTO the roster from
    // exactly this config block, so blanking it to [] here would make a re-join
    // (or any later config-derived join) announce nothing → the roster empties
    // again, defeating the fix above. Carry the prior entry's value verbatim
    // (default [] only on a first join where no block exists yet).
    announce_capabilities: priorEntry?.announce_capabilities ?? [],
    max_hop: stack.maxHop ?? 1,
  };

  // (d) Merge the network into the federation config with registry-resolved
  // peers (DD-5) + the own-scope accept-subjects (#1220). Idempotent: replace the
  // entry keyed by network id, never append a duplicate.
  const merged = mergeNetwork(existing, entry);

  // (d.1) cortex#1220 — VALIDATE-BEFORE-WRITE. The rendered
  // policy.federated.networks[] MUST pass the SAME own-scope rule the daemon
  // enforces at boot (`isFederatedSubjectInOwnScope`, ADR 0001) — refuse to
  // persist a config that would fail boot rather than write it and brick the next
  // daemon start (the #1220 failure mode). Validates the WHOLE merged set: the
  // entry just built is own-scope by construction, but a STALE peer subtree left
  // by a pre-fix join surfaces here (self-heals when THAT network is re-joined —
  // the replace overwrites it — or is named in the error for manual removal)
  // instead of silently reappearing at boot.
  const expectedPrefix = ownFederatedSubjectScopePrefix(stack.principalId, stack.stackSlug);
  const outOfScope: string[] = [];
  for (const n of merged) {
    for (const [i, p] of n.accept_subjects.entries()) {
      if (!isFederatedSubjectInOwnScope(p, stack.principalId, stack.stackSlug)) {
        outOfScope.push(`networks["${n.id}"].accept_subjects[${i.toString()}] "${p}"`);
      }
    }
    for (const [i, p] of n.deny_subjects.entries()) {
      if (!isFederatedSubjectInOwnScope(p, stack.principalId, stack.stackSlug)) {
        outOfScope.push(`networks["${n.id}"].deny_subjects[${i.toString()}] "${p}"`);
      }
    }
  }
  if (outOfScope.length > 0) {
    return {
      ok: false,
      steps,
      reason:
        `refusing to write policy.federated.networks — ${outOfScope.length.toString()} accept/deny ` +
        `subject(s) fall outside this stack's own federated scope "${expectedPrefix}" and would fail ` +
        `daemon boot (ADR 0001 / cortex#1220): ${outOfScope.join("; ")}. Re-run join for the offending ` +
        `network to re-render its accept-list, or remove the stale entry from the config.`,
      ...(warnings.length > 0 && { warnings }),
    };
  }

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

    ports.configStore.writeNetworks(merged);
    steps.push(
      `wrote policy.federated.networks["${networkId}"] — ${peers.length.toString()} peer(s), ` +
        `accept ${acceptSubjects.join(", ")} (own-scope; peer presence added in-memory by the reconciler)`,
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
    const natsServer = ports.natsServer;

    // (e.0) #821 MAJOR-1 — a CHEAP pre-restart config-syntax gate (`nats-server
    // -c <cfg> -t`). This catches an obviously-broken config BEFORE the restart
    // that would crash the bus. It is NECESSARY-NOT-SUFFICIENT (it's a syntax
    // check — it did NOT catch the original #821 crash, which is a runtime
    // account-resolution failure), so it sits ON TOP of the account-required +
    // creds-exist + health-probe defenses, never replacing them. A `-t` FAILURE
    // means the config is definitely broken → refuse BEFORE restarting (nothing
    // to roll back: we have not restarted yet, and the leaf write is reverted by
    // restoring the snapshot to keep the on-disk config clean for the next try).
    // #821 item-2 — never-throws contract. validateConfig (and restart, below)
    // ultimately shell out via Bun.spawn, which THROWS SYNCHRONOUSLY on ENOENT
    // (launchctl/systemctl/nats-server not on PATH). joinNetwork is documented
    // "never throws", so guard the call: a thrown spawn error becomes a clean
    // failure verdict, not an uncaught stack trace that wedges the CLI.
    let validate: { ok: true } | { ok: false; reason: string };
    try {
      validate = await natsServer.validateConfig();
    } catch (err) {
      validate = {
        ok: false,
        reason: `nats-server config validation could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!validate.ok) {
      try {
        ports.leafFile.restoreLeafState(snapshot);
      } catch (err) {
        // Restore failed — surface it; we have NOT restarted, so the bus is still
        // up on its prior in-memory config, but the on-disk config now carries the
        // bad leaf. Report so the principal can clean up before the next restart.
        process.stderr.write(
          `network join: leaf snapshot restore after a failed -t gate also failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return {
        ok: false,
        steps,
        reason:
          `nats-server config validation (-t) failed before restart, refusing to restart ` +
          `(reverted the leaf write): ${validate.reason}`,
        network: entry,
        usedCache,
        resolvedPeers: peers.map((p) => p.principal_id),
        ...(warnings.length > 0 && { warnings }),
      };
    }

    // #821 — a restart that EXITS non-zero, OR one that exits 0 but leaves the
    // server DOWN (the community crash: `launchctl kickstart` returned 0, then
    // nats-server exited 1 on the bad leaf), must NOT be reported as healthy.
    // restartAndProbe couples the restart with the post-restart health probe so
    // BOTH the initial restart AND the rollback-recovery restart are judged by
    // the SAME standard — exit code is necessary-not-sufficient (#821 BLOCKER:
    // the recovery path previously trusted exit code alone and could claim the
    // bus was "restored" while it was DOWN).
    // #821 item-2 — restartAndProbe catches INTERNALLY so BOTH call sites (the
    // initial restart AND the rollback-recovery restart) honour the never-throws
    // contract. NatsServiceManager.restart()/isHealthy() shell out via Bun.spawn
    // (throws synchronously on ENOENT) / fetch; a throw here becomes a failure
    // result, never an uncaught escape from joinNetwork.
    const restartAndProbe = async (): Promise<
      { ok: true } | { ok: false; reason: string }
    > => {
      try {
        const r = await natsServer.restart();
        if (!r.ok) return { ok: false, reason: r.reason };
        const health = await natsServer.isHealthy();
        if (!health.healthy) {
          return {
            ok: false,
            reason: `nats-server did not come back up after restart (${health.reason})`,
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: `nats-server restart/probe could not run: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    };

    const initial = await restartAndProbe();

    if (!initial.ok) {
      // Restore the prior leaf state + re-restart to bring the bus back. A failed
      // join MUST NEVER leave the bus down. The recovery restart is HEALTH-PROBED
      // (not trusted by exit code) so we only claim "restored" when the bus is
      // verifiably back up; otherwise we escalate to manual intervention.
      let rollbackNote: string;
      try {
        ports.leafFile.restoreLeafState(snapshot);
        const recovery = await restartAndProbe();
        rollbackNote = recovery.ok
          ? "rolled back leaf config + restarted nats-server (bus restored to prior state, verified healthy)"
          : `rolled back leaf config but the recovery restart did NOT bring the bus back up (${recovery.reason}) — bus may be DOWN, intervene manually`;
      } catch (err) {
        rollbackNote = `rollback FAILED (${err instanceof Error ? err.message : String(err)}) — bus may be DOWN, intervene manually`;
      }
      steps.push(`WARN: ${rollbackNote}`);
      return {
        ok: false,
        steps,
        reason: `nats-server restart failed (${initial.reason}); ${rollbackNote}`,
        network: entry,
        usedCache,
        resolvedPeers: peers.map((p) => p.principal_id),
        warnings: [...warnings, rollbackNote],
      };
    }
    steps.push("restarted nats-server to load leaf config (verified healthy)");
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
 *
 * P1 (cortex#1086) — the roster-members → peers projection now lives in the
 * runtime-callable `buildRosterPeers` (`src/bus/agent-network/roster-read.ts`)
 * so the federation reconciler (P3) shares the exact same read. This is the
 * thin config-shape adapter: `RosterPeer` → `PolicyFederatedPeer`
 * (dropping the wire-segment view the config doesn't carry). Behavior-
 * preserving — `buildRosterPeers` lifted this loop verbatim.
 */
function buildPeers(
  localPrincipalId: string,
  roster: NetworkRosterResult,
): PolicyFederatedPeer[] {
  return buildRosterPeers(localPrincipalId, roster).map((p) => ({
    principal_id: p.principal_id,
    stack_id: p.stack_id,
    ...(p.principal_pubkey !== undefined && {
      principal_pubkey: p.principal_pubkey,
    }),
  }));
}

/**
 * Project a written {@link PolicyFederatedPeer} → the `{principal, stack}` wire
 * view {@link deriveAcceptSubjects} consumes (P2 #1087). The `stack` segment is
 * the part AFTER the `/` in `stack_id` (`{principal}/{stack}`); a malformed id
 * with no usable slash falls back to `default` (mirrors `roster-read`'s
 * `stackSlugOf`, so the accept-list segment matches the leaf-write/peer view).
 *
 * Exported for direct unit testing of the projection in isolation.
 */
export function peerToWireIdentity(
  peer: PolicyFederatedPeer,
): FederatedWireIdentity {
  const slash = peer.stack_id.indexOf("/");
  const stack =
    slash >= 0 && slash < peer.stack_id.length - 1
      ? peer.stack_id.slice(slash + 1)
      : "default";
  return { principal: peer.principal_id, stack };
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
 *   - remove the `include` directive from the base nats config,
 *   - delete the leaf include file,
 *   - restart the daemon.
 *
 * #801 — leave NEVER strips the base `-c <config>` plist arg. That config is
 * the BASE nats-server config the leaf files are `include`d into, not a
 * per-network artifact; removing it would leave nats-server unstartable.
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
  const warnings: string[] = [];

  // C-820 (leave symmetry) — BEFORE the local teardown, remove `networkId` from
  // each capability's registry `networks[]` (set-difference) so the principal
  // exits this ONE network's roster while staying in the others. This is the
  // inverse of join's union: join tags caps with the network on the registry,
  // leave un-tags them. A registry deregister FAILURE is NON-FATAL — the local
  // teardown still proceeds (the principal's bus must come down regardless), and
  // the failure is surfaced as a warning so it can be re-run when the registry
  // is reachable. The leave still reports `ok` because the local effect (the
  // one that keeps nats-server / cortex from talking to the left network)
  // succeeded. A `not-wired` registry port (no registryUrl on leave) skips this.
  const dereg = await ports.registry.deregisterFromNetwork(networkId);
  if (dereg.ok) {
    steps.push(`deregistered capabilities from network "${networkId}" roster (${dereg.note})`);
  } else {
    const warn =
      `registry deregister-from-network for "${networkId}" failed (${dereg.reason}) — ` +
      `the LOCAL leave completed, but the principal's capability tags were not retagged; ` +
      `re-run \`cortex network leave ${networkId}\` when the registry is reachable to exit the roster.`;
    warnings.push(warn);
    steps.push(`WARN: ${warn}`);
  }

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

    // #801 — DO NOT touch the plist `-c <config>` arg. That config (e.g.
    // local.conf) is the BASE nats-server config; the per-network leaf remotes
    // are `include`d INTO it, they are not the base config itself. Stripping
    // `-c <config>` on leave (even when no networks remain) leaves nats-server
    // with no config to load → unstartable (the #801 bug: jc/default leave
    // stripped `-c local.conf` and the bus would not come back up). Leave's
    // teardown is exactly: remove the policy.federated.networks[] entry, remove
    // the `include` directive, delete the leaf file. The base `-c` arg is
    // owned by stack provisioning, never by join/leave.
    if (ports.leafFile.list().length === 0) {
      steps.push(
        "no networks remain — base nats-server `-c <config>` arg left intact (#801)",
      );
    }
  } catch (err) {
    return {
      ok: false,
      steps,
      reason: `teardown write failed: ${err instanceof Error ? err.message : String(err)}`,
      remaining: remaining.map((n) => n.id),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  const restart = await ports.daemon.restart();
  if (!restart.ok) {
    return {
      ok: false,
      steps,
      reason: `config reverted but daemon restart failed: ${restart.reason}`,
      remaining: remaining.map((n) => n.id),
      ...(warnings.length > 0 && { warnings }),
    };
  }
  steps.push("restarted stack daemon");

  return {
    ok: true,
    steps,
    remaining: remaining.map((n) => n.id),
    ...(warnings.length > 0 && { warnings }),
  };
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
