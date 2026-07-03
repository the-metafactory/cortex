/**
 * #1317 / #1396 — live HubAuthPort reload-targeting tests.
 *
 * The #1317 bug: the reload shelled out to a BARE `nats-server --signal reload`,
 * which refuses when >1 nats-server runs (the normal multi-stack state). These
 * tests drive the LIVE adapter's `reload()` with injected exec / process-lister /
 * inspector / signal seams + a real temp hub config, and assert it targets the
 * SPECIFIC hub PID:
 *   - config-path match: SIGHUP goes to the one nats-server loading THIS conf,
 *     amongst several
 *   - pid_file declared: SIGHUP goes to the pid_file's PID (no process scan)
 *   - no match: reload throws (never signals a wrong server)
 *
 * The #1396 trust-path hardening: before signalling, the adapter re-reads the
 * target PID's LIVE argv and refuses unless it is still a nats-server serving
 * THIS config. The invariant under test — **never signal an unverified PID**:
 *   - pid_file points at a live-but-NON-nats process → fail loud, no signal
 *   - pid_file points at a nats-server for a DIFFERENT config → fail loud
 *   - target PID no longer exists (recycled/exited) → fail loud
 *   - argv matches → signals exactly once
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";
import { buildLiveSecretPorts, type NatsProcessInspector } from "../network-secret-adapters";
import type { NatsProcess } from "../../../../common/nats/hub-reload-target";
import { materialFromSeedString } from "../../../../bus/stack-provisioning";
import { NetworkCache } from "../../../../common/registry/network-cache";
import type { NetworkDescriptor, NetworkRosterResult } from "../../../../common/registry/types";

let tmp: string;
let hubConf: string;

function material() {
  return materialFromSeedString(new TextDecoder().decode(createUser().getSeed()));
}

// A gate exec that always passes (nats-server -c <conf> -t → code 0).
const passingGate = async () => ({ code: 0, stderr: "" });

/**
 * Build a per-PID argv inspector from a pid→command map — the #1396 re-check
 * seam. A PID absent from the map reads as "no such process" (undefined), which
 * the adapter treats as a fail-loud (the PID exited / was recycled).
 */
function inspectorFrom(map: Record<number, string>): NatsProcessInspector {
  return async (pid) => (pid in map ? map[pid] : undefined);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "secret-adapter-"));
  hubConf = join(tmp, "local.conf");
  writeFileSync(hubConf, "leafnodes {\n  listen: 0.0.0.0:7422\n}\n", { mode: 0o600 });
  chmodSync(hubConf, 0o600);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("reload targeting — config-path match", () => {
  test("SIGHUPs the one nats-server serving THIS config amongst several", async () => {
    const signalled: { pid: number; sig: string }[] = [];
    const processes: NatsProcess[] = [
      { pid: 2264, command: `nats-server -c ${join(tmp, "community.conf")} -js` },
      { pid: 2265, command: `nats-server -c ${hubConf} -js` },
      { pid: 2266, command: `nats-server -c ${join(tmp, "halden.conf")} -js` },
    ];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => processes,
      // Re-check reads the target's live argv — still the hub's nats-server.
      inspect: inspectorFrom({ 2265: `nats-server -c ${hubConf} -js` }),
      signal: (pid, sig) => signalled.push({ pid, sig }),
    });

    await ports.hub.reload();
    expect(signalled).toEqual([{ pid: 2265, sig: "SIGHUP" }]);
  });

  test("no nats-server serving this config → reload throws (no wrong signal)", async () => {
    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [{ pid: 1, command: `nats-server -c ${join(tmp, "other.conf")}` }],
      inspect: inspectorFrom({}),
      signal: (pid) => signalled.push(pid),
    });

    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/could not target the hub reload/);
    expect(signalled.length).toBe(0);
  });
});

