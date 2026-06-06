/**
 * S4 (#738) — the REAL + DRY-RUN port adapters for `cortex network`.
 *
 * The orchestration (`network-lib.ts`) is pure over {@link NetworkPorts}. This
 * module builds the two concrete bundles:
 *
 *   - {@link buildLivePorts}   — mutates the live deployment (leaf include file,
 *     nats-server plist, the stack's federation config, launchctl). Used only
 *     on `--apply`.
 *   - {@link buildDryRunPorts} — the DEFAULT-safe bundle: every effect is a
 *     no-op that the orchestrator's step log captures, so an accidental run
 *     during development touches nothing (the S4 SAFETY rule). Reads still hit
 *     disk (a dry-run join needs to know the current config to show the diff),
 *     but no write/exec/restart happens.
 *
 * Wiring of the S1–S3 pieces:
 *   - S1 `NetworkRegistryClient` (pin+verify, DD-9) + `registerStackIdentity`
 *     (proof-of-possession, reused from provision-stack) → {@link NetworkRegistryPort}.
 *   - S3 `renderLeafIncludeFile` + `leafIncludeFileName` → {@link LeafFilePort}.
 *   - S3 `ensureConfigArg` + `renderProgramArguments` → {@link PlistPort}.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { expandTilde } from "../../../common/config/loader";
import {
  ensureLeafInclude,
  leafIncludeFileName,
  removeLeafInclude,
  renderLeafIncludeFile,
} from "../../../common/nats/leaf-remote-renderer";
import {
  ensureConfigArg,
  plistConfigArgPresent,
  renderProgramArguments,
} from "../../../common/nats/nats-plist-loader";
import { NetworkRegistryClient } from "../../../common/registry/network-client";
import {
  buildRegistrationClaim,
  materialFromSeedString,
  registerStackIdentity,
} from "../../../bus/stack-provisioning";
import type {
  PolicyFederatedNetwork,
  PolicyPublic,
} from "../../../common/types/cortex-config";

import type {
  ConfigStorePort,
  DaemonPort,
  LeafFilePort,
  LeafStatePort,
  NatsServerPort,
  NetworkPorts,
  NetworkRegistryPort,
  PlistPort,
  RenderLeafInputs,
} from "./network-ports";
import type {
  PublicPolicyPort,
  PublicRegistryPort,
  PublicScopePorts,
  PublicSubscribePort,
} from "./network-public-ports";

/** Everything the live adapters need, threaded from the CLI flags. */
export interface LivePortsConfig {
  networkId: string;
  principalId: string;
  stackId: string;
  registryUrl?: string;
  registryPubkey?: string;
  seedPath?: string;
  natsConfigPath?: string;
  plistPath?: string;
  monitorUrl?: string;
}

// =============================================================================
// Registry port — S1 client + provision-stack register (proof-of-possession).
// =============================================================================

/**
 * Shared idempotent proof-of-possession registration (reused by the S4
 * `registerStack` and the S5 public-index announce/deregister). Loads the seed,
 * builds + signs the claim with the supplied `capabilities`, and POSTs it. An
 * EMPTY `capabilities` list de-advertises the stack on the public index
 * (the registry searches over the claim's `capabilities`). Never throws.
 */
