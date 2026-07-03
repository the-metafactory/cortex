/**
 * C-1355 — E2E lifecycle integration guard: shared harness.
 *
 * Everything the scripted walkthrough needs to run FULLY IN-PROCESS:
 *
 *   - a LOCAL in-process network-registry (the real Hono `app` from
 *     `src/services/network-registry/src/index.ts` with the in-memory store —
 *     NO Cloudflare, NO D1, NO network I/O);
 *   - a `globalThis.fetch` router that forwards every request aimed at the
 *     registry base URL into `app.fetch(req, env)` so the REAL CLI code paths
 *     (`dispatchNetwork` / `dispatchProvisionStack` → `globalThis.fetch`) hit
 *     the in-process registry instead of the wire. Any fetch to a NON-registry
 *     URL throws — the suite must never touch the network;
 *   - a recording HUB-reload port that stands in for the multi-nats hub reload
 *     (`network-secret-adapters.ts:87-107`, the seam #1317 owns). It captures the
 *     hub config in memory and counts reloads instead of SIGHUP-ing a live
 *     nats-server;
 *   - temp-dir config trees (pattern: PR #1343 stack-signing-boot isolation).
 *
 * The registry's module-scoped singletons (store, nonce cache, derived pubkey,
 * rate-limit buckets) are reset between runs via {@link resetRegistry}, which
 * delegates to the registry's own exported `resetStores()`
 * (`src/services/network-registry/__tests__/helpers.ts`) — the single source of
 * truth for that reset list.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import app, { type Env } from "../../../../../services/network-registry/src/index";
import { generateKeypair } from "../../../../../services/network-registry/src/signing";
import { resetStores } from "../../../../../services/network-registry/__tests__/helpers";
import type { HubAuthPort } from "../../network-secret-ports";
import type {
  NetworkPorts,
  ConfigStorePort,
  DaemonPort,
  NetworkRegistryPort,
  LeafFilePort,
  PlistPort,
} from "../../network-ports";
import type { PolicyFederatedNetwork } from "../../../../../common/types/cortex-config";

export type { Env };

/** The in-process registry base URL. Host is irrelevant (the app routes on the
 * path only); a loopback high port keeps it visibly "local" + un-routable. */
export const REGISTRY_BASE = "http://127.0.0.1:18771";

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

/**
 * Reset EVERY module-scoped registry singleton so a run starts from a clean
 * store. Delegates to the registry's own exported `resetStores()` instead of
 * re-listing the `_set*` / `_reset*` hooks here, so a newly-added registry
 * singleton is picked up automatically rather than silently drifting out of a
 * hand-maintained copy (which would leak state between runs in the exact suite
 * meant to catch regressions).
 */
export function resetRegistry(): void {
  resetStores();
}

/**
 * Build a fresh registry `Env`. `adminPubkeys` seeds `REGISTRY_ADMIN_PUBKEYS`
 * (the network-create + admit + admin-read allowlist). The hub-admin write gate
 * (sealed-secret / revoke) FALLS BACK to `REGISTRY_ADMIN_PUBKEYS` when
 * `REGISTRY_HUB_ADMIN_PUBKEYS` is unset (the Q5 "one principal is both
 * authorities" collapse — see `admission-requests.ts` `parseHubAdminPubkeys`),
 * so a single admin identity drives create + admit + seal + revoke in this guard.
 */
export async function makeRegistryEnv(adminPubkeys: string[]): Promise<Env> {
  const reg = await generateKeypair();
  return {
    REGISTRY_SIGNING_KEY: reg.privateKeyB64,
    REGISTRY_PUBLIC_KEY: reg.publicKeyB64,
    REGISTRY_ADMIN_PUBKEYS: adminPubkeys.join(","),
    ENVIRONMENT: "test",
  };
}

/**
 * Route `globalThis.fetch` into the in-process registry `app` for any request
 * whose URL starts with {@link REGISTRY_BASE}; throw on anything else. Returns a
 * restore function — call it in `afterAll`/`afterEach`.
 */
