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

import { expandTilde, loadConfigWithAgents } from "../../../common/config/loader";

import {
  deriveJoinInputs,
  deriveLeaveInputs,
  tolerantReader,
  type ConfigReader,
} from "./network-derive";

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
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";
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

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type NetworkSubcommand = "join" | "leave" | "status";

/**
 * #753 — default cortex.yaml path the config-deriver reads when no `--config`
 * is passed. Same canonical path as `cortex agents` (`agents.ts`). The
 * one-liner `cortex network join <network>` reads here.
 */
const DEFAULT_CONFIG_PATH = "~/.config/cortex/cortex.yaml";

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
        "--creds": "value",
        "--account": "value",
        "--nats-config": "value",
        "--plist": "value",
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
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

// =============================================================================
// Helpers
// =============================================================================

function requireValueFlag(
  flags: Record<string, string | true>,
  name: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const v = flags[name];
  if (v === undefined) return { ok: false, reason: `${name} is required` };
  if (v === true) return { ok: false, reason: `${name} requires a value` };
  return { ok: true, value: v };
}

function optionalValueFlag(
  flags: Record<string, string | true>,
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
  flags: Record<string, string | true>,
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

/**
 * `join`/`leave` mutate the live deployment. The DEFAULT is dry-run (safe);
 * `--apply` opts into real mutation. `--dry-run` is accepted explicitly too.
 * `--apply` and `--dry-run` together is a usage error.
 */
function resolveApply(
  flags: Record<string, string | true>,
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
  flags: Record<string, string | true>,
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
        ...readOverride(flags, "--account", "account"),
        ...readOverride(flags, "--creds", "credsPath"),
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
  flags: Record<string, string | true>,
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
    plistPath: inputs.plistPath,
  };
  const ports = applyRes.apply ? buildLivePorts(cfg) : buildDryRunPorts(cfg);

  const res = await leaveNetwork(networkId, ports);
  return renderFlowResult("leave", networkId, res.ok, res.reason, res.steps, applyRes.apply, json, {
    not_joined: res.notJoined === true ? "true" : "false",
    remaining: (res.remaining ?? []).join(","),
  });
}

async function runStatus(
  flags: Record<string, string | true>,
  json: boolean,
): Promise<ExitResult> {
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("status", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("status", slugRes.reason, json);

  const cfg = portsConfig("", principalRes.value, slugRes.slug, flags);
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
  flags: Record<string, string | true>,
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
  flags: Record<string, string | true>,
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
  flags: Record<string, string | true>,
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
  flags: Record<string, string | true>,
): LivePortsConfig {
  return {
    networkId,
    principalId: inputs.principal,
    stackId: `${inputs.principal}/${stackSlug}`,
    registryUrl: inputs.registryUrl,
    ...(inputs.registryPubkey !== undefined && { registryPubkey: inputs.registryPubkey }),
    seedPath: inputs.seedPath,
    natsConfigPath: inputs.natsConfigPath,
    plistPath: inputs.plistPath,
    monitorUrl: optionalValueFlag(flags, "--monitor-url"),
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
          → restart. Idempotent (re-running converges).
  status  Show joined networks, peers, accept-subjects, leaf link state + counters.
  leave   Reverse a join cleanly: remove the network + leaf include, drop the
          plist -c arg if no networks remain, restart. Idempotent.

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
  --creds <p>             Override stack.nats_infra.creds_path (default: ~/.config/nats/<network>.creds).
  --account <nkey-U>      Override stack.nats_infra.account (A… nkey-U the leaf binds to).
  --nats-config <p>       Override stack.nats_infra.config_path (nats-server -c config).
  --plist <p>             Override stack.nats_infra.plist_path (nats-server launchd plist).
  --leaf-node <name>      Leaf connection name on the network entry (default: network id).
  --max-hop <n>           Hop budget written on the network (default: 1).
  --capabilities <csv>    (join public) Comma-separated capability ids to announce
                          to the public index (e.g. code-review.typescript,research.synthesis).
  --allow <csv>           (join public) Comma-separated INBOUND allowlist of public
                          sender principals. Empty (default) = inbound DISABLED (OQ1
                          safe). Non-empty = inbound enabled, gated to these ids only.
  --monitor-url <url>     (status) nats-server monitor base URL for leaf telemetry.
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