async function registerWithCapabilities(
  cfg: LivePortsConfig,
  capabilities: { id: string }[],
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const url = cfg.registryUrl ?? "";
  if (cfg.seedPath === undefined) {
    return { ok: false, reason: "no --seed-path for registration" };
  }
  const seedFile = expandTilde(cfg.seedPath);
  if (!existsSync(seedFile)) {
    return { ok: false, reason: `seed file not found at ${seedFile}` };
  }
  let material;
  try {
    material = materialFromSeedString(readFileSync(seedFile, "utf-8"));
  } catch (err) {
    return { ok: false, reason: `seed load failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const body = await buildRegistrationClaim({
    principalId: cfg.principalId,
    material,
    stacks: [{ stack_id: cfg.stackId }],
    capabilities,
  });
  let result;
  try {
    result = await registerStackIdentity({ registryUrl: url, principalId: cfg.principalId, body });
  } catch (err) {
    return { ok: false, reason: `registry POST failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) {
    return { ok: false, reason: `registry rejected registration (HTTP ${result.status.toString()})` };
  }
  return { ok: true, note: `HTTP ${result.status.toString()}` };
}

function buildRegistryPort(cfg: LivePortsConfig): NetworkRegistryPort {
  const url = cfg.registryUrl ?? "";
  const client = new NetworkRegistryClient({
    url,
    ...(cfg.registryPubkey !== undefined ? { pubkey: cfg.registryPubkey } : {}),
  });

  return {
    async registerStack() {
      // S4 federated register — proof-of-possession with no capability change.
      return registerWithCapabilities(cfg, []);
    },
    fetchVerified(networkId) {
      // S1's fetchAndCache returns { descriptor, roster } on ok and refreshes
      // the disk cache (DD-10) — exactly the port's contract.
      return client.fetchAndCache(networkId);
    },
    loadCached(networkId) {
      return client.loadCached(networkId);
    },
  };
}

// =============================================================================
// Leaf-file port — S3 renderer output written to the nats config dir.
// =============================================================================

/** Directory the per-network leaf include files live in (beside nats config). */
function leafDir(cfg: LivePortsConfig): string {
  const natsConfig = expandTilde(cfg.natsConfigPath ?? "");
  return dirname(natsConfig);
}

function buildLeafFilePort(cfg: LivePortsConfig, mutate: boolean): LeafFilePort {
  const dir = leafDir(cfg);
  return {
    write(inputs: RenderLeafInputs) {
      const content = renderLeafIncludeFile(inputs.descriptor, inputs.binding);
      if (!mutate) return; // dry-run: render to validate, but do not write.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, leafIncludeFileName(inputs.descriptor.network_id)), content, "utf-8");
    },
    remove(networkId) {
      if (!mutate) return;
      const p = join(dir, leafIncludeFileName(networkId));
      rmSync(p, { force: true });
    },
    ensureInclude(networkId) {
      // #754 — wire the main nats config to `include` the rendered leaf file.
      // Read local.conf, apply S3's idempotent ensure, write back. Dry-run is
      // inert (the orchestrator's step log still records the intended action).
      if (!mutate) return;
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      const current = existsSync(configPath)
        ? readFileSync(configPath, "utf-8")
        : "";
      const next = ensureLeafInclude(current, networkId);
      if (next === current) return; // byte-stable no-op.
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, next, "utf-8");
    },
    removeInclude(networkId) {
      // #754 — leave teardown: drop the include directive (inverse of ensure).
      if (!mutate) return;
      const configPath = expandTilde(cfg.natsConfigPath ?? "");
      if (!existsSync(configPath)) return;
      const current = readFileSync(configPath, "utf-8");
      const next = removeLeafInclude(current, networkId);
      if (next === current) return; // no-op.
      writeFileSync(configPath, next, "utf-8");
    },
    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => /^leafnodes-[a-z][a-z0-9-]*\.conf$/.test(f))
        .map((f) => f.replace(/^leafnodes-/, "").replace(/\.conf$/, ""));
    },
    natsConfigPath() {
      return expandTilde(cfg.natsConfigPath ?? "");
    },
  };
}

// =============================================================================
// Plist port — built on S3's canonical ensureConfigArg + renderProgramArguments
// (`src/common/nats/nats-plist-loader.ts`) as the single source of truth for
// the ProgramArguments arg-list transform AND its XML rendering. This adapter
// only does the plist I/O: read the existing args back out, and splice S3's
// rendered block into the file. No bespoke arg/XML logic lives here.
// =============================================================================

/** Read the `ProgramArguments` <string> entries from a launchd plist. */
function readProgramArguments(plistPath: string): string[] {
  const xml = readFileSync(plistPath, "utf-8");
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (block === null) return [];
  const args: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1] ?? "")) !== null) {
    args.push(unescapeXml(m[1] ?? ""));
  }
  return args;
}

function unescapeXml(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Rewrite the plist's ProgramArguments block in place with `nextArgs`. The XML
 * block is rendered by S3's canonical {@link renderProgramArguments} (the
 * single source of truth for the ProgramArguments key+array XML, including the
 * five-entity escaping) — this adapter only splices it into the plist. Matches
 * the existing `<key>ProgramArguments</key>` block INCLUDING its leading
 * horizontal indent so S3's own `\t`-prefixed output replaces it 1:1 (no
 * double-indent), keeping the on-disk plist byte-shape stable.
 */
function writeProgramArguments(plistPath: string, nextArgs: string[]): void {
  const xml = readFileSync(plistPath, "utf-8");
  const next = xml.replace(
    /[ \t]*<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/,
    renderProgramArguments(nextArgs),
  );
  writeFileSync(plistPath, next, "utf-8");
}

