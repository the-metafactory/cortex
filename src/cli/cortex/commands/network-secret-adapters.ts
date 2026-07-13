/**
 * ADR-0018 PR5b (#1240) — LIVE adapters for `cortex network secret`.
 *
 * The real side effects the orchestrator (`network-secret-lib.ts`) depends on:
 *   - HUB-LOCAL: read/write the hub nats-server config (chmod 600 — it carries
 *     leaf secrets) + SIGHUP it. A `-c <conf> -t` syntax gate runs first so a
 *     malformed config never reaches a live reload.
 *     CAVEAT (#1528): nats-server does NOT apply leafnode-`authorization`
 *     changes on reload — `getLeafNodeOptionsChanges` rejects any `Users`
 *     change and the server keeps the old auth (server/reload.go:921-941). So
 *     the SIGHUP here applies any OTHER reloadable options but leaves the new/
 *     dropped leaf user pending until the hub is RESTARTED. The orchestrator's
 *     hub-owner-facing steps say so; the caller must not read "reloaded" as
 *     "the authorization change is live".
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

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, mkdtempSync, rmSync } from "fs";
import { resolve as resolvePath, join as joinPath, dirname as pathDirname } from "path";
import { tmpdir } from "os";
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "os";
import { lookup as dnsLookup } from "dns/promises";

import { expandTilde } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
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
  randomNonce,
  signAdminRequest,
  type StackIdentityMaterial,
} from "../../../bus/stack-provisioning";
import { bunExecRunner, type ExecRunner } from "../../../common/nats/nats-service-manager";
import { NetworkCache } from "../../../common/registry/network-cache";
import { resolveNetworkCacheDir } from "../../../common/state-path";
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
  ScopedUserMintPort,
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
    // cortex#1598 — the operator-mode scoped-user mint (arc-backed). Present on
    // the live bundle unconditionally; the operator branch of `addOrRotate` only
    // reaches for it when the network attests hub_mode: operator.
    scopedMint: buildScopedUserMintAdapter(),
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

      // SIGHUP the hub. NOTE (#1528): nats-server does NOT apply leafnode-
      // `authorization` (`Users`) changes on reload — it rejects that reload and
      // keeps the old auth (server/reload.go:921-941). The signal still applies
      // other reloadable options; the new/dropped leaf user takes effect only on
      // a hub RESTART. Callers surface that to the hub owner (see network-secret-lib).
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
  /** `{principal}/{stack}` slash form — the scoped-user stack segment (cortex#1598). */
  stack_id?: string | null;
}

