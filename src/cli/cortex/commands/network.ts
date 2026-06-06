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

import { expandTilde } from "../../../common/config/loader";

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
  type LivePortsConfig,
} from "./network-adapters";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type NetworkSubcommand = "join" | "leave" | "status";

const NETWORK_ID_RE = /^[a-z][a-z0-9-]*$/;
const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;

const SPEC: SubcommandSpec<NetworkSubcommand> = {
  cliName: "network",
  subcommands: {
    join: {
      positionals: ["network"],
      flags: {
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
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    leave: {
      positionals: ["network"],
      flags: {
        "--principal": "value",
        "--stack": "value",
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
): Promise<ExitResult> {
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("join", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("join", principalRes.reason, json);
  if (!PRINCIPAL_ID_RE.test(principalRes.value)) {
    return usageError("join", `--principal "${principalRes.value}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("join", slugRes.reason, json);

  // All six are required for a live join; resolve them typed so the stack
  // identity carries real strings (no non-null assertions).
  for (const required of ["--registry-url", "--seed-path", "--nats-config", "--plist"]) {
    const r = requireValueFlag(flags, required);
    if (!r.ok) return usageError("join", r.reason, json);
  }
  const credsRes = requireValueFlag(flags, "--creds");
  if (!credsRes.ok) return usageError("join", credsRes.reason, json);
  const accountRes = requireValueFlag(flags, "--account");
  if (!accountRes.ok) return usageError("join", accountRes.reason, json);

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
    principalId: principalRes.value,
    stackSlug: slugRes.slug,
    credentials: expandTilde(credsRes.value),
    account: accountRes.value,
    leafNode: optionalValueFlag(flags, "--leaf-node"),
    maxHop,
  };

  const cfg = portsConfig(networkId, principalRes.value, slugRes.slug, flags);
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
): Promise<ExitResult> {
  if (!NETWORK_ID_RE.test(networkId)) {
    return usageError("leave", `network "${networkId}" must be lowercase alphanumeric + hyphen, letter-prefixed`, json);
  }
  const principalRes = requireValueFlag(flags, "--principal");
  if (!principalRes.ok) return usageError("leave", principalRes.reason, json);
  const slugRes = resolveStackSlug(principalRes.value, optionalValueFlag(flags, "--stack"));
  if (!slugRes.ok) return usageError("leave", slugRes.reason, json);
  for (const required of ["--nats-config", "--plist"]) {
    const r = requireValueFlag(flags, required);
    if (!r.ok) return usageError("leave", r.reason, json);
  }
  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("leave", applyRes.reason, json);

  const cfg = portsConfig(networkId, principalRes.value, slugRes.slug, flags);
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

// =============================================================================
// Dispatcher
// =============================================================================

export async function dispatchNetwork(argv: string[]): Promise<ExitResult> {
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
      return runJoin(parsed.positionals.network ?? "", parsed.flags, json);
    case "leave":
      return runLeave(parsed.positionals.network ?? "", parsed.flags, json);
    case "status":
      return runStatus(parsed.flags, json);
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex network — one-command join to the Internet of Agentic Work (S4, #738)

Usage:
  cortex network join  <network> --principal <id> --registry-url <url> \\
                        --seed-path <p> --creds <p> --account <nkey-U> \\
                        --nats-config <p> --plist <p> [--stack <id>] \\
                        [--registry-pubkey <b64>] [--leaf-node <name>] \\
                        [--max-hop <n>] [--apply] [--json]
  cortex network leave  <network> --principal <id> --nats-config <p> \\
                        --plist <p> [--stack <id>] [--apply] [--json]
  cortex network status --principal <id> [--stack <id>] [--monitor-url <url>] [--json]

Subcommands:
  join    Register → pull the SIGNED+VERIFIED network descriptor (DD-9; cached
          fallback on registry outage, DD-10) → render the nats-server leaf +
          ensure the plist loads it (DD-6) → write policy.federated.networks[]
          with registry-resolved peers (DD-5) + the stack's OWN accept-subject
          → restart. Idempotent (re-running converges).
  status  Show joined networks, peers, accept-subjects, leaf link state + counters.
  leave   Reverse a join cleanly: remove the network + leaf include, drop the
          plist -c arg if no networks remain, restart. Idempotent.

Safety:
  join/leave default to DRY-RUN (no disk/daemon mutation — they print the
  intended actions). Pass --apply to execute for real. --apply and --dry-run
  are mutually exclusive.

Flags:
  --principal <id>        Local principal id (the {me} subject segment).
  --stack <id>            {principal}/{slug}; defaults to <principal>/default.
  --registry-url <url>    Network-registry base URL (control plane).
  --registry-pubkey <b64> Pinned registry Ed25519 pubkey (DD-9); TOFU if omitted.
  --seed-path <p>         Stack signing seed for registration (proof-of-possession).
  --creds <p>             nats-server leaf .creds file (absolute).
  --account <nkey-U>      Local NATS account the leaf binds to (A… nkey-U).
  --nats-config <p>       nats-server config the plist loads (-c) + includes the leaf.
  --plist <p>             nats-server launchd plist to ensure loads the config.
  --leaf-node <name>      Leaf connection name on the network entry (default: network id).
  --max-hop <n>           Hop budget written on the network (default: 1).
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