describe("reload targeting — pid_file declared", () => {
  test("SIGHUPs the pid_file's PID without scanning processes", async () => {
    const pidFile = join(tmp, "nats.pid");
    writeFileSync(pidFile, "8123\n");
    writeFileSync(hubConf, `pid_file: "${pidFile}"\nleafnodes {\n  listen: 0.0.0.0:7422\n}\n`, { mode: 0o600 });

    const signalled: { pid: number; sig: string }[] = [];
    let listerCalled = false;
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => {
        listerCalled = true;
        return [];
      },
      // The pid_file's PID re-checks as the hub's nats-server → signalled.
      inspect: inspectorFrom({ 8123: `nats-server -c ${hubConf} -js` }),
      signal: (pid, sig) => signalled.push({ pid, sig }),
    });

    await ports.hub.reload();
    expect(signalled).toEqual([{ pid: 8123, sig: "SIGHUP" }]);
    // pid_file is authoritative for RESOLUTION — we must NOT have scanned the
    // process list. (The argv re-check inspects only that one PID, not the list.)
    expect(listerCalled).toBe(false);
  });

  test("pid_file declared but missing on disk → falls back to process match", async () => {
    writeFileSync(hubConf, `pid_file: "${join(tmp, "absent.pid")}"\nleafnodes {}\n`, { mode: 0o600 });
    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [{ pid: 555, command: `nats-server -c ${hubConf}` }],
      inspect: inspectorFrom({ 555: `nats-server -c ${hubConf}` }),
      signal: (pid) => signalled.push(pid),
    });
    await ports.hub.reload();
    expect(signalled).toEqual([555]);
  });
});

describe("reload — #1396 trust-path: never signal an unverified PID", () => {
  test("pid_file points at a live-but-NON-nats process → fail loud, no signal", async () => {
    // Stale pid_file: the hub crashed, its PID (8123) was recycled onto an
    // unrelated process. The blind path would SIGHUP-terminate it; the re-check
    // must refuse.
    const pidFile = join(tmp, "nats.pid");
    writeFileSync(pidFile, "8123\n");
    writeFileSync(hubConf, `pid_file: "${pidFile}"\nleafnodes {}\n`, { mode: 0o600 });

    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [],
      inspect: inspectorFrom({ 8123: "/usr/bin/postgres -D /var/lib/pg" }),
      signal: (pid) => signalled.push(pid),
    });

    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/refusing to SIGHUP pid 8123/);
    expect(String(err)).toMatch(/pid_file/);
    expect(signalled.length).toBe(0);
  });

  test("pid_file points at a nats-server for a DIFFERENT config → fail loud, no signal", async () => {
    const pidFile = join(tmp, "nats.pid");
    writeFileSync(pidFile, "8123\n");
    writeFileSync(hubConf, `pid_file: "${pidFile}"\nleafnodes {}\n`, { mode: 0o600 });

    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [],
      // A real nats-server — but serving a DIFFERENT config. Must not be signalled.
      inspect: inspectorFrom({ 8123: `nats-server -c ${join(tmp, "other.conf")} -js` }),
      signal: (pid) => signalled.push(pid),
    });

    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/refusing to SIGHUP pid 8123/);
    expect(signalled.length).toBe(0);
  });

  test("config-match target exits before signal (recycled/gone) → fail loud, no signal", async () => {
    // config-match found pid 2265, but between enumeration and signal it exited —
    // the inspector reports no such process. The TOCTOU re-check must refuse.
    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [{ pid: 2265, command: `nats-server -c ${hubConf} -js` }],
      inspect: inspectorFrom({}), // 2265 no longer alive
      signal: (pid) => signalled.push(pid),
    });

    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/refusing to SIGHUP pid 2265/);
    expect(String(err)).toMatch(/<no such process>/);
    expect(signalled.length).toBe(0);
  });
});

describe("reload — signal-throw (EPERM) fails loud", () => {
  test("a throwing signal sender is wrapped + rethrown, naming pid + via", async () => {
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: passingGate,
      psLister: async () => [{ pid: 2265, command: `nats-server -c ${hubConf} -js` }],
      inspect: inspectorFrom({ 2265: `nats-server -c ${hubConf} -js` }),
      signal: () => {
        throw new Error("kill EPERM");
      },
    });

    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/SIGHUP to hub nats-server pid 2265/);
    expect(String(err)).toMatch(/via config-match/);
    expect(String(err)).toMatch(/EPERM/);
  });
});

describe("reload — gate failure still gates", () => {
  test("a failing -t syntax gate aborts the reload (no signal)", async () => {
    const signalled: number[] = [];
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      exec: async () => ({ code: 1, stderr: "parse error" }),
      psLister: async () => [{ pid: 1, command: `nats-server -c ${hubConf}` }],
      signal: (pid) => signalled.push(pid),
    });
    let err: unknown;
    try {
      await ports.hub.reload();
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/-t exited 1/);
    expect(signalled.length).toBe(0);
  });
});

