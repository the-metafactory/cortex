/**
 * ADR-0018 PR5b (#1240) — LIVE adapters for `cortex network secret`.
 *
 * The real side effects the orchestrator (`network-secret-lib.ts`) depends on:
 *   - HUB-LOCAL: read/write the hub nats-server config (chmod 600 — it carries
 *     leaf secrets) + reload it (SIGHUP — an in-place authorization reload, no
 *     restart). A `-c <conf> -t` syntax gate runs first so a malformed config
 *     never reaches a live reload.
 *   - REGISTRY: the admin-signed admission-row LOOKUP + the hub-admin-signed
 *     sealed-secret delivery / revoke POSTs.
 *
 * #1317 — the reload targets the SPECIFIC hub process that serves THIS config,
 * never a bare `nats-server --signal reload` (which refuses the moment >1
 * nats-server runs locally — the normal multi-stack state). Resolution order:
 * the config's `pid_file` (preferred — the server's self-report); otherwise the
 * running nats-server whose argv loads this config path.
 *
 * #1396 (trust-path) — a resolved PID is NOT signalled blind. A `pid_file`
 * survives a crash / `kill -9` and its PID can recycle onto an innocent process,
 * and the enumerate→signal step has a TOCTOU window; so immediately before the
 * SIGHUP we re-read the target PID's LIVE argv (`ps -p <pid> -o command=`) and
 * refuse unless it is still a nats-server loading THIS config
 * ({@link argvIsNatsServerForConfig}). The signal is a raw `process.kill(pid,
 * "SIGHUP")` — the argv re-check, not a nats-aware `--signal reload=<pid>` form,
 * is the safety. See {@link file://../../../common/nats/hub-reload-target.ts}
 * for the pure core + the argv predicate.
 *
 * These are ONLY constructed on a real `--apply` (or dry-run, which still reads).
 * The orchestrator gates every MUTATION on `apply`, so the live mutating methods
 * are not invoked during a dry-run.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from "fs";
import { resolve as resolvePath, join as joinPath } from "path";
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "os";
import { lookup as dnsLookup } from "dns/promises";

import { expandTilde } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import { canonicalJSON } from "../../../common/registry/signing";
import { sealToPrincipal } from "../../../common/crypto/seal-to-principal";
import { mintLeafPsk } from "../../../common/nats/leaf-psk";
import {
  readPidFileDirective,
  resolveHubReloadTarget,
  argvIsNatsServerForConfig,
  isNatsServerCommand,
  type NatsProcess,
} from "../../../common/nats/hub-reload-target";
import {
  signClaimWithSeed,
  randomNonce,
  type StackIdentityMaterial,
} from "../../../bus/stack-provisioning";
import { bunExecRunner, type ExecRunner } from "../../../common/nats/nats-service-manager";
import { NetworkCache } from "../../../common/registry/network-cache";
import { extractHubHost } from "./network-secret-lib";
import {
  readNetworksFromConfig,
  writeNetworksGuarded,
} from "./network-config-write";
import type {
  NetworkSecretPorts,
  HubAuthPort,
  AdmissionLookupPort,
  SealDeliveryPort,
  SecretCrypto,
  HubLocalityPort,
  NetworkKeyRotationPorts,
  AdmittedListPort,
  HubKeyStorePort,
  KeyRotationCrypto,
} from "./network-secret-ports";

/**
 * Enumerate the running nats-server processes (pid + full command line). Used to
 * find the process serving a given hub config when no `pid_file` is declared.
 * Injected so tests assert reload-targeting without spawning `ps`.
 */
export type NatsProcessLister = () => Promise<NatsProcess[]>;