export function installRegistryFetchRouter(env: Env): () => void {
  const real = globalThis.fetch;
  const routed = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.startsWith(REGISTRY_BASE)) {
      const req = input instanceof Request ? input : new Request(url, init);
      return app.fetch(req, env);
    }
    throw new Error(
      `e2e-lifecycle: blocked an external fetch to ${url} — the lifecycle guard must stay ` +
        `fully in-process (registry base ${REGISTRY_BASE}). No network I/O is permitted.`,
    );
  }) as typeof globalThis.fetch;
  globalThis.fetch = routed;
  return () => {
    globalThis.fetch = real;
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// ---------------------------------------------------------------------------
// Recording HUB-reload port (the STUB seam — network-secret-adapters.ts:87-107)
// ---------------------------------------------------------------------------

/** A `HubAuthPort` that keeps the hub config in memory and COUNTS reloads
 * instead of SIGHUP-ing a live nats-server. This is the exact port #1317 will
 * make target the real multi-nats hub; here we assert it is EXERCISED. */
export interface RecordingHubPort extends HubAuthPort {
  /** How many times `reload()` was invoked. */
  reloads: number;
  /** Every text written via `writeConf`, in order. */
  writes: string[];
  /** The current in-memory hub config. */
  conf: string;
}

export function makeRecordingHubPort(initialConf = ""): RecordingHubPort {
  const port: RecordingHubPort = {
    // A path string for plan/report output only — never read/written on disk.
    confPath: "<stubbed hub nats-server config — in-memory, not a real file>",
    reloads: 0,
    writes: [],
    conf: initialConf,
    readConf(): Promise<string> {
      return Promise.resolve(port.conf);
    },
    writeConf(text: string): Promise<void> {
      port.conf = text;
      port.writes.push(text);
      return Promise.resolve();
    },
    reload(): Promise<void> {
      port.reloads += 1;
      return Promise.resolve();
    },
  };
  return port;
}

// ---------------------------------------------------------------------------
// Temp-dir management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

/** Make a fresh temp dir tracked for teardown. */
export function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Remove every tracked temp dir. Call in `afterAll`. */
export function cleanupDirs(): void {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// leaveNetwork ports — the DAEMON-RESTART stub + an in-memory config store.
// ---------------------------------------------------------------------------

/** What a driven `leaveNetwork(...)` did, for assertions. */
export interface LeavePortsHandle {
  ports: NetworkPorts;
  /** Live daemon-restart count (the stubbed launchctl kickstart). */
  counters: { restarts: number };
  /** Each `configStore.writeNetworks(...)` payload, in order. */
  writes: PolicyFederatedNetwork[][];
  /** Network ids whose `include` directive + leaf file were removed. */
  removedIncludes: string[];
  removedFiles: string[];
  /** The live in-memory `policy.federated.networks[]`. */
  current: () => PolicyFederatedNetwork[];
}

/**
 * Build a `NetworkPorts` bundle for driving the REAL `leaveNetwork` orchestrator
 * with an in-memory config store + a STUBBED daemon restart (the seam the issue
 * calls out — no launchctl, no nats-server). Only the ports `leaveNetwork`
 * actually touches are real; the join-only surface (bind-mode, operator-mode
 * conversion, nats-server restart) is a typed no-op — leave never calls it.
 */
export function makeLeaveNetworkPorts(initial: PolicyFederatedNetwork[]): LeavePortsHandle {
  let networks = [...initial];
  const counters = { restarts: 0 };
  const writes: PolicyFederatedNetwork[][] = [];
  const removedIncludes: string[] = [];
  const removedFiles: string[] = [];

  const configStore: ConfigStorePort = {
    readNetworks: () => [...networks],
    writeNetworks: (next) => {
      networks = [...next];
      writes.push([...next]);
    },
  };
  const daemon: DaemonPort = {
    restart: () => {
      counters.restarts += 1;
      return Promise.resolve({ ok: true as const });
    },
  };
  // Only `deregisterFromNetwork` + `departFromNetwork` are called by leave; the
  // join-side registry methods are never reached, so a partial + cast keeps the
  // fake small.
  const registry = {
    deregisterFromNetwork: () => Promise.resolve({ ok: true as const, note: "test no-op" }),
    departFromNetwork: () => Promise.resolve({ ok: true as const, note: "test no-op" }),
  } as unknown as NetworkRegistryPort;
  // Leave calls only removeInclude / remove / list.
  const leafFile = {
    removeInclude: (id: string) => {
      removedIncludes.push(id);
    },
    remove: (id: string) => {
      removedFiles.push(id);
    },
    list: (): string[] => [],
  } as unknown as LeafFilePort;
  const plist = {} as unknown as PlistPort;

  const ports: NetworkPorts = { registry, leafFile, plist, configStore, daemon };
  return {
    ports,
    counters,
    writes,
    removedIncludes,
    removedFiles,
    current: () => [...networks],
  };
}
