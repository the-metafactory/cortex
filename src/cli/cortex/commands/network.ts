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

import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { expandTilde, loadConfigWithAgents } from "../../../common/config/loader";
import type { LoadedConfig } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import {
  materialFromSeedString,
  buildNetworkCreateClaim,
  postNetworkCreate,
  type StackIdentityMaterial,
  type SignedNetworkCreateBody,
} from "../../../bus/stack-provisioning";

import {
  deriveJoinInputs,
  deriveLeaveInputs,
  tolerantReader,
  type ConfigReader,
} from "./network-derive";
import {
  parseLeafPackageFile,
  type LeafPackageFile,
} from "./network-leaf-package";

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
  createLiveProbeBus,
  type LiveProbeBus,
} from "./network-ping-adapters";
import { buildPingSignerFromConfig } from "./network-ping-signer";
import type { NetworkPingPorts } from "./network-ping-ports";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type NetworkSubcommand = "join" | "leave" | "status" | "create" | "ping";

/** Default registry URL when neither --registry-url nor config provides one. */
const DEFAULT_REGISTRY_URL = "https://network.meta-factory.ai";

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
        // O-4b (cortex#1063) — SOURCE the operator-mode leaf package from a JSON
        // file (the interim form of the shape O-4a's signed register→issue
        // response will carry) instead of the four flags above. Read + validated
        // before it reaches deriveJoinInputs; sits BELOW the explicit flags and
        // ABOVE config in precedence (flag > package > config > convention).
        "--from-package": "value",
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

/**
 * O-4b (cortex#1063) — read + validate the `--from-package <file>` leaf package.
 * A PURE READ: it only reads the file (never writes), so it is safe under
 * dry-run. Returns the parsed {@link LeafPackageFile}, or a usage-error reason on
 * a missing/unreadable/malformed file — fail-fast so unvalidated key material
 * never reaches the operator-mode conversion seam. `undefined` when the flag is
 * absent (the common case: no package source).
 */
function readLeafPackageFlag(
  flags: FlagMap,
): { ok: true; package: LeafPackageFile | undefined } | { ok: false; reason: string } {
  const path = optionalValueFlag(flags, "--from-package");
  if (path === undefined) return { ok: true, package: undefined };

  const expanded = expandTilde(path);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `--from-package file not found at ${expanded}` };
  }
  let text: string;
  try {
    text = readFileSync(expanded, "utf-8");
  } catch (err) {
    return {
      ok: false,
      reason: `failed to read --from-package file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseLeafPackageFile(text);
  if (!parsed.ok) {
    return { ok: false, reason: `invalid --from-package file: ${parsed.reason}` };
  }
  return { ok: true, package: parsed.package };
}

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

async function runJoin(
  networkId: string,
  flags: FlagMap,
  json: boolean,
  load: ConfigReader,
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

  // O-4b (cortex#1063) — read + validate the `--from-package` leaf package FIRST
  // (a pure read). A malformed/missing package fails fast as a usage error here,
  // BEFORE any derivation or mutation, so unvalidated key material never reaches
  // the operator-mode conversion. Absent ⇒ undefined (the common case).
  const pkgRes = readLeafPackageFlag(flags);
  if (!pkgRes.ok) return usageError("join", pkgRes.reason, json);

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
        // O-3 (cortex#1053) — operator-mode leaf-package overrides.
        ...readOverride(flags, "--operator-jwt", "operatorJwt"),
        ...readOverride(flags, "--account-jwt", "accountJwt"),
        ...readOverride(flags, "--system-account", "systemAccount"),
        ...readOverride(flags, "--system-account-jwt", "systemAccountJwt"),
        // O-4b (cortex#1063) — the `--from-package` leaf package (parsed above).
        // Sits BELOW the explicit per-field flags and ABOVE config in the
        // deriver's precedence chain (flag > package > config > convention).
        ...(pkgRes.package !== undefined && { leafPackage: pkgRes.package }),
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

  const stack: JoiningStack = {
    principalId: inputs.principal,
    stackSlug: slugRes.slug,
    credentials: expandTilde(inputs.credsPath),
    account: inputs.account,
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
  return renderFlowResult("join", networkId, res.ok, res.reason, res.steps, applyRes.apply, json, {
    used_cache: res.usedCache === true ? "true" : "false",
    peers: (res.resolvedPeers ?? []).join(","),
  });
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
    return ok("cortex network status: no networks joined\n");
  }
  const lines = ["cortex network status:", ""];
  for (const n of res.networks) {
    lines.push(`  ${n.networkId}  [leaf:${n.leafNode}]  link:${n.link.state}`);
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
      `  hub_url:   ${hubUrl}\n  leaf_port: ${leafPort.toString()}\n  admin:     ${matRes.material.fingerprint}\n`,
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
      return runJoin(parsed.positionals.network ?? "", parsed.flags, json, load);
    case "leave":
      return runLeave(parsed.positionals.network ?? "", parsed.flags, json, load);
    case "status":
      return runStatus(parsed.flags, json);
    case "create":
      return runCreate(parsed.positionals.network ?? "", parsed.flags, json);
    case "ping":
      return runPing(parsed.positionals.peer ?? "", parsed.flags, json, load, pingBusFactory);
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex network — one-command join to the Internet of Agentic Work (S4, #738; #752/#753)

Usage:
  cortex network join  <network> [--apply] [--config <p>] [overrides…]
  cortex network leave  <network> [--apply] [--config <p>] [overrides…]
  cortex network status [--principal <id>] [--stack <id>] [--monitor-url <url>] [--json]
  cortex network create <network> --hub <tls-url> --leaf-port <port> --admin-seed <path> [--registry-url <url>] [--apply]
  cortex network ping   <peer> [--assistant <a>] [--network <id>] [--count N] [--timeout <ms>] [--json]

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
  --from-package <file>   (O-4b, #1063) SOURCE the operator-mode leaf package from a
                          JSON file — the interim form of the shape O-4a's signed
                          register→issue response will carry:
                          { operatorJwt, account, accountJwt, systemAccount?,
                            systemAccountJwt?, credsPath, endpoint? }. Saves passing
                          the four --operator-jwt/--account-jwt/--account/
                          --system-account* flags by hand. Validated (nkey-U/JWT
                          shape) + fail-fast on a malformed package. Precedence:
                          explicit flags override the package; the package overrides
                          config; the package sets only what it carries.
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