function buildPlistPort(cfg: LivePortsConfig, mutate: boolean): PlistPort {
  const plistPath = expandTilde(cfg.plistPath ?? "");
  return {
    ensureConfigLoaded(configPath) {
      if (!existsSync(plistPath)) return;
      const args = readProgramArguments(plistPath);
      if (plistConfigArgPresent(args, configPath)) return; // idempotent no-op
      const next = ensureConfigArg(args, configPath);
      if (!mutate) return;
      writeProgramArguments(plistPath, next);
    },
    dropConfigArg(configPath) {
      if (!existsSync(plistPath)) return;
      const args = readProgramArguments(plistPath);
      const next = args.filter((a, i) => {
        if (a === "-c" || a === "--config") return false;
        if (i > 0 && (args[i - 1] === "-c" || args[i - 1] === "--config")) return false;
        if (a === `--config=${configPath}`) return false;
        return true;
      });
      if (!mutate) return;
      writeProgramArguments(plistPath, next);
    },
  };
}

// =============================================================================
// Config-store port — read/write policy.federated.networks[] in stacks/<stack>.yaml.
// =============================================================================

/**
 * The stack-scoped config file that carries policy.federated.networks[] (#756).
 *
 * Two layouts, resolved the same way the loader's composer resolves its
 * ingestion path (`LAYOUT_MARKER = system/system.yaml`):
 *
 *   - **config-split (current, migration 0003 / #714):** per-stack dirs. Each
 *     stack lives at `~/.config/cortex/<slug>/`, with its policy block in
 *     `~/.config/cortex/<slug>/stacks/<slug>.yaml`. This is the file the daemon
 *     actually composes + loads, so the join's `policy.federated.networks[]`
 *     MUST land here. Detected by the per-stack marker
 *     `~/.config/cortex/<slug>/system/system.yaml`.
 *   - **flat (legacy):** `~/.config/cortex/stacks/<slug>.yaml`. The pre-split
 *     path; used only as a fallback when the per-stack dir is absent.
 *
 * Before #756 the join wrote the FLAT path unconditionally, so on a config-split
 * deployment the policy block landed as a stray orphan the daemon never read.
 * We now prefer the split layout whenever its per-stack dir exists.
 */
function stackConfigPath(cfg: LivePortsConfig): string {
  const slug = cfg.stackId.split("/")[1] ?? "default";
  const cortexDir = expandTilde("~/.config/cortex");
  // Config-split: the per-stack dir is marked by `<slug>/system/system.yaml`
  // (the same marker the loader's composer keys on). When present, the policy
  // block belongs in the per-stack `stacks/<slug>.yaml` the daemon composes.
  const perStackDir = join(cortexDir, slug);
  const splitMarker = join(perStackDir, "system", "system.yaml");
  if (existsSync(splitMarker)) {
    return join(perStackDir, "stacks", `${slug}.yaml`);
  }
  // Flat (legacy) fallback.
  return join(cortexDir, "stacks", `${slug}.yaml`);
}

function buildConfigStorePort(cfg: LivePortsConfig, mutate: boolean): ConfigStorePort {
  const path = stackConfigPath(cfg);
  return {
    readNetworks() {
      if (!existsSync(path)) return [];
      const raw = parseYaml(readFileSync(path, "utf-8")) as
        | { policy?: { federated?: { networks?: PolicyFederatedNetwork[] } } }
        | null;
      return raw?.policy?.federated?.networks ?? [];
    },
    writeNetworks(networks) {
      if (!mutate) return;
      const raw = existsSync(path)
        ? ((parseYaml(readFileSync(path, "utf-8")) ?? {}) as Record<string, unknown>)
        : {};
      const policy = (raw.policy ??= {}) as Record<string, unknown>;
      const federated = ((policy as { federated?: unknown }).federated ??= {}) as Record<string, unknown>;
      federated.networks = networks;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stringifyYaml(raw), "utf-8");
    },
  };
}

// =============================================================================
// Daemon port — launchctl kickstart of the stack daemon.
// =============================================================================

function buildDaemonPort(cfg: LivePortsConfig, mutate: boolean): DaemonPort {
  return {
    async restart() {
      if (!mutate) return { ok: true }; // dry-run: pretend success.
      const label = `ai.meta-factory.cortex.${cfg.stackId.split("/")[1] ?? "default"}`;
      const proc = Bun.spawn(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${label}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        return { ok: false, reason: `launchctl kickstart exited ${code.toString()}: ${err.trim()}` };
      }
      return { ok: true };
    },
  };
}

