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
 * the config's `pid_file` (preferred — the server's authoritative self-report)
 * → `nats-server --signal reload=<pid>`; otherwise the running nats-server whose
 * argv loads this config path → `kill -SIGHUP <pid>`. See
 * {@link file://../../../common/nats/hub-reload-target.ts} for the pure core.
 *
 * These are ONLY constructed on a real `--apply` (or dry-run, which still reads).
 * The orchestrator gates every MUTATION on `apply`, so the live mutating methods
 * are not invoked during a dry-run.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from "fs";

import { expandTilde } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import { canonicalJSON } from "../../../common/registry/signing";
import { sealToPrincipal } from "../../../common/crypto/seal-to-principal";
import { mintLeafPsk } from "../../../common/nats/leaf-psk";
import {
  readPidFileDirective,
  resolveHubReloadTarget,
  type NatsProcess,
} from "../../../common/nats/hub-reload-target";
import {
  signClaimWithSeed,
  randomNonce,
  type StackIdentityMaterial,
} from "../../../bus/stack-provisioning";
import { bunExecRunner, type ExecRunner } from "../../../common/nats/nats-service-manager";
import type {
  NetworkSecretPorts,
  HubAuthPort,
  AdmissionLookupPort,
  SealDeliveryPort,
  SecretCrypto,
} from "./network-secret-ports";

/**
 * Enumerate the running nats-server processes (pid + full command line). Used to
 * find the process serving a given hub config when no `pid_file` is declared.
 * Injected so tests assert reload-targeting without spawning `ps`.
 */
export type NatsProcessLister = () => Promise<NatsProcess[]>;

/** Send `signal` (e.g. "SIGHUP") to `pid`. Injected so tests don't kill PIDs. */
export type SignalSender = (pid: number, signal: NodeJS.Signals) => void;

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
    // Match the nats-server binary at the head of the command (path-tolerant).
    if (/(^|\/)nats-server(\s|$)/.test(command)) procs.push({ pid, command });
  }
  return procs;
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
  /** Injectable signal sender (tests). Production omits → process.kill. */
  signal?: SignalSender;
  /** Injectable fetch (tests). Production omits → globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/** Build the full live port bundle. */
export function buildLiveSecretPorts(cfg: LiveSecretPortsConfig): NetworkSecretPorts {
  return {
    hub: buildLiveHubAuthPort(cfg),
    admission: buildLiveAdmissionLookupPort(cfg),
    delivery: buildLiveSealDeliveryPort(cfg),
    crypto: buildLiveSecretCrypto(),
  };
}

// ---------------------------------------------------------------------------
// HUB-LOCAL — hub nats config read/write/reload
// ---------------------------------------------------------------------------

function buildLiveHubAuthPort(cfg: LiveSecretPortsConfig): HubAuthPort {
  const confPath = expandTilde(cfg.hubConfigPath);
  const exec = cfg.exec ?? bunExecRunner;
  const psLister = cfg.psLister ?? bunNatsProcessLister;
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
      // SIGHUP — nats-server applies authorization changes in place, no restart.
      try {
        sendSignal(targetRes.target.pid, "SIGHUP");
      } catch (err) {
        throw new Error(
          `SIGHUP to hub nats-server pid ${targetRes.target.pid.toString()} ` +
            `(resolved via ${targetRes.target.via}) failed: ${err instanceof Error ? err.message : String(err)}`,
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