function buildLiveAdmissionLookupPort(cfg: LiveSecretPortsConfig): AdmissionLookupPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async findAdmittedRow(networkId, memberPubkey) {
      // Admin-signed read of the ADMITTED list (x-admin-signed header).
      // cortex#1652 — the claim CARRIES the network scope: the registry's FND-5
      // read gate authorizes a GLOBAL admin with or without it, but a
      // PER-NETWORK admin (#1321) only when the claim names a network they
      // administer — the pre-#1652 unscoped claim 403'd every per-network
      // custodian (the decision-A separated-authorities deployment).
      const claim = {
        admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        network_id: networkId,
      };
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify(signed) },
      });
      if (!resp.ok) {
        throw new Error(`registry admission list failed (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
      const rows = (await resp.json()) as AdmissionRow[];
      const row = rows.find((r) => r.network_id === networkId && r.peer_pubkey === memberPubkey && r.status === "ADMITTED");
      return row
        ? {
            request_id: row.request_id,
            principal_id: row.principal_id,
            ...(typeof row.stack_id === "string" && row.stack_id.length > 0 && { stack_id: row.stack_id }),
          }
        : undefined;
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
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/sealed-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
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
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
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
// cortex#1598 — SCOPED-USER MINT: shell `arc nats add-federated-user` (arc#269),
// read the exported creds text back, hand it to the operator-mode admit seal.
//
// Modeled 1:1 on `network-federation-wiring.ts` (the ADR-0013 sovereign model arc-shell
// pattern): cortex → arc → nsc. Never throws — every failure surfaces as
// `{ ok: false, reason, code }` so the orchestrator can `fail(...)` cleanly.
//
// The verb is on arc MAIN but not yet in a released arc binary (arc#269 merged,
// deploy is a separate step). So an arc that does not know the subcommand
// (exit 127 / unknown-command / a non-`arc.nats.federated-user.v1` envelope) is
// mapped to `code: "ARC_TOO_OLD"` — a clear "run `arc upgrade`" signal, never a
// silent no-op.
// ---------------------------------------------------------------------------

/** Result of one `arc nats add-federated-user` subprocess invocation. */
export interface ArcScopedMintRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Pluggable arc subprocess driver. Receives the FULL argv (`["nats",
 * "add-federated-user", …]`); production prepends `arc` via Bun.spawn. Tests
 * inject a fake to assert the argv and drive success/error envelopes.
 */
export type ArcScopedMintRunner = (argv: readonly string[]) => Promise<ArcScopedMintRunResult>;

async function defaultArcScopedMintRunner(argv: readonly string[]): Promise<ArcScopedMintRunResult> {
  const proc = Bun.spawn(["arc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Module-level runner override — the `__set…ForTests` seam (mirrors the join
 *  leaf-secret fetcher override). Lets tests swap the arc runner used by the
 *  adapter that `buildLiveSecretPorts` wires, without threading a runner arg
 *  through every construction site. */
let scopedMintRunnerOverride: ArcScopedMintRunner | null = null;

/** Test-only — inject a fake arc runner for the scoped-mint adapter. */
export function __setScopedMintRunnerForTests(r: ArcScopedMintRunner | null): void {
  scopedMintRunnerOverride = r;
}

/** Schema arc emits for `nats add-federated-user` (arc#269). Must match arc's
 *  `ARC_NATS_FEDERATED_USER_SCHEMA`; a divergence fails as ARC_TOO_OLD. */
const ARC_NATS_FEDERATED_USER_SCHEMA = "arc.nats.federated-user.v1";

/**
 * The `arc.nats.federated-user.v1` OK envelope — a superset across the
 * add / reissue / revoke verbs (each populates the subset it emits). Fields are
 * optional here so ONE parser serves all three; each caller asserts the fields
 * its verb guarantees.
 */
interface ArcFederatedUserOk {
  schema: typeof ARC_NATS_FEDERATED_USER_SCHEMA;
  ok: true;
  account?: string;
  accountPubKey?: string;
  user?: string;
  /** add: the minted user pubkey. */
  userPubKey?: string;
  /** reissue: the NEW user pubkey. */
  newPubKey?: string;
  /** reissue / revoke: the OLD (revoked) user pubkey. */
  revokedPubKey?: string;
  signingKeyPubKey?: string;
  scopeAlreadyPresent?: boolean;
  userAlreadyPresent?: boolean;
  credsPath?: string;
  jwt?: string;
}

/**
 * Parse arc's `arc.nats.federated-user.v1` JSON envelope from a runner result.
 * A missing / wrong-schema / unparseable line is `ARC_TOO_OLD` (the installed
 * arc predates the verb); an `ok:false` envelope surfaces arc's typed error
 * code. Shared by all three federated-user verbs so the boilerplate can't drift.
 */
function parseFederatedUserEnvelope(
  result: ArcScopedMintRunResult,
  verb: string,
): { ok: true; env: ArcFederatedUserOk } | { ok: false; code: string; reason: string } {
  const line = result.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  let parsed: unknown;
  if (line.length > 0) {
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== ARC_NATS_FEDERATED_USER_SCHEMA
  ) {
    return {
      ok: false,
      code: "ARC_TOO_OLD",
      reason:
        `arc returned no valid '${ARC_NATS_FEDERATED_USER_SCHEMA}' envelope for '${verb}' ` +
        `(the installed arc predates it — arc#269/#270). Run 'arc upgrade'. ` +
        `arc exit ${result.exitCode.toString()}, stderr: ${result.stderr.trim() || "(empty)"}`,
    };
  }
  const env = parsed as { ok?: unknown; error?: unknown };
  if (env.ok !== true) {
    const rawError = env.error;
    const errCode =
      rawError !== null && typeof rawError === "object" && "code" in rawError && typeof (rawError as { code?: unknown }).code === "string"
        ? (rawError as { code: string }).code
        : "(unknown code)";
    const errMsg =
      rawError !== null && typeof rawError === "object" && "message" in rawError && typeof (rawError as { message?: unknown }).message === "string"
        ? (rawError as { message: string }).message
        : "(no message)";
    return { ok: false, code: errCode, reason: `arc nats ${verb} failed: ${errCode}: ${errMsg}` };
  }
  return { ok: true, env: parsed as ArcFederatedUserOk };
}

/**
 * Spawn `arc nats <verb>` once. A spawn throw (ENOENT — arc missing / no such
 * verb) is `ARC_TOO_OLD`. Shared by every federated-user verb so the invoke +
 * arc-missing handling can't drift.
 */