// =============================================================================
// Nats-server port — launchctl kickstart of the nats-server plist's service
// (#757). The join mutates local.conf (leaf include + `include` directive); the
// nats-server process that reads local.conf must be restarted for the leaf to
// take effect. We restart the service named by the join's `--plist`
// (the nats-server plist), reading its `<key>Label</key>` so the kickstart
// target is whatever the principal's plist declares (homebrew.mxcl.nats-server,
// a custom label, etc.) — no hardcoded label.
// =============================================================================

/** Read the launchd `<key>Label</key><string>…</string>` from a plist. */
function readPlistLabel(plistPath: string): string | undefined {
  const xml = readFileSync(plistPath, "utf-8");
  const m = /<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(xml);
  if (m === null) return undefined;
  const label = unescapeXml(m[1] ?? "").trim();
  return label === "" ? undefined : label;
}

function buildNatsServerPort(cfg: LivePortsConfig, mutate: boolean): NatsServerPort {
  const plistPath = expandTilde(cfg.plistPath ?? "");
  return {
    async restart() {
      if (!mutate) return { ok: true }; // dry-run: pretend success, touch nothing.
      if (cfg.plistPath === undefined || !existsSync(plistPath)) {
        return { ok: false, reason: `nats-server plist not found at ${plistPath}` };
      }
      const label = readPlistLabel(plistPath);
      if (label === undefined) {
        return { ok: false, reason: `no <key>Label</key> in nats-server plist ${plistPath}` };
      }
      const proc = Bun.spawn(
        ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${label}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        return {
          ok: false,
          reason: `launchctl kickstart ${label} exited ${code.toString()}: ${err.trim()}`,
        };
      }
      return { ok: true };
    },
  };
}

// =============================================================================
// Leaf-state port — nats-server monitor /leafz for status.
// =============================================================================

