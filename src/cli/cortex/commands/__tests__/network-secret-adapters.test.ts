/**
 * #1317 — live HubAuthPort reload-targeting tests.
 *
 * The bug: the reload shelled out to a BARE `nats-server --signal reload`, which
 * refuses when >1 nats-server runs (the normal multi-stack state). These tests
 * drive the LIVE adapter's `reload()` with injected exec / process-lister /
 * signal seams + a real temp hub config, and assert it targets the SPECIFIC
 * hub PID:
 *   - config-path match: SIGHUP goes to the one nats-server loading THIS conf,
 *     amongst several
 *   - pid_file declared: SIGHUP goes to the pid_file's PID (no process scan)
 *   - no match: reload throws (never signals a wrong server)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";
import { buildLiveSecretPorts } from "../network-secret-adapters";
import type { NatsProcess } from "../../../../common/nats/hub-reload-target";
import { materialFromSeedString } from "../../../../bus/stack-provisioning";

let tmp: string;
let hubConf: string;

function material() {
  return materialFromSeedString(new TextDecoder().decode(createUser().getSeed()));
}

// A gate exec that always passes (nats-server -c <conf> -t → code 0).
const passingGate = async () => ({ code: 0, stderr: "" });

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
      signal: (pid, sig) => signalled.push({ pid, sig }),
    });

    await ports.hub.reload();
    expect(signalled).toEqual([{ pid: 8123, sig: "SIGHUP" }]);
    // pid_file is authoritative — we must NOT have scanned the process list.
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
      signal: (pid) => signalled.push(pid),
    });
    await ports.hub.reload();
    expect(signalled).toEqual([555]);
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
