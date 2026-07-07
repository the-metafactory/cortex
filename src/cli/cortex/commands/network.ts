#!/usr/bin/env bun
/**
 * `cortex network <subcommand>` — S4 (#738) the headline one-command join.
 *
 * Spec `docs/design-network-join-control-plane.md` §6 F4 + §9 ("feel like
 * TCP/IP"). Connecting a stack to a network used to be ~10 manual steps across
 * four Myelin layers + two config files + an out-of-band key swap (the §1
 * friction table). This command is the executable form: hand it a network name,
 * it does everything (DD-4).
 *
 *   join <network>     register → pull VERIFIED descriptor (DD-9; cached
 *                      fallback DD-10) → render leaf + load plist (DD-6) →
 *                      write policy.federated.networks[] with registry-resolved
 *                      peers (DD-5) + the OWN accept-subject → restart.
 *                      Idempotent (DD-4).
 *   status             leaf link state + joined networks + peers + counters.
 *   leave <network>    reverse it all, cleanly + idempotently.
 *
 * ## Wiring (the S1–S3 pieces this command composes)
 *
 *   - S1 `NetworkRegistryClient` — `fetchAndCache`/`loadCached`, pin+verify
 *     (DD-9). Wrapped by the {@link NetworkRegistryPort} adapter.
 *   - S1 `registerStackIdentity` (via provision-stack's register flow) —
 *     idempotent proof-of-possession registration.
 *   - S3 `renderLeafIncludeFile` + `leafIncludeFileName` — the leaf include
 *     file. S3 `ensureConfigArg`/`renderProgramArguments` — the plist loader.
 *   - The branded {@link VerifiedNetworkDescriptor} — only a signature-verified
 *     descriptor flows into the renderer (compiler-enforced, S3-review N2).
 *
 * ## SAFETY (S4 brief)
 *
 * The real adapters MUTATE the live deployment (leaf file, plist, config,
 * launchctl). The orchestration is pure over injected ports
 * (`network-lib.ts`); the live adapters live in `network-adapters.ts` and are
 * only constructed on a real invocation. `--dry-run` (the DEFAULT-safe posture
 * for `join`/`leave`) swaps in no-op effect adapters that record the intended
 * actions and print them WITHOUT touching disk or daemons — so an accidental
 * run during development is inert.
 *
 * Exit codes: 0 success · 1 operational failure · 2 usage error.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";

import { expandTilde, loadConfigWithAgents } from "../../../common/config/loader";
import type { LoadedConfig } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import { NetworkCache } from "../../../common/registry/network-cache";
import {
  materialFromSeedString,
  buildNetworkCreateClaim,
  postNetworkCreate,
  type StackIdentityMaterial,
  type SignedNetworkCreateBody,
} from "../../../bus/stack-provisioning";
// O-5 community-fleet role grant (ADR-0015). These runtime helpers live in
// cortex (src/cli/cortex/lib/discord-roles.ts) — NOT the metafactory-discord
// bundle the CLI tooling moved to (ADR-0017, epic #1171 S2): the daemon-side
// admit path cannot import from an external arc bundle. Admit's ASSIGN side
// moved to network-admit-adapters.ts (S5); reject's REMOVE side (shared with
// `secret revoke-member`, out of scope for S5) still uses these directly.
import {
  removeRole,
  resolveRoleId,
  loadConfig as loadDiscordConfig,
  resolveServerContext,
} from "../lib/discord-roles";

import {
  deriveJoinInputs,
  deriveLeaveInputs,
  tolerantReader,
  type ConfigReader,
} from "./network-derive";
import { DEFAULT_REGISTRY } from "./default-registry";
// network-leaf-package import removed — ADR-0015 retired O-4b / Model-A.

/**
 * #753 — the production config reader: `loadConfigWithAgents` wrapped so a
 * MISSING cortex.yaml is benign (a fully-flagged back-compat invocation works
 * on a machine with no config), while a present-but-broken file still surfaces
 * its parse/schema error. Tests inject their own reader through `dispatchNetwork`.
 */
const DEFAULT_READER: ConfigReader = tolerantReader(
  loadConfigWithAgents,
  (path) => existsSync(expandTilde(path)),
);

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";
import {
  joinNetwork,
  leaveNetwork,
  networkStatus,
  type JoiningStack,
} from "./network-lib";
import type { NetworkPorts } from "./network-ports";
import {
  buildLivePorts,
  buildDryRunPorts,
  buildLivePublicPorts,
  buildDryRunPublicPorts,
  type LivePortsConfig,
} from "./network-adapters";
import {
  joinPublic,
  leavePublic,
  type PublicJoinInputs,
} from "./network-public-lib";
import {
  derivePingInputs,
  pingPeer,
  type PingResult,
} from "./network-ping-lib";
import {
  deriveProvisionNames,
  provisionStack,
  type ProvisionInputs,
  type ProvisionPorts,
} from "./network-provision-lib";
import { buildLiveProvisionPorts } from "./network-provision-adapters";
import {
  makeLiveStack,
  type MakeLiveInputs,
  type MakeLivePorts,
} from "./network-make-live-lib";
import { buildLiveMakeLivePorts, buildResolverPreloadAdapter } from "./network-make-live-adapters";
import type { OperatorModeLeafPackage, NatsBaseIdentity } from "../../../common/nats/leaf-remote-renderer";
import { parseLoopbackListen } from "../../../common/nats/leaf-remote-renderer";
import {
  detectPubkey,
  looksLikeNkeyRole,
  samePubkey,
  toNkeyPubkey,
} from "../../../common/registry/pubkey-normalize";
import {
  runNetworkSecret,
  runNetworkKeyRotation,
  type SecretAction,
  type DeliveryMode,
  type SecretInputs,
  type KeyRotationInputs,
} from "./network-secret-lib";
import type { NetworkKeyRotationPorts } from "./network-secret-ports";
import {
  buildLiveSecretPorts,
  buildLiveKeyRotationPorts,
  hubAdminMaterialFromSeedFile,
} from "./network-secret-adapters";
import { fetchSealedLeafSecret } from "../../../common/registry/fetch-sealed-secret";
import { defaultKeyId } from "../../../common/crypto/network-encryption-policy";
import {
  resolveOwnAdmissionState,
  type OwnAdmissionState,
} from "../../../common/registry/admission-state";
import {
  createLiveProbeBus,
  type LiveProbeBus,
} from "./network-ping-adapters";
import { buildPingSignerFromConfig } from "./network-ping-signer";
import type { NetworkPingPorts } from "./network-ping-ports";
import {
  runDoctorChecks,
  type DoctorRunResult,
  type DoctorCheck,
} from "./network-doctor-lib";
import {
  buildDoctorConfigPort,
  buildMonitorPort,
} from "./network-doctor-adapters";
import type { NetworkDoctorPorts } from "./network-doctor-ports";
import {
  deriveHandoffState,
  gatherHandoffSignals,
  guardLeafUp,
  runHandoffStatus,
  type HandoffLeg,
  type HandoffReport,
} from "./network-handoff-lib";
import type { NetworkHandoffPorts } from "./network-handoff-ports";
import { buildLiveHandoffPorts } from "./network-handoff-adapters";
import {
  runNetworkAuthorize,
  type AuthorizeInputs,
  type AuthorizeReport,
} from "./network-authorize-lib";
import type { NetworkAuthorizePorts } from "./network-authorize-ports";
import { buildLiveAuthorizePorts } from "./network-authorize-adapters";
import {
  runNetworkAdmit,
  runNetworkReject,
  runNetworkListPending,
  renderPendingTable,
} from "./network-admit-lib";
import type { AdmitPorts, SecretPortsFactory } from "./network-admit-ports";
import { buildLiveAdmitPorts } from "./network-admit-adapters";

export { type ExitResult } from "./_shared/exit-result";
// Re-exported for backward compatibility: `SecretPortsFactory` is homed in
// network-admit-ports.ts (S5 #1586 review) so both network.ts and
// network-admit-adapters.ts import the SAME type without a circular import;
// external consumers (tests) still import it from here.
export type { SecretPortsFactory };

// =============================================================================
// Grammar
// =============================================================================

type NetworkSubcommand = "join" | "leave" | "status" | "create" | "ping" | "doctor" | "admit" | "reject" | "provision" | "make-live" | "secret" | "handoff" | "authorize";

/**
 * Default registry URL when neither --registry-url nor config provides one.
 * cortex#1228 — sourced from the single compiled-in {@link DEFAULT_REGISTRY}
 * anchor (the host that actually serves `/registry/pubkey`).
 */
const DEFAULT_REGISTRY_URL = DEFAULT_REGISTRY.url;

/**
 * #753 — default cortex.yaml path the config-deriver reads when no `--config`
 * is passed. Same canonical path as `cortex agents` (`agents.ts`). The
 * one-liner `cortex network join <network>` reads here.
 */
const DEFAULT_CONFIG_PATH = "~/.config/cortex/cortex.yaml";

/**
 * #800 — the cortex.yaml the stack's CORTEX daemon loads (the join's `--config`,
 * default {@link DEFAULT_CONFIG_PATH}). Threaded into the ports config so the
 * daemon-restart can LOCATE the daemon's launchd/systemd service by its
 * `--config` arg instead of guessing `ai.meta-factory.cortex.<stack-slug>`.
 */
function cortexConfigPathFromFlags(flags: FlagMap): string {
  return expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH);
}