/** Send `signal` (e.g. "SIGHUP") to `pid`. Injected so tests don't kill PIDs. */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Read the full command line (argv joined) of a SINGLE running PID, or undefined
 * when the PID is not alive / not readable. Used for the pre-signal argv re-check
 * (#1396). Injected so the trust-path re-check is testable without real processes.
 */
export type NatsProcessInspector = (pid: number) => Promise<string | undefined>;

/** Real `ps`-backed process lister: every running nats-server with its argv. */
export const bunNatsProcessLister: NatsProcessLister = async () => {
  // `ps -axww -o pid=,command=` — no header, unlimited-width command column so a
  // long `-c <path>` is never truncated. Filter to nats-server invocations.
  const proc = Bun.spawn(["ps", "-axww", "-o", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  const procs: NatsProcess[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const sp = trimmed.indexOf(" ");
    if (sp < 0) continue;
    const pid = Number.parseInt(trimmed.slice(0, sp), 10);
    const command = trimmed.slice(sp + 1).trim();
    if (!Number.isInteger(pid)) continue;
    // Match the nats-server binary at the head of the command (path-tolerant) —
    // the ONE definition lives in the pure core, reused by the argv re-check.
    if (isNatsServerCommand(command)) procs.push({ pid, command });
  }
  return procs;
};

/**
 * Real `ps -p <pid> -o command=`-backed inspector: the live argv of one PID.
 * Empty output / non-zero exit (no such process) → undefined. Portable across
 * macOS + Linux; `/proc/<pid>/cmdline` would be a Linux-only alternative.
 */
export const bunNatsProcessInspector: NatsProcessInspector = async (pid) => {
  const proc = Bun.spawn(["ps", "-p", pid.toString(), "-o", "command="], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) return undefined; // no such process
  const out = (await new Response(proc.stdout).text()).trim();
  return out === "" ? undefined : out;
};

/** Real `process.kill`-backed signal sender. */
export const bunSignalSender: SignalSender = (pid, signal) => process.kill(pid, signal);

export interface LiveSecretPortsConfig {
  /** The hub nats-server config path (carries the leaf authorization users). */
  hubConfigPath: string;
  /** Registry base URL. */
  registryUrl: string;
  /** The HUB-ADMIN identity (seed signs the delivery/revoke + admin read). */
  material: StackIdentityMaterial;
  /** Injectable exec runner (tests). Production omits → bunExecRunner. */
  exec?: ExecRunner;
  /** Injectable nats-server process lister (tests). Production omits → ps-backed. */
  psLister?: NatsProcessLister;
  /** Injectable per-PID argv inspector (tests). Production omits → `ps -p`-backed. */
  inspect?: NatsProcessInspector;
  /** Injectable signal sender (tests). Production omits → process.kill. */
  signal?: SignalSender;
  /** Injectable fetch (tests). Production omits → globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * cortex#1481 — injectable network-descriptor cache (tests). Production
   * omits → a {@link NetworkCache} rooted at the SAME `~/.config/cortex/
   * network-cache/` DD-10 dir `cortex network join` writes (resolved via
   * `expandTilde` for $HOME-honouring test hermeticity, mirroring
   * `network-adapters.ts`'s `buildCachedNetworkPort`).
   */
  networkCache?: NetworkCache;
  /** Injectable hostname resolver (tests). Production omits → `os.hostname()`. */
  hostname?: () => string;
  /**
   * cortex#1481 (Sage review, Important 2) — injectable DNS resolver: host →
   * its IP addresses (tests). Production omits → `dns/promises.lookup(host,
   * {all:true})`. Used by `hubHostIsLocalInterface` to decide whether the hub's
   * host points at this machine.
   */
  resolveHostAddresses?: (host: string) => Promise<string[]>;
  /**
   * cortex#1481 — injectable local-interface address lister (tests). Production
   * omits → `os.networkInterfaces()` flattened to bare addresses.
   */
  localInterfaceAddresses?: () => string[];
}

/** Build the full live port bundle. */
export function buildLiveSecretPorts(cfg: LiveSecretPortsConfig): NetworkSecretPorts {
  return {
    hub: buildLiveHubAuthPort(cfg),
    admission: buildLiveAdmissionLookupPort(cfg),
    delivery: buildLiveSealDeliveryPort(cfg),
    crypto: buildLiveSecretCrypto(),
    hubLocality: buildLiveHubLocalityPort(cfg),
  };
}

// ---------------------------------------------------------------------------
// HUB-LOCAL — hub nats config read/write/reload
// ---------------------------------------------------------------------------

function buildLiveHubAuthPort(cfg: LiveSecretPortsConfig): HubAuthPort {
  const confPath = expandTilde(cfg.hubConfigPath);
  const exec = cfg.exec ?? bunExecRunner;
  const psLister = cfg.psLister ?? bunNatsProcessLister;
  const inspectProcess = cfg.inspect ?? bunNatsProcessInspector;
  const sendSignal = cfg.signal ?? bunSignalSender;
  return {
    confPath,
    readConf(): Promise<string> {
      if (!existsSync(confPath)) {
        return Promise.reject(new Error(`hub config not found at ${confPath} (set --hub-config)`));
      }
      return Promise.resolve(readFileSync(confPath, "utf-8"));
    },
    writeConf(text: string): Promise<void> {
      // The hub config now carries leaf SECRETS, so it is a secret-at-rest.
      // Atomic write (temp + rename) so a SIGKILL mid-write never leaves
      // corrupt HOCON that crashes nats-server, then chmod 600.
      const tmp = `${confPath}.tmp-${process.pid.toString()}`;
      writeFileSync(tmp, text, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, confPath);
      chmodSync(confPath, 0o600);
      return Promise.resolve();
    },
    async reload(): Promise<void> {
      // Syntax gate first — never reload a broken config onto the live hub.
      // Skip the gate (not the reload) if the nats-server binary is absent.
      try {
        const gate = await exec(["nats-server", "-c", confPath, "-t"]);
        if (gate.code !== 0) {
          throw new Error(`nats-server -c ${confPath} -t exited ${gate.code.toString()}: ${gate.stderr.trim()}`);
        }
      } catch (err) {
        // A missing binary throws on spawn — degrade to a warning, still reload.
        if (err instanceof Error && /exited \d/.test(err.message)) throw err;
        process.stderr.write(
          `cortex network secret: skipping nats-server -t gate (could not run nats-server: ${err instanceof Error ? err.message : String(err)})\n`,
        );
      }

      // #1317 — reload the SPECIFIC hub that serves THIS config, never a bare
      // `nats-server --signal reload` (it refuses when >1 nats-server runs —
      // the normal multi-stack state). Prefer the config's `pid_file`; else
      // match the running nats-server whose argv loads this config path.
      const pidFromPidFile = readPidFromHubConfig(confPath);
      let processes: NatsProcess[] = [];
      if (pidFromPidFile === undefined) {
        // Only enumerate when we have to (no pid_file to lean on).
        processes = await psLister();
      }
      const targetRes = resolveHubReloadTarget(confPath, pidFromPidFile, processes);
      if (!targetRes.ok) {
        throw new Error(`could not target the hub reload: ${targetRes.reason}`);
      }

      // #1396 trust-path — NEVER signal an unverified PID. Whether the target came
      // from the pid_file (which survives a crash/`kill -9` and can point at a
      // recycled, unrelated PID) or from config-match (a sub-ms enumerate→signal
      // TOCTOU window), re-read its LIVE argv HERE, immediately before the SIGHUP,
      // and refuse unless it is still a nats-server loading THIS config. SIGHUP's
      // default disposition is TERMINATE, so an unverified signal could kill an
      // innocent process. Both paths funnel through the ONE argv predicate.
      const { pid, via } = targetRes.target;
      const liveArgv = await inspectProcess(pid);
      if (liveArgv === undefined || !argvIsNatsServerForConfig(liveArgv, confPath)) {
        throw new Error(
          `refusing to SIGHUP pid ${pid.toString()} (resolved via ${via}): its live argv is not a ` +
            `nats-server serving ${resolvePath(confPath)} — argv: ${liveArgv ?? "<no such process>"}. ` +
            (via === "pid_file"
              ? `The pid_file is likely STALE (the hub crashed and this PID was recycled onto another process). ` +
                `Remove the stale pid_file or restart the hub, then retry.`
              : `The hub likely exited between enumeration and reload. Restart it, then retry.`),
        );
      }

      // SIGHUP — nats-server applies authorization changes in place, no restart.
      try {
        sendSignal(pid, "SIGHUP");
      } catch (err) {
        throw new Error(
          `SIGHUP to hub nats-server pid ${pid.toString()} ` +
            `(resolved via ${via}) failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}

/**
 * If the hub config at `confPath` declares a `pid_file`, read the PID it holds.
 * Returns `undefined` when no `pid_file` is declared OR the file is absent /
 * unreadable / malformed — the caller then falls back to config-path matching.
 */
function readPidFromHubConfig(confPath: string): number | undefined {
  let confText: string;
  try {
    confText = readFileSync(confPath, "utf-8");
  } catch (_err) {
    // The conf was just written by the orchestrator; an unreadable read here is
    // unexpected but non-fatal — fall back to process matching.
    return undefined;
  }
  const declared = readPidFileDirective(confText);
  if (declared === undefined) return undefined;
  const pidPath = expandTilde(declared);
  if (!existsSync(pidPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8").trim();
  } catch (err) {
    process.stderr.write(
      `cortex network secret: pid_file ${pidPath} declared but unreadable (${err instanceof Error ? err.message : String(err)}); falling back to process match\n`,
    );
    return undefined;
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// ---------------------------------------------------------------------------
// REGISTRY — admission lookup (admin read) + sealed delivery / revoke (hub-admin)
// ---------------------------------------------------------------------------

interface AdmissionRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
}

function buildLiveAdmissionLookupPort(cfg: LiveSecretPortsConfig): AdmissionLookupPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async findAdmittedRow(networkId, memberPubkey) {
      // Admin-signed read of the ADMITTED list (x-admin-signed header). NOTE: the
      // registry's read gate checks the REGISTRY-admin allowlist; for metafactory
      // the hub-admin seed IS the registry-admin (Q5 collapse), so this works. A
      // fully-separable deployment must put the hub-admin on REGISTRY_ADMIN_PUBKEYS
      // for the lookup (documented in the PR).
      const claim = { admin_pubkey: cfg.material.pubkeyB64, issued_at: new Date().toISOString() };
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify({ claim, signature }) },
      });
      if (!resp.ok) {
        throw new Error(`registry admission list failed (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
      const rows = (await resp.json()) as AdmissionRow[];
      const row = rows.find((r) => r.network_id === networkId && r.peer_pubkey === memberPubkey && r.status === "ADMITTED");
      return row ? { request_id: row.request_id, principal_id: row.principal_id } : undefined;
    },
  };
}

function buildLiveSealDeliveryPort(cfg: LiveSecretPortsConfig): SealDeliveryPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async postSealedSecret(requestId, sealedBlob) {
      const claim = {
        request_id: requestId,
        sealed_secret: sealedBlob,
        hub_admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        nonce: randomNonce(),
      };
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/sealed-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim, signature }),
      });
      if (!resp.ok) {
        throw new Error(`registry rejected sealed-secret (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
    },
    async revoke(requestId) {
      const claim = {
        request_id: requestId,
        hub_admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        nonce: randomNonce(),
      };
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim, signature }),
      });
      if (!resp.ok) {
        throw new Error(`registry rejected revoke (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
    },
  };
}

function buildLiveSecretCrypto(): SecretCrypto {
  return {
    mintPsk: () => mintLeafPsk(),
    seal: (plaintext, pubkey) => sealToPrincipal(plaintext, pubkey),
  };
}

// ---------------------------------------------------------------------------
// cortex#1481 — HUB LOCALITY: read-only, local-disk-only hub_url resolution.
// ---------------------------------------------------------------------------

/** Production DNS resolver: host → its IP addresses (v4 + v6). */
const defaultResolveHostAddresses = async (host: string): Promise<string[]> => {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
};

/** Production local-interface lister: every address on `os.networkInterfaces()`. */
const defaultLocalInterfaceAddresses = (): string[] => {
  const out: string[] = [];
  for (const ifaces of Object.values(osNetworkInterfaces())) {
    for (const iface of ifaces ?? []) out.push(iface.address);
  }
  return out;
};

/**
 * cortex#1481 — LIVE {@link HubLocalityPort}: reads the SAME DD-10
 * `~/.config/cortex/network-cache/<network>.json` last-known-good cache
 * `cortex network join` writes (read-only, local disk — deliberately never a
 * live registry round trip; see the port jsdoc for why), + `os.hostname()`, +
 * (Sage review Important 2) a DNS→local-interface probe so a hub owner whose
 * own hub is cached as an FQDN still gets the local auto-write. Every fact is
 * injectable so tests never touch the real home dir, hostname, DNS, or NICs.
 */
function buildLiveHubLocalityPort(cfg: LiveSecretPortsConfig): HubLocalityPort {
  const cache =
    cfg.networkCache ??
    new NetworkCache({ cacheDir: expandTilde(joinPath("~", ".config", "cortex", "network-cache")) });
  const getHostname = cfg.hostname ?? osHostname;
  const resolveHostAddresses = cfg.resolveHostAddresses ?? defaultResolveHostAddresses;
  const localInterfaceAddresses = cfg.localInterfaceAddresses ?? defaultLocalInterfaceAddresses;
  return {
    resolveHubUrl(networkId) {
      return Promise.resolve(cache.load(networkId)?.descriptor.hub_url);
    },
    localHostname() {
      return getHostname();
    },
    async hubHostIsLocalInterface(hubUrl) {
      // Parse the SAME host the pure decider matches on (one grammar, no drift).
      const host = extractHubHost(hubUrl);
      if (host === undefined) return false;
      let addresses: string[];
      try {
        addresses = await resolveHostAddresses(host);
      } catch (err) {
        // FAIL-SAFE: a DNS failure must NEVER throw (the seal proceeds) and must
        // NEVER be read as "local" (that would risk the foreign-hub write). Log
        // + treat as NOT local → the caller falls to the EXTERNAL artifact path.
        process.stderr.write(
          `cortex network secret: hub host "${host}" DNS lookup failed (${err instanceof Error ? err.message : String(err)}); ` +
            `treating the hub as NOT local (external) — fail-safe\n`,
        );
        return false;
      }
      const local = new Set(localInterfaceAddresses());
      return addresses.some((a) => local.has(a));
    },
  };
}

// ---------------------------------------------------------------------------
// C-1349 Slice 2 — LIVE adapters for `cortex network secret rotate-key`.
// ---------------------------------------------------------------------------

export interface LiveKeyRotationPortsConfig {
  /** The hub nats-server config path (to recover each member's leaf PSK). */
  hubConfigPath: string;
  /** Registry base URL. */
  registryUrl: string;
  /** The HUB-ADMIN identity (signs the admin read + the sealed-blob POSTs). */
  material: StackIdentityMaterial;
  /** The HUB STACK's own cortex config (the K store rotate-key advances). */
  hubStackConfigPath: string;
  /** Injectable fetch (tests). Production omits → globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/** Build the full live port bundle for `rotate-key`. */
export function buildLiveKeyRotationPorts(cfg: LiveKeyRotationPortsConfig): NetworkKeyRotationPorts {
  const hubConfPath = expandTilde(cfg.hubConfigPath);
  return {
    readHubConf(): Promise<string> {
      if (!existsSync(hubConfPath)) {
        return Promise.reject(new Error(`hub config not found at ${hubConfPath} (set --hub-config)`));
      }
      return Promise.resolve(readFileSync(hubConfPath, "utf-8"));
    },
    admission: buildLiveAdmittedListPort(cfg),
    // rotate-key reuses the per-member sealed-blob POST verbatim.
    delivery: buildLiveSealDeliveryPort({
      hubConfigPath: cfg.hubConfigPath,
      registryUrl: cfg.registryUrl,
      material: cfg.material,
      ...(cfg.fetchImpl !== undefined && { fetchImpl: cfg.fetchImpl }),
    }),
    crypto: buildLiveKeyRotationCrypto(),
    keyStore: buildLiveHubKeyStorePort(cfg.hubStackConfigPath),
  };
}

function buildLiveAdmittedListPort(cfg: LiveKeyRotationPortsConfig): AdmittedListPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async listAdmittedRows(networkId) {
      // The SAME admin-signed read `findAdmittedRow` / `admit --list-pending` use.
      // ADR-0020 scopes admin reads to GLOBAL admins; a per-network admin 403s
      // here — surfaced readably rather than as a silent empty list.
      const claim = { admin_pubkey: cfg.material.pubkeyB64, issued_at: new Date().toISOString() };
      const signature = await signClaimWithSeed(cfg.material.seed, new TextEncoder().encode(canonicalJSON(claim)));
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify({ claim, signature }) },
      });
      if (resp.status === 403) {
        throw new Error(
          `registry refused the ADMITTED list (HTTP 403 admin_not_authorized): admission reads are ` +
            `GLOBAL-admin-only today (ADR-0020), so a per-network admin cannot enumerate members for ` +
            `"${networkId}" to rotate the key. Use a global-admin seed; per-network read-scoping is the ADR-0020 fast-follow.`,
        );
      }
      if (!resp.ok) {
        throw new Error(`registry ADMITTED list failed (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
      const rows = (await resp.json()) as AdmissionRow[];
      return rows
        .filter((r) => r.network_id === networkId && r.status === "ADMITTED")
        .map((r) => ({ request_id: r.request_id, principal_id: r.principal_id, peer_pubkey: r.peer_pubkey }));
    },
  };
}

function buildLiveHubKeyStorePort(hubStackConfigPath: string): HubKeyStorePort {
  const path = expandTilde(hubStackConfigPath);
  return {
    configPath: path,
    readNetworks() {
      return Promise.resolve(readNetworksFromConfig(path));
    },
    writeNetworks(networks) {
      // The SAME offer.ts write-guard Slice 1 added (validate → backup → atomic →
      // verify → restore → chmod 600). NO daemon-loads assertion — rotate-key is
      // the hub admin editing their OWN stack config; they restart the daemon.
      writeNetworksGuarded(path, networks, { backupLabel: "rotate-key" });
      return Promise.resolve();
    },
  };
}

function buildLiveKeyRotationCrypto(): KeyRotationCrypto {
  return {
    mintPayloadKey: () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return bytes;
    },
    seal: (plaintext, pubkey) => sealToPrincipal(plaintext, pubkey),
  };
}

/** Load + chmod-600-gate a hub-admin seed file, re-deriving its material. */
export async function hubAdminMaterialFromSeedFile(
  seedPath: string,
): Promise<{ ok: true; material: StackIdentityMaterial } | { ok: false; reason: string }> {
  const { readFile } = await import("fs/promises");
  const { materialFromSeedString } = await import("../../../bus/stack-provisioning");
  const expanded = expandTilde(seedPath);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `--admin-seed file not found at ${expanded}` };
  }
  try {
    enforceChmod600(expanded);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const seed = await readFile(expanded, "utf-8");
    return { ok: true, material: materialFromSeedString(seed) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