// =============================================================================
// cortex#1481 — LIVE HubLocalityPort: reads the SAME DD-10 network-cache file
// `cortex network join` writes (read-only, local disk — never a live registry
// round trip), + an injectable hostname. Both are hermetic (tmp cache dir,
// fake hostname) — never the developer's real ~/.config/cortex or real host.
// =============================================================================
describe("buildLiveHubLocalityPort (via buildLiveSecretPorts)", () => {
  function fakeDescriptor(networkId: string, hubUrl: string): NetworkDescriptor {
    return { network_id: networkId, hub_url: hubUrl, leaf_port: 7422, members: [] };
  }
  function fakeRoster(networkId: string): NetworkRosterResult {
    return { network_id: networkId, members: [] };
  }

  test("resolveHubUrl reads the cached descriptor's hub_url written by `network join`", async () => {
    const cacheDir = mkdtempSync(join(tmp, "netcache-"));
    const cache = new NetworkCache({ cacheDir });
    cache.store("metafactory", fakeDescriptor("metafactory", "tls://andreas-vm.example.com:7422"), fakeRoster("metafactory"));

    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      networkCache: cache,
      hostname: () => "jc-laptop.local",
    });

    await expect(ports.hubLocality.resolveHubUrl("metafactory")).resolves.toBe("tls://andreas-vm.example.com:7422");
    expect(ports.hubLocality.localHostname()).toBe("jc-laptop.local");
  });

  test("resolveHubUrl resolves undefined when nothing is cached for the network (fail-safe upstream)", async () => {
    const cacheDir = mkdtempSync(join(tmp, "netcache-empty-"));
    const cache = new NetworkCache({ cacheDir });

    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      networkCache: cache,
      hostname: () => "jc-laptop.local",
    });

    await expect(ports.hubLocality.resolveHubUrl("never-joined")).resolves.toBeUndefined();
  });

  test("localHostname defaults to the injected os.hostname() when not overridden", () => {
    const cacheDir = mkdtempSync(join(tmp, "netcache-hn-"));
    const ports = buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      networkCache: new NetworkCache({ cacheDir }),
    });
    // Whatever the real machine's hostname is — just prove it's a non-empty string
    // and that the port doesn't hard-fail without an injected override.
    expect(typeof ports.hubLocality.localHostname()).toBe("string");
    expect(ports.hubLocality.localHostname().length).toBeGreaterThan(0);
  });

  // Sage review Important 2 — the DNS→local-interface probe, with injected fake
  // resolver + interface lister (no real DNS / NIC read).
  function portsWith(opts: {
    resolveHostAddresses: (host: string) => Promise<string[]>;
    localInterfaceAddresses: () => string[];
  }) {
    return buildLiveSecretPorts({
      hubConfigPath: hubConf,
      registryUrl: "http://127.0.0.1:0",
      material: material(),
      networkCache: new NetworkCache({ cacheDir: mkdtempSync(join(tmp, "netcache-iface-")) }),
      hostname: () => "macjcf",
      resolveHostAddresses: opts.resolveHostAddresses,
      localInterfaceAddresses: opts.localInterfaceAddresses,
    });
  }

  test("hubHostIsLocalInterface → true when the hub FQDN resolves to a local NIC address", async () => {
    const ports = portsWith({
      resolveHostAddresses: async () => ["203.0.113.7", "192.168.1.42"],
      localInterfaceAddresses: () => ["127.0.0.1", "192.168.1.42", "::1"],
    });
    await expect(ports.hubLocality.hubHostIsLocalInterface("tls://nats.meta-factory.dev:7422")).resolves.toBe(true);
  });

  test("hubHostIsLocalInterface → false when the hub FQDN resolves to a NON-local address", async () => {
    const ports = portsWith({
      resolveHostAddresses: async () => ["203.0.113.7"],
      localInterfaceAddresses: () => ["127.0.0.1", "192.168.1.42"],
    });
    await expect(ports.hubLocality.hubHostIsLocalInterface("tls://nats.meta-factory.dev:7422")).resolves.toBe(false);
  });

  test("hubHostIsLocalInterface → false (fail-safe) when DNS resolution throws, never rethrows", async () => {
    const ports = portsWith({
      resolveHostAddresses: async () => { throw new Error("ENOTFOUND (fake)"); },
      localInterfaceAddresses: () => ["127.0.0.1"],
    });
    await expect(ports.hubLocality.hubHostIsLocalInterface("tls://nats.meta-factory.dev:7422")).resolves.toBe(false);
  });

  test("hubHostIsLocalInterface → false for an unparseable hub_url (never calls the resolver)", async () => {
    let resolverCalled = false;
    const ports = portsWith({
      resolveHostAddresses: async () => { resolverCalled = true; return []; },
      localInterfaceAddresses: () => ["127.0.0.1"],
    });
    await expect(ports.hubLocality.hubHostIsLocalInterface("not a url :::")).resolves.toBe(false);
    expect(resolverCalled).toBe(false);
  });
});