const NETWORK_ID_RE = /^[a-z][a-z0-9-]*$/;
const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;
// S5 — capability id grammar (`<domain>.<entity>`, matches the schema's
// announce_capabilities[] rule) + principal-id grammar for the allowlist.
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const SPEC: SubcommandSpec<NetworkSubcommand> = {
  cliName: "network",
  subcommands: {
    join: {
      positionals: ["network"],
      flags: {
        // #753 — `--config` points the deriver at the cortex.yaml to read
        // principal / stack / seed / registry / nats-infra from. All other
        // value-flags below are now OPTIONAL OVERRIDES: present ⇒ wins;
        // absent ⇒ derived from this config (or convention). The one-liner is
        // `cortex network join <network>` with NO other flags.
        "--config": "value",
        "--principal": "value",
        "--stack": "value",
        "--registry-url": "value",
        "--registry-pubkey": "value",
        "--seed-path": "value",
        // C-791 — the principal ROOT seed (the FIRST stack's seed). Present ONLY
        // when joining a SECOND+ stack of an already-registered principal: the
        // register step then signs the add-stack claim with the root + fetch-
        // merges the existing stacks (mirrors `provision-stack register
        // --principal-seed`). Omit for a first-stack join (then `--seed-path` is
        // itself the root). The flag wins over config; no config field is
        // derived for it (no natural cortex.yaml field exists — see help).
        "--principal-seed": "value",
        "--creds": "value",
        "--account": "value",
        // C-1224 (ADR-0013 Model B) — the secret-authenticated leaf pipe. When
        // set, the join renders a leaf that authenticates to the hub via URL
        // userinfo (`tls://<user>:<secret>@host`) and binds the principal's OWN
        // local account, instead of a `.creds`-file leaf. Map to
        // stack.nats_infra.{leaf_secret,leaf_user}; `--leaf-user` defaults to the
        // principal id. The secret DISTRIBUTION is out-of-band (held PR5).
        "--leaf-secret": "value",
        "--leaf-user": "value",
        // O-3 (cortex#1053) — the operator-mode "leaf package" flags. When the
        // stack's bus is anonymous/hard-isolated (the #794 fail-fast input),
        // these let `cortex network join` AUTO-CONVERT it to operator-mode
        // (render the SOP §B0.1 blocks) instead of refusing. Map to
        // stack.nats_infra.{operator_jwt,account_jwt,system_account,
        // system_account_jwt}. O-4 supplies them via the register→issue
        // handshake; these flags/config fields are the manual/interim path.
        "--operator-jwt": "value",
        "--account-jwt": "value",
        "--system-account": "value",
        "--system-account-jwt": "value",
        "--nats-config": "value",
        "--plist": "value",
        // #763 — Linux/systemd: the nats-server systemd unit path (the
        // launchd plist's sibling). Maps to stack.nats_infra.unit_path.
        "--unit": "value",
        "--max-hop": "value",
        "--leaf-node": "value",
        // S5 (#739) — public-scope flags. `--capabilities` (comma-separated)
        // announces to the public index; `--allow` (comma-separated) is the
        // INBOUND allowlist (empty ⇒ deny-by-default, OQ1 safe). Only consumed
        // on `join public`; ignored on a federated join.
        "--capabilities": "value",
        "--allow": "value",
        // cortex#1485 (epic #1479, join-6) — opt-in guided-join. When set, the
        // leaf-up step is GATED on the 3-leg handoff state: it refuses (fails
        // closed) unless the seal leg is done AND the hub-authorize leg is
        // effectively done, instead of storming the hub with an unauthorized leaf.
        // OPT-IN, never the default. The hub-authorize leg now reads a REAL
        // registry signal (cortex#1498 — `cortex network authorize` stamps
        // `hub_authorized_at`); when that read is unreachable/unconfigured it
        // degrades to the documented undefined fallback, so --guided remains a
        // DELIBERATE-CONFIRMATION gate: --hub-authorized-confirmed lets the
        // member acknowledge an un-auto-verifiable leg — but NEVER overrides a
        // real negative (Sage #1499).
        "--guided": "bool",
        // cortex#1485 (Sage #1499) — member ATTESTATION for the guided-join gate:
        // "the hub owner has confirmed to me they applied my authorization". Under
        // --guided, upgrades an un-auto-verifiable (undefined) hub-authorize leg to
        // treated-done so the leaf-up step PROCEEDS — but NEVER overrides a real
        // negative (#1498) hub-authorize signal. Meaningless without --guided.
        "--hub-authorized-confirmed": "bool",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    leave: {
      positionals: ["network"],
      flags: {
        // #753 — same config-derivation seam as join (subset of inputs).
        "--config": "value",
        "--principal": "value",
        "--stack": "value",
        "--registry-url": "value",
        "--seed-path": "value",
        "--nats-config": "value",
        "--plist": "value",
        "--unit": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    status: {
      positionals: [],
      flags: {
        "--principal": "value",
        "--stack": "value",
        "--monitor-url": "value",
        // #814 — explicit cortex.yaml override (highest precedence). When
        // omitted, the status path resolves the NAMED stack's config from
        // --principal + the --stack slug, layout-aware (see runStatus). Without
        // this, status fell through to the default monolith ~/.config/cortex/
        // cortex.yaml and read the wrong file for a config-split stack — so a
        // joined config-split stack reported "no networks joined".
        "--config": "value",
      },
    },
    // #747 — signed-admin network create/update. Dry-run by DEFAULT (like
    // join): prints the claim it WOULD POST; `--apply` actually POSTs it to
    // `<registry-url>/networks/<network_id>`. The admin seed is an nkey seed
    // (SU…) — the same key shape `provision-stack` uses — so `admin_pubkey`
    // is consistent with how principal registration derives its pubkey.
    create: {
      positionals: ["network"],
      flags: {
        "--hub": "value",
        "--leaf-port": "value",
        "--admin-seed": "value",
        "--network-admins": "value",
        "--registry-url": "value",
        // #1598 — hub-mode / resolver-mode attestation (closed enums; the
        // registry re-validates and serves them on the SIGNED descriptor).
        "--hub-mode": "value",
        "--resolver-mode": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    // signal#113 P-11 (#56) — active federated reachability probe. Fires a
    // Direct `probe.echo` at <peer>, awaits the built-in echo on our own
    // `probe.reply.echo`, measures RTT, prints + returns the verdict per the
    // §3.3 taxonomy + exit codes (0 reachable / 2 not-configured / 3
    // no-responder / 4 timeout / 5 refused). Derives principal/stack from
    // cortex.yaml like join (#753).
    ping: {
      positionals: ["peer"],
      flags: {
        "--config": "value",
        "--principal": "value",
        "--stack": "value",
        // Direct-probe target assistant. Omitted ⇒ the target stack's reserved
        // DID (`did:mf:{target}-{target-stack}`).
        "--assistant": "value",
        // Topology selector ONLY — scopes peer resolution when the peer is
        // reachable on more than one shared network. NEVER a wire segment
        // (ADR-0002 §4).
        "--network": "value",
        // `ping -c` — number of echo probes. Default 1.
        "--count": "value",
        // Per-probe echo wait budget (ms). Default 2000.
        "--timeout": "value",
      },
    },
    // cortex#1484 (epic #1479) — verify the WHOLE federation path from the
    // joining member's own machine: config → local monitor → leaf established
    // → leaf account binding → a real echoed round-trip per configured peer.
    // Read-only (+ one bounded probe echo per peer, reusing `ping`'s
    // transport). Reports pass/fail/warn/skip + a fix + the responsible role
    // PER LEG, so a broken link pinpoints the failing leg instead of a bare
    // "not reachable". Derives principal/stack from cortex.yaml like status.
    doctor: {
      positionals: ["network"],
      flags: {
        "--config": "value",
        "--principal": "value",
        "--stack": "value",
        "--monitor-url": "value",
      },
    },
    // ADR-0015 — one-command admin admission decision. Signs an admission
    // decision claim → POSTs to `/admission-requests/:id/admit` → principal
    // is ADMITTED on the roster. Mints nothing (no arc nats add-bot).
    // Dry-run by DEFAULT: prints the claim it WOULD post; --apply executes.
    //
    // NOTE: --network is intentionally absent. The admission request's
    // network_id is set at register time (when the principal calls
    // POST /principals/:id/register). The admit subcommand reads the stored
    // request and acts on whatever network_id the registry recorded.
    // Tracking issue: cortex#1145 — thread network_id from register through
    // the admission gate so the stored row is always network-scoped.
    admit: {
      // C-1314 — request-id is OPTIONAL (trailing `?`): the discovery mode
      // `admit --list-pending` takes no request-id. The admit-a-request path
      // still validates its presence in runAdmit.
      positionals: ["request-id?"],
      flags: {
        "--admin-seed": "value",
        "--registry-url": "value",
        "--discord-member": "value",
        "--discord-server": "value",
        "--discord-guild": "value",
        "--discord-role": "value",
        "--apply": "bool",
        "--dry-run": "bool",
        // C-1314 — DISCOVERY mode. `cortex network admit --list-pending` admin-
        // signs a read (`x-admin-signed`) and GETs
        // `/admission-requests?status=<status>`, printing the queue so an admin
        // can find the request-id to admit. Read-only (no --apply; no request-id
        // positional). `--status` defaults to PENDING; `--network` filters the
        // returned rows client-side (the endpoint lists all networks at once).
        "--list-pending": "bool",
        "--status": "value",
        "--network": "value",
        // C-1316 — admit-and-seal. After the roster admission commits, admit ALSO
        // mints + seals + delivers the per-member leaf PSK (the `secret add-member`
        // motion), so an admitted peer is CONNECTABLE, not just rostered. The seal
        // runs the hub-local nats-server config through the same reload path as
        // `cortex network secret`, so it needs to know which hub config to edit.
        "--hub-config": "value",
        // Opt-out: commit the roster row ONLY, skip the seal (the rare
        // admit-without-seal case, or a fully-separable deployment where the
        // hub-admin ≠ the registry-admin and sealing is a genuinely separate step).
        "--roster-only": "bool",
        // cortex#1481 — force the seal-only path (registry seal + hub-owner
        // artifact, NEVER a local hub write) even when the auto-detected hub
        // locality would otherwise call the hub local. Distinct from
        // --roster-only: the seal (mint + deliver) STILL runs here.
        "--seal-only": "bool",
        // cortex#1481 — the hub's OWN federation account nkey-U, when the admin
        // already knows it. Rides the hub-owner artifact's `account:` field.
        "--hub-account": "value",
      },
    },
    // C-1348 (ADR-0015) — the admission DENIAL verb, the mirror of `admit`.
    // Signs an admission decision claim carrying decision:"reject" → POSTs to
    // `/admission-requests/:id/reject` → the PENDING row moves to REJECTED.
    // Grants + seals NOTHING (rejection has no roster row to make connectable),
    // so it omits admit's --hub-config/--roster-only seal controls. Dry-run by
    // DEFAULT: prints the claim it WOULD post; --apply executes. The row's
    // network_id is fixed at register time; the registry authorises and acts on
    // that stored value, so there is no network selector.
    //
    // C-1350 S3 — Tier-1 de-admission pairing: `--discord-member` (+
    // `--discord-guild/--discord-server/--discord-role`) mirrors admit's flag
    // block, but REMOVES the community-fleet role as a final non-fatal step. A
    // role-removal failure NEVER fails the reject (the decision already committed).
    reject: {
      positionals: ["request-id?"],
      flags: {
        "--admin-seed": "value",
        "--registry-url": "value",
        "--discord-member": "value",
        "--discord-server": "value",
        "--discord-guild": "value",
        "--discord-role": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    // G1d / T1 (cortex#1139, ADR-0013) — one-command sovereign account-topology
    // setup. Mints the principal's OWN nsc operator + a dedicated federation
    // account + a per-stack agents account (via arc), wires the local
    // federated.> export/import, ensures the signing seed, and writes
    // stack.nats_infra back — leaving the stack ready for `cortex network join`.
    // DRY-RUN by default (prints the plan); --apply mutates. `cortex network
    // join` auto-calls this when the stack isn't provisioned yet.
    provision: {
      positionals: ["stack"],
      flags: {
        "--config": "value",
        "--principal": "value",
        "--seed-path": "value",
        "--creds": "value",
        "--force": "bool",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    // C-1257 (PR7/#1225, ADR-0013 Model B) — the daemon-switch step. Lands a
    // provisioned stack's daemon onto its own agents account: mints the bus
    // creds under ANDREAS_<STACK>_AGENTS at nats.credsPath, teaches the local
    // NATS server the account (resolver_preload), restarts the nats-server +
    // the cortex daemon. DRY-RUN by default; --apply mutates. Run AFTER
    // `cortex network provision <stack> --apply`.
    "make-live": {
      positionals: ["stack"],
      flags: {
        "--config": "value",
        "--principal": "value",
        "--nats-config": "value",
        "--creds": "value",
        "--force": "bool",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    // ADR-0018 PR5b (#1240) — leaf-secret tooling. `cortex network secret
    // <action> <network> <member-pubkey>` where <action> ∈ {add-member,
    // revoke-member, rotate}. Hub-admin authority (Q5): mints the per-member
    // leaf PSK, writes the member's hub `authorization` user + reloads, and
    // seals/delivers (or revokes) the secret. DRY-RUN by default; --apply mutates.
    // C-1349 Slice 2 — `rotate-key <network>` (NO member positional — network-wide
    // K rotation) mints K′, re-seals every ADMITTED member, advances the hub K
    // store. `member` is OPTIONAL so rotate-key parses; the per-member actions
    // still require it (runSecret enforces).
    secret: {
      positionals: ["action", "network", "member?"],
      flags: {
        // The HUB-ADMIN seed (mints + seals + signs the registry delivery/revoke).
        "--admin-seed": "value",
        "--registry-url": "value",
        // The hub nats-server config the per-member authorization user lands in.
        "--hub-config": "value",
        // C-1349 Slice 1 — the HUB STACK's cortex config (config-split dir sentinel
        // or legacy monolith). Read-only: sourced for the per-network payload key
        // K (`policy.federated.networks[<net>].payload_key`) to seal alongside the
        // PSK. A config LOCATOR only — K is never a flag/second store. Defaults to
        // the standard `~/.config/cortex` path (like join/create/status).
        "--config": "value",
        "--stack": "value",
        // add-member: sealed (default, plug-and-play) | oob (trusted bootstrap).
        "--deliver": "value",
        // Override the hub leaf user (defaults to the member's principal id).
        "--leaf-user": "value",
        // C-1350 S3 — revoke-member de-admission pairing: `--discord-member`
        // (+ `--discord-guild/--discord-server/--discord-role`) mirrors admit's
        // flag block, REMOVING the community-fleet role as a final non-fatal step
        // after the hub-cut + registry REVOKE. A removal failure NEVER fails the
        // revoke (transport is already cut, the row already REVOKED).
        "--discord-member": "value",
        "--discord-server": "value",
        "--discord-guild": "value",
        "--discord-role": "value",
        "--apply": "bool",
        "--dry-run": "bool",
        // cortex#1481 — force the seal-only path (registry seal + hub-owner
        // artifact, NEVER a local hub write) for add-member/rotate, even when
        // the auto-detected hub locality would otherwise call the hub local.
        "--seal-only": "bool",
        // cortex#1481 — the hub's OWN federation account nkey-U, when the admin
        // already knows it. Rides the hub-owner artifact's `account:` field.
        "--hub-account": "value",
      },
    },
    // cortex#1485 (epic #1479, join-6) — the guided-join handoff STATE. A join is
    // a 3-leg handoff across ≤3 people/machines: seal (admin) → hub-authorize
    // (hub owner) → leaf-up (member). `cortex network handoff status <member>
    // --network <net>` shows, for that member, each leg's state (done | pending |
    // blocked), the outstanding next leg, and WHOSE job it is. `action` is the
    // verb (`status`); `member` is who the report is about. Read-only.
    handoff: {
      positionals: ["action", "member"],
      flags: {
        // The network whose handoff is being reported (required — a handoff is
        // always network-scoped).
        "--network": "value",
        // Mirrors doctor/status: locate the LOCAL stack's config + admission
        // read + leaf monitor for the seal/leaf-up leg signals.
        "--config": "value",
        "--principal": "value",
        "--stack": "value",
        "--monitor-url": "value",
        "--registry-url": "value",
        "--seed-path": "value",
      },
    },
    // cortex#1498 (epic #1479 follow-up) — the HUB-OWNER's side of the guided-
    // join handoff's hub-authorize leg. Run AFTER applying the member's leaf
    // `authorization` entry on the hub's OWN nats-server config (the #1481
    // hub-owner artifact) to stamp the registry's `hub_authorized_at`, the real
    // signal `handoff status` / `join --guided` read. Hub-admin authority — the
    // SAME allowlist `secret add-member`'s sealed delivery uses (ADR-0018 Q5).
    // Mints nothing; no local fs/nats-config write. Dry-run by DEFAULT.
    authorize: {
      positionals: ["member"],
      flags: {
        "--network": "value",
        "--admin-seed": "value",
        "--registry-url": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

// =============================================================================
// Helpers
// =============================================================================

function requireValueFlag(
  flags: FlagMap,
  name: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const v = flags[name];
  if (v === undefined) return { ok: false, reason: `${name} is required` };
  if (v === true || Array.isArray(v)) return { ok: false, reason: `${name} requires a value` };
  return { ok: true, value: v };
}

function optionalValueFlag(
  flags: FlagMap,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * #753 — build a single-key override fragment for the config-deriver from a
 * value-flag. When the flag is absent (or valueless) the fragment is empty, so
 * the deriver falls through to config / convention. `key` defaults to the
 * camelCase of the flag's tail; pass it explicitly where the names differ.
 * Spreading the result keeps the override object free of `undefined` keys
 * (which would otherwise shadow the config value with `undefined`).
 */
function readOverride(
  flags: FlagMap,
  flagName: string,
  key?: string,
): Record<string, string> {
  const v = optionalValueFlag(flags, flagName);
  if (v === undefined) return {};
  // Default key: strip leading `--`, drop hyphens → `principal` from
  // `--principal`. Callers pass an explicit `key` for the renamed inputs.
  const resolvedKey = key ?? flagName.replace(/^--/, "").replace(/-/g, "");
  return { [resolvedKey]: v };
}

// readLeafPackageFlag removed — ADR-0015 retired O-4b / --from-package / Model-A.

/** Resolve the stack slug from `--stack` (`{principal}/{slug}`) or default. */
function resolveStackSlug(
  principalId: string,
  stackFlag: string | undefined,
): { ok: true; slug: string } | { ok: false; reason: string } {
  if (stackFlag === undefined) return { ok: true, slug: "default" };
  const parts = stackFlag.split("/");
  if (parts.length !== 2 || parts[0] !== principalId) {
    return {
      ok: false,
      reason: `--stack "${stackFlag}" must be {principal}/{slug} with prefix matching --principal "${principalId}"`,
    };
  }
  const slug = parts[1] ?? "";
  if (!/^[a-z][a-z0-9_-]*$/.test(slug)) {
    return { ok: false, reason: `--stack slug "${slug}" must be letter-prefixed lowercase` };
  }
  return { ok: true, slug };
}

/** Config dir base — the same canonical path the daemon + the rest of the
 *  network lifecycle use. expandTilde reads $HOME (tests pin it). */
const CONFIG_DIR_BASE = "~/.config/cortex";

/**
 * #814 — resolve the cortex config path the `status` read should target for a
 * NAMED stack, layout-aware. A faithful TS mirror of `resolve_stack_config_path`
 * (scripts/lib/plist-render.sh) so the CLI status read and the install-time
 * plist render agree on which file a stack's `policy.federated.networks[]` lives
 * in:
 *
 *   - config-split (migration 0003 / #714): `<base>/<slug>/system/system.yaml`
 *     marker present ⇒ the per-stack sentinel `<base>/<slug>/<slug>.yaml` (the
 *     loader resolves configDir = dirname(<sentinel>) and composes the dir; the
 *     policy block is read from `<base>/<slug>/stacks/<slug>.yaml` by
 *     `stackConfigPath`, which derives it from THIS sentinel — #813).
 *   - legacy monolith: no per-stack dir ⇒ the root monolith — `cortex.yaml` for
 *     the `meta-factory` default-stack slug, `cortex.<slug>.yaml` otherwise.
 *
 * Directory layout takes precedence (same as the shell resolver + #813's
 * discovery). The returned path is fed into `cortexConfigPath` so the post-#813
 * `readNetworks`/`stackConfigPath` read the file the daemon actually loads.
 *
 * #814 review (MAJOR) — default-stack mapping. When `--stack` is omitted,
 * `resolveStackSlug` returns the sentinel slug `"default"`, but the locator
 * system's canonical bare-name default stack is `"meta-factory"`
 * (`config_file_to_slug`: `cortex.yaml` → `meta-factory`; `resolve_stack_config_path`
 * keys off that). So we map `"default"` → the `meta-factory` bare-name default
 * HERE (status-resolver scope only — NOT in `resolveStackSlug`, which would
 * ripple into join/leave) so the common no-`--stack` invocation resolves the
 * REAL default stack: `~/.config/cortex/meta-factory/meta-factory.yaml` under the
 * config-split layout, else the `~/.config/cortex/cortex.yaml` monolith — matching
 * the shell locator exactly. Without this, no-`--stack` resolved the nonexistent
 * `cortex.default.yaml` and falsely reported "no networks joined".
 */
function resolveStatusConfigPath(slug: string): string {
  const base = expandTilde(CONFIG_DIR_BASE);
  // The no-`--stack` sentinel `"default"` IS the `meta-factory` bare-name default
  // in the locator system (scoped to status; see doc comment above).
  const locatorSlug = slug === "default" ? "meta-factory" : slug;
  if (existsSync(join(base, locatorSlug, "system", "system.yaml"))) {
    // Config-split — point at the per-stack sentinel.
    return join(base, locatorSlug, `${locatorSlug}.yaml`);
  }
  // Legacy monolith. `meta-factory` is the bare-name default-stack special case.
  const filename = locatorSlug === "meta-factory" ? "cortex.yaml" : `cortex.${locatorSlug}.yaml`;
  return join(base, filename);
}

/**
 * #830 — resolve the LOCAL stack's config path for a network command, layout-aware:
 * explicit `--config` wins; otherwise the `--stack` flag (full `{principal}/{slug}`
 * or a bare slug) selects the slug and {@link resolveStatusConfigPath} maps it to
 * the split sentinel or the legacy monolith. Shared so `ping` and any future
 * command resolve identically to `status` and can't drift (the gap that made ping
 * read the flat default and report `not-configured` for a config-split peer).
 */
function resolveLocalStackConfigPath(flags: FlagMap): string {
  const explicitConfig = optionalValueFlag(flags, "--config");
  if (explicitConfig !== undefined) return expandTilde(explicitConfig);
  const stackFlag = optionalValueFlag(flags, "--stack");
  const slug =
    stackFlag === undefined
      ? "default"
      : stackFlag.includes("/")
        ? (stackFlag.split("/")[1] ?? "default")
        : stackFlag;
  return resolveStatusConfigPath(slug);
}

/**
 * `join`/`leave` mutate the live deployment. The DEFAULT is dry-run (safe);
 * `--apply` opts into real mutation. `--dry-run` is accepted explicitly too.
 * `--apply` and `--dry-run` together is a usage error.
 */
function resolveApply(
  flags: FlagMap,
): { ok: true; apply: boolean } | { ok: false; reason: string } {
  const apply = flags["--apply"] === true;
  const dry = flags["--dry-run"] === true;
  if (apply && dry) {
    return { ok: false, reason: "--apply and --dry-run are mutually exclusive" };
  }
  return { ok: true, apply };
}

// =============================================================================
// Subcommand handlers
// =============================================================================

/**
 * ADR-0018 PR5b (#1240) — plug-and-play leaf-secret auto-fetch for `join`.
 *
 * The locked #1240 constraint: the joiner NEVER handles a secret. When no leaf
 * secret is resolved from `--leaf-secret` / `stack.nats_infra.leaf_secret`,
 * `join` AUTO-fetches the sealed blob from the member PoP-read endpoint,
 * decrypts it with the joiner's OWN seed, and renders the leaf — fully
 * automatic. BEST-EFFORT + SOFT-CLOSED: any failure (not yet admitted, no
 * secret delivered, registry down, odd seed) returns `undefined` and the join
 * falls through to its existing behaviour, so this never breaks a join that
 * supplied its secret another way.
 */
type LeafSecretFetcher = typeof fetchSealedLeafSecret;
let joinLeafSecretFetcherOverride: LeafSecretFetcher | null = null;

/** Test-only — inject a fake leaf-secret fetcher for the join wiring. */
export function __setJoinLeafSecretFetcherForTests(f: LeafSecretFetcher | null): void {
  joinLeafSecretFetcherOverride = f;
}

/**
 * #1597 — where a fetched v2 per-member `.creds` file is installed. Deliberately
 * the `-leaf` suffixed name, NOT `defaultCredsPath`'s `<network>.creds`: the
 * derive convention path may carry a hand-placed Model-A file we must never
 * clobber. Tests inject a tmp dir via {@link __setLeafCredsInstallDirForTests}.
 */
const LEAF_CREDS_INSTALL_DIR = "~/.config/nats";
let leafCredsInstallDirOverride: string | null = null;

/** Test-only — redirect the v2 creds install dir to a tmp dir. */
export function __setLeafCredsInstallDirForTests(dir: string | null): void {
  leafCredsInstallDirOverride = dir;
}

function leafCredsInstallPath(networkId: string): string {
  const dir = leafCredsInstallDirOverride ?? expandTilde(LEAF_CREDS_INSTALL_DIR);
  return join(dir, `${networkId}-leaf.creds`);
}

/**
 * #1597 — install the fetched v2 credential file at the conventional path.
 * Written as a NEW same-dir tmp file EXCLUSIVELY created 0600 (flag "wx" — a
 * stale tmp from a crashed run is removed, never silently reused, so
 * `writeFileSync`'s create-only mode semantics always apply), then renamed
 * over the target: a direct overwrite of a looser pre-existing file would
 * expose the fresh credential group-readable until a trailing chmod (Sage
 * #1609). The tmp+rename keeps the text 0600 from creation to install AND
 * makes the replacement atomic. When the content already matches, the write
 * is skipped (re-join idempotency — no content/mtime churn) but a looser
 * pre-existing mode is still tightened to 0600. BOTH mutations — the write
 * and the mode-tighten — are reported to the caller, which surfaces them on
 * stderr (this runs in dry-run too — see the call site).
 */
function installLeafCreds(
  networkId: string,
  creds: string,
): { path: string; wrote: boolean; tightened: boolean } {
  const path = leafCredsInstallPath(networkId);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf-8");
  } catch (err) {
    // Only ENOENT means "not installed yet" — surface EACCES/EISDIR/etc. as
    // the real filesystem problem they are (the caller's catch reports them).
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    existing = undefined;
  }
  const wrote = existing !== creds;
  if (wrote) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    rmSync(tmp, { force: true }); // a stale tmp (crash + PID reuse) may be loose
    try {
      writeFileSync(tmp, creds, { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
    } catch (err) {
      // Never leave the credential text behind under the tmp name.
      try {
        rmSync(tmp, { force: true });
      } catch (_cleanupErr) {
        // Best-effort cleanup only — the write/rename failure is the real error.
      }
      throw err;
    }
  }
  // Tighten a looser mode ONLY when needed, and report it: even the
  // identical-content path is a (metadata) mutation when a pre-existing file
  // was group-readable. A fresh tmp+rename install is already 0600.
  const tightened = (statSync(path).mode & 0o777) !== 0o600;
  if (tightened) chmodSync(path, 0o600);
  return { path, wrote, tightened };
}

/**
 * The join-side result of the auto-fetch, discriminated by which leaf-auth
 * shape the sealed envelope delivered (#1597):
 *   - `secret-auth` (v1) — the Model-B shared-string pipe; join renders the
 *     URL-userinfo remote.
 *   - `creds-file` (v2)  — a per-member NSC user `.creds` was fetched and is
 *     ALREADY INSTALLED at `credsPath` (0600); join points the stack binding at
 *     it and renders the existing creds-file remote branch.
 */
type AutoFetchedLeafAuth =
  | { kind: "secret-auth"; leafSecret: string; leafUser: string; payloadKey?: string; payloadKeyKid?: string }
  | { kind: "creds-file"; credsPath: string; leafUser: string; payloadKey?: string; payloadKeyKid?: string };

async function maybeAutoFetchLeafSecret(
  networkId: string,
  inputs: { leafSecret?: string; seedPath: string; registryUrl: string; principal: string },
  /** #1597 (R7) — the member's OWN identities a v2 credential must be minted for. */
  expectedLeafUsers: readonly string[],
): Promise<AutoFetchedLeafAuth | undefined> {
  // Only when no leaf secret was resolved from flag/config (don't override an
  // explicit secret-auth join).
  if (inputs.leafSecret !== undefined) return undefined;

  const seedExpanded = expandTilde(inputs.seedPath);
  if (!existsSync(seedExpanded)) return undefined;

  let material;
  try {
    enforceChmod600(seedExpanded);
    const seed = await readFile(seedExpanded, "utf-8");
    material = materialFromSeedString(seed);
  } catch (_err) {
    // Best-effort: a missing/group-readable/odd seed means we cannot auto-fetch.
    // The join continues without an auto-secret (it may use creds, or fail later
    // with a clearer leaf-binding error). Safe to ignore here.
    return undefined;
  }

  const fetcher = joinLeafSecretFetcherOverride ?? fetchSealedLeafSecret;
  const res = await fetcher({
    registryUrl: inputs.registryUrl,
    networkId,
    principalId: inputs.principal,
    material,
    expectedLeafUsers,
  });
  if (!res.ok) return undefined;

  // #1597 — a v2 envelope delivered a per-member `.creds` file (operator-mode
  // hub). Install it NOW, before the ports split: the #821 existence preflight
  // is a pure read in BOTH live and dry-run, so the file must exist for either
  // mode to render a truthful plan (the issue pins this ordering: "the #821
  // existence preflight passes because the file was just written"). This is a
  // DELIBERATE carve-out from the "dry-run touches nothing" contract — it
  // installs only the member's OWN delivered credential at its conventional
  // 0600 path (the same member-local class as the enforceChmod600 above); the
  // nats config / plist / registry writes all stay behind --apply. EVERY
  // mutation this carve-out performs — a content write AND a mode tighten —
  // is surfaced by the stderr notice below, so dry-run output stays honest.
  if (res.kind === "creds") {
    let install: { path: string; wrote: boolean; tightened: boolean };
    try {
      install = installLeafCreds(networkId, res.creds);
    } catch (err) {
      // Best-effort like every other auto-fetch failure: fall through to the
      // existing join behaviour, surfacing why on stderr (never the creds).
      // On a v2-only hub with nothing at the derive-time creds path this is
      // NOT silent: the #821 existence preflight then fails the join loudly.
      process.stderr.write(
        `cortex network join: fetched a v2 leaf credential for "${networkId}" but could not ` +
          `install it: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return undefined;
    }
    if (install.wrote || install.tightened) {
      const action = install.wrote
        ? "installed the fetched per-member leaf credential file at"
        : "tightened the mode of the leaf credential file at";
      process.stderr.write(
        `cortex network join: ${action} ${install.path} (0600). NOTE: this happens even ` +
          `without --apply, so the leaf-file preflight previews truthfully; all other join ` +
          `mutations stay behind --apply.\n`,
      );
    }
    return {
      kind: "creds-file",
      credsPath: install.path,
      leafUser: res.leafUser,
      ...(res.payloadKey !== undefined && { payloadKey: res.payloadKey }),
      ...(res.payloadKeyKid !== undefined && { payloadKeyKid: res.payloadKeyKid }),
    };
  }

  return {
    kind: "secret-auth",
    leafSecret: res.leafPsk,
    leafUser: res.leafUser,
    // C-1349 Slice 1 — carry the sealed payload key K (+ kid) through to the
    // join so it installs `encryption: enabled` + `payload_key` into the stack
    // config. Absent on encryption-off networks / old blobs. K never logged.
    ...(res.payloadKey !== undefined && { payloadKey: res.payloadKey }),
    ...(res.payloadKeyKid !== undefined && { payloadKeyKid: res.payloadKeyKid }),
  };
}

/**
 * C-1315 — turn a classified admission state into the actionable message a
 * Model-B joiner needs, REPLACING the misleading legacy `.creds not found (#821)`
 * preflight. Returns `undefined` for states we can't explain (keep the original
 * error). Every message states plainly that a legacy `.creds` file is NOT the fix.
 */
export function joinBlockerMessage(networkId: string, s: OwnAdmissionState): string | undefined {
  const seal = `cortex network secret add-member ${networkId} ${s.peerPubkey} --apply`;
  switch (s.state) {
    case "no-row":
      return (
        `no admission request exists for network "${networkId}" — register first with ` +
        `\`cortex provision-stack register <principal> --network ${networkId} --registry-url <url> --seed-path <seed>\`, ` +
        `then have an admin admit + seal. (This is a Model-B secret-auth join; a legacy .creds file is NOT the fix.)`
      );
    case "pending":
      return (
        `admission request ${s.requestId ?? "(unknown)"} for "${networkId}" is PENDING — give this request-id to a ` +
        `network admin to admit (\`cortex network admit ${s.requestId ?? "<id>"} --apply\`), then re-run join. ` +
        `No sealed leaf secret has been delivered yet; a legacy .creds file is NOT the fix.`
      );
    case "admitted-unsealed":
      return (
        `admission request ${s.requestId ?? "(unknown)"} for "${networkId}" is ADMITTED, but the sealed leaf secret ` +
        `has not been delivered — ask an admin to run \`${seal}\`. \`cortex network join\` then auto-fetches + ` +
        `unseals it (you never handle a raw secret). A legacy .creds file is NOT the fix.`
      );
    case "admitted-sealed":
      return (
        `admission request ${s.requestId ?? "(unknown)"} for "${networkId}" is ADMITTED and a sealed leaf secret ` +
        `EXISTS, but this stack could not open it — it is likely sealed to a different pubkey or corrupted. Verify ` +
        `this stack's registered pubkey (${s.peerPubkey}) matches what the admin sealed to, or ask them to re-seal: \`${seal}\`.`
      );
    case "revoked":
      return (
        `admission for "${networkId}" was REVOKED (request ${s.requestId ?? "(unknown)"}` +
        `${s.updatedAt !== undefined ? ` on ${s.updatedAt}` : ""}) — membership was withdrawn. ` +
        `Run \`cortex network leave ${networkId} --apply\` to clean up the dead leaf, then re-register or ` +
        `contact a network admin to re-join. A legacy .creds file is NOT the fix.`
      );
    case "rejected":
      return (
        `admission request ${s.requestId ?? "(unknown)"} for "${networkId}" was REJECTED by a network admin. ` +
        `Contact them or re-register. A legacy .creds file is NOT the fix.`
      );
    default:
      return undefined; // unknown status — keep the original error
  }
}

/**
 * C-1315 — decide whether a failed join's `#821` creds-preflight error should be
 * REPLACED with the actionable Model-B admission-state message. Pure + exported
 * so the invariant is unit-testable. The rewrite is confined to the Model-B
 * no-secret path; it must fire ONLY when ALL hold:
 *   - the join failed (`!joinOk`),
 *   - no leaf secret was resolved (flag/config/auto-fetch) — else it's not the
 *     no-secret path,
 *   - NO explicit `--creds` flag was given — an explicit `--creds` join opted
 *     into creds-file (Model-A) auth, so a missing/typo'd creds path is a genuine
 *     "creds not found" error, NOT a Model-B admission gap; keep it verbatim
 *     (review major, #1397), and
 *   - the failure carries the `cortex#821` preflight marker.
 */
export function shouldReplaceCredsPreflightError(args: {
  joinOk: boolean;
  resolvedLeafSecret: string | undefined;
  explicitCredsFlag: string | undefined;
  reason: unknown;
}): boolean {
  return (
    !args.joinOk &&
    args.resolvedLeafSecret === undefined &&
    args.explicitCredsFlag === undefined &&
    typeof args.reason === "string" &&
    args.reason.includes("cortex#821")
  );
}

/**
 * C-1315 — when a join fails the Model-B creds preflight (#821) with no resolved
 * leaf secret, probe the joiner's OWN admission row (PoP `/mine` read) and return
 * the actionable state message. Best-effort: any inability to probe (no seed on
 * disk, unreadable seed, registry unreachable) returns `undefined` so the caller
 * keeps the original error rather than inventing a misleading one.
 */
async function classifyModelBJoinBlocker(
  networkId: string,
  inputs: { seedPath: string; registryUrl: string; principal: string },
): Promise<string | undefined> {
  const seedExpanded = expandTilde(inputs.seedPath);
  if (!existsSync(seedExpanded)) return undefined;
  let material;
  try {
    enforceChmod600(seedExpanded);
    const seed = await readFile(seedExpanded, "utf-8");
    material = materialFromSeedString(seed);
  } catch (_err) {
    // Can't load the stack identity → can't probe; keep the original error. Safe.
    return undefined;
  }
  const probe = await resolveOwnAdmissionState(
    { registryUrl: inputs.registryUrl, principalId: inputs.principal, material },
    networkId,
  );
  if (!probe.ok) return undefined; // registry unreachable/not configured → keep original
  return joinBlockerMessage(networkId, probe.state);
}

async function runJoin(
  networkId: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  provisionPortsFactory: ProvisionPortsFactory,
  // cortex#1485 (Sage #1499) — the SAME injectable handoff-ports factory the
  // `handoff` command uses, so the `--guided` guard reads the leg signals through
  // the live hub-auth port and picks up the #1498 real read automatically once
  // wired (no code change), and CLI tests can inject a fake to drive both guard
  // branches.
  handoffPortsFactory: HandoffPortsFactory,
): Promise<ExitResult> {
  // S5 (#739) — `join public` is the open-square opt-in, structurally distinct
  // from a federated join (no leaf, no creds/account, no peers). Route it to
  // the public path BEFORE the federated network-id grammar check ("public" is
  // the literal scope name, not a network id).
  if (networkId === "public") {
    return runJoinPublic(flags, json);
  }
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("join", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }

  // cortex#1139 — plug-and-play: if the stack hasn't been provisioned (no
  // dedicated federation + agents account in config), auto-run `cortex network
  // provision` first so a single `join` stands the whole substrate up. On an
  // --apply provision failure we abort (a join with no account tree is doomed);
  // otherwise we prepend the provision output and continue.
  const autoProv = await maybeAutoProvision(flags, json, load, provisionPortsFactory);
  if (autoProv.ran && (!autoProv.provisionedAfter || autoProv.provisionFailed)) {
    // Provision ran but the stack isn't (yet) provisioned for THIS invocation —
    // a dry-run (nothing written) or a failed apply. Surface the provision
    // output + guidance; don't attempt a doomed join in the same run.
    const guidance = autoProv.provisionFailed
      ? ""
      : json
        ? ""
        : "\ncortex network join: re-run after `cortex network provision <stack> --apply` to join.\n";
    return autoProv.provisionFailed
      ? { exitCode: 1, stdout: "", stderr: autoProv.output }
      : { exitCode: 0, stdout: autoProv.output + guidance, stderr: "" };
  }
  const provPrefix = autoProv.output;

  // #753 — derive principal / stack / seed / registry / nats-infra (config +
  // convention), with each flag surviving as an optional override. Config-load
  // errors (bad YAML, schema violations) surface as an op-error with the
  // loader's message; a derivable-but-missing required value surfaces as a
  // usage error naming the config field.
  let derived;
  try {
    derived = deriveJoinInputs(
      networkId,
      {
        ...readOverride(flags, "--principal"),
        ...readOverride(flags, "--stack", "stack"),
        ...readOverride(flags, "--seed-path", "seedPath"),
        ...readOverride(flags, "--registry-url", "registryUrl"),
        ...readOverride(flags, "--registry-pubkey", "registryPubkey"),
        ...readOverride(flags, "--nats-config", "natsConfigPath"),
        ...readOverride(flags, "--plist", "plistPath"),
        ...readOverride(flags, "--unit", "unitPath"),
        ...readOverride(flags, "--account", "account"),
        ...readOverride(flags, "--creds", "credsPath"),
        // C-1224 (ADR-0013 Model B) — secret-auth leaf overrides.
        ...readOverride(flags, "--leaf-secret", "leafSecret"),
        ...readOverride(flags, "--leaf-user", "leafUser"),
        // O-3 (cortex#1053) — operator-mode leaf-package overrides.
        ...readOverride(flags, "--operator-jwt", "operatorJwt"),
        ...readOverride(flags, "--account-jwt", "accountJwt"),
        ...readOverride(flags, "--system-account", "systemAccount"),
        ...readOverride(flags, "--system-account-jwt", "systemAccountJwt"),
        // (--from-package removed — ADR-0015 retired O-4b / Model-A)
      },
      expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH),
      load,
    );
  } catch (err) {
    return opError("join", `config load failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  if (!derived.ok || derived.inputs === undefined) {
    return usageError("join", derived.reason ?? "could not derive join inputs", json);
  }
  const inputs = derived.inputs;

  // cortex#1228 — TOFU is NEVER silent. A custom (non-default) registry with no
  // pinned pubkey is trusted-on-first-use; surface a loud warning so the
  // principal knows a network-path attacker could substitute the anchor. The
  // default metafactory registry is pre-pinned (compiled-in) and never reaches
  // this branch. Folded into the returned ExitResult.stderr (below) so it is
  // both visible on the terminal AND captured by the CLI test harness.
  const tofuWarning =
    inputs.registryTofu === true
      ? `cortex network join: WARNING — registry ${inputs.registryUrl} is a custom ` +
        `(non-default) registry with NO pinned pubkey. Trusting it on first use (TOFU): ` +
        `a network-path attacker could substitute their own trust anchor. Pin it with ` +
        `--registry-pubkey <key> or policy.federated.registry.pubkey, or join the default ` +
        `metafactory network (${DEFAULT_REGISTRY.url}, pre-pinned) with no --registry-url.\n`
      : undefined;

  // Grammar checks on the RESOLVED principal (derived or flagged).
  if (!PRINCIPAL_ID_RE.test(inputs.principal)) {
    return usageError("join", `principal "${inputs.principal}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  const slugRes = resolveStackSlug(inputs.principal, inputs.stack);
  if (!slugRes.ok) return usageError("join", slugRes.reason, json);

  const maxHopRaw = optionalValueFlag(flags, "--max-hop");
  let maxHop: number | undefined;
  if (maxHopRaw !== undefined) {
    maxHop = Number.parseInt(maxHopRaw, 10);
    if (!Number.isInteger(maxHop) || maxHop < 0) {
      return usageError("join", `--max-hop "${maxHopRaw}" must be a non-negative integer`, json);
    }
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("join", applyRes.reason, json);

  // ADR-0018 PR5b — plug-and-play: when no leaf secret came from flag/config,
  // auto-fetch + unseal it from the admission gate (the joiner never handles a
  // secret). Best-effort: undefined ⇒ fall through to the existing behaviour.
  //
  // #1597 (R7) — the member's OWN identities a fetched v2 per-member credential
  // must be minted for: both the flag/locator-honouring identity (the admission
  // row's principal) and the boot-pinned identity (C-1436/C-1364 — what the
  // daemon stamps on the wire), in `{principal}/{stack}` and bare-principal
  // forms (v1's leaf_user convention is the bare principal id). Every entry is
  // one of OUR identities, so the set stays a strict R7 guard: a credential
  // minted for a different member can never match.
  const expectedLeafUsers = [
    ...new Set([
      `${inputs.principal}/${slugRes.slug}`,
      inputs.principal,
      `${inputs.bootPrincipal}/${inputs.bootStackSlug}`,
      inputs.bootPrincipal,
    ]),
  ];
  const autoAuth = await maybeAutoFetchLeafSecret(networkId, inputs, expectedLeafUsers);
  const autoSecret = autoAuth?.kind === "secret-auth" ? autoAuth : undefined;
  const resolvedLeafSecret = inputs.leafSecret ?? autoSecret?.leafSecret;
  const resolvedLeafUser = inputs.leafUser ?? autoSecret?.leafUser;
  // #1597 — a fetched v2 credential file was installed at its conventional
  // 0600 path: point the stack binding THERE (instead of the derive-time creds
  // path) so joinNetwork renders the existing creds-file remote branch — the
  // exact shape production operator-mode leaves run. The #821 existence
  // preflight passes because the file was just written.
  const resolvedCredsPath =
    autoAuth?.kind === "creds-file" ? autoAuth.credsPath : expandTilde(inputs.credsPath);
  // C-1349 Slice 1 — the sealed envelope's payload key K (+ kid), when the admin
  // sealed one via `secret add-member`/`rotate`. Present ⇒ join writes
  // `encryption: enabled` + `payload_key` (+ kid) into stacks/<slug>.yaml.
  // Rides BOTH envelope versions (#1597).
  const resolvedPayloadKey = autoAuth?.payloadKey;
  const resolvedPayloadKeyKid = autoAuth?.payloadKeyKid;

  const stack: JoiningStack = {
    // C-1436 — the own-scope federation identity's PRINCIPAL segment MUST derive
    // from `config.principal.id` (via `inputs.bootPrincipal`), the SAME single
    // authority the daemon boot validator pins to (`CortexConfigSchema` federated
    // subject-scope superRefine → `config.principal.id`) and the runtime stamps
    // onto the wire. `inputs.principal` is the flag/locator-honouring principal and
    // stays the write-path target per ADR-0004 DA-5 — but a `--principal` override
    // (or a `stack.id` principal-half) that differs from `principal.id` would make
    // the guard validate `federated.{flag}.` while boot enforces `federated.{config}.`,
    // letting a config pass the join own-scope guard yet fail daemon boot (or be
    // falsely refused). NOTE — deliberately NOT `deriveStackId().principal` (the
    // C-1364 stack-axis pattern does not carry over): on the override path that
    // returns the `stack.id` principal-half, which is NOT the wire principal. Pin
    // the guard to `bootPrincipal` so guard + boot can never split. See cortex#1436.
    principalId: inputs.bootPrincipal,
    // C-1364 — the own-scope federation identity MUST derive from `stack.id` via
    // `deriveStackId` (ADR-0004), the SAME single authority the daemon boot
    // validator uses (`CortexConfigSchema` federated subject-scope superRefine).
    // `slugRes.slug` (below) is the flag/locator-honouring slug and stays the
    // write-path target per ADR-0004 DA-5 — but a `--stack` override or a drifted
    // stack (locator slug ≠ `stack.id` trailing segment) would make it diverge
    // from what boot enforces, letting a config pass the join own-scope guard yet
    // fail daemon boot (or be falsely refused). Pin the guard to `bootStackSlug`
    // so guard + boot can never split. See cortex#1364.
    stackSlug: inputs.bootStackSlug,
    credentials: resolvedCredsPath,
    account: inputs.account,
    // C-1224 (ADR-0013 Model B) — pass the secret-auth leaf material (when
    // resolved, including PR5b's auto-fetched leaf PSK) so the join renders a
    // secret-auth pipe binding the principal's OWN local account instead of a
    // `.creds`-file leaf.
    ...(resolvedLeafSecret !== undefined && { leafSecret: resolvedLeafSecret }),
    ...(resolvedLeafUser !== undefined && { leafUser: resolvedLeafUser }),
    // C-1349 Slice 1 — sealed payload key K (+ kid) → join installs encryption.
    ...(resolvedPayloadKey !== undefined && { payloadKey: resolvedPayloadKey }),
    ...(resolvedPayloadKeyKid !== undefined && { payloadKeyId: resolvedPayloadKeyKid }),
    leafNode: optionalValueFlag(flags, "--leaf-node"),
    maxHop,
    // O-3 (cortex#1053) — pass the operator-mode leaf package (when resolved)
    // so join auto-converts an anonymous bus instead of fail-fasting (#794).
    ...(inputs.operatorModePackage !== undefined && {
      operatorModePackage: inputs.operatorModePackage,
    }),
  };

  const cfg = portsConfigFromInputs(networkId, inputs, slugRes.slug, flags);

  // cortex#1485 (epic #1479, join-6; Sage #1499) — OPT-IN guided-join gate. When
  // `--guided` is set, the leaf-up step is refused (fail-closed) unless the
  // 3-leg handoff (seal → hub-authorize → leaf-up) is clear to bring the leaf
  // up — so a member never storms the hub with an unauthorized leaf (the
  // metafactory-community Authorization-Violation window). It reads the leg
  // signals through the SAME injected handoff-ports factory `handoff status`
  // uses (via the shared `gatherHandoffSignals`), so the #1498 real
  // hub-authorize read is picked up automatically once wired — no code change
  // here. Because that read is a documented stub TODAY (hub-authorize always
  // undefined), --guided is a DELIBERATE-CONFIRMATION gate rather than an
  // unconditional block: `--hub-authorized-confirmed` is the member attesting
  // "the hub owner confirmed my authorization", which upgrades the
  // un-auto-verifiable leg — but NEVER a real negative (#1498). This is
  // deliberately NOT the default: without the attestation path it would block
  // every join today.
  if (flags["--guided"] === true) {
    const handoffPorts = handoffPortsFactory(cfg, inputs.policyNetworks);
    // member == the joining principal — this IS the local stack, so the leaf-up
    // leg reads local `/leafz` (though the guard depends only on seal +
    // hub-authorize).
    const { signals } = await gatherHandoffSignals(handoffPorts, {
      networkId,
      member: inputs.principal,
      selfPrincipal: inputs.principal,
    });
    const attested = flags["--hub-authorized-confirmed"] === true;
    const state = deriveHandoffState(signals, { attested });
    const guard = guardLeafUp(state, networkId);
    if (!guard.allowed) {
      return opError("join", guard.message, json);
    }
  }

  const ports = applyRes.apply ? buildLivePorts(cfg) : buildDryRunPorts(cfg);

  const res = await joinNetwork(networkId, stack, ports);

  // C-1315 — when the join fails the Model-B creds preflight (#821) and no leaf
  // secret was resolved (flag/config/auto-fetch), the REAL blocker is almost
  // always an admission-state gap (not yet admitted / sealed delivery missing /
  // revoked), NOT a missing legacy .creds file. Probe the joiner's own admission
  // row and REPLACE the misleading message with the actionable state. Only fires
  // on the secret-auth (Model-B) no-secret path; an explicit --creds / --leaf-
  // secret join, or a registry we can't reach, keeps the original #821 error.
  let effectiveReason = res.reason;
  if (
    shouldReplaceCredsPreflightError({
      joinOk: res.ok,
      resolvedLeafSecret,
      explicitCredsFlag: optionalValueFlag(flags, "--creds"),
      reason: res.reason,
    })
  ) {
    const actionable = await classifyModelBJoinBlocker(networkId, {
      seedPath: inputs.seedPath,
      registryUrl: inputs.registryUrl,
      principal: inputs.principal,
    });
    if (actionable !== undefined) effectiveReason = actionable;
  }

  const flow = renderFlowResult("join", networkId, res.ok, effectiveReason, res.steps, applyRes.apply, json, {
    used_cache: res.usedCache === true ? "true" : "false",
    peers: (res.resolvedPeers ?? []).join(","),
  });
  // cortex#1228 — prepend the custom-registry TOFU warning to stderr (when set)
  // so it is surfaced regardless of the flow's success/JSON mode.
  const withTofu =
    tofuWarning !== undefined ? { ...flow, stderr: tofuWarning + flow.stderr } : flow;
  // cortex#1139 — prepend any auto-provision output so the join transcript shows
  // the substrate setup that ran first (to stdout on success, stderr on failure).
  if (provPrefix === "") return withTofu;
  return withTofu.exitCode === 0
    ? { ...withTofu, stdout: provPrefix + withTofu.stdout }
    : { ...withTofu, stderr: provPrefix + withTofu.stderr };
}

async function runLeave(
  networkId: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
): Promise<ExitResult> {
  // S5 (#739) — `leave public` reverses the open-square opt-in.
  if (networkId === "public") {
    return runLeavePublic(flags, json);
  }
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("leave", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }

  // #753 — derive principal / stack / nats-config / plist (the leave subset).
  let derived;
  try {
    derived = deriveLeaveInputs(
      {
        ...readOverride(flags, "--principal"),
        ...readOverride(flags, "--stack", "stack"),
        ...readOverride(flags, "--nats-config", "natsConfigPath"),
        ...readOverride(flags, "--plist", "plistPath"),
        ...readOverride(flags, "--unit", "unitPath"),
        // C-820 — registry coordinates for the leave-side cap retag (optional).
        ...readOverride(flags, "--registry-url", "registryUrl"),
        ...readOverride(flags, "--registry-pubkey", "registryPubkey"),
        ...readOverride(flags, "--seed-path", "seedPath"),
      },
      expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH),
      load,
    );
  } catch (err) {
    return opError("leave", `config load failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  if (!derived.ok || derived.inputs === undefined) {
    return usageError("leave", derived.reason ?? "could not derive leave inputs", json);
  }
  const inputs = derived.inputs;

  const slugRes = resolveStackSlug(inputs.principal, inputs.stack);
  if (!slugRes.ok) return usageError("leave", slugRes.reason, json);
  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("leave", applyRes.reason, json);

  const cfg: LivePortsConfig = {
    networkId,
    principalId: inputs.principal,
    stackId: `${inputs.principal}/${slugRes.slug}`,
    natsConfigPath: inputs.natsConfigPath,
    // #763 — platform-resolved descriptor (plist on macOS, unit on Linux).
    ...(inputs.plistPath !== undefined && { plistPath: inputs.plistPath }),
    ...(inputs.unitPath !== undefined && { unitPath: inputs.unitPath }),
    platform: inputs.platform,
    // #800 — locate the daemon service for the post-leave restart.
    cortexConfigPath: cortexConfigPathFromFlags(flags),
    // C-820 — registry coordinates for the leave-side cap retag (the inverse of
    // join's union). All optional: absent ⇒ the registry deregister is skipped
    // (the local leave still completes, with a warning).
    ...(inputs.registryUrl !== undefined && { registryUrl: inputs.registryUrl }),
    ...(inputs.registryPubkey !== undefined && { registryPubkey: inputs.registryPubkey }),
    ...(inputs.seedPath !== undefined && { seedPath: inputs.seedPath }),
  };
  const ports = applyRes.apply ? buildLivePorts(cfg) : buildDryRunPorts(cfg);

  const res = await leaveNetwork(networkId, ports);
  return renderFlowResult("leave", networkId, res.ok, res.reason, res.steps, applyRes.apply, json, {
    not_joined: res.notJoined === true ? "true" : "false",
    remaining: (res.remaining ?? []).join(","),
  });
}

async function runStatus(
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
): Promise<ExitResult> {
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("status", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("status", slugRes.reason, json);

  // #814 — point the read at the NAMED stack's actual config. An explicit
  // `--config` wins (highest precedence): the ternary below injects the resolved
  // path ONLY when `--config` is undefined, so an explicit `--config` flows
  // through untouched to cortexConfigPathFromFlags. When omitted, resolve the
  // config path layout-aware from --principal + the --stack slug (mirroring
  // resolve_stack_config_path) and thread it in as `--config`, so the post-#813
  // readNetworks/stackConfigPath read the file the stack's daemon actually loads
  // instead of the default monolith. Previously status fell through to
  // ~/.config/cortex/cortex.yaml and reported a joined config-split stack as
  // "no networks joined".
  const statusFlags: FlagMap =
    optionalValueFlag(flags, "--config") === undefined
      ? { ...flags, "--config": resolveStatusConfigPath(slugRes.slug) }
      : flags;

  const cfg = portsConfig("", principalRes.value, slugRes.slug, statusFlags);

  // C-1350 (Slice 2) — resolve the registry-url + signing-seed the member `/mine`
  // admission read needs, the SAME precedence join/leave use (flag → config →
  // the compiled-in default registry / stack seed convention). Best-effort: an
  // unreadable config is NOT fatal for a read-only status — the admission port
  // simply reports `unavailable` when it can't sign the read.
  const admissionCoords = resolveStatusAdmissionCoords(
    statusFlags,
    principalRes.value,
    slugRes.slug,
    load,
  );
  const cfgWithAdmission: LivePortsConfig = {
    ...cfg,
    ...(admissionCoords.registryUrl !== undefined && { registryUrl: admissionCoords.registryUrl }),
    ...(admissionCoords.seedPath !== undefined && { seedPath: admissionCoords.seedPath }),
  };

  // status is read-only — live ports, but it only ever reads.
  const ports: NetworkPorts = buildLivePorts(cfgWithAdmission);

  const res = await networkStatus(ports);
  if (json) {
    return ok(renderJson(envelopeOk(res.networks)));
  }
  if (res.networks.length === 0) {
    // C-850 — nothing joined AND nothing cached/registered.
    return ok("cortex network status: no networks registered or joined\n");
  }
  const lines = ["cortex network status:", ""];
  for (const n of res.networks) {
    // C-850 — lead each row with the lifecycle stage (registered/joined/live/
    // disconnected), then the leaf-node + raw leaf telemetry.
    lines.push(
      `  ${n.networkId}  [${n.status}]  [leaf:${n.leafNode}]  link:${n.link.state}`,
    );
    lines.push(`    peers:    ${n.peers.length > 0 ? n.peers.join(", ") : "(none)"}`);
    lines.push(`    accept:   ${n.acceptSubjects.join(", ")}`);
    lines.push(`    max_hop:  ${n.maxHop.toString()}`);
    if (n.link.inMsgs !== undefined || n.link.outMsgs !== undefined) {
      lines.push(`    counters: in=${(n.link.inMsgs ?? 0).toString()} out=${(n.link.outMsgs ?? 0).toString()}`);
    }
    // C-1350 (Slice 2) — a REVOKED member sees an explicit message naming the
    // network + the cleanup command, instead of the silent dead-leaf mystery.
    // An unavailable lookup surfaces a non-fatal hint (matches #1315 posture);
    // an admitted/live row carries no admission field, so nothing is added.
    if (n.admission?.revoked === true) {
      const when = n.admission.revokedAt !== undefined ? ` on ${n.admission.revokedAt}` : "";
      lines.push(
        `    ⚠ REVOKED — you were removed from "${n.networkId}"${when}. ` +
          `Run \`cortex network leave ${n.networkId} --apply\` to clean up the dead leaf.`,
      );
    } else if (n.admission?.departed === true) {
      // C-1350 Slice 1 — voluntary departure: a QUIET informational line, no
      // warning banner (the member left on purpose; nothing to act on).
      const when = n.admission.departedAt !== undefined ? ` ${n.admission.departedAt}` : "";
      lines.push(`    admission: departed${when}`);
    } else if (n.admission?.lookup === "unavailable") {
      lines.push(`    admission_lookup: unavailable`);
    }
    lines.push("");
  }
  return ok(lines.join("\n"));
}

/**
 * C-1350 (Slice 2) — resolve the registry-url + signing-seed the status
 * admission `/mine` read needs, mirroring join/leave precedence: flag →
 * `policy.federated.registry` / `stack.nkey_seed_path` → the compiled-in default
 * registry. Read-only + best-effort — a config that fails to load returns only
 * what the flags gave (the port then reports `unavailable`), never throwing so a
 * status read cannot fail on the admission lookup.
 */
function resolveStatusAdmissionCoords(
  flags: FlagMap,
  principal: string,
  slug: string,
  load: ConfigReader,
): { registryUrl?: string; seedPath?: string } {
  const flagRegistry = optionalValueFlag(flags, "--registry-url");
  const flagSeed = optionalValueFlag(flags, "--seed-path");

  let cfg: LoadedConfig | undefined;
  try {
    cfg = load(resolveStatusConfigPath(slug));
  } catch (_err) {
    // Read-only status must not fail because the config couldn't be loaded; fall
    // back to flags + the default registry. The admission port reports
    // `unavailable` when it still can't resolve a seed. Safe to ignore.
    cfg = undefined;
  }

  const registryUrl =
    flagRegistry ?? cfg?.policy?.federated?.registry?.url ?? DEFAULT_REGISTRY_URL;
  const seedPath =
    flagSeed ?? cfg?.stack?.nkey_seed_path ?? `~/.config/nats/${principal}-${slug}.seed`;

  // Both always resolve to a string (flag → config → the non-empty default), but
  // a flag could be an empty string — omit an empty value so the port falls back
  // to reporting `unavailable` rather than signing a read with a blank url/seed.
  return {
    ...(registryUrl !== "" && { registryUrl }),
    ...(seedPath !== "" && { seedPath }),
  };
}

// =============================================================================
// signal#113 P-11 (#56) — `cortex network ping`
// =============================================================================

/** Parse a `<peer>` positional into `{principal, stack}` (stack defaults to `default`). */
function parsePeerArg(
  peer: string,
): { ok: true; principal: string; stack: string } | { ok: false; reason: string } {
  const parts = peer.split("/");
  if (parts.length > 2) {
    return { ok: false, reason: `peer "${peer}" must be {principal} or {principal}/{stack}` };
  }
  const principal = parts[0] ?? "";
  const stack = parts[1] ?? "default";
  if (!PRINCIPAL_ID_RE.test(principal)) {
    return { ok: false, reason: `peer principal "${principal}" must be lowercase alphanumeric + hyphen, letter-prefixed` };
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(stack)) {
    return { ok: false, reason: `peer stack "${stack}" must be letter-prefixed lowercase` };
  }
  return { ok: true, principal, stack };
}

/**
 * Factory for the probe bus port. Production builds a {@link LiveProbeBus} over
 * the runtime from the loaded config; tests inject a fake. Receives the full
 * {@link LoadedConfig} so the live factory can build the posture-gated stack
 * signer (PR #822 MAJOR-1) — the probe REQUEST is signed exactly like every
 * other federated dispatch under `permissive`/`enforce`. Returns the ports +
 * a `stop()` to drain the runtime.
 */
export type PingBusFactory = (
  cfg: LoadedConfig,
) => Promise<{ ports: NetworkPingPorts; stop: () => Promise<void> }>;

/** The production factory — a live NATS-backed probe bus, signed per posture. */
const DEFAULT_PING_BUS_FACTORY: PingBusFactory = async (cfg) => {
  // PR #822 MAJOR-1 — feed the plumbed signer so an enforce-posture peer
  // accepts the probe (signed `signed_by[]` + originator). `undefined` under
  // `signing: off` (publishes unsigned, byte-identical to pre-#822).
  const signer = await buildPingSignerFromConfig(cfg);
  const bus: LiveProbeBus = await createLiveProbeBus(cfg.config, signer);
  const ports: NetworkPingPorts = {
    bus,
    newNonce: () => crypto.randomUUID(),
    newCorrelationId: () => crypto.randomUUID(),
  };
  return { ports, stop: () => bus.stop() };
};

async function runPing(
  peerArg: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  busFactory: PingBusFactory,
): Promise<ExitResult> {
  const peerRes = parsePeerArg(peerArg);
  if (!peerRes.ok) return usageError("ping", peerRes.reason, json);

  // --count (default 1, ≥1) and --timeout (default 2000ms, ≥1).
  const count = parsePositiveInt(flags, "--count", 1);
  if (!count.ok) return usageError("ping", count.reason, json);
  const timeout = parsePositiveInt(flags, "--timeout", 2000);
  if (!timeout.ok) return usageError("ping", timeout.reason, json);

  // Load config (the #753 seam). A missing/broken config is an op-error.
  // #830 — resolve the LOCAL stack's config LAYOUT-AWARE (port of #814's status
  // resolver) so ping reads the file the daemon composes `peers[]` from on a
  // config-split stack, instead of the flat default monolith (which made ping
  // report `not-configured` for a peer that IS in the split policy). Explicit
  // `--config` wins; otherwise `--stack` selects the slug (none → the
  // `meta-factory` bare-name default, handled inside resolveStatusConfigPath).
  let cfg;
  try {
    cfg = load(resolveLocalStackConfigPath(flags));
  } catch (err) {
    return opError("ping", `config load failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  const derived = derivePingInputs({
    cfg,
    targetPrincipal: peerRes.principal,
    targetStack: peerRes.stack,
    ...(optionalValueFlag(flags, "--assistant") !== undefined && {
      assistant: optionalValueFlag(flags, "--assistant"),
    }),
    ...(optionalValueFlag(flags, "--network") !== undefined && {
      network: optionalValueFlag(flags, "--network"),
    }),
    count: count.value,
    timeoutMs: timeout.value,
    ...(optionalValueFlag(flags, "--principal") !== undefined && {
      principalOverride: optionalValueFlag(flags, "--principal"),
    }),
  });
  if (!derived.ok || derived.inputs === undefined) {
    return usageError("ping", derived.reason ?? "could not derive ping inputs", json);
  }
  const inputs = derived.inputs;

  // `not-configured` fails closed at OUR boundary — never start the runtime /
  // emit anything. `pingPeer` short-circuits, so the bus is never built.
  if (!inputs.isConfiguredPeer) {
    // `pingPeer` short-circuits on `!isConfiguredPeer` BEFORE touching the bus,
    // so this port is never invoked — the runtime is never started, nothing is
    // emitted (the §3.3 `not-configured` fail-closed). The stub just satisfies
    // the port shape; `fireProbe` returns a resolved promise it never calls.
    const res = await pingPeer(inputs, {
      bus: { fireProbe: () => Promise.resolve({ kind: "timeout" }) },
      newNonce: () => "",
      newCorrelationId: () => "",
    });
    return renderPingResult(res, inputs.targetPrincipal, inputs.targetStack, json);
  }

  // Build the live (or injected) bus and fire the probe(s). The factory gets
  // the full LoadedConfig so the live path can build the posture-gated signer.
  let busHandle;
  try {
    busHandle = await busFactory(cfg);
  } catch (err) {
    return opError("ping", `failed to start bus: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  try {
    const res = await pingPeer(inputs, busHandle.ports);
    return renderPingResult(res, inputs.targetPrincipal, inputs.targetStack, json);
  } finally {
    await busHandle.stop();
  }
}

/** Parse a positive-integer value flag with a default. */
function parsePositiveInt(
  flags: FlagMap,
  name: string,
  dflt: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  const raw = optionalValueFlag(flags, name);
  if (raw === undefined) return { ok: true, value: dflt };
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, reason: `${name} "${raw}" must be a positive integer` };
  }
  return { ok: true, value: n };
}

/** Render a {@link PingResult} — human table or `--json` envelope + exit code. */
function renderPingResult(
  res: PingResult,
  targetPrincipal: string,
  targetStack: string,
  json: boolean,
): ExitResult {
  const peer = `${targetPrincipal}/${targetStack}`;
  if (json) {
    const env = envelopeOk(
      res.probes.map((p) => ({
        seq: p.seq,
        verdict: p.verdict,
        ...(p.rttMs !== undefined && { rtt_ms: p.rttMs }),
      })),
      {
        peer,
        verdict: res.verdict,
        sent: String(res.stats.sent),
        received: String(res.stats.received),
        loss_pct: String(Math.round(res.stats.loss * 100)),
        ...(res.stats.rttMinMs !== undefined && { rtt_min_ms: String(res.stats.rttMinMs) }),
        ...(res.stats.rttAvgMs !== undefined && { rtt_avg_ms: res.stats.rttAvgMs.toFixed(1) }),
        ...(res.stats.rttMaxMs !== undefined && { rtt_max_ms: String(res.stats.rttMaxMs) }),
        ...(res.detail !== undefined && { detail: res.detail }),
      },
    );
    // JSON goes to stdout regardless of exit code so a verdict is always
    // machine-readable; the exit code carries the verdict per §3.3.
    return { exitCode: res.exitCode, stdout: renderJson(env), stderr: "" };
  }

  const lines: string[] = [`PING ${peer} via federated dispatch:`];
  for (const p of res.probes) {
    lines.push(
      `  seq=${p.seq}  ${p.verdict}` +
        (p.rttMs !== undefined ? `  rtt=${p.rttMs}ms` : ""),
    );
  }
  lines.push(`--- ${peer} ping statistics ---`);
  lines.push(
    `${res.stats.sent} probes sent, ${res.stats.received} echoes received, ` +
      `${Math.round(res.stats.loss * 100)}% loss`,
  );
  if (res.stats.rttMinMs !== undefined && res.stats.rttAvgMs !== undefined && res.stats.rttMaxMs !== undefined) {
    lines.push(
      `rtt min/avg/max = ${res.stats.rttMinMs}/${res.stats.rttAvgMs.toFixed(1)}/${res.stats.rttMaxMs} ms`,
    );
  }
  if (res.verdict !== "reachable") {
    lines.push(`verdict: ${res.verdict}${res.detail !== undefined ? ` — ${res.detail}` : ""}`);
  }
  const body = lines.join("\n") + "\n";
  // Reachable → stdout/exit 0; any failure verdict → stderr + the verdict's
  // exit code (so scripts branch on `$?` per §3.3).
  return res.exitCode === 0
    ? { exitCode: 0, stdout: body, stderr: "" }
    : { exitCode: res.exitCode, stdout: "", stderr: body };
}

// =============================================================================
// cortex#1484 (epic #1479) — `cortex network doctor`
// =============================================================================

/**
 * Factory for the doctor ports bundle. Production builds the live config +
 * monitor + probe-bus adapters from the resolved {@link LivePortsConfig} +
 * the loaded {@link LoadedConfig} (the probe-bus signer needs the full
 * config, mirroring `PingBusFactory`); tests inject fakes. Returns the ports
 * + a `stop()` to drain the runtime.
 */
export type DoctorPortsFactory = (
  cfg: LoadedConfig,
  livePortsCfg: LivePortsConfig,
) => Promise<{ ports: NetworkDoctorPorts; stop: () => Promise<void> }>;

/** The production factory — live config/monitor reads + a live NATS-backed probe bus. */
const DEFAULT_DOCTOR_PORTS_FACTORY: DoctorPortsFactory = async (cfg, livePortsCfg) => {
  // Reuse the SAME posture-gated signer + live probe bus `ping` uses, so
  // doctor's peer-reachable leg is byte-identical to `ping`'s round-trip.
  const signer = await buildPingSignerFromConfig(cfg);
  const bus: LiveProbeBus = await createLiveProbeBus(cfg.config, signer);
  const ports: NetworkDoctorPorts = {
    config: buildDoctorConfigPort({
      // Read the COMPOSED networks off the already-loaded config — NOT a raw
      // re-parse of the pointer file, which finds zero networks under the
      // config-split layout (policy.federated lives in stacks/<slug>.yaml). Same
      // source `derivePingInputs` uses (network-ping-lib.ts).
      networks: cfg.policy?.federated?.networks ?? [],
      ...(livePortsCfg.natsConfigPath !== undefined && { natsConfigPath: livePortsCfg.natsConfigPath }),
    }),
    monitor: buildMonitorPort(livePortsCfg),
    probe: {
      bus,
      newNonce: () => crypto.randomUUID(),
      newCorrelationId: () => crypto.randomUUID(),
    },
  };
  return { ports, stop: () => bus.stop() };
};

async function runDoctor(
  networkId: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  doctorPortsFactory: DoctorPortsFactory,
): Promise<ExitResult> {
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("doctor", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("doctor", slugRes.reason, json);

  // #814-style — an explicit --config wins; otherwise resolve the NAMED
  // stack's config layout-aware (mirrors status/ping so doctor reads the same
  // file the daemon actually loads).
  const doctorFlags: FlagMap =
    optionalValueFlag(flags, "--config") === undefined
      ? { ...flags, "--config": resolveStatusConfigPath(slugRes.slug) }
      : flags;

  let cfg: LoadedConfig;
  try {
    cfg = load(cortexConfigPathFromFlags(doctorFlags));
  } catch (err) {
    return opError("doctor", `config load failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  const livePortsCfg = portsConfig(networkId, principalRes.value, slugRes.slug, doctorFlags);

  let handle;
  try {
    handle = await doctorPortsFactory(cfg, livePortsCfg);
  } catch (err) {
    return opError("doctor", `failed to build doctor ports: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  try {
    const res = await runDoctorChecks(handle.ports, { cfg, networkId });
    return renderDoctorResult(res, networkId, json);
  } finally {
    await handle.stop();
  }
}

/** Render a {@link DoctorRunResult} — a human per-leg table or a `--json` envelope + exit code. */
function renderDoctorResult(
  res: DoctorRunResult,
  networkId: string,
  json: boolean,
): ExitResult {
  if (json) {
    const env = envelopeOk(
      res.checks.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        detail: c.detail,
        owner: c.owner,
        ...(c.fix !== undefined && { fix: c.fix }),
      })),
      { network: networkId, verdict: res.verdict },
    );
    // JSON goes to stdout regardless of exit code — the verdict is always
    // machine-readable; the exit code carries it too (mirrors `ping`).
    return { exitCode: res.exitCode, stdout: renderJson(env), stderr: "" };
  }

  const icon = (status: DoctorCheck["status"]): string => {
    switch (status) {
      case "pass":
        return "✓";
      case "fail":
        return "✗";
      case "warn":
        return "⚠";
      case "skip":
        return "·";
    }
  };

  const lines: string[] = [`cortex network doctor ${networkId}:`, ""];
  for (const c of res.checks) {
    lines.push(`  ${icon(c.status)} ${c.id} — ${c.detail}`);
    if (c.fix !== undefined) {
      lines.push(`      fix (${c.owner}): ${c.fix}`);
    }
  }
  lines.push("");
  lines.push(`verdict: ${res.verdict}`);
  const body = lines.join("\n") + "\n";
  // Healthy → stdout/exit 0; degraded/broken → stderr + the verdict's exit
  // code (so scripts branch on `$?`, mirroring `ping`).
  return res.exitCode === 0
    ? { exitCode: 0, stdout: body, stderr: "" }
    : { exitCode: res.exitCode, stdout: "", stderr: body };
}

// =============================================================================
// cortex#1485 (epic #1479, join-6) — `cortex network handoff status`
// =============================================================================

/**
 * Factory for the handoff ports bundle. Production builds the live
 * admission-read + live hub-auth (cortex#1498 — reads the registry's
 * `hub_authorized_at` marker) + config + monitor adapters from the resolved
 * {@link LivePortsConfig} + the composed networks; tests inject a fake.
 * Read-only — no `stop()` needed (unlike doctor, handoff opens no probe bus).
 */
export type HandoffPortsFactory = (
  cfg: LivePortsConfig,
  networks: import("../../../common/types/cortex-config").PolicyFederatedNetwork[],
) => NetworkHandoffPorts;

/** The production factory — reuses the live admission + doctor config/monitor
 *  adapters + the live hub-authorize read (cortex#1498). */
const DEFAULT_HANDOFF_PORTS_FACTORY: HandoffPortsFactory = (cfg, networks) =>
  buildLiveHandoffPorts(cfg, networks);

async function runHandoff(
  action: string,
  member: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  handoffPortsFactory: HandoffPortsFactory,
): Promise<ExitResult> {
  if (action !== "status") {
    return usageError("handoff", `unknown action "${action}" — the only handoff action is "status"`, json);
  }
  const networkRes = requireValueFlag(flags, "--network");
  if (!networkRes.ok) return usageError("handoff", networkRes.reason, json);
  const networkId = networkRes.value;
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("handoff", `--network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  if (!PRINCIPAL_ID_RE.test(member)) {
    return usageError("handoff", `member "${member}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }

  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("handoff", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("handoff", slugRes.reason, json);

  // Mirror doctor/status: an explicit --config wins; else resolve the NAMED
  // stack's config layout-aware, so the seal/leaf-up leg reads reflect what the
  // daemon actually loads.
  const handoffFlags: FlagMap =
    optionalValueFlag(flags, "--config") === undefined
      ? { ...flags, "--config": resolveStatusConfigPath(slugRes.slug) }
      : flags;

  let cfg: LoadedConfig;
  try {
    cfg = load(cortexConfigPathFromFlags(handoffFlags));
  } catch (err) {
    return opError("handoff", `config load failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // The seal leg's `/mine` admission read needs a registry-url + signing seed —
  // resolved the SAME best-effort way `status` does (C-1350).
  const admissionCoords = resolveStatusAdmissionCoords(
    handoffFlags,
    principalRes.value,
    slugRes.slug,
    load,
  );
  const livePortsCfg: LivePortsConfig = {
    ...portsConfig(networkId, principalRes.value, slugRes.slug, handoffFlags),
    ...(admissionCoords.registryUrl !== undefined && { registryUrl: admissionCoords.registryUrl }),
    ...(admissionCoords.seedPath !== undefined && { seedPath: admissionCoords.seedPath }),
  };

  const ports = handoffPortsFactory(livePortsCfg, cfg.policy?.federated?.networks ?? []);
  const report = await runHandoffStatus(ports, {
    networkId,
    member,
    selfPrincipal: principalRes.value,
  });
  return renderHandoffReport(report, json);
}

/** Render a {@link HandoffReport} — a human per-leg table or a `--json` envelope. */
function renderHandoffReport(report: HandoffReport, json: boolean): ExitResult {
  const { state } = report;
  if (json) {
    const env = envelopeOk(
      state.legs.map((l) => ({
        id: l.id,
        title: l.title,
        status: l.status,
        owner: l.owner,
        detail: l.detail,
      })),
      {
        network: report.networkId,
        member: report.member,
        ...(state.nextLeg !== undefined && { next_leg: state.nextLeg }),
        ...(state.nextOwner !== undefined && { next_owner: state.nextOwner }),
        can_bring_leaf_up: state.canBringLeafUp ? "true" : "false",
        ...(report.notes.length > 0 && { notes: report.notes.join(" | ") }),
      },
    );
    return { exitCode: 0, stdout: renderJson(env), stderr: "" };
  }

  const icon = (status: HandoffLeg["status"]): string => {
    switch (status) {
      case "done":
        return "✓";
      case "pending":
        return "…";
      case "blocked":
        return "·";
    }
  };
  const lines: string[] = [
    `cortex network handoff status ${report.member} (network "${report.networkId}"):`,
    "",
  ];
  for (const l of state.legs) {
    lines.push(`  ${icon(l.status)} ${l.id} [${l.status}] (owner: ${l.owner}) — ${l.detail}`);
  }
  lines.push("");
  if (state.nextLeg !== undefined) {
    lines.push(`outstanding: ${state.nextLeg} (owner: ${state.nextOwner ?? "?"})`);
  } else {
    lines.push("outstanding: none — all legs done");
  }
  lines.push(`can bring leaf up: ${state.canBringLeafUp ? "yes" : "no"}`);
  for (const note of report.notes) {
    lines.push(`  note: ${note}`);
  }
  return ok(lines.join("\n") + "\n");
}

// =============================================================================
// cortex#1498 (epic #1479 follow-up) — `cortex network authorize <member>`
// =============================================================================

/** Member pubkey grammar — the SAME acceptance `secret`/`admit` use (either encoding). */
const AUTHORIZE_PUBKEY_LABEL = "32-byte Ed25519 pubkey — base64 (44 chars) or an NKey public key (A…/U… + 55 base32 chars)";

/**
 * Factory for the authorize port bundle. Production builds the live adapters
 * (admin-signed admission lookup + hub-admin-signed authorize POST). Tests
 * inject fakes that record calls without touching HTTP.
 */
export type AuthorizePortsFactory = (cfg: {
  registryUrl: string;
  material: StackIdentityMaterial;
}) => NetworkAuthorizePorts;

const DEFAULT_AUTHORIZE_PORTS_FACTORY: AuthorizePortsFactory = (cfg) => buildLiveAuthorizePorts(cfg);

/**
 * `cortex network authorize <member> --network <net> --admin-seed <path> [--apply]`.
 * The hub owner runs this AFTER applying the member's leaf `authorization`
 * entry on their OWN nats-server config (the #1481 hub-owner artifact), to
 * stamp the registry's `hub_authorized_at` (cortex#1498) — the real signal
 * `handoff status` / `join --guided` read in place of the honor-system
 * `--hub-authorized-confirmed` attestation. Dry-run by DEFAULT; --apply POSTs.
 */
async function runAuthorize(
  member: string,
  flags: FlagMap,
  json: boolean,
  portsFactory: AuthorizePortsFactory,
): Promise<ExitResult> {
  const networkRes = requireValueFlag(flags, "--network");
  if (!networkRes.ok) return usageError("authorize", networkRes.reason, json);
  const networkId = networkRes.value;
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("authorize", `--network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  if (member === "") {
    return usageError("authorize", `requires a member pubkey (usage: cortex network authorize <member-pubkey> --network <net>)`, json);
  }
  if (detectPubkey(member) === undefined) {
    return usageError("authorize", `member "${member}" must be a ${AUTHORIZE_PUBKEY_LABEL}`, json);
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("authorize", applyRes.reason, json);

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("authorize", seedRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_REGISTRY_URL;

  const matRes = await hubAdminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("authorize", matRes.reason, json);

  const ports = portsFactory({ registryUrl, material: matRes.material });
  const inputs: AuthorizeInputs = { networkId, memberPubkey: member, apply: applyRes.apply };

  let report: AuthorizeReport;
  try {
    report = await runNetworkAuthorize(inputs, ports);
  } catch (err) {
    return opError("authorize", `authorize failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  if (json) {
    const data: Record<string, string> = {
      subcommand: "authorize",
      applied: report.applied ? "true" : "false",
      ...report.data,
      hub_admin_fingerprint: matRes.material.fingerprint,
    };
    const env = report.ok ? envelopeOk([], data) : envelopeError(report.reason ?? "authorize command failed", data);
    return report.ok ? ok(renderJson(env)) : { exitCode: 1, stdout: "", stderr: renderJson(env) };
  }

  const header = report.applied
    ? `cortex network authorize ${networkId}: ${report.ok ? "ok" : "FAILED"}`
    : `cortex network authorize ${networkId}: dry-run (no mutation; pass --apply)`;
  const lines = [header, ...report.steps.map((s) => `  ${s}`)];
  if (!report.ok) lines.push(`  ✗ ${report.reason ?? "unknown failure"}`);
  lines.push("");
  const body = lines.join("\n");
  return report.ok ? ok(body) : { exitCode: 1, stdout: "", stderr: body };
}

// =============================================================================
// #747 — signed-admin network create/update
// =============================================================================

/** Load + re-derive admin material from a seed file (chmod-600 gated). */
async function adminMaterialFromSeedFile(
  seedPath: string,
): Promise<{ ok: true; material: StackIdentityMaterial } | { ok: false; reason: string }> {
  const expanded = expandTilde(seedPath);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `--admin-seed file not found at ${expanded}` };
  }
  try {
    // Refuse to read a group/world-readable secret — same discipline as
    // loadStackSigningKey / provision-stack.
    enforceChmod600(expanded);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  let seed: string;
  try {
    seed = await readFile(expanded, "utf-8");
  } catch (err) {
    return { ok: false, reason: `failed to read --admin-seed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { ok: true, material: materialFromSeedString(seed) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function runCreate(
  networkId: string,
  flags: FlagMap,
  json: boolean,
): Promise<ExitResult> {
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("create", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }

  const hubRes = requireValueFlag(flags, "--hub");
  if (!hubRes.ok) return usageError("create", hubRes.reason, json);
  const hubUrl = hubRes.value;

  const portRes = requireValueFlag(flags, "--leaf-port");
  if (!portRes.ok) return usageError("create", portRes.reason, json);
  const leafPort = Number.parseInt(portRes.value, 10);
  if (!Number.isInteger(leafPort) || leafPort < 1 || leafPort > 65535) {
    return usageError("create", `--leaf-port "${portRes.value}" must be an integer in 1..65535`, json);
  }

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("create", seedRes.reason, json);

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("create", applyRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_REGISTRY_URL;

  // #1321 — optional per-network admins (comma-separated base64 Ed25519 pubkeys).
  // The registry accepts admin_pubkeys ONLY from a GLOBAL admin (ADR-0020); the
  // CLI validates the SHAPE locally for fast feedback and normalises (trim, drop
  // blanks) before signing. Omitted → a plain topology create/update.
  let adminPubkeys: string | undefined;
  const networkAdminsRaw = optionalValueFlag(flags, "--network-admins");
  if (networkAdminsRaw !== undefined) {
    const entries = networkAdminsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (entries.length === 0) {
      return usageError("create", "--network-admins must list at least one base64 pubkey", json);
    }
    const bad = entries.find((e) => !MEMBER_PUBKEY_RE.test(e));
    if (bad !== undefined) {
      return usageError("create", `--network-admins entry "${bad}" must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)`, json);
    }
    adminPubkeys = entries.join(",");
  }

  // #1598 — optional hub-mode / resolver-mode attestation (closed enums,
  // validated locally for fast feedback; the registry validator re-checks).
  // resolver-mode only means something for an operator hub — refuse the
  // incoherent combination here too.
  const hubModeRaw = optionalValueFlag(flags, "--hub-mode");
  if (hubModeRaw !== undefined && hubModeRaw !== "operator" && hubModeRaw !== "simple") {
    return usageError("create", `--hub-mode "${hubModeRaw}" must be "operator" or "simple"`, json);
  }
  const resolverModeRaw = optionalValueFlag(flags, "--resolver-mode");
  if (resolverModeRaw !== undefined && resolverModeRaw !== "nats" && resolverModeRaw !== "memory") {
    return usageError("create", `--resolver-mode "${resolverModeRaw}" must be "nats" or "memory"`, json);
  }
  if (resolverModeRaw !== undefined && hubModeRaw !== "operator") {
    return usageError("create", `--resolver-mode requires --hub-mode operator`, json);
  }
  const hubMode = hubModeRaw;
  const resolverMode = resolverModeRaw;

  // Load the admin nkey seed + derive its base64 pubkey (the SAME key shape +
  // signing path provision-stack uses), then build the signed claim.
  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("create", matRes.reason, json);

  let body: SignedNetworkCreateBody;
  try {
    body = await buildNetworkCreateClaim({
      networkId,
      hubUrl,
      leafPort,
      material: matRes.material,
      adminPubkeys,
      ...(hubMode !== undefined && { hubMode }),
      ...(resolverMode !== undefined && { resolverMode }),
    });
  } catch (err) {
    return opError("create", `failed to build network-create claim: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // DRY-RUN (default): print the claim that WOULD be POSTed; touch no registry.
  if (!applyRes.apply) {
    if (json) {
      return ok(
        renderJson(
          envelopeOk([body as unknown as Record<string, unknown>], {
            network: networkId,
            registry_url: registryUrl,
            applied: "false",
            admin_fingerprint: matRes.material.fingerprint,
          }),
        ),
      );
    }
    const lines = [
      `cortex network create ${networkId}: dry-run (no registry write; pass --apply to POST)`,
      `  registry:     ${registryUrl}`,
      `  hub_url:      ${hubUrl}`,
      `  leaf_port:    ${leafPort.toString()}`,
      `  admin_pubkey: ${matRes.material.pubkeyB64}`,
      `  fingerprint:  ${matRes.material.fingerprint}`,
      `  network_admins: ${adminPubkeys ?? "(none — defers to global REGISTRY_ADMIN_PUBKEYS)"}`,
      `  hub_mode:     ${hubMode ?? "(unattested)"}`,
      `  resolver_mode: ${resolverMode ?? "(unattested)"}`,
      ``,
      `Would POST ${registryUrl}/networks/${networkId}:`,
      JSON.stringify(body, null, 2),
      ``,
    ];
    return ok(lines.join("\n"));
  }

  // APPLY: POST the signed claim. Surface the registry's error JSON verbatim
  // (admin_not_configured → 503 / admin_not_authorized → 403 / etc.).
  let result: Awaited<ReturnType<typeof postNetworkCreate>>;
  try {
    result = await postNetworkCreate({ registryUrl, networkId, body });
  } catch (err) {
    return opError("create", `registry POST failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  if (!result.ok) {
    const detail =
      typeof result.response === "object" && result.response !== null
        ? JSON.stringify(result.response)
        : String(result.response);
    const reason = `registry rejected network create (HTTP ${result.status.toString()}): ${detail}`;
    return opError("create", reason, json);
  }

  if (json) {
    return ok(
      renderJson(
        envelopeOk([result.response as Record<string, unknown>], {
          network: networkId,
          registry_url: registryUrl,
          applied: "true",
          admin_fingerprint: matRes.material.fingerprint,
        }),
      ),
    );
  }
  return ok(
    `cortex network create ${networkId}: created/updated at ${registryUrl} (HTTP ${result.status.toString()})\n` +
      `  hub_url:   ${hubUrl}\n  leaf_port: ${leafPort.toString()}\n` +
      `  admin:     ${matRes.material.fingerprint}\n`,
  );
}

// =============================================================================
// S5 (#739) — public-scope opt-in (join/leave public)
// =============================================================================

/** Split a comma-separated flag value into trimmed, non-empty tokens. */
function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runJoinPublic(
  flags: FlagMap,
  json: boolean,
): Promise<ExitResult> {
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("join", principalRes.reason, json);
  if (!PRINCIPAL_ID_RE.test(principalRes.value)) {
    return usageError("join", `--principal "${principalRes.value}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("join", slugRes.reason, json);

  // Public-path required flags: registry (announce), seed (proof-of-possession),
  // nats-config (subscribe public.>), plist (daemon arg). NOT creds/account —
  // public has no leaf.
  for (const required of ["--registry-url", "--seed-path", "--nats-config", "--plist"]) {
    const r = requireValueFlag(flags, required);
    if (!r.ok) return usageError("join", r.reason, json);
  }

  // --capabilities (CSV) — announce to the public index. Validate each id.
  const capabilities = splitCsv(optionalValueFlag(flags, "--capabilities"));
  for (const cap of capabilities) {
    if (!CAPABILITY_ID_RE.test(cap)) {
      return usageError("join", `--capabilities "${cap}" must be a <domain>.<entity> capability id (e.g. 'code-review.typescript')`, json);
    }
  }

  // --allow (CSV) — the INBOUND allowlist. Empty ⇒ deny-by-default (OQ1 safe).
  const allowPrincipals = splitCsv(optionalValueFlag(flags, "--allow"));
  for (const p of allowPrincipals) {
    if (!PRINCIPAL_ID_RE.test(p)) {
      return usageError("join", `--allow "${p}" must be a principal id (lowercase alphanumeric + hyphen, letter-prefixed)`, json);
    }
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("join", applyRes.reason, json);

  const cfg = portsConfig("public", principalRes.value, slugRes.slug, flags);
  const ports = applyRes.apply ? buildLivePublicPorts(cfg) : buildDryRunPublicPorts(cfg);
  const inputs: PublicJoinInputs = { capabilities, allowPrincipals };

  const res = await joinPublic(inputs, ports);
  return renderFlowResult("join", "public", res.ok, res.reason, res.steps, applyRes.apply, json, {
    inbound: res.written?.enabled === true ? "enabled" : "disabled",
    allow: (res.written?.allow_principals ?? []).join(","),
    announced: capabilities.join(","),
  });
}

async function runLeavePublic(
  flags: FlagMap,
  json: boolean,
): Promise<ExitResult> {
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("leave", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("leave", slugRes.reason, json);
  for (const required of ["--registry-url", "--seed-path", "--nats-config", "--plist"]) {
    const r = requireValueFlag(flags, required);
    if (!r.ok) return usageError("leave", r.reason, json);
  }
  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("leave", applyRes.reason, json);

  const cfg = portsConfig("public", principalRes.value, slugRes.slug, flags);
  const ports = applyRes.apply ? buildLivePublicPorts(cfg) : buildDryRunPublicPorts(cfg);

  const res = await leavePublic(ports);
  return renderFlowResult("leave", "public", res.ok, res.reason, res.steps, applyRes.apply, json, {
    not_joined: res.notJoined === true ? "true" : "false",
  });
}

// =============================================================================
// Ports config + result rendering
// =============================================================================

function portsConfig(
  networkId: string,
  principalId: string,
  stackSlug: string,
  flags: FlagMap,
): LivePortsConfig {
  return {
    networkId,
    principalId,
    stackId: `${principalId}/${stackSlug}`,
    registryUrl: optionalValueFlag(flags, "--registry-url"),
    registryPubkey: optionalValueFlag(flags, "--registry-pubkey"),
    seedPath: optionalValueFlag(flags, "--seed-path"),
    natsConfigPath: optionalValueFlag(flags, "--nats-config"),
    plistPath: optionalValueFlag(flags, "--plist"),
    monitorUrl: optionalValueFlag(flags, "--monitor-url"),
    cortexConfigPath: cortexConfigPathFromFlags(flags),
  };
}

/**
 * #753 — build the live/dry-run ports config from the DERIVED join inputs
 * (config + convention + flag-overrides resolved upstream by the deriver),
 * rather than re-reading raw flags. `--monitor-url` is the one read-only-status
 * flag that doesn't participate in the join derivation, so it's read here.
 */
function portsConfigFromInputs(
  networkId: string,
  inputs: import("./network-derive").DerivedJoinInputs,
  stackSlug: string,
  flags: FlagMap,
): LivePortsConfig {
  return {
    networkId,
    principalId: inputs.principal,
    stackId: `${inputs.principal}/${stackSlug}`,
    registryUrl: inputs.registryUrl,
    ...(inputs.registryPubkey !== undefined && { registryPubkey: inputs.registryPubkey }),
    seedPath: inputs.seedPath,
    // C-791 — optional principal ROOT seed for a 2nd-stack join. Flag-only (no
    // config field): present ⇒ the register step root-signs the add-stack claim
    // + fetch-merges existing stacks; absent ⇒ first-stack register (with the
    // idempotency skip when the stack is already on record).
    ...(optionalValueFlag(flags, "--principal-seed") !== undefined && {
      rootSeedPath: optionalValueFlag(flags, "--principal-seed"),
    }),
    natsConfigPath: inputs.natsConfigPath,
    // #763 — platform-resolved service descriptor: plist on macOS, systemd unit
    // on Linux. The deriver sets exactly one + the platform; thread both through
    // so the adapter selects the right NatsServiceManager.
    ...(inputs.plistPath !== undefined && { plistPath: inputs.plistPath }),
    ...(inputs.unitPath !== undefined && { unitPath: inputs.unitPath }),
    platform: inputs.platform,
    monitorUrl: optionalValueFlag(flags, "--monitor-url"),
    // #800 — locate the daemon service for the post-join restart.
    cortexConfigPath: cortexConfigPathFromFlags(flags),
    // #762 — caps the join announces INTO the network so the principal joins
    // the roster (registry control-plane; never on the wire).
    announceCapabilities: inputs.announceCapabilities,
  };
}

function renderFlowResult(
  sub: string,
  networkId: string,
  okFlag: boolean,
  reason: string | undefined,
  steps: string[],
  applied: boolean,
  json: boolean,
  data: Record<string, string>,
): ExitResult {
  if (json) {
    const env = okFlag
      ? envelopeOk([{ network: networkId, applied, steps }], data)
      : envelopeError(reason ?? "unknown failure", { network: networkId, ...data });
    return { exitCode: okFlag ? 0 : 1, stdout: okFlag ? renderJson(env) : "", stderr: okFlag ? "" : renderJson(env) };
  }
  const banner = applied ? "" : "  (dry-run — no live mutation; pass --apply to execute)\n";
  const body =
    `cortex network ${sub} ${networkId}: ${okFlag ? "ok" : "FAILED"}\n` +
    banner +
    steps.map((s) => `  • ${s}`).join("\n") +
    (okFlag ? "" : `\n  ✗ ${reason ?? "unknown failure"}`) +
    "\n";
  return okFlag ? ok(body) : { exitCode: 1, stdout: "", stderr: body };
}

// =============================================================================
// Result builders
// =============================================================================

function ok(stdout: string): ExitResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function usageError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex network ${sub}: ${reason}\n${topLevelHelp()}`;
  return { exitCode: 2, stdout: "", stderr };
}

/**
 * #753 — operational failure (exit 1), distinct from a usage error (exit 2).
 * Used when the config file itself fails to load/parse — that is an
 * operational problem, not a CLI-grammar mistake.
 */
function opError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex network ${sub}: ${reason}\n`;
  return { exitCode: 1, stdout: "", stderr };
}

// =============================================================================
// ADR-0015 — runAdmit: one-command admin admission decision (R2, cortex#1142)
// =============================================================================

/** Default registry URL — mirrors network create / join constants (#1228). */
const DEFAULT_ADMIT_REGISTRY_URL = DEFAULT_REGISTRY.url;

/** Default Discord role for O-5 community-fleet admission. */
const DEFAULT_ADMIT_DISCORD_ROLE = "community-fleet";

/**
 * S5 (#1519, epic #1514) — factory for the admit/reject port bundle (registry
 * reads/decision + admit's Discord role ASSIGN + the C-1316 seal delegation).
 * Production builds the live adapters. Tests inject fakes that record calls
 * without touching HTTP/Discord — replaces the pre-S5 (admit-only)
 * `__setDiscordAdmitClientForTests` mutable-singleton override.
 *
 * NOTE: reject's Discord role REMOVE stays on `removeDiscordFleetRole` below,
 * NOT this port — it turns out to be shared with `secret revoke-member`
 * (`network-secret-cli.test.ts`, out of scope for this slice), so it isn't
 * admit-exclusive the way the assign-side singleton is.
 */
export type AdmitPortsFactory = (cfg: {
  registryUrl: string;
  material: StackIdentityMaterial;
  /** Only meaningful for `admit` — the C-1316 fold-in seal delegates to
   *  `secret add-member`'s own ports factory. `reject` omits it. */
  secretPortsFactory?: SecretPortsFactory;
}) => AdmitPorts;

const DEFAULT_ADMIT_PORTS_FACTORY: AdmitPortsFactory = (cfg) => buildLiveAdmitPorts(cfg);

// ---------------------------------------------------------------------------
// C-1350 S3 — Tier-1 de-admission: REMOVE the community-fleet role (the inverse
// of admit's assign). `reject` and `secret revoke-member` share this — it is
// NOT folded into the S5 `AdmitPorts.discord` port (admit-only) because
// `secret revoke-member` (out of scope for this slice) depends on the same
// singleton-override test seam.
//
// S5 note: this is NO LONGER an exact mirror of admit's Discord path. Admit's
// assign moved to `AdmitPorts.discord.assignRole` (network-admit-adapters.ts)
// — the injected-singleton short-circuit is gone there, replaced by a clean
// port. `removeDiscordFleetRole` below kept the pre-S5 shape (including the
// `discordClient ? "injected" : ctx.botToken` singleton-override seam) because
// it's shared with `secret revoke-member`. The flag NAMES and PRECEDENCE
// still agree (same `--discord-*` flags, same resolution order); only the
// TEST-INJECTION mechanism diverged. The only behavioural difference is it
// calls `removeRole`, and a failure is ALWAYS non-fatal (the parent decision
// has already committed).
// ---------------------------------------------------------------------------

/** Minimal Discord client surface (role removal) injectable for tests. */
export interface DiscordRemoveClient {
  resolveRoleId(botToken: string, guildId: string, roleName: string): Promise<string>;
  removeRole(botToken: string, guildId: string, userId: string, roleId: string): Promise<{ success: boolean; error?: string }>;
}

let discordRemoveClientOverride: DiscordRemoveClient | null = null;

/** Test-only setter. Production callers never touch this. Null restores default. */
export function __setDiscordRemoveClientForTests(client: DiscordRemoveClient | null): void {
  discordRemoveClientOverride = client;
}

/** Default production client — thin wrappers over the real discord lib. */
const defaultDiscordRemoveClient: DiscordRemoveClient = {
  resolveRoleId,
  removeRole,
};

/** The Discord flags the de-admission role removal reads (mirrors admit's). */
interface DiscordRemoveFlags {
  /** The member snowflake to strip the role from (`--discord-member`). */
  member: string;
  /** `--discord-server` profile name (optional). */
  server?: string;
  /** `--discord-guild` id override (optional). */
  guild?: string;
  /** Role name-or-id (`--discord-role`, defaults to community-fleet). */
  role: string;
}

/** Outcome of the (best-effort) de-admission role removal. */
interface DiscordRemoveOutcome {
  /** skipped | skipped_no_token | skipped_no_guild | removed | failed. */
  status: string;
  /** Actionable warning when the role could not be removed (empty on success). */
  warning: string;
}

/**
 * Remove the community-fleet role from a de-admitted member, mirroring admit's
 * assignment block byte-for-byte in resolution precedence:
 *   `--guild` flag > `--server` profile > top-level config (via
 *   resolveServerContext), with the injected test client short-circuiting token/
 *   guild resolution exactly as admit's did.
 *
 * ALWAYS best-effort: any resolution or API failure returns a `failed`/`skipped_*`
 * status + an actionable "remove the role manually" warning — it NEVER throws, so
 * the parent `reject`/`revoke-member` decision (already committed) always stands.
 *
 * @param verb  the committed parent motion ("rejected" | "revoked") — woven into
 *              the warning so the principal knows the decision itself held.
 */
async function removeDiscordFleetRole(
  flags: DiscordRemoveFlags,
  verb: string,
): Promise<DiscordRemoveOutcome> {
  const discordClient = discordRemoveClientOverride;
  try {
    const discordConfig = loadDiscordConfig();
    const ctx = resolveServerContext(discordConfig, {
      server: flags.server,
      guild: flags.guild,
    });

    const botToken = discordClient ? "injected" : ctx.botToken;
    const guildId = discordClient ? (flags.guild ?? ctx.guildId) : ctx.guildId;

    if (!discordClient && !botToken) {
      return {
        status: "skipped_no_token",
        warning: `Discord role not removed: no bot token configured (run: discord config set botToken <token>) — remove the role manually`,
      };
    }
    if (!guildId) {
      return {
        status: "skipped_no_guild",
        warning: `Discord role not removed: no guild id configured — pass --discord-guild <id> or run: discord config set guildId <id> — remove the role manually`,
      };
    }

    const client = discordClient ?? defaultDiscordRemoveClient;
    let roleId: string;
    try {
      roleId = await client.resolveRoleId(botToken ?? "", guildId, flags.role);
    } catch (err) {
      return {
        status: "failed",
        warning: `Discord role not removed: ${err instanceof Error ? err.message : String(err)} — member ${verb}, remove the role manually`,
      };
    }

    const roleResult = await client.removeRole(botToken ?? "", guildId, flags.member, roleId);
    if (roleResult.success) {
      return { status: "removed", warning: "" };
    }
    return {
      status: "failed",
      warning: `Discord role removal failed: ${roleResult.error ?? "unknown error"} — member ${verb}, remove the role manually`,
    };
  } catch (err) {
    return {
      status: "failed",
      warning: `Discord role removal error: ${err instanceof Error ? err.message : String(err)} — member ${verb}, remove the role manually`,
    };
  }
}

// =============================================================================
// C-1314 — `cortex network admit --list-pending` (admission-queue discovery)
// =============================================================================

/** Admission-request statuses the registry list endpoint accepts. C-1350 adds
 *  REVOKED + DEPARTED so `admit --list-pending --status DEPARTED` surfaces
 *  departed-but-not-hub-revoked rows (the admin's cue to run `secret
 *  revoke-member` and cut the hub `authorization` user). Kept in lockstep with
 *  the registry-side `validStatuses` gate in routes/admission-requests.ts. */
const LIST_STATUSES = ["PENDING", "ADMITTED", "REJECTED", "REVOKED", "DEPARTED"] as const;

/**
 * `cortex network admit --list-pending [--status <s>] [--network <id>] --admin-seed <path> [--registry-url <url>] [--json]`
 *
 * C-1314 — the admission-queue DISCOVERY surface. An admin can't otherwise find
 * a request-id from the CLI (the alternatives were the MC Pier queue or a
 * hand-signed GET). Admin-signs a read claim into the `x-admin-signed` header
 * and GETs `/admission-requests?status=<status>`, mirroring the admit apply-path
 * read + `findAdmittedRow`. Read-only: no --apply, no request-id positional.
 *
 * S5 (#1519) — thin commander wiring: parse + validate flags, load the admin
 * material, build admit ports, call {@link runNetworkListPending}
 * (`network-admit-lib.ts`), format the returned report.
 *
 * ADR-0020 read-scoping limitation: admin READS are GLOBAL-admin-only today
 * (the registry list route gates on `parseAdminPubkeys` — the global allowlist —
 * NOT the target network's per-network admins). So a PER-NETWORK admin gets a
 * 403 here even for their own network; we surface that readably (never a silent
 * empty table) and point at the fast-follow. `--network` is a CLIENT-side filter
 * (the endpoint returns every network's rows at once).
 */
async function runListPending(
  flags: FlagMap,
  json: boolean,
  admitPortsFactory: AdmitPortsFactory,
): Promise<ExitResult> {
  // --admin-seed required: the list is admin-signed (no anonymous read).
  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) {
    return usageError(
      "admit",
      `${seedRes.reason} — --list-pending admin-signs the query, so pass --admin-seed <path>`,
      json,
    );
  }

  // --status defaults to PENDING (the discovery case); validate the enum.
  const statusRaw = optionalValueFlag(flags, "--status") ?? "PENDING";
  const status = statusRaw.toUpperCase();
  if (!(LIST_STATUSES as readonly string[]).includes(status)) {
    return usageError("admit", `--status "${statusRaw}" must be one of ${LIST_STATUSES.join(", ")}`, json);
  }

  // --network is a CLIENT-side filter over the (all-networks) response.
  const networkFilter = optionalValueFlag(flags, "--network");
  if (networkFilter !== undefined && !NETWORK_ID_RE.test(networkFilter)) {
    return usageError(
      "admit",
      `--network "${networkFilter}" must be lowercase alphanumeric + hyphen, letter-prefixed`,
      json,
    );
  }

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_ADMIT_REGISTRY_URL;

  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("admit", matRes.reason, json);
  const material = matRes.material;

  const ports = admitPortsFactory({ registryUrl, material });
  const report = await runNetworkListPending(
    { status, ...(networkFilter !== undefined && { networkFilter }), registryUrl, material },
    ports,
  );

  if (!report.ok) {
    return opError("admit", report.reason ?? "list-pending failed", json);
  }

  if (json) {
    return ok(
      renderJson(
        envelopeOk(report.rows, {
          subcommand: "admit",
          mode: "list-pending",
          status,
          ...(networkFilter !== undefined && { network: networkFilter }),
          registry_url: registryUrl,
          admin_fingerprint: material.fingerprint,
          count: report.rows.length.toString(),
        }),
      ),
    );
  }
  return ok(renderPendingTable(report.rows, status, networkFilter, registryUrl));
}

// =============================================================================
// cortex#1482 (epic #1479, join-3) — shared `--hub-account` boundary.
// =============================================================================

/**
 * Validate + normalize a `--hub-account` flag value to the canonical
 * nkey-account form. Accepts EITHER an nkey-U account key (`A…`) or its
 * base64 form (auto-converts); REFUSES a value that looks like the member's
 * own registered/PoP USER key (`U…`) with a plain explanation (seal-target ≠
 * leaf-account, ADR-0018) rather than a bare grammar error. `raw === undefined`
 * (nothing passed) is not an error — the caller's `hubAccount` stays
 * `undefined` (omit ⇒ the printed artifact tells the hub owner to add the
 * account themselves). Shared by `admit --hub-account` and
 * `secret … --hub-account` — the SAME boundary, validated once.
 */
function normalizeHubAccountFlag(
  raw: string | undefined,
): { ok: true; value?: string } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  const normalized = toNkeyPubkey(raw, "account");
  if (normalized !== undefined) return { ok: true, value: normalized };
  if (looksLikeNkeyRole(raw, "user")) {
    return {
      ok: false,
      reason:
        `--hub-account "${raw}" looks like a registered/PoP user nkey (U…) — that's the MEMBER's identity ` +
        `key, not the hub's federation account. These are different keys (seal-target ≠ leaf-account, ` +
        `ADR-0018); pass the hub's OWN account nkey (A…) or its base64 form instead.`,
    };
  }
  return {
    ok: false,
    reason: `--hub-account "${raw}" is not a valid federation-account pubkey (expected an nkey-U account key "A…" (56 chars) or its base64 form (44 chars))`,
  };
}

/**
 * `cortex network admit <request-id> --admin-seed <path> [--apply]`
 *
 * ADR-0015 replacement for `cortex creds grant`. Signs an admission decision
 * claim and POSTs it to `/admission-requests/:id/admit`. Admits the principal
 * to the network roster. Mints nothing (no arc nats add-bot call).
 *
 * Dry-run by default (safe posture). Pass --apply to execute.
 * Optionally assigns Discord role (O-5) via --discord-member when applied.
 *
 * --network is intentionally absent: the request's network_id is stored at
 * register time. See cortex#1145 to thread it end-to-end.
 *
 * S5 (#1519) — thin commander wiring: parse + validate flags, load the admin
 * material, and — for the apply path only — build admit ports and call
 * {@link runNetworkAdmit} (`network-admit-lib.ts`). Dry-run stays fully
 * inline (it never builds a port and never hits the registry — the
 * `fetchCalled === false` contract the existing tests pin).
 */
async function runAdmit(
  requestId: string,
  flags: FlagMap,
  json: boolean,
  // C-1316 — the SAME injectable secret-ports factory `runSecret` uses, so the
  // folded-in seal is testable with fake hub/registry/crypto ports. Production
  // omits it → the live adapters (`buildLiveSecretPorts`).
  secretPortsFactory: SecretPortsFactory = DEFAULT_SECRET_PORTS_FACTORY,
  // S5 (cortex#1519) — injectable admit-ports factory so admit/reject CLI
  // tests drive fake registry/Discord/seal ports. Production omits it → the
  // live adapters (`buildLiveAdmitPorts`).
  admitPortsFactory: AdmitPortsFactory = DEFAULT_ADMIT_PORTS_FACTORY,
): Promise<ExitResult> {
  // C-1314 — DISCOVERY mode. `--list-pending` is a read-only query for the
  // admission queue (no request-id positional, no --apply). Route it before the
  // request-id gate so `cortex network admit --list-pending` doesn't trip the
  // "missing request-id" usage error.
  if (flags["--list-pending"] === true) {
    return runListPending(flags, json, admitPortsFactory);
  }

  if (!requestId) {
    return usageError("admit", "missing request-id (usage: cortex network admit <request-id> --admin-seed <path>; discover ids with `cortex network admit --list-pending --admin-seed <path>`)", json);
  }

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("admit", seedRes.reason, json);

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("admit", applyRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_ADMIT_REGISTRY_URL;
  const discordMember = optionalValueFlag(flags, "--discord-member");
  const discordServer = optionalValueFlag(flags, "--discord-server");
  const discordGuild = optionalValueFlag(flags, "--discord-guild");
  const discordRole = optionalValueFlag(flags, "--discord-role") ?? DEFAULT_ADMIT_DISCORD_ROLE;
  // cortex#1481 (Sage review, Important 1) — validate --hub-account with the
  // SAME guard the `secret` path enforces, and validate it HERE — before the
  // admission is committed — so a malformed account fails fast (exit 2)
  // rather than silently riding into the printed hub-owner artifact the hub
  // owner pastes into a live nats-server config. cortex#1482 — normalizes
  // either encoding (nkey-U or base64) and explains a registered-vs-account
  // role mismatch instead of a bare grammar error (ADR-0018).
  const admitHubAccountRes = normalizeHubAccountFlag(optionalValueFlag(flags, "--hub-account"));
  if (!admitHubAccountRes.ok) {
    return usageError("admit", admitHubAccountRes.reason, json);
  }
  const admitHubAccount = admitHubAccountRes.value;

  // Load + chmod-600-gate the admin seed
  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("admit", matRes.reason, json);
  const material = matRes.material;

  // DRY-RUN (default): print the plan, touch nothing — never builds a port.
  if (!applyRes.apply) {
    if (json) {
      return ok(
        renderJson(
          envelopeOk([], {
            subcommand: "admit",
            request_id: requestId,
            registry_url: registryUrl,
            admin_fingerprint: material.fingerprint,
            applied: "false",
          }),
        ),
      );
    }
    const lines = [
      `cortex network admit ${requestId}: dry-run (no registry write; pass --apply to execute)`,
      `  registry:          ${registryUrl}`,
      `  admin_fingerprint: ${material.fingerprint}`,
      ...(discordMember !== undefined ? [`  discord_member:    ${discordMember}`] : []),
      ``,
    ];
    return ok(lines.join("\n"));
  }

  // APPLY path — fetch/decision/seal/Discord all live in network-admit-lib.ts
  // over network-admit-ports.ts.
  const ports = admitPortsFactory({ registryUrl, material, secretPortsFactory });
  const report = await runNetworkAdmit(
    {
      requestId,
      registryUrl,
      material,
      rosterOnly: flags["--roster-only"] === true,
      // cortex#1481 — --seal-only forces the never-write-a-foreign-hub path even
      // when the auto-detected locality would otherwise call the hub local.
      sealOnly: flags["--seal-only"] === true,
      hubConfigPath: optionalValueFlag(flags, "--hub-config") ?? DEFAULT_HUB_CONFIG_PATH,
      adminSeedPath: seedRes.value,
      // Already nkey-U-validated above (fail-fast before the admission commits).
      ...(admitHubAccount !== undefined && { hubAccount: admitHubAccount }),
      // cortex#1598 — DEFERRED operator-mode attestation resolver (the network id
      // is only known after the row fetch inside runNetworkAdmit).
      resolveOperatorAttestation: (networkId: string) =>
        resolveOperatorAttestation(flags, networkId, DEFAULT_READER),
      ...(discordMember !== undefined && {
        discord: {
          member: discordMember,
          role: discordRole,
          ...(discordServer !== undefined && { server: discordServer }),
          ...(discordGuild !== undefined && { guild: discordGuild }),
        },
      }),
    },
    ports,
  );

  if (!report.ok) {
    return opError("admit", report.reason, json);
  }
  const sealOutcome = report.sealOutcome;

  // Output summary
  if (json) {
    const data: Record<string, string> = {
      subcommand: "admit",
      applied: "true",
      request_id: requestId,
      principal_id: report.principalId,
      admin_fingerprint: material.fingerprint,
      // C-1316 — make the peer's connectability machine-readable.
      seal_status: sealOutcome.status,
      connectable: sealOutcome.status === "sealed" ? "true" : "false",
      ...(report.discordStatus !== "skipped" && { discord_status: report.discordStatus }),
    };
    if (sealOutcome.reason) data.seal_reason = sealOutcome.reason;
    if (sealOutcome.fallbackCmd) data.seal_fallback = sealOutcome.fallbackCmd;
    // cortex#1481 — the hub-owner artifact carries the raw PSK (like the OOB
    // `surfaced` block) so it rides its OWN explicit key, joined with real
    // newlines, never folded into a step/reason field.
    if (sealOutcome.hubOwnerArtifact) data.hub_owner_artifact = sealOutcome.hubOwnerArtifact.join("\n");
    if (report.discordWarning) data.discord_warning = report.discordWarning;
    return ok(renderJson(envelopeOk([], data)));
  }

  const lines: string[] = [
    `cortex network admit ${requestId}: admitted`,
    `  principal:   ${report.principalId}`,
    `  admin:       ${material.fingerprint}`,
  ];
  // C-1316 — the seal transcript: state plainly whether the peer is CONNECTABLE.
  if (sealOutcome.status === "sealed") {
    lines.push(`  seal:        delivered — peer is now CONNECTABLE`);
    for (const s of sealOutcome.steps) lines.push(`    ${s}`);
    // cortex#1481 — external hub (or --seal-only): the hub write never
    // happened, so print the hub-owner artifact explicitly.
    if (sealOutcome.hubOwnerArtifact) {
      lines.push("");
      for (const s of sealOutcome.hubOwnerArtifact) lines.push(`  ${s}`);
    }
  } else if (sealOutcome.status === "skipped") {
    lines.push(`  seal:        skipped — ${sealOutcome.reason ?? "no seal"} (peer is ADMITTED but INERT)`);
    if (sealOutcome.fallbackCmd) lines.push(`               to seal: ${sealOutcome.fallbackCmd}`);
  } else {
    lines.push(`  seal:        NOT delivered — peer is ADMITTED but INERT`);
    lines.push(`               reason: ${sealOutcome.reason ?? "seal failed"}`);
    if (sealOutcome.fallbackCmd) lines.push(`               to seal: ${sealOutcome.fallbackCmd}`);
  }
  if (discordMember !== undefined) {
    if (report.discordStatus === "assigned") {
      lines.push(`  discord:     role "${discordRole}" assigned to member ${discordMember}`);
    } else {
      lines.push(`  discord:     ${report.discordWarning}`);
    }
  }
  lines.push("");
  return ok(lines.join("\n"));
}

// =============================================================================
// C-1348 — `cortex network reject <request-id>` (admission DENIAL)
// =============================================================================

/**
 * `cortex network reject <request-id> --admin-seed <path> [--apply]`
 *
 * ADR-0015's admission-denial verb — the exact mirror of {@link runAdmit},
 * except the signed decision claim carries `decision: "reject"` and it POSTs to
 * `/admission-requests/:id/reject`. The registry's shared `handleDecision` moves
 * the PENDING row to REJECTED. Grants + seals NOTHING (a rejected request has no
 * roster row to make connectable), so — unlike admit — there is no seal step.
 *
 * C-1350 S3 — the Tier-1 de-admission pairing: where admit's `--discord-member`
 * block ASSIGNS the community-fleet role, reject's REMOVES it (a final, non-fatal
 * step after the REJECTED decision commits). Same flag names, same resolution
 * precedence; a role-removal failure never fails the reject.
 *
 * Dry-run by default (safe posture). Pass --apply to execute.
 *
 * There is no network selector: the request's network_id is fixed at register
 * time and the registry authorises + acts on whatever it recorded — the reject
 * is scoped by that stored value, never by anything the caller passes.
 */
async function runReject(
  requestId: string,
  flags: FlagMap,
  json: boolean,
  // S5 (cortex#1519) — injectable admit-ports factory (shared with `admit`),
  // so reject's registry decision-POST is testable with fake ports. NOTE:
  // reject's Discord ROLE REMOVAL is NOT reachable through this factory — it
  // stays on the shared `removeDiscordFleetRole` helper below (see that
  // function's doc comment for why). Production omits this param → the live
  // adapters.
  admitPortsFactory: AdmitPortsFactory = DEFAULT_ADMIT_PORTS_FACTORY,
): Promise<ExitResult> {
  if (!requestId) {
    return usageError("reject", "missing request-id (usage: cortex network reject <request-id> --admin-seed <path>; discover ids with `cortex network admit --list-pending --admin-seed <path>`)", json);
  }

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("reject", seedRes.reason, json);

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("reject", applyRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_ADMIT_REGISTRY_URL;
  // C-1350 S3 — de-admission Discord flags (mirror admit's block exactly).
  const discordMember = optionalValueFlag(flags, "--discord-member");
  const discordServer = optionalValueFlag(flags, "--discord-server");
  const discordGuild = optionalValueFlag(flags, "--discord-guild");
  const discordRole = optionalValueFlag(flags, "--discord-role") ?? DEFAULT_ADMIT_DISCORD_ROLE;

  // Load + chmod-600-gate the admin seed
  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("reject", matRes.reason, json);
  const material = matRes.material;

  // DRY-RUN (default): print the plan, touch nothing — never builds a port.
  if (!applyRes.apply) {
    if (json) {
      return ok(
        renderJson(
          envelopeOk([], {
            subcommand: "reject",
            request_id: requestId,
            decision: "reject",
            registry_url: registryUrl,
            admin_fingerprint: material.fingerprint,
            applied: "false",
          }),
        ),
      );
    }
    const lines = [
      `cortex network reject ${requestId}: dry-run (no registry write; pass --apply to execute)`,
      `  decision:          reject`,
      `  registry:          ${registryUrl}`,
      `  admin_fingerprint: ${material.fingerprint}`,
      ...(discordMember !== undefined ? [`  discord_member:    ${discordMember} (role "${discordRole}" would be removed)`] : []),
      ``,
    ];
    return ok(lines.join("\n"));
  }

  // APPLY path — the decision POST lives in network-admit-lib.ts over
  // network-admit-ports.ts. No admin-signed GET pre-check first (see
  // runNetworkReject's doc: the admin READ gate is GLOBAL-admin-only today,
  // ADR-0020, so a GET pre-check would 403 a PER-NETWORK admin before the
  // POST that would in fact authorise them).
  const ports = admitPortsFactory({ registryUrl, material });
  const report = await runNetworkReject({ requestId, material }, ports);

  if (!report.ok) {
    return opError("reject", report.reason ?? "reject failed", json);
  }

  // C-1350 S3 — Tier-1 de-admission: remove the community-fleet role. The
  // REJECTED decision is ALREADY committed above, so this is a final
  // non-fatal step — any failure degrades to an actionable warning. Stays on
  // `removeDiscordFleetRole` (shared with `secret revoke-member`), not the
  // S5 `AdmitPorts.discord` port — see the note above `removeDiscordFleetRole`.
  let discordStatus = "skipped";
  let discordWarning = "";
  if (discordMember !== undefined) {
    const outcome = await removeDiscordFleetRole(
      { member: discordMember, server: discordServer, guild: discordGuild, role: discordRole },
      "rejected",
    );
    discordStatus = outcome.status;
    discordWarning = outcome.warning;
  }

  // Output summary — no seal (rejection grants nothing); Discord role removal
  // rides along only when --discord-member was given.
  if (json) {
    const data: Record<string, string> = {
      subcommand: "reject",
      applied: "true",
      request_id: requestId,
      decision: "reject",
      ...(report.principalId ? { principal_id: report.principalId } : {}),
      admin_fingerprint: material.fingerprint,
      ...(discordStatus !== "skipped" && { discord_status: discordStatus }),
    };
    if (discordWarning) data.discord_warning = discordWarning;
    return ok(renderJson(envelopeOk([], data)));
  }

  const lines: string[] = [
    `cortex network reject ${requestId}: rejected`,
    ...(report.principalId ? [`  principal:   ${report.principalId}`] : []),
    `  admin:       ${material.fingerprint}`,
  ];
  if (discordStatus === "removed") {
    lines.push(`  discord:     community-fleet role removed`);
  } else if (discordStatus !== "skipped") {
    lines.push(`  discord:     ${discordWarning}`);
  }
  lines.push(``);
  return ok(lines.join("\n"));
}

// =============================================================================
// ADR-0018 PR5b (#1240) — `cortex network secret <action> <network> <member>`
// =============================================================================

/** Default registry for the secret tooling — mirrors admit / create (#1228). */
const DEFAULT_SECRET_REGISTRY_URL = DEFAULT_REGISTRY.url;
/** Default hub nats-server config (the operator-mode hub local.conf). */
const DEFAULT_HUB_CONFIG_PATH = "~/.config/nats/local.conf";
/** Member pubkey grammar — 32-byte Ed25519, base64 (44 chars, padded). */
const MEMBER_PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Factory for the secret port bundle (`SecretPortsFactory` type now homed in
 * network-admit-ports.ts, S5 #1586 review — see the re-export note above).
 * Production builds the live adapters (hub config fs + reload, registry
 * admin-read + hub-admin delivery/revoke). Tests inject fakes that record
 * calls without touching fs/registry/nats.
 */
const DEFAULT_SECRET_PORTS_FACTORY: SecretPortsFactory = (cfg) => buildLiveSecretPorts(cfg);

/**
 * C-1349 Slice 2 — factory for the `rotate-key` port bundle. Production builds the
 * live adapters (hub-conf read + registry ADMITTED-list + hub-admin sealed-blob
 * POST + K mint + guarded hub-K-store write). Tests inject recording fakes.
 */
export type KeyRotationPortsFactory = (cfg: {
  hubConfigPath: string;
  registryUrl: string;
  material: import("../../../bus/stack-provisioning").StackIdentityMaterial;
  hubStackConfigPath: string;
}) => NetworkKeyRotationPorts;

const DEFAULT_KEY_ROTATION_PORTS_FACTORY: KeyRotationPortsFactory = (cfg) =>
  buildLiveKeyRotationPorts(cfg);

/**
 * C-1349 Slice 1 — read the per-network payload key `K` (+ its kid) from the HUB
 * STACK's own resolved cortex config (`policy.federated.networks[<net>]`), the
 * SAME store the encryption runtime reads (`networkKeyFromConfig`). This is the
 * single K custody source for sealed delivery (design decision #1: no `--payload
 * -key-path` flag, no second store). `--config`/`--stack` are config LOCATORS
 * resolved exactly as every sibling network verb does.
 *
 * Returns the base64 K string VERBATIM (the seal carries it opaquely) + the kid
 * (`payload_key_id ?? <net>/k1`). NEVER logs K. A MISSING config or an
 * encryption-off / keyless network → `{ ok: true }` with no key (seal PSK only).
 * A config that EXISTS but fails to parse/validate FAILS (surfaced to the admin)
 * rather than silently downgrading a network that is supposed to be encrypted.
 */
/**
 * cortex#1598 (epic #1595 slice 2) — resolve the OPERATOR-MODE attestation for a
 * network. `hub_mode` / `resolver_mode` come off the last VERIFIED descriptor
 * (the SAME DD-10 `~/.config/cortex/network-cache/` cache the hub-locality read
 * uses) when present — the verified attestation wins — ELSE off the hub owner's
 * own `policy.federated.networks[<id>].hub_mode`/`.resolver_mode`.
 *
 * The local-config fallback is LOAD-BEARING, not cosmetic: the hub owner runs
 * `network create`, not `join`, so they may have NO cached descriptor for their
 * OWN network. Reading only the cache would leave `hubMode` undefined and
 * silently degrade an operator network to the PSK/hub-write path — writing an
 * inline leaf user onto an operator hub and crashing it (cortex#794), the exact
 * F4 failure Guard A exists to prevent. The local declaration closes that gap.
 * A network with NEITHER a cached descriptor NOR a local declaration resolves to
 * simple (unattested = legacy/simple, the design §5.1 / registry `validate.ts`
 * back-compat rule) — so an operator network MUST be attested one way or the
 * other. The hub FED account comes from `--hub-fed-account` → else the local
 * `hub_fed_account`. Injectable cache for tests.
 */
export function resolveOperatorAttestation(
  flags: FlagMap,
  networkId: string,
  load: ConfigReader,
  cache: NetworkCache = new NetworkCache({
    cacheDir: expandTilde(join("~", ".config", "cortex", "network-cache")),
  }),
): { hubMode?: "operator" | "simple"; resolverMode?: "nats" | "memory"; hubFedAccount?: string } {
  const descriptor = cache.load(networkId)?.descriptor;

  // Read the local config once (the hub owner's own declaration + the FED
  // account). Non-fatal if unreadable — the operator branch fail-fasts clearly
  // on a missing FED account, and the separate payload-key read reports a broken
  // config with its own message.
  let cfgNetwork: import("../../../common/types/cortex-config").PolicyFederatedNetwork | undefined;
  try {
    const cfg = load(resolveLocalStackConfigPath(flags));
    cfgNetwork = cfg.policy?.federated?.networks.find((n) => n.id === networkId);
  } catch (_err) {
    cfgNetwork = undefined;
  }

  // Verified descriptor wins; the hub owner's local declaration is the fallback.
  const hubMode = descriptor?.hub_mode ?? cfgNetwork?.hub_mode;
  const resolverMode = descriptor?.resolver_mode ?? cfgNetwork?.resolver_mode;
  const hubFedAccount = optionalValueFlag(flags, "--hub-fed-account") ?? cfgNetwork?.hub_fed_account;

  return {
    ...(hubMode !== undefined && { hubMode }),
    ...(resolverMode !== undefined && { resolverMode }),
    ...(hubFedAccount !== undefined && hubFedAccount.length > 0 && { hubFedAccount }),
  };
}

function resolveHubPayloadKey(
  flags: FlagMap,
  networkId: string,
  load: ConfigReader,
): { ok: true; payloadKey?: string; payloadKeyKid?: string } | { ok: false; reason: string } {
  const path = resolveLocalStackConfigPath(flags);
  let cfg: LoadedConfig;
  try {
    cfg = load(path);
  } catch (err) {
    return {
      ok: false,
      reason:
        `failed to read the hub stack config ${path} for the network payload key: ` +
        `${err instanceof Error ? err.message : String(err)} — fix the config, or pass ` +
        `--config <path> to point at the hub stack's cortex config`,
    };
  }
  const network = cfg.policy?.federated?.networks.find((n) => n.id === networkId);
  if (network?.payload_key === undefined) {
    // No config, encryption-off network, or a network with no K → seal PSK only.
    return { ok: true };
  }
  return {
    ok: true,
    payloadKey: network.payload_key,
    payloadKeyKid: network.payload_key_id ?? defaultKeyId(networkId),
  };
}

async function runSecret(
  actionArg: string,
  networkId: string,
  member: string,
  flags: FlagMap,
  json: boolean,
  portsFactory: SecretPortsFactory,
  // C-1349 Slice 1 — injectable hub stack config reader so the payload-key (K)
  // read is testable without touching the principal's real `~/.config/cortex/`.
  // Production omits → the tolerant `loadConfigWithAgents` reader.
  load: ConfigReader = DEFAULT_READER,
  // C-1349 Slice 2 — injectable rotate-key ports factory. Production omits → live.
  keyRotationPortsFactory: KeyRotationPortsFactory = DEFAULT_KEY_ROTATION_PORTS_FACTORY,
): Promise<ExitResult> {
  // C-1349 Slice 2 — `rotate-key` is network-WIDE (no member pubkey); route it to
  // its own handler BEFORE the per-member action + member-grammar validation.
  if (actionArg === "rotate-key") {
    return runKeyRotation(networkId, flags, json, keyRotationPortsFactory);
  }

  // 1. Validate the action.
  const validActions: SecretAction[] = ["add-member", "revoke-member", "rotate"];
  if (!validActions.includes(actionArg as SecretAction)) {
    return usageError("secret", `unknown action "${actionArg}" (expected one of: ${validActions.join(", ")}, rotate-key)`, json);
  }
  const action = actionArg as SecretAction;

  // 2. Validate network + member pubkey grammar.
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("secret", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  if (member === "") {
    return usageError("secret", `action "${action}" requires a member pubkey (usage: cortex network secret ${action} <network> <member-pubkey>)`, json);
  }
  // cortex#1482 — accept EITHER encoding (base64 OR an nkey-U, either role);
  // the RAW string rides through unchanged into SecretInputs.memberPubkey —
  // network-secret-lib.ts normalizes it for the actual lookup/seal and, on a
  // miss, uses this same raw value to explain a registered-vs-account
  // representation mismatch (ADR-0018) instead of a bare grammar error.
  if (detectPubkey(member) === undefined) {
    return usageError(
      "secret",
      `member "${member}" must be a 32-byte Ed25519 pubkey — base64 (44 chars) or an NKey public key (A…/U… + 55 base32 chars)`,
      json,
    );
  }

  // 3. Resolve delivery mode (add-member / rotate only — rotate is always sealed).
  const deliverRaw = optionalValueFlag(flags, "--deliver") ?? "sealed";
  if (deliverRaw !== "sealed" && deliverRaw !== "oob") {
    return usageError("secret", `--deliver must be "sealed" or "oob" (got "${deliverRaw}")`, json);
  }
  const deliver: DeliveryMode = deliverRaw;
  if (action === "rotate" && deliver === "oob") {
    return usageError("secret", `rotate always re-seals; --deliver oob is only valid for add-member`, json);
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("secret", applyRes.reason, json);

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("secret", seedRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_SECRET_REGISTRY_URL;
  const hubConfigPath = optionalValueFlag(flags, "--hub-config") ?? DEFAULT_HUB_CONFIG_PATH;
  const leafUserOverride = optionalValueFlag(flags, "--leaf-user");
  // C-1350 S3 — revoke-member de-admission Discord flags (mirror admit's block).
  // Only meaningful for revoke-member; other actions ignore them.
  const discordMember = optionalValueFlag(flags, "--discord-member");
  const discordServer = optionalValueFlag(flags, "--discord-server");
  const discordGuild = optionalValueFlag(flags, "--discord-guild");
  const discordRole = optionalValueFlag(flags, "--discord-role") ?? DEFAULT_ADMIT_DISCORD_ROLE;
  // cortex#1481 — add-member/rotate only: force the seal-only path (never write
  // the local hub) + the hub's own account nkey-U, when the admin knows it.
  // cortex#1482 — normalize either encoding (nkey-U or base64) and explain a
  // registered-vs-account role mismatch instead of a bare grammar error.
  const sealOnly = flags["--seal-only"] === true;
  const hubAccountRes = normalizeHubAccountFlag(optionalValueFlag(flags, "--hub-account"));
  if (!hubAccountRes.ok) return usageError("secret", hubAccountRes.reason, json);
  const hubAccount = hubAccountRes.value;
  // cortex#1482 (Pair 1) — a plausible copy-paste mix-up: the member's OWN
  // registered/PoP pubkey and the hub's federation account are DIFFERENT
  // keys by design (seal-target ≠ leaf-account, ADR-0018). Catch it here,
  // before either value reaches the lookup/artifact.
  if (hubAccount !== undefined && samePubkey(member, hubAccount)) {
    return usageError(
      "secret",
      `member pubkey and --hub-account resolve to the SAME key — they must be different (the member's ` +
        `registered/PoP pubkey vs. the hub's federation account; seal-target ≠ leaf-account, ADR-0018)`,
      json,
    );
  }

  // 4. Load + chmod-600-gate the hub-admin seed.
  const matRes = await hubAdminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("secret", matRes.reason, json);

  // 4b. C-1349 Slice 1 — resolve the per-network payload key K from the HUB
  // STACK's own resolved config (design decision #1: hub config ONLY, no mint,
  // no second store). add-member / rotate seal it alongside the PSK so join
  // installs encryption; revoke-member does not touch K. A genuinely-broken hub
  // config FAILS the command (never silently downgrade encryption); an ABSENT
  // config or an encryption-off network → seal PSK only (the lib prints the
  // SOP-fallback info line). K never reaches this function's output.
  let payloadKey: string | undefined;
  let payloadKeyKid: string | undefined;
  if (action !== "revoke-member" && deliver === "sealed") {
    const kRes = resolveHubPayloadKey(flags, networkId, load);
    if (!kRes.ok) return opError("secret", kRes.reason, json);
    payloadKey = kRes.payloadKey;
    payloadKeyKid = kRes.payloadKeyKid;
  }

  // cortex#1598 — operator-mode attestation (hub_mode/resolver_mode off the
  // verified descriptor + the hub FED account). Absent ⇒ the simple/PSK path
  // (unchanged); present + operator-mode ⇒ addOrRotate mints a scoped user + seals v2.
  const op = resolveOperatorAttestation(flags, networkId, load);

  const ports = portsFactory({ hubConfigPath, registryUrl, material: matRes.material });
  const inputs: SecretInputs = {
    action,
    networkId,
    memberPubkey: member,
    deliver,
    ...(leafUserOverride !== undefined && { leafUserOverride }),
    ...(payloadKey !== undefined && { payloadKey }),
    ...(payloadKeyKid !== undefined && { payloadKeyKid }),
    sealOnly,
    ...(hubAccount !== undefined && { hubAccount }),
    ...(op.hubMode !== undefined && { hubMode: op.hubMode }),
    ...(op.resolverMode !== undefined && { resolverMode: op.resolverMode }),
    ...(op.hubFedAccount !== undefined && { hubFedAccount: op.hubFedAccount }),
    apply: applyRes.apply,
  };

  let report;
  try {
    report = await runNetworkSecret(inputs, ports);
  } catch (err) {
    return opError("secret", `secret ${action} failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // 4b. C-1350 S3 — Tier-1 de-admission pairing for revoke-member. The hub cut +
  // registry REVOKE are ALREADY committed in the report above (transport is cut,
  // the row is REVOKED), so removing the community-fleet role is a final NON-FATAL
  // step: any resolution/API failure degrades to an actionable warning and the
  // revoke still exits 0. Only runs on a successfully-APPLIED revoke-member with
  // --discord-member given (a dry-run or a failed revoke removes nothing).
  let discordStatus = "skipped";
  let discordWarning = "";
  if (action === "revoke-member" && discordMember !== undefined) {
    if (report.ok && report.applied) {
      const outcome = await removeDiscordFleetRole(
        { member: discordMember, server: discordServer, guild: discordGuild, role: discordRole },
        "revoked",
      );
      discordStatus = outcome.status;
      discordWarning = outcome.warning;
    } else if (!report.applied) {
      // Dry-run: surface the intent (no mutation) — mirrors admit's dry-run line.
      discordStatus = "dry-run";
    }
    // A FAILED apply (report.ok === false) leaves discordStatus "skipped": the
    // revoke didn't commit, so there is nothing to pair the role removal with.
  }

  // 4c. C-1349 Slice 2 — revoke does NOT auto-rotate (design decision #7), but on
  // an ENCRYPTION-ENABLED network the evictee may retain K and decrypt captured
  // traffic. So a revoke-member on a network with a hub-side K prints a rotate-now
  // recommendation naming the EXACT command. Best-effort: a broken/absent hub
  // config just omits the hint (the revoke already committed — never fail it here).
  let rotateNowHint: string | undefined;
  if (action === "revoke-member" && report.ok) {
    const kRes = resolveHubPayloadKey(flags, networkId, load);
    if (kRes.ok && kRes.payloadKey !== undefined) {
      rotateNowHint =
        `evicted member may retain the payload key K — run ` +
        `\`cortex network secret rotate-key ${networkId} --admin-seed <p> --apply\` ` +
        `to mint a new K and re-seal it to the remaining members`;
    }
  }

  // 5. Render. SECRETS never appear in steps/data; the oob PSK is surfaced in a
  // dedicated, explicitly-labelled block (the one place a secret reaches stdout).
  if (json) {
    const data: Record<string, string> = {
      subcommand: "secret",
      applied: report.applied ? "true" : "false",
      ...report.data,
      hub_admin_fingerprint: matRes.material.fingerprint,
      ...(discordStatus !== "skipped" && { discord_status: discordStatus }),
      ...(rotateNowHint !== undefined && { rotate_now_recommendation: rotateNowHint }),
    };
    if (discordWarning) data.discord_warning = discordWarning;
    // The oob PSK is the hub-admin's to hand over — include it under an explicit
    // key so a machine consumer can pluck it, never folded into the plan text.
    if (report.surfaced) {
      data.oob_leaf_user = report.surfaced.leafUser;
      data.oob_leaf_secret = report.surfaced.psk;
    }
    // cortex#1481 — the hub-owner artifact carries the raw PSK (like the OOB
    // block above) so it rides its OWN explicit key, joined with real
    // newlines, never folded into steps/data's other fields.
    if (report.hubOwnerArtifact) data.hub_owner_artifact = report.hubOwnerArtifact.join("\n");
    const env = report.ok ? envelopeOk([], data) : envelopeError(report.reason ?? "secret command failed", data);
    return report.ok ? ok(renderJson(env)) : { exitCode: 1, stdout: "", stderr: renderJson(env) };
  }

  const header = report.applied
    ? `cortex network secret ${action} ${networkId}: ${report.ok ? "ok" : "FAILED"}`
    : `cortex network secret ${action} ${networkId}: dry-run (no mutation; pass --apply)`;
  const lines = [header, ...report.steps.map((s) => `  ${s}`)];
  if (!report.ok) lines.push(`  ✗ ${report.reason ?? "unknown failure"}`);
  if (discordStatus === "removed") {
    lines.push(`  discord:    community-fleet role removed`);
  } else if (discordStatus === "dry-run") {
    lines.push(`  discord:    would remove role "${discordRole}" from member ${discordMember}`);
  } else if (discordStatus !== "skipped") {
    lines.push(`  discord:    ${discordWarning}`);
  }
  if (rotateNowHint !== undefined) {
    lines.push(`  ⚠ rotate now: ${rotateNowHint}`);
  }
  if (report.surfaced) {
    lines.push("");
    lines.push("  ── OUT-OF-BAND SECRET (hand this to the member over a secure channel) ──");
    lines.push(`  leaf user:   ${report.surfaced.leafUser}`);
    lines.push(`  leaf secret: ${report.surfaced.psk}`);
  }
  // cortex#1481 — external hub (or --seal-only): the hub write never
  // happened, so print the exact hub-owner snippet explicitly.
  if (report.hubOwnerArtifact) {
    lines.push("");
    for (const s of report.hubOwnerArtifact) lines.push(`  ${s}`);
  }
  lines.push("");
  const body = lines.join("\n");
  return report.ok ? ok(body) : { exitCode: 1, stdout: "", stderr: body };
}

/**
 * C-1349 Slice 2 — `cortex network secret rotate-key <network> --admin-seed <p>
 * [--apply]`. Network-WIDE payload-key (K) rotation: mint K′ → re-seal EVERY
 * ADMITTED member (leaf_psk UNCHANGED + payload_key=K′ + bumped kid) → advance the
 * hub K store. DRY-RUN by default; --apply mutates. K NEVER reaches stdout/json —
 * only the new kid + a SHA-256(K′) fingerprint are printable.
 */
async function runKeyRotation(
  networkId: string,
  flags: FlagMap,
  json: boolean,
  keyRotationPortsFactory: KeyRotationPortsFactory,
): Promise<ExitResult> {
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("secret", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("secret", applyRes.reason, json);

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("secret", seedRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_SECRET_REGISTRY_URL;
  const hubConfigPath = optionalValueFlag(flags, "--hub-config") ?? DEFAULT_HUB_CONFIG_PATH;
  const hubStackConfigPath = resolveLocalStackConfigPath(flags);

  const matRes = await hubAdminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("secret", matRes.reason, json);

  const ports = keyRotationPortsFactory({
    hubConfigPath,
    registryUrl,
    material: matRes.material,
    hubStackConfigPath,
  });
  const inputs: KeyRotationInputs = {
    networkId,
    apply: applyRes.apply,
    nowIso: new Date().toISOString(),
  };

  let report;
  try {
    report = await runNetworkKeyRotation(inputs, ports);
  } catch (err) {
    return opError("secret", `secret rotate-key failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  if (json) {
    const data: Record<string, string> = {
      subcommand: "secret",
      action: "rotate-key",
      applied: report.applied ? "true" : "false",
      ...report.data,
      hub_admin_fingerprint: matRes.material.fingerprint,
      resealed_count: report.members.filter((m) => m.resealed).length.toString(),
    };
    const members = report.members.map((m) => ({
      member_fingerprint: m.memberFingerprint,
      request_id: m.requestId,
      resealed: m.resealed ? "yes" : "no",
      ...(m.note !== undefined && { note: m.note }),
      ...(report.newKid !== undefined && m.resealed && { kid: report.newKid }),
    }));
    const env = report.ok ? envelopeOk(members, data) : envelopeError(report.reason ?? "rotate-key failed", { ...data, members: JSON.stringify(members) });
    return report.ok ? ok(renderJson(env)) : { exitCode: 1, stdout: "", stderr: renderJson(env) };
  }

  const header = report.applied
    ? `cortex network secret rotate-key ${networkId}: ${report.ok ? "ok" : "FAILED"}`
    : `cortex network secret rotate-key ${networkId}: dry-run (no mutation; pass --apply)`;
  const lines = [header, ...report.steps.map((s) => `  ${s}`)];
  if (report.members.length > 0) {
    lines.push("");
    lines.push("  MEMBER          RESEALED  KID / NOTE");
    for (const m of report.members) {
      const resealed = report.applied ? (m.resealed ? "yes" : "no ") : "—  ";
      const tail = m.resealed && report.newKid !== undefined ? report.newKid : (m.note ?? "");
      lines.push(`  ${m.memberFingerprint.padEnd(14)}  ${resealed.padEnd(8)}  ${tail}`);
    }
  }
  if (!report.ok) lines.push(`  ✗ ${report.reason ?? "unknown failure"}`);
  lines.push("");
  const body = lines.join("\n");
  return report.ok ? ok(body) : { exitCode: 1, stdout: "", stderr: body };
}

// =============================================================================
// G1d / T1 (cortex#1139) — `cortex network provision <stack>`
// =============================================================================

/**
 * Factory for the provision port bundle. Production builds the live adapters
 * (arc account-tree seam + signing + config write-back) targeting the stack's
 * config file; tests inject fakes that record calls without touching arc/fs.
 */
export type ProvisionPortsFactory = (stackConfigPath: string) => ProvisionPorts;

const DEFAULT_PROVISION_PORTS_FACTORY: ProvisionPortsFactory = (p) => buildLiveProvisionPorts(p);

/**
 * Factory for the make-live port bundle. Production builds the live adapters
 * (arc add-bot/export-account + resolver_preload editor + launchctl restarts);
 * `mutate` is the apply flag (false ⇒ the restart adapter no-ops, mirroring the
 * service-manager dry-run). Tests inject fakes that record calls without arc/fs.
 */
export type MakeLivePortsFactory = (mutate: boolean) => MakeLivePorts;

const DEFAULT_MAKE_LIVE_PORTS_FACTORY: MakeLivePortsFactory = (mutate) => buildLiveMakeLivePorts(mutate);

const STACK_SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/** Build the {@link MakeLiveInputs} from config + flags, or a usage reason. */
function deriveMakeLiveInputs(
  stackArg: string,
  flags: FlagMap,
  load: ConfigReader,
): { ok: true; inputs: MakeLiveInputs } | { ok: false; reason: string; usage: boolean } {
  const configPath = expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH);
  let cfg: LoadedConfig;
  try {
    cfg = load(configPath);
  } catch (err) {
    return { ok: false, reason: `config load failed: ${err instanceof Error ? err.message : String(err)}`, usage: false };
  }

  const principal = optionalValueFlag(flags, "--principal") ?? cfg.principal?.id;
  if (principal === undefined || principal === "") {
    return { ok: false, reason: "cannot resolve principal — pass --principal or set `principal.id` in cortex.yaml", usage: true };
  }
  if (!PRINCIPAL_ID_RE.test(principal)) {
    return { ok: false, reason: `principal "${principal}" must be lowercase alphanumeric + hyphen, letter-prefixed`, usage: true };
  }

  const slugRes = resolveProvisionSlug(stackArg, principal, cfg);
  if (!slugRes.ok) return { ok: false, reason: slugRes.reason, usage: true };
  const slug = slugRes.slug;

  const names = deriveProvisionNames(principal, slug);
  if (!names.ok) return { ok: false, reason: names.reason, usage: true };

  const agentsAccountPubkey = cfg.stack?.nats_infra?.agents_account;
  if (agentsAccountPubkey === undefined || agentsAccountPubkey === "") {
    return {
      ok: false,
      usage: true,
      reason:
        `stack.nats_infra.agents_account is not set for ${principal}/${slug} — ` +
        `run \`cortex network provision ${slug} --apply\` first to mint the account tree.`,
    };
  }

  // `nats.credsPath` is the daemon's OWN BUS/BOT creds — the user minted under
  // the `agents` account by make-live's own `add-bot` (network-make-live-lib.ts:179,
  // network-make-live-adapters.ts:96). It is DISTINCT from
  // `stack.nats_infra.creds_path`, the FEDERATION creds minted under a DIFFERENT
  // account at `network join`. The two must NEVER be conflated: a fallback to
  // `nats_infra.creds_path` here would mint the bus user under the wrong account
  // and collide with the federation user at join time (a tester proposed exactly
  // that — it is wrong). When neither --creds nor config supplies a path, default
  // to `~/.config/nats/<slug>-bot.creds` — the `-bot` suffix is LOAD-BEARING: it
  // keeps this BUS/BOT-user path DISTINCT from provision's FEDERATION-user default
  // `~/.config/nats/<slug>.creds` (deriveProvisionInputs, below). Two different
  // NATS accounts MUST be two different files; a bare `<slug>.creds` here would
  // resolve to the SAME path provision uses, so make-live (bus user, agents
  // account) and `network join` (federation user) would clobber each other. A
  // from-scratch `cortex stack create` stack now also seeds this key explicitly in
  // system.yaml, so this runtime default is the belt to that brace: a pre-existing,
  // unseeded stack needs NO --creds flag for from-scratch make-live.
  const credsPathRaw = optionalValueFlag(flags, "--creds") ?? cfg.config.nats?.credsPath;
  const credsPathExplicit = credsPathRaw !== undefined && credsPathRaw !== "";
  const credsPath = credsPathExplicit ? credsPathRaw : `~/.config/nats/${slug}-bot.creds`;
  const botName = cfg.config.nats?.name ?? "cortex";
  // BLOCK 1 — derive the nats-server config PER STACK from the stack's OWN config
  // (`stack.nats_infra.config_path`, the same field `network join` derives from),
  // NEVER a hardcoded shared default. make-live edits the resolver_preload of, and
  // HARD-RESTARTS, this exact nats-server; a `local.conf` default would silently
  // target the shared metafactory server for a `community`/`halden` stack (wrong
  // file + wrong server → blips metafactory + an own-auth Authorization Violation on
  // the WRONG bus). Fail-fast when it can't be derived rather than guessing — the
  // metafactory + work stacks legitimately carry `local.conf` in their own config.
  const natsConfigPath =
    optionalValueFlag(flags, "--nats-config") ?? cfg.stack?.nats_infra?.config_path;
  if (natsConfigPath === undefined || natsConfigPath === "") {
    return {
      ok: false,
      usage: true,
      reason:
        `cannot resolve the nats-server config for ${principal}/${slug} — pass --nats-config or set ` +
        "`stack.nats_infra.config_path` in the stack config. make-live edits + hard-restarts THIS " +
        "stack's nats-server; it must never default to the shared metafactory ~/.config/nats/local.conf.",
    };
  }

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return { ok: false, reason: applyRes.reason, usage: true };
  const force = flags["--force"] === true;

  // Read-only state probes (cheap fs reads via the resolver adapter).
  const resolverProbe = buildResolverPreloadAdapter();
  const state = {
    credsFileExists: existsSync(expandTilde(credsPath)),
    resolverHasAccount: resolverProbe.hasAccount(natsConfigPath, agentsAccountPubkey),
  };

  // cortex#1265 — assemble the operator-mode leaf package from the JWTs provision
  // wrote into `stack.nats_infra` (same minimum + precedence as network-derive's
  // O-3 join package). Present ⇒ a bus with no resolver_preload is BOOTSTRAPPED
  // operator-mode instead of refused (the local-only path).
  const ni = cfg.stack?.nats_infra;
  const opJwt = ni?.operator_jwt;
  const fedAccount = ni?.account;
  const acctJwt = ni?.account_jwt;
  const sysAccount = ni?.system_account;
  const sysJwt = ni?.system_account_jwt;
  const operatorModePackage: OperatorModeLeafPackage | undefined =
    opJwt !== undefined && opJwt !== "" &&
    fedAccount !== undefined && fedAccount !== "" &&
    acctJwt !== undefined && acctJwt !== ""
      ? {
          operatorJwt: opJwt,
          account: fedAccount,
          accountJwt: acctJwt,
          ...(sysAccount !== undefined && sysAccount !== "" && { systemAccount: sysAccount }),
          ...(sysJwt !== undefined && sysJwt !== "" && { systemAccountJwt: sysJwt }),
        }
      : undefined;

  // cortex#1265 (PR8) — derive the stack's OWN nats-server base identity so a
  // truly from-scratch stack (no `<slug>.conf` yet) can have its hard-isolated
  // base SYNTHESISED + bootstrapped in one make-live, instead of refusing. Every
  // field comes from the stack's own config — never fabricated: `listen` is the
  // host:port the stack's own daemon already dials (`nats.url`), validated to a
  // LOOPBACK host:port (parseLoopbackListen, review #1302) so a misconfigured
  // non-loopback / `0.0.0.0` / userinfo `nats.url` can't synthesise an over-exposed
  // bus; the names are the canonical `<slug>-<principal>`. Undefined when `nats.url`
  // is absent or not a safe loopback host:port — make-live then keeps the "create
  // the base config first" refusal for an absent file (never invent or over-expose).
  const listen = parseLoopbackListen(cfg.config.nats?.url);
  const baseIdentity: NatsBaseIdentity | undefined =
    listen !== undefined
      ? {
          serverName: `${slug}-${principal}`,
          listen,
          jetstreamStoreDir: `~/.config/nats/${slug}-jetstream`,
        }
      : undefined;

  const inputs: MakeLiveInputs = {
    principal,
    stackSlug: slug,
    stackId: `${principal}/${slug}`,
    agentsAccountName: names.agentsAccountName,
    agentsAccountPubkey,
    botName,
    credsPath,
    cortexConfigPath: configPath,
    // cortex#1265 (v5.30.2) — when credsPath was DEFAULTED, make-live persists the
    // resolved path into the SYSTEM-layer config so the daemon connects with it
    // (runtime.ts only passes credsPath when set). An explicit --creds/config value
    // is never overwritten (credsPathDefaulted stays false).
    credsPathDefaulted: !credsPathExplicit,
    systemConfigWritePath: resolveSystemWriteConfigPath(configPath),
    natsConfigPath,
    force,
    apply: applyRes.apply,
    state,
    ...(operatorModePackage !== undefined && { operatorModePackage }),
    ...(baseIdentity !== undefined && { baseIdentity }),
  };
  return { ok: true, inputs };
}

async function runMakeLive(
  stackArg: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  portsFactory: MakeLivePortsFactory,
): Promise<ExitResult> {
  const derived = deriveMakeLiveInputs(stackArg, flags, load);
  if (!derived.ok) {
    return derived.usage ? usageError("make-live", derived.reason, json) : opError("make-live", derived.reason, json);
  }
  const { inputs } = derived;

  // Build live ports only on --apply; dry-run uses them too but the restart
  // adapter no-ops when mutate=false (mirrors the service-manager contract).
  const ports = portsFactory(inputs.apply);
  const res = await makeLiveStack(inputs, ports);

  return renderFlowResult(
    "make-live",
    inputs.stackId,
    res.ok,
    res.reason,
    res.steps,
    inputs.apply,
    json,
    { agents_account: inputs.agentsAccountName },
  );
}

/**
 * Resolve where the `stack.nats_infra` write-back lands, layout-aware (mirrors
 * `stackConfigPath` in network-adapters): a config-split pointer writes to its
 * sibling `stacks/<basename>.yaml`; a legacy monolith writes to itself.
 */
function resolveStackWriteConfigPath(configPath: string): string {
  const expanded = expandTilde(configPath);
  const configDir = expanded.replace(/\/[^/]*$/, "");
  if (existsSync(join(configDir, "system", "system.yaml"))) {
    const base = (expanded.split("/").pop() ?? "").replace(/\.ya?ml$/i, "");
    return join(configDir, "stacks", `${base}.yaml`);
  }
  return expanded;
}

/**
 * Resolve where a DEFAULTED `nats.credsPath` write-back lands (cortex#1265,
 * v5.30.2). `nats` is the SYSTEM/bus layer: in a config-split layout it lives in
 * `<configDir>/system/system.yaml`; a legacy monolith carries it in the single
 * file. Sibling of {@link resolveStackWriteConfigPath} but targeting the SYSTEM
 * layer — the stack-layer file owns `nats_infra`, NOT `config.nats`. Writing
 * `nats.credsPath` to the stack file would split-brain it away from the
 * stack-create seed (which writes system.yaml) and from the config-table owner.
 */
function resolveSystemWriteConfigPath(configPath: string): string {
  const expanded = expandTilde(configPath);
  const configDir = expanded.replace(/\/[^/]*$/, "");
  const systemYaml = join(configDir, "system", "system.yaml");
  if (existsSync(systemYaml)) return systemYaml;
  return expanded;
}

/** Resolve the stack slug for provision: positional `{principal}/{slug}` or a
 *  bare slug, else the single configured `stack.id`, else `default`. */
function resolveProvisionSlug(
  stackArg: string,
  principal: string,
  cfg: LoadedConfig,
): { ok: true; slug: string } | { ok: false; reason: string } {
  if (stackArg === "") {
    const id = cfg.stack?.id;
    const slug = id !== undefined ? id.split("/")[1] ?? "default" : "default";
    return { ok: true, slug };
  }
  if (stackArg.includes("/")) {
    const parts = stackArg.split("/");
    if (parts.length !== 2 || parts[0] !== principal) {
      return { ok: false, reason: `<stack> "${stackArg}" must be {principal}/{slug} with prefix matching principal "${principal}"` };
    }
    const slug = parts[1] ?? "";
    if (!STACK_SLUG_RE.test(slug)) return { ok: false, reason: `<stack> slug "${slug}" must be letter-prefixed lowercase` };
    return { ok: true, slug };
  }
  if (!STACK_SLUG_RE.test(stackArg)) return { ok: false, reason: `<stack> "${stackArg}" must be letter-prefixed lowercase` };
  return { ok: true, slug: stackArg };
}

/** Build the {@link ProvisionInputs} from config + flags, or a usage reason. */
function deriveProvisionInputs(
  stackArg: string,
  flags: FlagMap,
  load: ConfigReader,
): { ok: true; inputs: ProvisionInputs; stackConfigPath: string } | { ok: false; reason: string; usage: boolean } {
  const configPath = expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH);
  let cfg: LoadedConfig;
  try {
    cfg = load(configPath);
  } catch (err) {
    return { ok: false, reason: `config load failed: ${err instanceof Error ? err.message : String(err)}`, usage: false };
  }

  const principal = optionalValueFlag(flags, "--principal") ?? cfg.principal?.id;
  if (principal === undefined || principal === "") {
    return { ok: false, reason: "cannot resolve principal — pass --principal or set `principal.id` in cortex.yaml", usage: true };
  }
  if (!PRINCIPAL_ID_RE.test(principal)) {
    return { ok: false, reason: `principal "${principal}" must be lowercase alphanumeric + hyphen, letter-prefixed`, usage: true };
  }

  const slugRes = resolveProvisionSlug(stackArg, principal, cfg);
  if (!slugRes.ok) return { ok: false, reason: slugRes.reason, usage: true };
  const slug = slugRes.slug;

  const names = deriveProvisionNames(principal, slug);
  if (!names.ok) return { ok: false, reason: names.reason, usage: true };

  const seedPath = optionalValueFlag(flags, "--seed-path") ?? cfg.stack?.nkey_seed_path ?? `~/.config/nats/${principal}-${slug}.seed`;
  // FEDERATION-user creds default. DELIBERATELY DISTINCT from make-live's BUS/BOT
  // creds default `~/.config/nats/<slug>-bot.creds` (deriveMakeLiveInputs, above):
  // these are two different NATS accounts (federation vs `agents`), so they MUST
  // be two different files — a shared path would clobber on the second mint.
  const credsPath = optionalValueFlag(flags, "--creds") ?? cfg.stack?.nats_infra?.creds_path ?? `~/.config/nats/${slug}.creds`;
  // cortex#1265 (PR8) — the per-stack nats-server config path make-live + join
  // derive their `--nats-config` from. Preserve a value already in config (the
  // SOP §B2 / hand-set path — never clobber), else the convention `~/.config/
  // nats/<slug>.conf` (docs/sop-stack-onboarding.md §B0.1 + §B2). Writing it here
  // is what closes the provision→make-live loop (no manual `nsc generate config`).
  const natsConfigPath = optionalValueFlag(flags, "--nats-config") ?? cfg.stack?.nats_infra?.config_path ?? `~/.config/nats/${slug}.conf`;

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return { ok: false, reason: applyRes.reason, usage: true };

  // cortex#1265 — the SYS (system) account to best-effort export. `--system-account`
  // overrides the conventional "SYS"; absent on a fresh nsc operator (skipped — optional).
  const systemAccountName = optionalValueFlag(flags, "--system-account") ?? "SYS";
  // The JWT export is ensure-shaped: it is a no-op once both operator_jwt AND
  // account_jwt already sit in config (the renderer's minimum).
  const natsInfra = cfg.stack?.nats_infra;
  const operatorModeJwtsPresent =
    natsInfra?.operator_jwt !== undefined &&
    natsInfra.operator_jwt !== "" &&
    natsInfra.account_jwt !== undefined &&
    natsInfra.account_jwt !== "";

  const inputs: ProvisionInputs = {
    principal,
    stackSlug: slug,
    stackId: `${principal}/${slug}`,
    operatorName: names.operatorName, // nsc operator account name (OP_<PRINCIPAL>)
    federationAccountName: names.federationAccountName,
    agentsAccountName: names.agentsAccountName,
    systemAccountName,
    seedPath,
    credsPath,
    configPath: natsConfigPath,
    force: flags["--force"] === true,
    apply: applyRes.apply,
    state: {
      federationAccount: cfg.stack?.nats_infra?.account,
      agentsAccount: cfg.stack?.nats_infra?.agents_account,
      systemAccount: cfg.stack?.nats_infra?.system_account,
      signingSeedExists: existsSync(expandTilde(seedPath)),
      operatorModeJwtsPresent,
    },
  };
  return { ok: true, inputs, stackConfigPath: resolveStackWriteConfigPath(configPath) };
}

async function runProvision(
  stackArg: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  portsFactory: ProvisionPortsFactory,
): Promise<ExitResult> {
  const derived = deriveProvisionInputs(stackArg, flags, load);
  if (!derived.ok) {
    return derived.usage ? usageError("provision", derived.reason, json) : opError("provision", derived.reason, json);
  }
  const { inputs, stackConfigPath } = derived;

  const ports = portsFactory(stackConfigPath);
  const res = await provisionStack(inputs, ports);

  if (json) {
    const data: Record<string, string> = {
      stack: inputs.stackId,
      applied: res.applied ? "true" : "false",
      operator: inputs.operatorName, // nsc operator account
      federation_account: inputs.federationAccountName,
      agents_account: inputs.agentsAccountName,
    };
    if (res.resolved !== undefined) {
      data.account = res.resolved.account;
      data.agents_account_pubkey = res.resolved.agentsAccount;
      data.config_path = res.resolved.configPath;
    }
    const env = res.ok
      ? envelopeOk([{ stack: inputs.stackId, plan: res.plan }], data)
      : envelopeError(res.reason ?? "provision failed", data);
    return res.ok
      ? ok(renderJson(env))
      : { exitCode: 1, stdout: "", stderr: renderJson(env) };
  }

  const header = res.applied
    ? `cortex network provision ${inputs.stackId}: ${res.ok ? "ok" : "FAILED"}`
    : `cortex network provision ${inputs.stackId}: dry-run (no mutation; pass --apply)`;
  const body =
    `${header}\n` +
    `  principal: ${inputs.principal}   stack: ${inputs.stackId}\n` +
    res.steps.map((s) => (s === "" ? "" : `  ${s}`)).join("\n") +
    (res.ok ? "" : `\n  ✗ ${res.reason ?? "unknown failure"}`) +
    "\n";
  return res.ok ? ok(body) : { exitCode: 1, stdout: "", stderr: body };
}

/**
 * `cortex network join` plug-and-play (cortex#1139) — when the stack isn't
 * provisioned yet (no `stack.nats_infra.account` + `agents_account`),
 * auto-run `cortex network provision` first so a single `join` stands the whole
 * substrate up. Returns the provision output to PREPEND, and whether join
 * should abort (an --apply provision that failed).
 */
/**
 * A stack is "provisioned enough to join" once its federation account is in
 * config (`stack.nats_infra.account`). `agents_account` is the G1d enhancement
 * (cross-account wiring); its absence does NOT block a legacy join.
 */
function isStackProvisioned(cfg: LoadedConfig): boolean {
  return cfg.stack?.nats_infra?.account !== undefined;
}

/**
 * Auto-provision fires ONLY for a config that genuinely describes a cortex
 * stack (principal.id + stack.id present) that has NOT yet minted its account
 * tree. This deliberately EXCLUDES the fully-flagged / empty-config legacy join
 * path (no principal/stack in config) so it never disrupts an explicit join.
 */
function shouldAutoProvision(cfg: LoadedConfig): boolean {
  return (
    cfg.principal?.id !== undefined &&
    cfg.stack?.id !== undefined &&
    cfg.stack.nats_infra?.account === undefined
  );
}

async function maybeAutoProvision(
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
  portsFactory: ProvisionPortsFactory,
): Promise<{ ran: boolean; provisionedAfter: boolean; provisionFailed: boolean; output: string }> {
  const configPath = expandTilde(optionalValueFlag(flags, "--config") ?? DEFAULT_CONFIG_PATH);
  let cfg: LoadedConfig;
  try {
    cfg = load(configPath);
  } catch {
    // A broken config surfaces later in the join's own derive; don't double-fail.
    return { ran: false, provisionedAfter: true, provisionFailed: false, output: "" };
  }
  if (!shouldAutoProvision(cfg)) {
    return { ran: false, provisionedAfter: true, provisionFailed: false, output: "" };
  }

  // Auto-provision with the SAME apply posture as the join.
  const res = await runProvision("", flags, json, load, portsFactory);
  const out = res.stdout || res.stderr;
  const banner = json ? "" : "cortex network join: stack not provisioned — auto-running `cortex network provision` first\n";

  // Re-read: on an --apply run the live config write-back lands, so the re-read
  // now sees the account tree and the join CAN proceed in the same invocation
  // (true plug-and-play). On a dry-run nothing was written, so the stack is
  // still unprovisioned and the join cannot meaningfully continue.
  let provisionedAfter: boolean;
  try {
    provisionedAfter = isStackProvisioned(load(configPath));
  } catch {
    provisionedAfter = false;
  }
  return { ran: true, provisionedAfter, provisionFailed: res.exitCode !== 0, output: banner + out };
}

// =============================================================================
// Dispatcher
// =============================================================================

export async function dispatchNetwork(
  argv: string[],
  // #753 — injectable config reader so CLI tests can derive from a fixture
  // config without touching the principal's real `~/.config/cortex/`.
  // Production callers omit it and the real `loadConfigWithAgents` is used.
  load: ConfigReader = DEFAULT_READER,
  // #56 — injectable probe-bus factory so `ping` CLI tests drive a fake bus
  // without standing up NATS. Production omits it → the live NATS-backed bus.
  pingBusFactory: PingBusFactory = DEFAULT_PING_BUS_FACTORY,
  // cortex#1139 — injectable provision-ports factory so `provision` / the join
  // auto-provision CLI tests drive fake arc/fs ports. Production omits it → the
  // live adapters (arc account-tree seam + signing + config write-back).
  provisionPortsFactory: ProvisionPortsFactory = DEFAULT_PROVISION_PORTS_FACTORY,
  // ADR-0018 PR5b — injectable secret-ports factory so the `secret` CLI tests
  // drive fake hub/registry/crypto ports. Production omits → the live adapters.
  secretPortsFactory: SecretPortsFactory = DEFAULT_SECRET_PORTS_FACTORY,
  // C-1257 — injectable make-live ports factory so the make-live CLI tests drive
  // fake arc/fs/restart ports. Production omits → the live adapters.
  makeLivePortsFactory: MakeLivePortsFactory = DEFAULT_MAKE_LIVE_PORTS_FACTORY,
  // C-1349 Slice 2 — injectable rotate-key ports factory so the CLI tests drive
  // fake hub-conf/registry/crypto/keyStore ports. Production omits → live.
  keyRotationPortsFactory: KeyRotationPortsFactory = DEFAULT_KEY_ROTATION_PORTS_FACTORY,
  // cortex#1484 — injectable doctor-ports factory so `doctor` CLI tests drive
  // fake config/monitor/probe-bus ports without touching fs or NATS.
  // Production omits it → the live adapters.
  doctorPortsFactory: DoctorPortsFactory = DEFAULT_DOCTOR_PORTS_FACTORY,
  // cortex#1485 — injectable handoff-ports factory so `handoff` CLI tests drive
  // fake admission/hub-auth/config/monitor ports. Production omits → live.
  handoffPortsFactory: HandoffPortsFactory = DEFAULT_HANDOFF_PORTS_FACTORY,
  // cortex#1498 — injectable authorize-ports factory so `authorize` CLI tests
  // drive fake admission-lookup/delivery ports. Production omits → live.
  authorizePortsFactory: AuthorizePortsFactory = DEFAULT_AUTHORIZE_PORTS_FACTORY,
  // S5 (cortex#1519) — injectable admit-ports factory so `admit`/`reject` CLI
  // tests drive fake registry/Discord/seal ports. Production omits → live.
  admitPortsFactory: AdmitPortsFactory = DEFAULT_ADMIT_PORTS_FACTORY,
): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: 2, stdout: "", stderr: `cortex network: ${err.message}\n${topLevelHelp()}` };
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return { exitCode: 2, stdout: "", stderr: `cortex network: ${msg}\n${topLevelHelp()}` };
  }

  switch (parsed.subcommand) {
    case "join":
      return runJoin(parsed.positionals.network ?? "", parsed.flags, json, load, provisionPortsFactory, handoffPortsFactory);
    case "leave":
      return runLeave(parsed.positionals.network ?? "", parsed.flags, json, load);
    case "status":
      return runStatus(parsed.flags, json, load);
    case "create":
      return runCreate(parsed.positionals.network ?? "", parsed.flags, json);
    case "ping":
      return runPing(parsed.positionals.peer ?? "", parsed.flags, json, load, pingBusFactory);
    case "doctor":
      return runDoctor(parsed.positionals.network ?? "", parsed.flags, json, load, doctorPortsFactory);
    case "handoff":
      return runHandoff(
        parsed.positionals.action ?? "",
        parsed.positionals.member ?? "",
        parsed.flags,
        json,
        load,
        handoffPortsFactory,
      );
    case "authorize":
      return runAuthorize(parsed.positionals.member ?? "", parsed.flags, json, authorizePortsFactory);
    case "admit":
      return runAdmit(parsed.positionals["request-id"] ?? "", parsed.flags, json, secretPortsFactory, admitPortsFactory);
    case "reject":
      return runReject(parsed.positionals["request-id"] ?? "", parsed.flags, json, admitPortsFactory);
    case "provision":
      return runProvision(parsed.positionals.stack ?? "", parsed.flags, json, load, provisionPortsFactory);
    case "make-live":
      return runMakeLive(parsed.positionals.stack ?? "", parsed.flags, json, load, makeLivePortsFactory);
    case "secret":
      return runSecret(
        parsed.positionals.action ?? "",
        parsed.positionals.network ?? "",
        parsed.positionals.member ?? "",
        parsed.flags,
        json,
        secretPortsFactory,
        load,
        keyRotationPortsFactory,
      );
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex network — one-command join to the Internet of Agentic Work (S4, #738; #752/#753)

Usage:
  cortex network join   <network> [--apply] [--config <p>] [overrides…]
  cortex network leave  <network> [--apply] [--config <p>] [overrides…]
  cortex network status [--principal <id>] [--stack <id>] [--monitor-url <url>] [--json]
  cortex network create <network> --hub <tls-url> --leaf-port <port> --admin-seed <path> [--network-admins <csv>] [--registry-url <url>] [--apply]
  cortex network ping   <peer> [--assistant <a>] [--network <id>] [--count N] [--timeout <ms>] [--json]
  cortex network doctor <network> [--principal <id>] [--stack <id>] [--config <p>] [--monitor-url <url>] [--json]
  cortex network handoff status <member> --network <net> [--principal <id>] [--stack <id>] [--config <p>] [--json]
  cortex network authorize <member-pubkey> --network <net> --admin-seed <hub-admin-seed>
                        [--registry-url <url>] [--apply] [--dry-run] [--json]
  cortex network admit  <request-id> --admin-seed <path> [--registry-url <url>] [--hub-config <p>]
                        [--roster-only] [--seal-only] [--hub-account <A…>] [--discord-member <id>]
                        [--discord-guild <id>] [--discord-server <profile>] [--discord-role <name>]
                        [--apply] [--dry-run] [--json]
  cortex network admit  --list-pending [--status <PENDING|ADMITTED|REJECTED>] [--network <id>]
                        --admin-seed <path> [--registry-url <url>] [--json]
  cortex network reject <request-id> --admin-seed <path> [--registry-url <url>] [--apply] [--dry-run] [--json]
  cortex network provision <stack> [--config <p>] [--principal <id>] [--seed-path <p>]
                        [--creds <p>] [--force] [--apply] [--dry-run] [--json]
  cortex network make-live <stack> [--config <p>] [--principal <id>] [--nats-config <p>]
                        [--creds <p>] [--force] [--apply] [--dry-run] [--json]
  cortex network secret <add-member|revoke-member|rotate> <network> <member-pubkey>
                        --admin-seed <hub-admin-seed> [--registry-url <url>] [--hub-config <p>]
                        [--deliver sealed|oob] [--leaf-user <u>] [--seal-only] [--hub-account <A…>]
                        [--apply] [--dry-run] [--json]
  cortex network secret rotate-key <network>   (network-wide K rotation — NO member pubkey)
                        --admin-seed <hub-admin-seed> [--config <p>] [--registry-url <url>]
                        [--hub-config <p>] [--apply] [--dry-run] [--json]

The one-liner (#753): \`cortex network join <network>\` derives EVERYTHING from
the loaded cortex.yaml — principal (principal.id), stack (stack.id), signing
seed (stack.nkey_seed_path), registry (policy.federated.registry.{url,pubkey}),
and the nats-server infra (stack.nats_infra.{config_path,plist_path,account,
creds_path}). Pass --config <p> to point at a non-default cortex.yaml
(default: ~/.config/cortex/cortex.yaml). The flags below are OPTIONAL
OVERRIDES: a passed flag wins; otherwise the value derives from config (or, for
creds, the convention ~/.config/nats/<network>.creds). A required value that is
neither flagged nor derivable fails with a clear error naming the config field.

Subcommands:
  join    Register → pull the SIGNED+VERIFIED network descriptor (DD-9; cached
          fallback on registry outage, DD-10) → render the nats-server leaf +
          ensure the plist loads it (DD-6) → write policy.federated.networks[]
          with registry-resolved peers (DD-5) + the stack's OWN accept-subject
          → restart. Idempotent (re-running converges). For a principal's
          SECOND+ stack, pass --principal-seed <root> so the register step
          root-signs the add-stack claim + preserves existing stacks (#791).
  ping    (signal#113 P-11, #56) Active federated reachability probe — the
          ICMP of the agent network. Fires a Direct probe.echo at <peer>
          ({principal} or {principal}/{stack}), awaits the built-in echo on
          our own probe.reply.echo, measures RTT, and prints + returns the
          verdict. The peer MUST be in this stack's
          policy.federated.networks[].peers[] (else not-configured, exit 2,
          nothing emitted). Exit codes: 0 reachable / 2 not-configured /
          3 no-responder / 4 timeout / 5 refused. --count for multiple probes
          (min/avg/max RTT); --assistant for a named Direct target; --network
          to disambiguate the topology (NEVER a wire segment).
  doctor  (cortex#1484, epic #1479) Verify the WHOLE federation path from this
          machine, leg by leg: network configured (peers[]/accept_subjects[])
          → local NATS monitor reachable → leaf established → leaf account
          binding → a REAL echoed round-trip per configured peer (reuses
          ping's transport). Each leg reports pass/fail/warn/skip + a fix +
          the responsible role (member/hub-owner/admin/peer), so a broken
          link pinpoints the failing leg instead of a bare "not reachable".
          READ-ONLY except for the bounded probe echo. No monitor configured
          on the local bus degrades leaf checks to warn/skip, never fail (the
          absent-monitor-is-inconclusive rule). Exit codes: 0 healthy /
          1 degraded / 2 broken.
  handoff (cortex#1485, epic #1479) Model a network join as the 3-leg handoff it
          actually is — seal (admin) → hub-authorize (hub owner) → leaf-up
          (member) — as STATE. \`handoff status <member> --network <net>\` shows,
          for that member, each leg's state (done | pending | blocked), the
          outstanding next leg, and WHOSE job it is (admin / hub-owner / member),
          so nobody has to guess what's outstanding or whose turn it is. The seal
          leg reads the member's own ADMITTED admission row (sealed leaf secret
          present); the leaf-up leg reuses doctor's /leafz leaf-established
          lookup. The hub-authorize leg (cortex#1498) reads the registry's
          \`hub_authorized_at\` marker — a REAL true/false once the hub owner has
          run \`cortex network authorize\`; a registry-unreachable read degrades to
          the documented undefined fallback (fail-closed, NOT done). Read-only.
          The enforcement counterpart is \`join --guided\`, which refuses to bring
          the leaf up until seal + hub-authorize are confirmed (or, absent a
          real signal, the \`--hub-authorized-confirmed\` attestation).
  authorize (cortex#1498, epic #1479 follow-up) The HUB OWNER's side of the
          hub-authorize leg. Run \`cortex network authorize <member-pubkey>
          --network <net> --admin-seed <hub-admin-seed>\` AFTER applying the
          member's leaf \`authorization\` entry on the hub's OWN nats-server
          config (the #1481 hub-owner artifact printed by \`secret add-member
          --seal-only\` / an EXTERNAL-hub add-member) to stamp the registry's
          \`hub_authorized_at\`. Hub-admin authority — the SAME allowlist
          \`secret add-member\`'s sealed delivery uses (ADR-0018 Q5). Mints
          nothing; no local fs/nats-config write (registry-only). DRY-RUN by
          default; --apply POSTs the signed claim.
  status  Show joined networks, peers, accept-subjects, leaf link state + counters.
  leave   Reverse a join cleanly: remove the network + leaf include, drop the
          plist -c arg if no networks remain, restart. Idempotent.
  create  (#747) Signed-admin create/update of a network's topology record
          (hub_url + leaf_port) in the registry. Replaces raw-SQL/D1 seeding.
          Derives admin_pubkey from --admin-seed (an nkey SU… seed, the same
          key shape as provision-stack), signs the claim, and POSTs it to
          <registry-url>/networks/<network>. DRY-RUN by default (prints the
          signed claim it WOULD POST); pass --apply to actually write. The
          registry FAILS CLOSED if its REGISTRY_ADMIN_PUBKEYS allowlist is
          unset, and rejects (403) an admin key not on the allowlist.
  provision (cortex#1139, ADR-0013) One-command sovereign account-topology setup.
          Mints the principal's OWN nsc operator (OP_<PRINCIPAL>) + a dedicated
          federation account + a per-stack agents account (ADR-0012 isolation),
          wires the local federated.> export/import (federation account → agents
          account), ensures the chmod-600 signing seed (no-clobber; --force to
          rotate), and writes stack.nats_infra back — leaving the stack ready for
          \`cortex network join\`. cortex runs zero nsc itself — it shells to arc
          for the nsc \`init-operator\` / \`add-account\` / \`add-federation-export\`
          mutations.
          DRY-RUN by default (prints the plan); --apply mutates. \`cortex network
          join\` auto-runs this when the stack isn't provisioned yet. The
          operator-mode bus conversion + restart are left to \`join\` (this verb is
          non-disruptive). Remaining two-party steps after provision: the leaf
          shared secret + hub topology agreement (out-of-band).
  make-live (C-1257, ADR-0013 Model B) The daemon-switch — lands a PROVISIONED
          stack's daemon onto its OWN agents account (ANDREAS_<STACK>_AGENTS).
          Mints the bus creds under the agents account at nats.credsPath (the
          file the daemon authenticates with), teaches the local NATS server the
          account (resolver_preload, MEMORY resolver), then HARD-restarts the
          nats-server (a SIGHUP reload does NOT load a new preloaded account) +
          the cortex daemon so it reconnects under the agents account. cortex
          runs zero nsc — it shells arc \`add-bot\` / \`export-account\`.
          Network-agnostic (local OR federated; for federated, run \`join\` after
          to render the leaf). make-live NEVER touches encryption/payload_key
          config — that is join's job: when the sealed leaf-secret envelope
          carries a payload key K (from \`secret add-member\`/\`rotate\`), join
          installs \`encryption: enabled\` + \`payload_key\` into the stack config
          (C-1349 Slice 1).
          The nats-server config it edits + hard-restarts is derived PER-STACK
          from stack.nats_infra.config_path (or --nats-config) — there is NO
          shared default, so a co-located stack on its OWN nats-server
          (community.conf / halden.conf) must carry config_path (or pass
          --nats-config); it NEVER silently targets the shared metafactory
          local.conf. Refuses a bus with no resolver_preload block (not
          operator-mode). The dry-run prints the resolved nats-server + daemon
          restart targets so the (possibly shared-server) blast radius is
          verifiable before --apply.
          Idempotent + dry-run by default; --apply mutates; --force re-mints.
          Run AFTER \`cortex network provision <stack> --apply\`.
  admit   (ADR-0015) One-command admin admission decision. Verifies the admin
          seed (chmod-600 gated), builds a signed admission decision claim
          (decision: "admit"), and POSTs it to /admission-requests/:id/admit
          in the registry. The principal is ADMITTED to the network roster.
          Mints nothing (no arc nats add-bot call — Model-A retired). Optionally
          assigns the Discord community-fleet role (O-5) via --discord-member.
          DRY-RUN by default; pass --apply to execute.
          ADMIT-AND-SEAL (C-1316): on --apply, admit ALSO mints + seals + delivers
          the per-member leaf PSK (the \`secret add-member\` motion) so the peer is
          CONNECTABLE, not just rostered — no ADMITTED-but-inert peers. Reuses the
          hub-local nats config at --hub-config (default ~/.config/nats/local.conf)
          — but ONLY when that hub is actually LOCAL to this host (cortex#1481):
          the network's cached hub_url is counted LOCAL when its host is a loopback
          alias, exactly matches this machine's hostname, OR resolves (DNS) to one
          of this machine's own network interfaces (the hub owner's own VM, even
          when it's cached as an FQDN). A hub that is none of those is NEVER
          written (the #1 storm cause — a foreign write leaves the joiner's leaf
          presenting a PSK the real hub never authorized). An external hub instead
          gets a registry-only seal + a printed hub-owner artifact (the exact
          leafnodes{} authorization snippet to hand to whoever runs that hub). Pass
          --seal-only to force that same
          seal-only + artifact path even when the hub looks local (never touches
          --hub-config); --hub-account <A…> names the hub's own federation account
          nkey-U when you already know it, so the printed snippet is account-bound.
          The seal NEVER fails a committed admit: if it can't run (hub-admin ≠
          registry-admin, or the hub config isn't readable) it surfaces a fallback
          telling you to run \`cortex network secret add-member\`. Pass --roster-only
          to commit the roster row ONLY and skip the seal entirely.
          --list-pending (C-1314): DISCOVERY mode — admin-signs a read and lists
          the admission queue (request-id · principal · network · peer · status ·
          created) so you can find the id to admit. Read-only (no --apply).
          --status defaults to PENDING; --network filters the rows client-side.
          NOTE (ADR-0020 read-scoping): admin READS are GLOBAL-admin-only today,
          so a per-network admin gets a readable 403 here even for their own
          network (per-network read-scoping is the fast-follow). Use a global-
          admin seed or the MC admission queue until then.
  reject  (C-1348, ADR-0015) The admission DENIAL verb — the mirror of admit.
          Verifies the admin seed (chmod-600 gated), builds a signed admission
          decision claim (decision: "reject"), and POSTs it to
          /admission-requests/:id/reject. The PENDING request moves to REJECTED.
          Grants + seals NOTHING (a denied request has no roster row), so there
          is no seal step and no Discord role — the admit-only flags are absent.
          Same admin gate as admit (global OR per-network admin, ADR-0020): a
          per-network admin may reject requests for THEIR OWN network only; a
          non-authorised key gets a readable 403. An already-decided (non-PENDING)
          request surfaces a clear "already ADMITTED/REJECTED/REVOKED" error.
          DRY-RUN by default; pass --apply to execute.

  join public   (S5, #739) Opt into the PUBLIC scope — the open square of the
          Internet of Agentic Work. Announces --capabilities to the registry
          public index + subscribes public.> + writes the policy.public opt-in.
          SAFE BY DEFAULT (OQ1): without --allow, inbound public is DISABLED
          (announce/discover only). With --allow <ids>, inbound is enabled but
          ALLOWLIST-gated to those principals — a non-allowlisted public sender
          is NEVER auto-trusted. There is no open-claim flag (deferred to the
          security ramp). public carries NO leaf — no --creds/--account needed.
  leave public  Reverse it: deregister from the public index + unsubscribe
          public.> + remove policy.public. Idempotent.

Safety:
  join/leave default to DRY-RUN (no disk/daemon mutation — they print the
  intended actions). Pass --apply to execute for real. --apply and --dry-run
  are mutually exclusive.

Flags (all OPTIONAL OVERRIDES — derived from cortex.yaml when omitted; #753):
  --config <p>            cortex.yaml to derive inputs from (default: ~/.config/cortex/cortex.yaml).
  --principal <id>        Override principal.id (the {me} subject segment).
  --stack <id>            Override stack.id; {principal}/{slug}; defaults to <principal>/default.
  --registry-url <url>    Override policy.federated.registry.url.
  --registry-pubkey <b64> Override policy.federated.registry.pubkey (DD-9); TOFU if omitted.
  --seed-path <p>         Override stack.nkey_seed_path (proof-of-possession).
  --principal-seed <p>    (join, #791) The principal ROOT seed (the FIRST stack's
                          seed). Pass ONLY when joining a SECOND+ stack of an
                          already-registered principal: the register step then
                          signs the add-stack claim with the root and fetch-
                          merges the principal's existing stacks (so other stacks
                          survive), mirroring \`provision-stack register
                          --principal-seed\`. Omit for a first-stack join (then
                          --seed-path is itself the root). A re-run, or a join
                          after \`provision-stack register\`, is idempotent (the
                          register no-ops when the stack is already on record),
                          so --principal-seed is only needed to register a NEW
                          2nd stack — not to re-run a converged one.
  --creds <p>             Override stack.nats_infra.creds_path (default: ~/.config/nats/<network>.creds).
  --account <nkey-U>      Override stack.nats_infra.account (A… nkey-U the leaf binds to).
  --operator-jwt <eyJ…>   (O-3, #1053) NSC operator JWT. With --account-jwt + --account, lets join
                          AUTO-CONVERT an anonymous/hard-isolated bus to operator-mode (render the
                          SOP §B0.1 blocks) instead of fail-fasting (#794). Maps to
                          stack.nats_infra.operator_jwt. O-4 supplies it via the register→issue
                          handshake; this flag/config is the manual/interim path.
  --account-jwt <eyJ…>    (O-3, #1053) The issued account JWT (preloaded under resolver_preload).
                          Maps to stack.nats_infra.account_jwt.
  --system-account <A…>   (O-3, #1053) OPTIONAL system account nkey-U (sets system_account). Maps
                          to stack.nats_infra.system_account.
  --system-account-jwt <eyJ…> (O-3, #1053) OPTIONAL system account JWT. Maps to
                          stack.nats_infra.system_account_jwt.
  --nats-config <p>       Override stack.nats_infra.config_path (nats-server -c config).
  --plist <p>             Override stack.nats_infra.plist_path (macOS nats-server launchd plist).
  --unit <p>              Override stack.nats_infra.unit_path (Linux nats-server systemd unit; #763).
                          Pass exactly ONE of --plist / --unit; each is self-describing.
  --leaf-node <name>      Leaf connection name on the network entry (default: network id).
  --max-hop <n>           Hop budget written on the network (default: 1).
  --capabilities <csv>    (join public) Comma-separated capability ids to announce
                          to the public index (e.g. code-review.typescript,research.synthesis).
  --allow <csv>           (join public) Comma-separated INBOUND allowlist of public
                          sender principals. Empty (default) = inbound DISABLED (OQ1
                          safe). Non-empty = inbound enabled, gated to these ids only.
  --guided                (join, #1485) OPT-IN guided join: refuse to bring the leaf
                          up (fail-closed) until the 3-leg handoff is clear — seal done
                          AND hub-authorize effectively done — instead of storming the
                          hub. Off by default. Hub-authorize can't be auto-verified today
                          (documented stub until #1498), so --guided is a deliberate-
                          confirmation gate: pair it with --hub-authorized-confirmed once
                          the hub owner tells you they applied your authorization.
  --hub-authorized-confirmed  (join, #1485) member attestation: "the hub owner confirmed
                          they applied my authorization on the hub". Under --guided,
                          upgrades the un-auto-verifiable hub-authorize leg to done so the
                          leaf-up step proceeds. NEVER overrides a real negative (#1498).
                          No effect without --guided.
  --network <net>         (handoff) the network whose handoff to report (required).
  --monitor-url <url>     (status) nats-server monitor base URL for leaf telemetry.
  --hub <tls-url>         (create) the hub's leaf-node dial URL (e.g. tls://hub.meta-factory.ai:7422).
  --leaf-port <port>      (create) the hub's leaf-node listen port (integer 1..65535).
  --admin-seed <path>     (create) path to the admin nkey seed (SU…) signing the claim.
                          admin_pubkey is derived from it; the registry's
                          REGISTRY_ADMIN_PUBKEYS allowlist must contain that pubkey.
  --network-admins <csv>  (create) comma-separated base64 Ed25519 pubkeys to set as
                          THIS network's per-network admins (#1321). They may admit
                          onto its roster + update its topology. Accepted only from a
                          GLOBAL admin's claim. Omit → defers to REGISTRY_ADMIN_PUBKEYS.
  --registry-url <url>    (create) registry base URL (default: https://network.meta-factory.ai).
  --apply                 Execute the live mutation (default: dry-run).
  --json                  Emit a { status, items, data, error } envelope.
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchNetwork(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
