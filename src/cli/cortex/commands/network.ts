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

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { expandTilde, loadConfigWithAgents } from "../../../common/config/loader";
import type { LoadedConfig } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import {
  materialFromSeedString,
  buildNetworkCreateClaim,
  postNetworkCreate,
  randomNonce,
  signClaimWithSeed,
  type StackIdentityMaterial,
  type SignedNetworkCreateBody,
} from "../../../bus/stack-provisioning";
import { canonicalJSON } from "../../../common/registry/signing";
// O-5 community-fleet role grant (ADR-0015). These runtime helpers live in
// cortex (src/cli/cortex/lib/discord-roles.ts) — NOT the metafactory-discord
// bundle the CLI tooling moved to (ADR-0017, epic #1171 S2): the daemon-side
// admit path cannot import from an external arc bundle.
import {
  assignRole,
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
  runNetworkSecret,
  type SecretAction,
  type DeliveryMode,
  type SecretInputs,
  type SecretReport,
} from "./network-secret-lib";
import type { NetworkSecretPorts } from "./network-secret-ports";
import {
  buildLiveSecretPorts,
  hubAdminMaterialFromSeedFile,
} from "./network-secret-adapters";
import { fetchSealedLeafSecret } from "../../../common/registry/fetch-sealed-secret";
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

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type NetworkSubcommand = "join" | "leave" | "status" | "create" | "ping" | "admit" | "reject" | "provision" | "make-live" | "secret";

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
      },
    },
    // C-1348 (ADR-0015) — the admission DENIAL verb, the mirror of `admit`.
    // Signs an admission decision claim carrying decision:"reject" → POSTs to
    // `/admission-requests/:id/reject` → the PENDING row moves to REJECTED.
    // Grants + seals NOTHING (rejection has no roster row to make connectable),
    // so it omits admit's Discord flags AND the --hub-config/--roster-only seal
    // controls. Dry-run by DEFAULT: prints the claim it WOULD post; --apply
    // executes. The row's network_id is fixed at register time; the registry
    // authorises and acts on that stored value, so there is no network selector.
    reject: {
      positionals: ["request-id?"],
      flags: {
        "--admin-seed": "value",
        "--registry-url": "value",
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
    secret: {
      positionals: ["action", "network", "member"],
      flags: {
        // The HUB-ADMIN seed (mints + seals + signs the registry delivery/revoke).
        "--admin-seed": "value",
        "--registry-url": "value",
        // The hub nats-server config the per-member authorization user lands in.
        "--hub-config": "value",
        // add-member: sealed (default, plug-and-play) | oob (trusted bootstrap).
        "--deliver": "value",
        // Override the hub leaf user (defaults to the member's principal id).
        "--leaf-user": "value",
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

async function maybeAutoFetchLeafSecret(
  networkId: string,
  inputs: { leafSecret?: string; seedPath: string; registryUrl: string; principal: string },
): Promise<{ leafSecret: string; leafUser: string } | undefined> {
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
  });
  if (!res.ok) return undefined;
  return { leafSecret: res.leafPsk, leafUser: res.leafUser };
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
        `admission for "${networkId}" was REVOKED (request ${s.requestId ?? "(unknown)"}) — membership was withdrawn. ` +
        `Re-register or contact a network admin. A legacy .creds file is NOT the fix.`
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
  const autoSecret = await maybeAutoFetchLeafSecret(networkId, inputs);
  const resolvedLeafSecret = inputs.leafSecret ?? autoSecret?.leafSecret;
  const resolvedLeafUser = inputs.leafUser ?? autoSecret?.leafUser;

  const stack: JoiningStack = {
    principalId: inputs.principal,
    stackSlug: slugRes.slug,
    credentials: expandTilde(inputs.credsPath),
    account: inputs.account,
    // C-1224 (ADR-0013 Model B) — pass the secret-auth leaf material (when
    // resolved, including PR5b's auto-fetched leaf PSK) so the join renders a
    // secret-auth pipe binding the principal's OWN local account instead of a
    // `.creds`-file leaf.
    ...(resolvedLeafSecret !== undefined && { leafSecret: resolvedLeafSecret }),
    ...(resolvedLeafUser !== undefined && { leafUser: resolvedLeafUser }),
    leafNode: optionalValueFlag(flags, "--leaf-node"),
    maxHop,
    // O-3 (cortex#1053) — pass the operator-mode leaf package (when resolved)
    // so join auto-converts an anonymous bus instead of fail-fasting (#794).
    ...(inputs.operatorModePackage !== undefined && {
      operatorModePackage: inputs.operatorModePackage,
    }),
  };

  const cfg = portsConfigFromInputs(networkId, inputs, slugRes.slug, flags);
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
  // status is read-only — live ports, but it only ever reads.
  const ports: NetworkPorts = buildLivePorts(cfg);

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
    lines.push("");
  }
  return ok(lines.join("\n"));
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

/** Minimal Discord client surface injectable for tests. */
export interface DiscordAdmitClient {
  resolveRoleId(botToken: string, guildId: string, roleName: string): Promise<string>;
  assignRole(botToken: string, guildId: string, userId: string, roleId: string): Promise<{ success: boolean; error?: string }>;
}

let discordAdmitClientOverride: DiscordAdmitClient | null = null;

/** Test-only setter. Production callers never touch this. Null restores default. */
export function __setDiscordAdmitClientForTests(client: DiscordAdmitClient | null): void {
  discordAdmitClientOverride = client;
}

/** Default production client — thin wrappers over the real discord lib. */
const defaultDiscordAdmitClient: DiscordAdmitClient = {
  resolveRoleId,
  assignRole,
};

/**
 * Build an admin-signed read claim for the `x-admin-signed` header.
 * No nonce (reads are idempotent). Uses the shared PKCS#8 signing bridge.
 */
async function buildAdmissionReadHeader(
  material: StackIdentityMaterial,
): Promise<string> {
  const claim = {
    admin_pubkey: material.pubkeyB64,
    issued_at: new Date().toISOString(),
  };
  const msgBytes = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(material.seed, msgBytes);
  return JSON.stringify({ claim, signature });
}

/**
 * The two roster-decision verbs the registry's shared `handleDecision` accepts
 * (`admit` | `reject`, `types.ts` AdmissionDecision). Both mint nothing — admit
 * moves PENDING→ADMITTED, reject moves PENDING→REJECTED. `revoke` is a distinct
 * post-admission motion, not a PENDING decision, so it is NOT in this union.
 */
type AdmissionDecision = "admit" | "reject";

/**
 * Build the admin-signed admission decision body (ADR-0015: `decision` selects
 * admit vs reject; no leaf_package — decides the roster row only, mints nothing).
 */
async function buildAdmissionDecisionBody(
  requestId: string,
  material: StackIdentityMaterial,
  decision: AdmissionDecision,
  opts: { issuedAt?: string; nonce?: string } = {},
): Promise<{ claim: { request_id: string; decision: AdmissionDecision; admin_pubkey: string; issued_at: string; nonce: string }; signature: string }> {
  const claim = {
    request_id: requestId,
    decision,
    admin_pubkey: material.pubkeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const msgBytes = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(material.seed, msgBytes);
  return { claim, signature };
}

// =============================================================================
// C-1314 — `cortex network admit --list-pending` (admission-queue discovery)
// =============================================================================

/** Admission-request statuses the registry list endpoint accepts. */
const LIST_STATUSES = ["PENDING", "ADMITTED", "REJECTED"] as const;

/** The subset of an `AdmissionRequest` row this CLI renders (matches the
 *  registry `GET /admission-requests` response, `types.ts` AdmissionRequest). */
interface AdmissionListRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
  created_at: string;
}

/** Render the discovery table (human path). Peer pubkey is truncated to a
 *  fingerprint for width; the full value rides the --json output. */
function renderPendingTable(
  rows: AdmissionListRow[],
  status: string,
  networkFilter: string | undefined,
  registryUrl: string,
): string {
  const scope = networkFilter !== undefined ? ` on network "${networkFilter}"` : "";
  const header =
    `cortex network admit --list-pending — ${rows.length.toString()} ${status} request(s)${scope} ` +
    `(registry: ${registryUrl})`;
  if (rows.length === 0) {
    return `${header}\n  (none) — nothing to ${status === "PENDING" ? "admit" : "show"}.\n`;
  }
  const cells = rows.map((r) => ({
    id: r.request_id,
    principal: r.principal_id,
    network: r.network_id ?? "(none)",
    peer: `${r.peer_pubkey.slice(0, 12)}…`,
    status: r.status,
    created: r.created_at,
  }));
  const w = {
    id: Math.max("REQUEST-ID".length, ...cells.map((c) => c.id.length)),
    principal: Math.max("PRINCIPAL".length, ...cells.map((c) => c.principal.length)),
    network: Math.max("NETWORK".length, ...cells.map((c) => c.network.length)),
    peer: Math.max("PEER_PUBKEY".length, ...cells.map((c) => c.peer.length)),
    status: Math.max("STATUS".length, ...cells.map((c) => c.status.length)),
  };
  const row = (id: string, principal: string, network: string, peer: string, st: string, created: string): string =>
    `  ${id.padEnd(w.id)}  ${principal.padEnd(w.principal)}  ${network.padEnd(w.network)}  ${peer.padEnd(w.peer)}  ${st.padEnd(w.status)}  ${created}`;
  const lines = [header, "", row("REQUEST-ID", "PRINCIPAL", "NETWORK", "PEER_PUBKEY", "STATUS", "CREATED")];
  for (const c of cells) lines.push(row(c.id, c.principal, c.network, c.peer, c.status, c.created));
  lines.push("", `To admit: cortex network admit <request-id> --admin-seed <path> --apply`, "");
  return lines.join("\n");
}

/**
 * `cortex network admit --list-pending [--status <s>] [--network <id>] --admin-seed <path> [--registry-url <url>] [--json]`
 *
 * C-1314 — the admission-queue DISCOVERY surface. An admin can't otherwise find
 * a request-id from the CLI (the alternatives were the MC Pier queue or a
 * hand-signed GET). Admin-signs a read claim into the `x-admin-signed` header
 * (reuses {@link buildAdmissionReadHeader} — no nonce, reads are idempotent) and
 * GETs `/admission-requests?status=<status>`, mirroring the admit apply-path
 * read + `findAdmittedRow`. Read-only: no --apply, no request-id positional.
 *
 * ADR-0020 read-scoping limitation: admin READS are GLOBAL-admin-only today
 * (the registry list route gates on `parseAdminPubkeys` — the global allowlist —
 * NOT the target network's per-network admins). So a PER-NETWORK admin gets a
 * 403 here even for their own network; we surface that readably (never a silent
 * empty table) and point at the fast-follow. `--network` is a CLIENT-side filter
 * (the endpoint returns every network's rows at once).
 */
async function runListPending(flags: FlagMap, json: boolean): Promise<ExitResult> {
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

  let rows: AdmissionListRow[];
  try {
    const readHeader = await buildAdmissionReadHeader(material);
    const getUrl = `${registryUrl.replace(/\/+$/, "")}/admission-requests?status=${encodeURIComponent(status)}`;
    const resp = await globalThis.fetch(getUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-admin-signed": readHeader },
    });
    if (resp.status === 403) {
      // ADR-0020 read-scoping: reads are global-admin-only. A per-network admin
      // lands here even for their own network — surface it readably rather than
      // as a silent empty table.
      const body = await resp.text();
      return opError(
        "admit",
        `registry refused the list (HTTP 403 admin_not_authorized): admission reads are ` +
          `GLOBAL-admin-only today, so a per-network admin cannot list PENDING requests` +
          `${networkFilter !== undefined ? ` for "${networkFilter}"` : ""} from the CLI yet. ` +
          `Per-network read-scoping is the ADR-0020 fast-follow; until then use a global-admin ` +
          `seed or the MC admission queue (Pier). Registry said: ${body}`,
        json,
      );
    }
    if (!resp.ok) {
      const body = await resp.text();
      return opError("admit", `registry list failed (HTTP ${resp.status.toString()}): ${body}`, json);
    }
    rows = (await resp.json()) as AdmissionListRow[];
  } catch (err) {
    return opError(
      "admit",
      `failed to list admission requests from registry: ${err instanceof Error ? err.message : String(err)}`,
      json,
    );
  }

  const filtered =
    networkFilter !== undefined ? rows.filter((r) => r.network_id === networkFilter) : rows;

  if (json) {
    return ok(
      renderJson(
        envelopeOk(filtered, {
          subcommand: "admit",
          mode: "list-pending",
          status,
          ...(networkFilter !== undefined && { network: networkFilter }),
          registry_url: registryUrl,
          admin_fingerprint: material.fingerprint,
          count: filtered.length.toString(),
        }),
      ),
    );
  }
  return ok(renderPendingTable(filtered, status, networkFilter, registryUrl));
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
 */
async function runAdmit(
  requestId: string,
  flags: FlagMap,
  json: boolean,
  // C-1316 — the SAME injectable secret-ports factory `runSecret` uses, so the
  // folded-in seal is testable with fake hub/registry/crypto ports. Production
  // omits it → the live adapters (`buildLiveSecretPorts`).
  secretPortsFactory: SecretPortsFactory = DEFAULT_SECRET_PORTS_FACTORY,
): Promise<ExitResult> {
  // C-1314 — DISCOVERY mode. `--list-pending` is a read-only query for the
  // admission queue (no request-id positional, no --apply). Route it before the
  // request-id gate so `cortex network admit --list-pending` doesn't trip the
  // "missing request-id" usage error.
  if (flags["--list-pending"] === true) {
    return runListPending(flags, json);
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

  // Load + chmod-600-gate the admin seed
  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("admit", matRes.reason, json);
  const material = matRes.material;

  // DRY-RUN (default): print the plan, touch nothing
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

  // APPLY path

  // 1. Fetch the PENDING admission request (admin-signed GET)
  let requestPrincipalId: string;
  let requestStatus: string;
  // C-1316 — the just-admitted member's seal target. `peer_pubkey` is the
  // ed25519 pubkey the leaf PSK is sealed to; `network_id` scopes the seal
  // (null for legacy network-less rows — then the seal can't run).
  let requestPeerPubkey: string;
  let requestNetworkId: string | null;
  try {
    const readHeader = await buildAdmissionReadHeader(material);
    const getUrl = `${registryUrl.replace(/\/+$/, "")}/admission-requests/${encodeURIComponent(requestId)}`;
    const getResp = await globalThis.fetch(getUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-admin-signed": readHeader,
      },
    });
    if (getResp.status === 404) {
      return opError("admit", `request-id "${requestId}" not found in registry (HTTP 404)`, json);
    }
    if (!getResp.ok) {
      const body = await getResp.text();
      return opError("admit", `registry GET failed (HTTP ${getResp.status.toString()}): ${body}`, json);
    }
    const req = (await getResp.json()) as {
      request_id: string;
      principal_id: string;
      status: string;
      peer_pubkey: string;
      network_id: string | null;
    };
    requestPrincipalId = req.principal_id;
    requestStatus = req.status;
    requestPeerPubkey = req.peer_pubkey;
    requestNetworkId = req.network_id;
  } catch (err) {
    return opError("admit", `failed to fetch request from registry: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // Must be PENDING to admit
  if (requestStatus !== "PENDING") {
    return opError("admit", `request "${requestId}" is not PENDING (status: ${requestStatus}) — cannot admit an already-decided request`, json);
  }

  // 2. Build + POST the signed admission decision
  let decisionBody: { claim: { request_id: string; decision: AdmissionDecision; admin_pubkey: string; issued_at: string; nonce: string }; signature: string };
  try {
    decisionBody = await buildAdmissionDecisionBody(requestId, material, "admit");
  } catch (err) {
    return opError("admit", `failed to build admission decision claim: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  try {
    const postUrl = `${registryUrl.replace(/\/+$/, "")}/admission-requests/${encodeURIComponent(requestId)}/admit`;
    const postResp = await globalThis.fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisionBody),
    });
    if (!postResp.ok) {
      const respBody = await postResp.text();
      return opError("admit", `registry rejected admission (HTTP ${postResp.status.toString()}): ${respBody}`, json);
    }
  } catch (err) {
    return opError("admit", `registry POST failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // 2b. C-1316 — admit-and-seal. The roster row is now ADMITTED; an admitted-but-
  // unsealed peer is INERT (on the roster, but its leaf can't connect — no
  // transport PSK). Under the metafactory Q5 collapse the admit signer
  // (registry-admin) IS the hub-admin, so the SAME --admin-seed mints + seals +
  // delivers the per-member leaf PSK in one concierge act. We reuse the EXISTING
  // `secret add-member` flow (`sealAdmittedMember` → `runNetworkSecret`) — no
  // sealing is reimplemented here. The admission is ALREADY committed, so the
  // seal NEVER fails the admit: any problem (hub-admin ≠ registry-admin → registry
  // refuses the delivery; hub config not local → readConf fails; legacy
  // network-less row) degrades to a fallback that tells the admin to seal
  // explicitly. Opt out entirely with --roster-only.
  let sealOutcome: AdmitSealOutcome;
  if (flags["--roster-only"] === true) {
    const net = requestNetworkId ?? "<network>";
    sealOutcome = {
      status: "skipped",
      steps: [],
      reason: "--roster-only: committed the roster row only, no seal",
      fallbackCmd: `cortex network secret add-member ${net} ${requestPeerPubkey} --admin-seed ${seedRes.value} --apply`,
    };
  } else {
    sealOutcome = await sealAdmittedMember({
      networkId: requestNetworkId,
      memberPubkey: requestPeerPubkey,
      registryUrl,
      hubConfigPath: optionalValueFlag(flags, "--hub-config") ?? DEFAULT_HUB_CONFIG_PATH,
      material,
      secretPortsFactory,
      adminSeedPath: seedRes.value,
    });
  }

  // 3. Assign Discord role (O-5) — when --discord-member is given
  let discordStatus = "skipped";
  let discordWarning = "";

  if (discordMember !== undefined) {
    const discordClient = discordAdmitClientOverride;
    try {
      const discordConfig = loadDiscordConfig();
      const ctx = resolveServerContext(discordConfig, {
        server: discordServer,
        guild: discordGuild,
      });

      const botToken = discordClient ? "injected" : ctx.botToken;
      const guildId = discordClient ? (discordGuild ?? ctx.guildId) : ctx.guildId;

      if (!discordClient && !botToken) {
        discordWarning = "Discord role not assigned: no bot token configured (run: discord config set botToken <token>)";
        discordStatus = "skipped_no_token";
      } else if (!guildId) {
        discordWarning = "Discord role not assigned: no guild id configured — pass --discord-guild <id> or run: discord config set guildId <id>";
        discordStatus = "skipped_no_guild";
      } else {
        const client = discordClient ?? defaultDiscordAdmitClient;
        let roleId: string;
        try {
          roleId = await client.resolveRoleId(botToken ?? "", guildId, discordRole);
        } catch (err) {
          discordWarning = `Discord role not assigned: ${err instanceof Error ? err.message : String(err)} — assign manually`;
          discordStatus = "failed";
          roleId = "";
        }

        if (roleId) {
          const roleResult = await client.assignRole(botToken ?? "", guildId, discordMember, roleId);
          if (roleResult.success) {
            discordStatus = "assigned";
          } else {
            discordWarning = `Discord role assignment failed: ${roleResult.error ?? "unknown error"} — admission committed, assign role manually`;
            discordStatus = "failed";
          }
        }
      }
    } catch (err) {
      discordWarning = `Discord role assignment error: ${err instanceof Error ? err.message : String(err)} — admission committed, assign role manually`;
      discordStatus = "failed";
    }
  }

  // 4. Output summary
  if (json) {
    const data: Record<string, string> = {
      subcommand: "admit",
      applied: "true",
      request_id: requestId,
      principal_id: requestPrincipalId,
      admin_fingerprint: material.fingerprint,
      // C-1316 — make the peer's connectability machine-readable.
      seal_status: sealOutcome.status,
      connectable: sealOutcome.status === "sealed" ? "true" : "false",
      ...(discordStatus !== "skipped" && { discord_status: discordStatus }),
    };
    if (sealOutcome.reason) data.seal_reason = sealOutcome.reason;
    if (sealOutcome.fallbackCmd) data.seal_fallback = sealOutcome.fallbackCmd;
    if (discordWarning) data.discord_warning = discordWarning;
    return ok(renderJson(envelopeOk([], data)));
  }

  const lines: string[] = [
    `cortex network admit ${requestId}: admitted`,
    `  principal:   ${requestPrincipalId}`,
    `  admin:       ${material.fingerprint}`,
  ];
  // C-1316 — the seal transcript: state plainly whether the peer is CONNECTABLE.
  if (sealOutcome.status === "sealed") {
    lines.push(`  seal:        delivered — peer is now CONNECTABLE`);
    for (const s of sealOutcome.steps) lines.push(`    ${s}`);
  } else if (sealOutcome.status === "skipped") {
    lines.push(`  seal:        skipped — ${sealOutcome.reason ?? "no seal"} (peer is ADMITTED but INERT)`);
    if (sealOutcome.fallbackCmd) lines.push(`               to seal: ${sealOutcome.fallbackCmd}`);
  } else {
    lines.push(`  seal:        NOT delivered — peer is ADMITTED but INERT`);
    lines.push(`               reason: ${sealOutcome.reason ?? "seal failed"}`);
    if (sealOutcome.fallbackCmd) lines.push(`               to seal: ${sealOutcome.fallbackCmd}`);
  }
  if (discordMember !== undefined) {
    if (discordStatus === "assigned") {
      lines.push(`  discord:     role "${discordRole}" assigned to member ${discordMember}`);
    } else {
      lines.push(`  discord:     ${discordWarning}`);
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
 * roster row to make connectable), so — unlike admit — there is no seal step and
 * no Discord role assignment.
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
): Promise<ExitResult> {
  if (!requestId) {
    return usageError("reject", "missing request-id (usage: cortex network reject <request-id> --admin-seed <path>; discover ids with `cortex network admit --list-pending --admin-seed <path>`)", json);
  }

  const seedRes = requireValueFlag(flags, "--admin-seed");
  if (!seedRes.ok) return usageError("reject", seedRes.reason, json);

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("reject", applyRes.reason, json);

  const registryUrl = optionalValueFlag(flags, "--registry-url") ?? DEFAULT_ADMIT_REGISTRY_URL;

  // Load + chmod-600-gate the admin seed
  const matRes = await adminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("reject", matRes.reason, json);
  const material = matRes.material;

  // DRY-RUN (default): print the plan, touch nothing
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
      ``,
    ];
    return ok(lines.join("\n"));
  }

  // APPLY path
  //
  // Unlike admit, reject does NOT do an admin-signed GET pre-check first. Admit
  // reads the row because it needs the peer_pubkey + network_id to SEAL; reject
  // seals nothing, so it needs no read. Crucially, the admin READ gate is
  // GLOBAL-admin-only today (ADR-0020 read-scoping — see runListPending), so a
  // GET pre-check would 403 a PER-NETWORK admin BEFORE the POST that would in
  // fact authorise them (handleDecision authorises global OR per-network admins).
  // We therefore POST directly and let the registry be the single authority:
  // its 200 body carries the decided row (principal_id/status) for the summary,
  // and its own 409/403/404 map to clear, actionable CLI errors.

  // 1. Build the signed admission decision (decision: reject)
  let decisionBody: { claim: { request_id: string; decision: AdmissionDecision; admin_pubkey: string; issued_at: string; nonce: string }; signature: string };
  try {
    decisionBody = await buildAdmissionDecisionBody(requestId, material, "reject");
  } catch (err) {
    return opError("reject", `failed to build admission decision claim: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // 2. POST it to /admission-requests/:id/reject
  let decidedPrincipalId = "";
  try {
    const postUrl = `${registryUrl.replace(/\/+$/, "")}/admission-requests/${encodeURIComponent(requestId)}/reject`;
    const postResp = await globalThis.fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisionBody),
    });
    if (!postResp.ok) {
      const respBody = await postResp.text();
      // Non-PENDING row → the registry's 409 already_decided. Surface the actual
      // current status (ADMITTED/REJECTED/REVOKED) readably rather than raw JSON.
      if (postResp.status === 409 && respBody.includes("already_decided")) {
        const current = extractCurrentStatus(respBody);
        const was = current !== undefined ? ` (already ${current})` : "";
        return opError("reject", `request "${requestId}" is already decided${was} — cannot reject an already-decided request`, json);
      }
      if (postResp.status === 404) {
        return opError("reject", `request-id "${requestId}" not found in registry (HTTP 404)`, json);
      }
      // 403 admin_not_authorized — e.g. a per-network admin rejecting a request
      // that belongs to a DIFFERENT network (their key isn't on that network's
      // admin allowlist and isn't a global admin). Surface it actionably.
      if (postResp.status === 403) {
        return opError("reject", `not authorised to reject request "${requestId}" — the admin key (${material.fingerprint}) is neither a global admin nor an admin of this request's network (HTTP 403)`, json);
      }
      return opError("reject", `registry rejected the decision (HTTP ${postResp.status.toString()}): ${respBody}`, json);
    }
    // 200 → the decided row. Pull principal_id for the summary (best-effort):
    // if the body isn't the expected JSON (shouldn't happen on 200), the summary
    // just omits the principal line — the rejection itself already committed, so
    // decidedPrincipalId stays "" and we never fail a committed decision on it.
    try {
      const row = (await postResp.json()) as { principal_id?: string };
      decidedPrincipalId = row.principal_id ?? "";
    } catch (_err) {
      // Intentionally ignored — see above; decidedPrincipalId remains "".
    }
  } catch (err) {
    return opError("reject", `registry POST failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // 3. Output summary — no seal, no Discord (rejection grants nothing).
  if (json) {
    return ok(
      renderJson(
        envelopeOk([], {
          subcommand: "reject",
          applied: "true",
          request_id: requestId,
          decision: "reject",
          ...(decidedPrincipalId ? { principal_id: decidedPrincipalId } : {}),
          admin_fingerprint: material.fingerprint,
        }),
      ),
    );
  }

  const lines: string[] = [
    `cortex network reject ${requestId}: rejected`,
    ...(decidedPrincipalId ? [`  principal:   ${decidedPrincipalId}`] : []),
    `  admin:       ${material.fingerprint}`,
    ``,
  ];
  return ok(lines.join("\n"));
}

/**
 * Pull the current status out of the registry's `already_decided` 409 body.
 * The route returns `{ error, details, current: <AdmissionRequest> }`; we read
 * `current.status` (falling back to undefined so the caller degrades to a
 * generic "already decided" line rather than crashing on an unexpected shape).
 */
function extractCurrentStatus(respBody: string): string | undefined {
  try {
    const parsed = JSON.parse(respBody) as { current?: { status?: string } };
    const status = parsed.current?.status;
    return typeof status === "string" ? status : undefined;
  } catch (_err) {
    return undefined;
  }
}

// =============================================================================
// C-1316 — admit-and-seal: fold the sealed leaf-secret delivery into admit
// =============================================================================

/** The outcome of the seal step folded into a successful admit. */
type AdmitSealStatus = "sealed" | "skipped" | "fallback";
interface AdmitSealOutcome {
  /** sealed = delivered (connectable); skipped = deliberately not run
   *  (--roster-only); fallback = tried/skipped but couldn't seal (still inert). */
  status: AdmitSealStatus;
  /** Human transcript lines from the seal — NEVER carry a secret. */
  steps: string[];
  /** Why the seal was skipped or fell back. */
  reason?: string;
  /** The explicit `secret add-member` command to seal after the fact. */
  fallbackCmd?: string;
}

/**
 * Seal + deliver the per-member leaf PSK for a just-admitted member by reusing
 * the EXISTING `secret add-member` orchestration (`runNetworkSecret`) — nothing
 * about sealing is reimplemented here.
 *
 * The caller has ALREADY committed the admission, so this NEVER throws and NEVER
 * fails the admit: every failure mode returns a `fallback` outcome that surfaces
 * the explicit `secret add-member` command instead. Failure modes it degrades on:
 *   - the admission row is network-less (legacy `network_id = null`) — nothing to
 *     bind a leaf PSK to;
 *   - the hub config isn't local / readable (a fully-separable deployment where
 *     the hub isn't on this host) — `readConf` rejects before any mutation;
 *   - the admit signer isn't the hub-admin (registry-admin ≠ hub-admin) — the
 *     registry refuses the sealed-secret delivery.
 */
async function sealAdmittedMember(args: {
  networkId: string | null;
  memberPubkey: string;
  registryUrl: string;
  hubConfigPath: string;
  material: StackIdentityMaterial;
  secretPortsFactory: SecretPortsFactory;
  adminSeedPath: string;
}): Promise<AdmitSealOutcome> {
  const { networkId, memberPubkey, registryUrl, hubConfigPath, material, secretPortsFactory, adminSeedPath } = args;

  // A network-less admission row (legacy null network_id) can't be sealed — the
  // leaf PSK is network-scoped, and `secret add-member` needs a real network id.
  if (networkId === null || networkId === "") {
    return {
      status: "fallback",
      steps: [],
      reason:
        "the admission row has no network_id (legacy / network-less request) — a leaf secret is network-scoped, so it can't be sealed automatically",
      fallbackCmd: `cortex network secret add-member <network> ${memberPubkey} --admin-seed ${adminSeedPath} --apply`,
    };
  }

  const fallbackCmd = `cortex network secret add-member ${networkId} ${memberPubkey} --admin-seed ${adminSeedPath} --apply`;

  const inputs: SecretInputs = {
    action: "add-member",
    networkId,
    memberPubkey,
    deliver: "sealed",
    apply: true,
  };

  let report: SecretReport;
  try {
    // #1316 nit (PR #1412): construct the ports factory INSIDE the try so the
    // "seal NEVER throws / NEVER fails the admit" invariant is structural — a
    // throwing factory (bad hub config, unreadable seed) degrades to `fallback`
    // like every other seal failure instead of escaping past the committed admit.
    const ports = secretPortsFactory({ hubConfigPath, registryUrl, material });
    report = await runNetworkSecret(inputs, ports);
  } catch (err) {
    return {
      status: "fallback",
      steps: [],
      reason: `seal could not run: ${err instanceof Error ? err.message : String(err)}`,
      fallbackCmd,
    };
  }

  if (!report.ok) {
    return {
      status: "fallback",
      steps: report.steps,
      reason: report.reason ?? "seal failed",
      fallbackCmd,
    };
  }

  return { status: "sealed", steps: report.steps };
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
 * Factory for the secret port bundle. Production builds the live adapters (hub
 * config fs + reload, registry admin-read + hub-admin delivery/revoke). Tests
 * inject fakes that record calls without touching fs/registry/nats.
 */
export type SecretPortsFactory = (cfg: {
  hubConfigPath: string;
  registryUrl: string;
  material: import("../../../bus/stack-provisioning").StackIdentityMaterial;
}) => NetworkSecretPorts;

const DEFAULT_SECRET_PORTS_FACTORY: SecretPortsFactory = (cfg) => buildLiveSecretPorts(cfg);

async function runSecret(
  actionArg: string,
  networkId: string,
  member: string,
  flags: FlagMap,
  json: boolean,
  portsFactory: SecretPortsFactory,
): Promise<ExitResult> {
  // 1. Validate the action.
  const validActions: SecretAction[] = ["add-member", "revoke-member", "rotate"];
  if (!validActions.includes(actionArg as SecretAction)) {
    return usageError("secret", `unknown action "${actionArg}" (expected one of: ${validActions.join(", ")})`, json);
  }
  const action = actionArg as SecretAction;

  // 2. Validate network + member pubkey grammar.
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("secret", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  if (!MEMBER_PUBKEY_RE.test(member)) {
    return usageError("secret", `member "${member}" must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)`, json);
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

  // 4. Load + chmod-600-gate the hub-admin seed.
  const matRes = await hubAdminMaterialFromSeedFile(seedRes.value);
  if (!matRes.ok) return opError("secret", matRes.reason, json);

  const ports = portsFactory({ hubConfigPath, registryUrl, material: matRes.material });
  const inputs: SecretInputs = {
    action,
    networkId,
    memberPubkey: member,
    deliver,
    ...(leafUserOverride !== undefined && { leafUserOverride }),
    apply: applyRes.apply,
  };

  let report;
  try {
    report = await runNetworkSecret(inputs, ports);
  } catch (err) {
    return opError("secret", `secret ${action} failed: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // 5. Render. SECRETS never appear in steps/data; the oob PSK is surfaced in a
  // dedicated, explicitly-labelled block (the one place a secret reaches stdout).
  if (json) {
    const data: Record<string, string> = {
      subcommand: "secret",
      applied: report.applied ? "true" : "false",
      ...report.data,
      hub_admin_fingerprint: matRes.material.fingerprint,
    };
    // The oob PSK is the hub-admin's to hand over — include it under an explicit
    // key so a machine consumer can pluck it, never folded into the plan text.
    if (report.surfaced) {
      data.oob_leaf_user = report.surfaced.leafUser;
      data.oob_leaf_secret = report.surfaced.psk;
    }
    const env = report.ok ? envelopeOk([], data) : envelopeError(report.reason ?? "secret command failed", data);
    return report.ok ? ok(renderJson(env)) : { exitCode: 1, stdout: "", stderr: renderJson(env) };
  }

  const header = report.applied
    ? `cortex network secret ${action} ${networkId}: ${report.ok ? "ok" : "FAILED"}`
    : `cortex network secret ${action} ${networkId}: dry-run (no mutation; pass --apply)`;
  const lines = [header, ...report.steps.map((s) => `  ${s}`)];
  if (!report.ok) lines.push(`  ✗ ${report.reason ?? "unknown failure"}`);
  if (report.surfaced) {
    lines.push("");
    lines.push("  ── OUT-OF-BAND SECRET (hand this to the member over a secure channel) ──");
    lines.push(`  leaf user:   ${report.surfaced.leafUser}`);
    lines.push(`  leaf secret: ${report.surfaced.psk}`);
  }
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
      return runJoin(parsed.positionals.network ?? "", parsed.flags, json, load, provisionPortsFactory);
    case "leave":
      return runLeave(parsed.positionals.network ?? "", parsed.flags, json, load);
    case "status":
      return runStatus(parsed.flags, json);
    case "create":
      return runCreate(parsed.positionals.network ?? "", parsed.flags, json);
    case "ping":
      return runPing(parsed.positionals.peer ?? "", parsed.flags, json, load, pingBusFactory);
    case "admit":
      return runAdmit(parsed.positionals["request-id"] ?? "", parsed.flags, json, secretPortsFactory);
    case "reject":
      return runReject(parsed.positionals["request-id"] ?? "", parsed.flags, json);
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
  cortex network admit  <request-id> --admin-seed <path> [--registry-url <url>] [--hub-config <p>]
                        [--roster-only] [--discord-member <id>] [--discord-guild <id>]
                        [--discord-server <profile>] [--discord-role <name>] [--apply] [--dry-run] [--json]
  cortex network admit  --list-pending [--status <PENDING|ADMITTED|REJECTED>] [--network <id>]
                        --admin-seed <path> [--registry-url <url>] [--json]
  cortex network reject <request-id> --admin-seed <path> [--registry-url <url>] [--apply] [--dry-run] [--json]
  cortex network provision <stack> [--config <p>] [--principal <id>] [--seed-path <p>]
                        [--creds <p>] [--force] [--apply] [--dry-run] [--json]
  cortex network make-live <stack> [--config <p>] [--principal <id>] [--nats-config <p>]
                        [--creds <p>] [--force] [--apply] [--dry-run] [--json]
  cortex network secret <add-member|revoke-member|rotate> <network> <member-pubkey>
                        --admin-seed <hub-admin-seed> [--registry-url <url>] [--hub-config <p>]
                        [--deliver sealed|oob] [--leaf-user <u>] [--apply] [--dry-run] [--json]

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
          to render the leaf). NEVER touches encryption/payload_key config.
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
          hub-local nats config at --hub-config (default ~/.config/nats/local.conf).
          The seal NEVER fails a committed admit: if it can't run (hub-admin ≠
          registry-admin, or the hub config isn't local) it surfaces a fallback
          telling you to run \`cortex network secret add-member\`. Pass --roster-only
          to commit the roster row ONLY and skip the seal.
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