async function invokeArcVerb(
  run: ArcScopedMintRunner,
  argv: readonly string[],
  verb: string,
  networkId: string,
): Promise<{ ok: true; result: ArcScopedMintRunResult } | { ok: false; code: "ARC_TOO_OLD"; reason: string }> {
  try {
    return { ok: true, result: await run(argv) };
  } catch (err) {
    return {
      ok: false,
      code: "ARC_TOO_OLD",
      reason:
        `failed to invoke 'arc nats ${verb}' for network "${networkId}" — ${err instanceof Error ? err.message : String(err)}. ` +
        `Needs an arc that provides '${verb}' (arc#269/#270); run 'arc upgrade'.`,
    };
  }
}

/**
 * Run a federated-user verb that EXPORTS creds to a tmp file, read the creds
 * text back, and remove the tmp dir. Shared by add (mint) + reissue (rotate) —
 * no creds plaintext residue on the admin machine (nsc can re-derive anytime).
 * Returns the parsed OK envelope + the creds text, or a typed error.
 */
async function runCredsExportingVerb(
  run: ArcScopedMintRunner,
  verb: string,
  natsUser: string,
  hubFedAccount: string,
  networkId: string,
): Promise<{ ok: true; env: ArcFederatedUserOk; creds: string } | { ok: false; code: string; reason: string }> {
  const outDir = mkdtempSync(joinPath(tmpdir(), "cortex-scoped-"));
  const outPath = joinPath(outDir, `${natsUser}.creds`);
  try {
    const argv: readonly string[] = ["nats", verb, natsUser, "--account", hubFedAccount, "--output", outPath, "--json"];
    const invoked = await invokeArcVerb(run, argv, verb, networkId);
    if (!invoked.ok) return invoked;
    const parsed = parseFederatedUserEnvelope(invoked.result, verb);
    if (!parsed.ok) return parsed;
    let creds: string;
    try {
      creds = readFileSync(outPath, "utf-8");
    } catch (err) {
      return {
        ok: false,
        code: "OTHER",
        reason: `arc reported a user for "${natsUser}" but its creds file at ${outPath} was unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ok: true, env: parsed.env, creds };
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `cortex network secret: could not remove scoped-mint tmp dir ${outDir} ` +
          `(${err instanceof Error ? err.message : String(err)}) — it may hold a creds file; remove it manually\n`,
      );
    }
  }
}

/** Map an arc federated-user error code to the port's narrower code union. */
function mapArcCode(code: string): "ARC_TOO_OLD" | "USER_NOT_SCOPED" | "USER_NOT_FOUND" | "PUSH_FAILED" | "OTHER" {
  switch (code) {
    case "ARC_TOO_OLD":
      return "ARC_TOO_OLD";
    case "USER_NOT_SCOPED":
      return "USER_NOT_SCOPED";
    case "USER_NOT_FOUND":
      return "USER_NOT_FOUND";
    case "PUSH_FAILED":
    case "REVOKE_FAILED":
      return "PUSH_FAILED";
    default:
      return "OTHER";
  }
}

/**
 * Build the live {@link ScopedUserMintPort} backed by `arc nats add-federated-user`.
 *
 * @param runner - Injectable subprocess driver. Defaults to the module-level
 *   test override when set, else `Bun.spawn(["arc", …])`.
 */
export function buildScopedUserMintAdapter(
  runner?: ArcScopedMintRunner,
): ScopedUserMintPort {
  const pickRun = () => runner ?? scopedMintRunnerOverride ?? defaultArcScopedMintRunner;
  /** Read a string field from arc's OK envelope, or "" if absent. */
  const field = (env: ArcFederatedUserOk, key: keyof ArcFederatedUserOk): string =>
    typeof env[key] === "string" ? (env[key]) : "";
  /** The first REQUIRED field missing / empty on an ok:true envelope, or null.
   *  An `ok:true` envelope that omits a guaranteed field is a contract breach —
   *  fail typed rather than seal a v2 envelope with empty fingerprint data. */
  const firstMissing = (env: ArcFederatedUserOk, keys: (keyof ArcFederatedUserOk)[]): string | null =>
    keys.find((k) => typeof env[k] !== "string" || env[k] === "") ?? null;
  return {
    async mintScopedUser({ hubFedAccount, natsUser, networkId }) {
      const res = await runCredsExportingVerb(pickRun(), "add-federated-user", natsUser, hubFedAccount, networkId);
      if (!res.ok) {
        // mint's port union is narrower (no PUSH_FAILED/USER_NOT_FOUND) — collapse to OTHER.
        const code = res.code === "ARC_TOO_OLD" ? "ARC_TOO_OLD" : res.code === "USER_NOT_SCOPED" ? "USER_NOT_SCOPED" : "OTHER";
        return { ok: false, code, reason: res.reason };
      }
      const missing = firstMissing(res.env, ["userPubKey", "signingKeyPubKey", "accountPubKey"]);
      if (missing !== null || res.creds === "") {
        return { ok: false, code: "OTHER", reason: `arc add-federated-user returned ok but is missing a required field (${missing ?? "creds"})` };
      }
      return {
        ok: true,
        creds: res.creds,
        userPubKey: field(res.env, "userPubKey"),
        signingKeyPubKey: field(res.env, "signingKeyPubKey"),
        accountPubKey: field(res.env, "accountPubKey"),
        scopeAlreadyPresent: res.env.scopeAlreadyPresent === true,
        userAlreadyPresent: res.env.userAlreadyPresent === true,
      };
    },

    async reissueScopedUser({ hubFedAccount, natsUser, networkId }) {
      // cortex#1599 ROTATE — same creds-exporting shape as add, different verb.
      const res = await runCredsExportingVerb(pickRun(), "reissue-federated-user", natsUser, hubFedAccount, networkId);
      if (!res.ok) return { ok: false, code: mapArcCode(res.code), reason: res.reason };
      const missing = firstMissing(res.env, ["newPubKey", "signingKeyPubKey", "accountPubKey", "revokedPubKey"]);
      if (missing !== null || res.creds === "") {
        return { ok: false, code: "OTHER", reason: `arc reissue-federated-user returned ok but is missing a required field (${missing ?? "creds"})` };
      }
      return {
        ok: true,
        creds: res.creds,
        userPubKey: field(res.env, "newPubKey"),
        signingKeyPubKey: field(res.env, "signingKeyPubKey"),
        accountPubKey: field(res.env, "accountPubKey"),
        revokedPubKey: field(res.env, "revokedPubKey"),
      };
    },

    async revokeScopedUser({ hubFedAccount, natsUser, networkId }) {
      // cortex#1599 REVOKE — no creds export; a lean argv + parse.
      const argv: readonly string[] = ["nats", "revoke-federated-user", natsUser, "--account", hubFedAccount, "--json"];
      const invoked = await invokeArcVerb(pickRun(), argv, "revoke-federated-user", networkId);
      if (!invoked.ok) return { ok: false, code: invoked.code, reason: invoked.reason };
      const parsed = parseFederatedUserEnvelope(invoked.result, "revoke-federated-user");
      if (!parsed.ok) {
        // revoke never checks scope, so USER_NOT_SCOPED cannot arise — narrow it to OTHER.
        const c = mapArcCode(parsed.code);
        return { ok: false, code: c === "USER_NOT_SCOPED" ? "OTHER" : c, reason: parsed.reason };
      }
      if (firstMissing(parsed.env, ["revokedPubKey"]) !== null) {
        return { ok: false, code: "OTHER", reason: `arc revoke-federated-user returned ok but is missing revokedPubKey` };
      }
      return { ok: true, revokedPubKey: field(parsed.env, "revokedPubKey") };
    },
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
    new NetworkCache({ cacheDir: resolveNetworkCacheDir() });
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
      // cortex#1652 (the ADR-0020 fast-follow) — the claim carries the network
      // scope, so a PER-NETWORK admin (#1321) of `networkId` is authorized by
      // the FND-5 read gate; a global admin's read narrows to the same network.
      const claim = {
        admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        network_id: networkId,
      };
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests?status=ADMITTED`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": JSON.stringify(signed) },
      });
      if (resp.status === 403) {
        throw new Error(
          `registry refused the ADMITTED list (HTTP 403 admin_not_authorized): the signing seed is ` +
            `neither a GLOBAL registry admin nor a per-network admin of "${networkId}" (#1321). ` +
            `Use a seed on one of those allowlists.`,
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
  // FS-7 (cortex#1839) — whole-config validate-on-write. For a MONOLITH (single-
  // file) hub config, `path` IS the whole config, so we can point the boot
  // validator straight at it. For a config-split hub, `path` is the `stacks/*.yaml`
  // that holds `policy.federated.networks`; composing the whole needs the POINTER,
  // which is not threaded to this hub-key store — so we fall back to the scoped
  // payload_key + round-trip guard there (rotate-key only advances the K fields,
  // which that guard already validates; it never touches whole-config fields like
  // accept_subjects). The single-file case (JC's deployment) gets the full check.
  const isConfigSplit = existsSync(joinPath(pathDirname(path), "system", "system.yaml"));
  return {
    configPath: path,
    readNetworks() {
      return Promise.resolve(readNetworksFromConfig(path));
    },
    writeNetworks(networks) {
      // The SAME offer.ts write-guard Slice 1 added (validate → backup → atomic →
      // verify → restore → chmod 600). NO daemon-loads assertion — rotate-key is
      // the hub admin editing their OWN stack config; they restart the daemon.
      writeNetworksGuarded(path, networks, {
        backupLabel: "rotate-key",
        ...(isConfigSplit ? {} : { validateComposePath: path }),
      });
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
