/**
 * #1317 — `resolveHubReloadTarget` + `readPidFileDirective` unit tests.
 *
 * The reload must target the SPECIFIC hub serving THIS config, never a bare
 * signal. Proves:
 *   - pid_file (when declared + readable) wins
 *   - config-path match picks the right PID amongst many nats-servers
 *   - zero / ambiguous matches fail LOUDLY (never signal a wrong server)
 *   - the pid_file directive parser tolerates HOCON spelling variants
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import {
  readPidFileDirective,
  resolveHubReloadTarget,
  type NatsProcess,
} from "../hub-reload-target";

const HUB = "/Users/op/.config/nats/local.conf";
const OTHER1 = "/Users/op/.config/nats/community.conf";
const OTHER2 = "/Users/op/.config/nats/halden.conf";

function proc(pid: number, configPath: string, extra = "-js"): NatsProcess {
  return { pid, command: `nats-server -c ${configPath} ${extra}` };
}

describe("resolveHubReloadTarget — pid_file path", () => {
  test("a valid pid_file PID wins, processes ignored", () => {
    const res = resolveHubReloadTarget(HUB, 4242, [proc(1, OTHER1)]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.target.pid).toBe(4242);
      expect(res.target.via).toBe("pid_file");
    }
  });

  test("an invalid pid_file PID fails (never falls through to a wrong match)", () => {
    const res = resolveHubReloadTarget(HUB, 0, [proc(7, HUB)]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("invalid PID");
  });
});

describe("resolveHubReloadTarget — config-path match (the multi-stack case)", () => {
  test("picks the single nats-server loading THIS config amongst many", () => {
    // The exact failure scenario from the bug: three nats-servers running.
    const processes = [proc(2264, OTHER1), proc(2265, HUB), proc(2266, OTHER2)];
    const res = resolveHubReloadTarget(HUB, undefined, processes);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.target.pid).toBe(2265);
      expect(res.target.via).toBe("config-match");
    }
  });

  test("matches --config=<path> fused form too", () => {
    const processes: NatsProcess[] = [
      { pid: 10, command: `nats-server --config=${HUB} -js` },
      { pid: 11, command: `nats-server --config=${OTHER1}` },
    ];
    const res = resolveHubReloadTarget(HUB, undefined, processes);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.target.pid).toBe(10);
  });

  test("resolves relative vs absolute config paths to the same target", () => {
    const rel = "./local.conf";
    const abs = resolve(rel);
    const res = resolveHubReloadTarget(abs, undefined, [proc(99, rel)]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.target.pid).toBe(99);
  });

  test("ZERO matches fails loudly (hub not running under this config)", () => {
    const res = resolveHubReloadTarget(HUB, undefined, [proc(1, OTHER1), proc(2, OTHER2)]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("no running nats-server");
      expect(res.reason).toContain(resolve(HUB));
    }
  });

  test("AMBIGUOUS (2+ matches) fails loudly, names the PIDs", () => {
    const res = resolveHubReloadTarget(HUB, undefined, [proc(3, HUB), proc(4, HUB)]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("ambiguous");
      expect(res.reason).toContain("3, 4");
    }
  });

  test("does NOT match a server whose config merely contains the name as a substring", () => {
    // `local.conf.bak` must not match `local.conf`.
    const res = resolveHubReloadTarget(HUB, undefined, [proc(5, `${HUB}.bak`)]);
    expect(res.ok).toBe(false);
  });
});

describe("readPidFileDirective", () => {
  test("colon form, quoted", () => {
    expect(readPidFileDirective(`pid_file: "/var/run/nats.pid"\nlisten: 0.0.0.0:4222\n`)).toBe(
      "/var/run/nats.pid",
    );
  });
  test("equals form, unquoted", () => {
    expect(readPidFileDirective(`pid_file = /run/nats.pid\n`)).toBe("/run/nats.pid");
  });
  test("single-quoted", () => {
    expect(readPidFileDirective(`  pid_file: '/run/x.pid'`)).toBe("/run/x.pid");
  });
  test("absent → undefined", () => {
    expect(readPidFileDirective(`listen: 0.0.0.0:4222\n`)).toBeUndefined();
  });
  test("does not false-match a key that merely ends in pid_file-ish text", () => {
    // A commented or differently-named key must not be picked up.
    expect(readPidFileDirective(`# my_pid_file_note: nope\nlisten: x\n`)).toBeUndefined();
  });
});