function buildLeafStatePort(cfg: LivePortsConfig): LeafStatePort | undefined {
  if (cfg.monitorUrl === undefined) return undefined;
  const base = cfg.monitorUrl.replace(/\/+$/, "");
  return {
    async linkStates() {
      try {
        const res = await fetch(`${base}/leafz`);
        if (!res.ok) return {};
        const body = (await res.json()) as {
          leafs?: { account?: string; name?: string; in_msgs?: number; out_msgs?: number }[];
        };
        const out: Record<string, { state: "established"; inMsgs?: number; outMsgs?: number }> = {};
        for (const leaf of body.leafs ?? []) {
          const key = leaf.name ?? leaf.account ?? "";
          if (key === "") continue;
          out[key] = { state: "established", inMsgs: leaf.in_msgs, outMsgs: leaf.out_msgs };
        }
        return out;
      } catch (err) {
        // Monitor unreachable — status degrades to "unknown" link state.
        process.stderr.write(
          `network-adapters: leaf-state fetch failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return {};
      }
    },
  };
}

// =============================================================================
// Bundle builders
// =============================================================================

function buildPorts(cfg: LivePortsConfig, mutate: boolean): NetworkPorts {
  const leafState = buildLeafStatePort(cfg);
  return {
    registry: buildRegistryPort(cfg),
    leafFile: buildLeafFilePort(cfg, mutate),
    plist: buildPlistPort(cfg, mutate),
    configStore: buildConfigStorePort(cfg, mutate),
    daemon: buildDaemonPort(cfg, mutate),
    natsServer: buildNatsServerPort(cfg, mutate),
    ...(leafState !== undefined ? { leafState } : {}),
  };
}

/** Live ports — every effect mutates the deployment. Use only on `--apply`. */
export function buildLivePorts(cfg: LivePortsConfig): NetworkPorts {
  return buildPorts(cfg, true);
}

/**
 * Dry-run ports — reads hit disk; every WRITE/EXEC/RESTART is a no-op (the
 * orchestrator's step log still records the intended action). The S4 default.
 */
export function buildDryRunPorts(cfg: LivePortsConfig): NetworkPorts {
  return buildPorts(cfg, false);
}

// =============================================================================
// S5 (#739) — public-scope adapters (join/leave public)
// =============================================================================

/**
 * The system-layer config file that carries `nats.subjects[]` — `system/system.yaml`
 * under the cortex config dir (the config-split puts the transport block in the
 * system layer, NOT the stack file — the double-message structural fix). The
 * `public.>` subscription is added/removed here.
 */
function systemConfigPath(): string {
  return join(expandTilde("~/.config/cortex"), "system", "system.yaml");
}

/** The literal `public.>` subscribe pattern. */
const PUBLIC_SUBSCRIBE = "public.>";

// S5 — public capability announce/deregister: re-register the stack with (caps)
// or (empty) so the registry's `/capabilities` public index includes/drops it.
function buildPublicRegistryPort(cfg: LivePortsConfig): PublicRegistryPort {
  return {
    async announceCapabilities(capabilities) {
      return registerWithCapabilities(
        cfg,
        capabilities.map((id) => ({ id })),
      );
    },
    async deregisterCapabilities() {
      // De-advertise — register with an EMPTY capability list.
      return registerWithCapabilities(cfg, []);
    },
  };
}

// S5 — manage `public.>` in system.yaml's `nats.subjects[]`.
function buildPublicSubscribePort(mutate: boolean): PublicSubscribePort {
  const path = systemConfigPath();
  const readSubjects = (): string[] => {
    if (!existsSync(path)) return [];
    const raw = parseYaml(readFileSync(path, "utf-8")) as
      | { nats?: { subjects?: string[] } }
      | null;
    return raw?.nats?.subjects ?? [];
  };
  return {
    hasPublicSubscription() {
      return readSubjects().includes(PUBLIC_SUBSCRIBE);
    },
    addPublicSubscription() {
      if (!mutate) return;
      const raw = existsSync(path)
        ? ((parseYaml(readFileSync(path, "utf-8")) ?? {}) as Record<string, unknown>)
        : {};
      const nats = (raw.nats ??= {}) as Record<string, unknown>;
      const subjects = Array.isArray(nats.subjects) ? (nats.subjects as string[]) : [];
      // Idempotent — never double-bind (the cortex#491 double-message footgun).
      if (!subjects.includes(PUBLIC_SUBSCRIBE)) subjects.push(PUBLIC_SUBSCRIBE);
      nats.subjects = subjects;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stringifyYaml(raw), "utf-8");
    },
    removePublicSubscription() {
      if (!mutate) return;
      if (!existsSync(path)) return;
      const raw = (parseYaml(readFileSync(path, "utf-8")) ?? {}) as Record<string, unknown>;
      const nats = raw.nats as { subjects?: string[] } | undefined;
      if (nats?.subjects === undefined) return;
      nats.subjects = nats.subjects.filter((s) => s !== PUBLIC_SUBSCRIBE);
      writeFileSync(path, stringifyYaml(raw), "utf-8");
    },
  };
}

// S5 — read/write `policy.public` in the stack file (same file S4's
// ConfigStorePort writes policy.federated.networks[] to).
function buildPublicPolicyPort(cfg: LivePortsConfig, mutate: boolean): PublicPolicyPort {
  const path = stackConfigPath(cfg);
  return {
    readPublic() {
      if (!existsSync(path)) return undefined;
      const raw = parseYaml(readFileSync(path, "utf-8")) as
        | { policy?: { public?: PolicyPublic } }
        | null;
      return raw?.policy?.public;
    },
    writePublic(next) {
      if (!mutate) return;
      const raw = existsSync(path)
        ? ((parseYaml(readFileSync(path, "utf-8")) ?? {}) as Record<string, unknown>)
        : {};
      const policy = (raw.policy ??= {}) as Record<string, unknown>;
      if (next === undefined) {
        // Leave teardown — drop the block entirely.
        delete (policy as { public?: unknown }).public;
      } else {
        (policy as { public?: unknown }).public = next;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stringifyYaml(raw), "utf-8");
    },
  };
}

function buildPublicPorts(cfg: LivePortsConfig, mutate: boolean): PublicScopePorts {
  return {
    registry: buildPublicRegistryPort(cfg),
    subscribe: buildPublicSubscribePort(mutate),
    policy: buildPublicPolicyPort(cfg, mutate),
    daemon: buildDaemonPort(cfg, mutate),
  };
}

/** Live public-scope ports — mutate system.yaml + stack config. `--apply` only. */
export function buildLivePublicPorts(cfg: LivePortsConfig): PublicScopePorts {
  return buildPublicPorts(cfg, true);
}

/**
 * Dry-run public-scope ports — the S5 default-safe posture. Reads hit disk (so
 * idempotency checks like `hasPublicSubscription` are accurate); every
 * WRITE/RESTART is a no-op. An accidental `join public` during development
 * touches nothing.
 */
export function buildDryRunPublicPorts(cfg: LivePortsConfig): PublicScopePorts {
  return buildPublicPorts(cfg, false);
}
