/**
 * #763 — `NatsServiceManager` tests: the launchd/systemd abstraction the
 * `cortex network join` adapters select on by platform/descriptor.
 *
 * Two implementations behind one seam:
 *   - launchd (macOS): ensure the nats-server plist `ProgramArguments` carry
 *     `-c <config>`, restart via `launchctl kickstart -k gui/<uid>/<label>`.
 *   - systemd (Linux): ensure the unit `[Service] ExecStart=` carries
 *     `-c <config>`, restart via `systemctl [--user] restart <unit>`.
 *
 * These tests write real temp descriptor files (a sample `.plist` + a sample
 * `.service` unit) and assert on the rewritten file bytes + the restart command
 * the manager WOULD run (captured via an injected exec, never a real
 * launchctl/systemctl). They cover: systemd ExecStart ensure (add / no-op /
 * repoint), launchd path unchanged (regression), platform/descriptor selection,
 * dry-run execs nothing, and the clear-error mismatch cases (plist-on-Linux /
 * unit-on-macOS).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  selectNatsServiceManager,
  type ExecRunner,
  type ExecResult,
} from "../nats-service-manager";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "s763-svcmgr-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const NATS_CONFIG = "/home/jc/.config/nats/local.conf";
const NATS_BIN = "/usr/bin/nats-server";

function barePlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    "\t<string>homebrew.mxcl.nats-server</string>",
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    "\t\t<string>/opt/homebrew/bin/nats-server</string>",
    "\t\t<string>-js</string>",
    "\t</array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function bareUnit(): string {
  return [
    "[Unit]",
    "Description=NATS Server",
    "",
    "[Service]",
    `ExecStart=${NATS_BIN} -js`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** A capturing exec runner — records argv, returns a success by default. */
function capturingExec(): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExecRunner = async (argv: string[]): Promise<ExecResult> => {
    calls.push(argv);
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

// =============================================================================
// systemd — ExecStart ensure (live write) + restart command
// =============================================================================

describe("systemd manager — ExecStart ensure-config-arg (live)", () => {
  test("ensureConfigLoaded adds -c <config> to the unit ExecStart", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");

    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: capturingExec().runner,
    });
    mgr.ensureConfigLoaded(NATS_CONFIG);

    const after = readFileSync(unitPath, "utf-8");
    expect(after).toContain(`ExecStart=${NATS_BIN} -js -c ${NATS_CONFIG}`);
  });

  test("ensureConfigLoaded is a byte-stable no-op when already present", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    const already = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c ${NATS_CONFIG}`,
    );
    writeFileSync(unitPath, already, "utf-8");

    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: capturingExec().runner,
    });
    mgr.ensureConfigLoaded(NATS_CONFIG);

    expect(readFileSync(unitPath, "utf-8")).toBe(already);
  });

  test("dropConfigArg removes the -c arg from the unit ExecStart", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    const withArg = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c ${NATS_CONFIG}`,
    );
    writeFileSync(unitPath, withArg, "utf-8");

    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: capturingExec().runner,
    });
    mgr.dropConfigArg(NATS_CONFIG);

    const after = readFileSync(unitPath, "utf-8");
    expect(after).toContain(`ExecStart=${NATS_BIN} -js`);
    expect(after).not.toContain(`-c ${NATS_CONFIG}`);
  });

  test("restart runs `systemctl --user restart <unit>` for a user-scope unit", async () => {
    const dir = freshDir();
    // A path under a `systemd/user/` dir → user scope.
    const userDir = join(dir, "systemd", "user");
    rmSync(userDir, { recursive: true, force: true });
    const fs = await import("fs");
    fs.mkdirSync(userDir, { recursive: true });
    const unitPath = join(userDir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");

    const { runner, calls } = capturingExec();
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: runner,
    });
    const res = await mgr.restart();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["systemctl", "--user", "restart", "nats-server.service"]);
  });

  test("restart runs system-scope `systemctl restart <unit>` for a /etc/systemd/system unit", async () => {
    const dir = freshDir();
    const sysDir = join(dir, "etc", "systemd", "system");
    const fs = await import("fs");
    fs.mkdirSync(sysDir, { recursive: true });
    const unitPath = join(sysDir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");

    const { runner, calls } = capturingExec();
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: runner,
    });
    await mgr.restart();
    expect(calls[0]).toEqual(["systemctl", "restart", "nats-server.service"]);
  });

  test("restart surfaces a non-zero systemctl exit as { ok: false }", async () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");

    const failing: ExecRunner = async () => ({ code: 5, stderr: "Failed to restart" });
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: true,
      exec: failing,
    });
    const res = await mgr.restart();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Failed to restart");
  });
});

// =============================================================================
// launchd — regression: behavior unchanged
// =============================================================================

describe("launchd manager — plist path unchanged (regression)", () => {
  test("ensureConfigLoaded appends -c <config> to ProgramArguments", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");

    const mgr = selectNatsServiceManager({
      descriptorPath: plistPath,
      platform: "darwin",
      mutate: true,
      exec: capturingExec().runner,
    });
    mgr.ensureConfigLoaded(NATS_CONFIG);

    const after = readFileSync(plistPath, "utf-8");
    expect(after).toContain("<string>-c</string>");
    expect(after).toContain(`<string>${NATS_CONFIG}</string>`);
  });

  test("restart runs `launchctl kickstart -k gui/<uid>/<label>` reading the plist Label", async () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");

    const { runner, calls } = capturingExec();
    const mgr = selectNatsServiceManager({
      descriptorPath: plistPath,
      platform: "darwin",
      mutate: true,
      exec: runner,
      uid: 501,
    });
    const res = await mgr.restart();
    expect(res.ok).toBe(true);
    expect(calls[0]?.[0]).toBe("launchctl");
    expect(calls[0]).toContain("kickstart");
    expect(calls[0]?.join(" ")).toContain("gui/501/homebrew.mxcl.nats-server");
  });
});

// =============================================================================
// selection — platform/descriptor picks the right manager + clear mismatch errors
// =============================================================================

describe("selectNatsServiceManager — platform/descriptor selection", () => {
  test("a .service descriptor on linux selects the systemd manager", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: false,
      exec: capturingExec().runner,
    });
    expect(mgr.kind).toBe("systemd");
  });

  test("a .plist descriptor on darwin selects the launchd manager", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");
    const mgr = selectNatsServiceManager({
      descriptorPath: plistPath,
      platform: "darwin",
      mutate: false,
      exec: capturingExec().runner,
    });
    expect(mgr.kind).toBe("launchd");
  });

  test("a plist descriptor on LINUX is a clear error (no cryptic ProgramArguments-empty)", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");
    expect(() =>
      selectNatsServiceManager({
        descriptorPath: plistPath,
        platform: "linux",
        mutate: false,
        exec: capturingExec().runner,
      }),
    ).toThrow(/launchd plist.*Linux|plist.*systemd|does not match/i);
  });

  test("a systemd unit descriptor on macOS is a clear error", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");
    expect(() =>
      selectNatsServiceManager({
        descriptorPath: unitPath,
        platform: "darwin",
        mutate: false,
        exec: capturingExec().runner,
      }),
    ).toThrow(/systemd unit.*macOS|unit.*launchd|does not match/i);
  });

  test("detects descriptor type by CONTENT when the extension is ambiguous", () => {
    const dir = freshDir();
    // A `.conf`-ish path carrying systemd unit content on linux → systemd.
    const unitPath = join(dir, "nats-server.unit");
    writeFileSync(unitPath, bareUnit(), "utf-8");
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: false,
      exec: capturingExec().runner,
    });
    expect(mgr.kind).toBe("systemd");
  });
});

// =============================================================================
// dry-run — execs nothing, writes nothing
// =============================================================================

describe("dry-run posture — no exec, no write", () => {
  test("systemd dry-run ensureConfigLoaded does NOT write the unit", () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    const before = bareUnit();
    writeFileSync(unitPath, before, "utf-8");

    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: false,
      exec: capturingExec().runner,
    });
    mgr.ensureConfigLoaded(NATS_CONFIG);

    expect(readFileSync(unitPath, "utf-8")).toBe(before);
  });

  test("systemd dry-run restart execs NOTHING and reports ok", async () => {
    const dir = freshDir();
    const unitPath = join(dir, "nats-server.service");
    writeFileSync(unitPath, bareUnit(), "utf-8");

    const { runner, calls } = capturingExec();
    const mgr = selectNatsServiceManager({
      descriptorPath: unitPath,
      platform: "linux",
      mutate: false,
      exec: runner,
    });
    const res = await mgr.restart();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("launchd dry-run restart execs NOTHING and reports ok", async () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");

    const { runner, calls } = capturingExec();
    const mgr = selectNatsServiceManager({
      descriptorPath: plistPath,
      platform: "darwin",
      mutate: false,
      exec: runner,
    });
    const res = await mgr.restart();
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
