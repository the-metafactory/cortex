/**
 * #763 — nats-server systemd unit-loader tests (the Linux sibling of
 * `nats-plist-loader.test.ts`).
 *
 * On Linux (clawbox, systemd) the nats-server service is a systemd unit, not a
 * launchd plist. The dormant-config trap is the same: a unit whose
 * `[Service] ExecStart=` runs bare `nats-server -js` never loads the rendered
 * leaf config. This unit takes the unit file's text + the config path and
 * returns the corrected unit text whose `ExecStart` carries `-c <config>` —
 * IDEMPOTENT + byte-stable (no-op when already present), preserving every other
 * `ExecStart` argument and every other unit section. It also reads the unit's
 * service id (its file name / `Description`) — the systemd analogue of the
 * launchd `<key>Label</key>`. It does NOT write the unit or restart anything;
 * the S4 adapter applies. Pure + fixture-driven (no real `systemctl`).
 */

import { describe, expect, test } from "bun:test";

import {
  ensureUnitConfigArg,
  systemdUnitConfigArgPresent,
  systemdUnitServiceId,
} from "../systemd-unit-loader";

const NATS_BIN = "/usr/bin/nats-server";
const CONFIG = "/home/jc/.config/nats/local.conf";

/** A bare unit running `nats-server -js` (the dormant trap). */
function bareUnit(): string {
  return [
    "[Unit]",
    "Description=NATS Server",
    "After=network.target",
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

describe("ensureUnitConfigArg", () => {
  test("adds -c <config> to ExecStart when the dormant unit runs bare -js", () => {
    const next = ensureUnitConfigArg(bareUnit(), CONFIG);
    expect(next).toContain(`ExecStart=${NATS_BIN} -js -c ${CONFIG}`);
  });

  test("is a no-op (byte-stable) when -c <config> is already present", () => {
    const already = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c ${CONFIG}`,
    );
    expect(ensureUnitConfigArg(already, CONFIG)).toBe(already);
  });

  test("repoints -c when present but pointing at a different config (one -c only)", () => {
    const stale = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c /old/path/other.conf`,
    );
    const next = ensureUnitConfigArg(stale, CONFIG);
    expect(next).toContain(`ExecStart=${NATS_BIN} -js -c ${CONFIG}`);
    expect(next).not.toContain("/old/path/other.conf");
    // exactly one -c in the ExecStart line
    const execLine = next
      .split("\n")
      .find((l) => l.startsWith("ExecStart="));
    expect(execLine?.match(/(^|\s)-c(\s|$)/g)?.length ?? 0).toBe(1);
  });

  test("supports the --config=<path> long form already present (no-op)", () => {
    const already = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js --config=${CONFIG}`,
    );
    expect(ensureUnitConfigArg(already, CONFIG)).toBe(already);
  });

  test("supports the --config <path> split long form already present (no-op)", () => {
    const already = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js --config ${CONFIG}`,
    );
    expect(ensureUnitConfigArg(already, CONFIG)).toBe(already);
  });

  test("preserves the other ExecStart args and every other unit section", () => {
    const next = ensureUnitConfigArg(bareUnit(), CONFIG);
    // Other ExecStart args survive.
    expect(next).toContain("-js");
    // Other sections + directives survive verbatim.
    expect(next).toContain("[Unit]");
    expect(next).toContain("Description=NATS Server");
    expect(next).toContain("After=network.target");
    expect(next).toContain("Restart=on-failure");
    expect(next).toContain("[Install]");
    expect(next).toContain("WantedBy=default.target");
  });

  test("rewrites only the ExecStart line, leaving line count + ordering stable", () => {
    const before = bareUnit();
    const after = ensureUnitConfigArg(before, CONFIG);
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  test("does not mutate when there is no [Service] ExecStart (throws clearly)", () => {
    const noExec = ["[Unit]", "Description=NATS Server", "", "[Service]", "Restart=on-failure", ""].join("\n");
    expect(() => ensureUnitConfigArg(noExec, CONFIG)).toThrow(/ExecStart/);
  });

  test("throws on a non-absolute config path (nats-server needs an absolute path)", () => {
    expect(() => ensureUnitConfigArg(bareUnit(), "local.conf")).toThrow();
  });

  test("is idempotent across repeated application (apply twice == apply once)", () => {
    const once = ensureUnitConfigArg(bareUnit(), CONFIG);
    const twice = ensureUnitConfigArg(once, CONFIG);
    expect(twice).toBe(once);
  });

  test("handles ExecStart= with a leading +/-/@ prefix (systemd special exec prefixes)", () => {
    const prefixed = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=-${NATS_BIN} -js`,
    );
    const next = ensureUnitConfigArg(prefixed, CONFIG);
    expect(next).toContain(`ExecStart=-${NATS_BIN} -js -c ${CONFIG}`);
  });
});

describe("systemdUnitConfigArgPresent", () => {
  test("detects the short -c form in ExecStart", () => {
    const unit = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c ${CONFIG}`,
    );
    expect(systemdUnitConfigArgPresent(unit, CONFIG)).toBe(true);
  });

  test("detects the --config=<path> long form", () => {
    const unit = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js --config=${CONFIG}`,
    );
    expect(systemdUnitConfigArgPresent(unit, CONFIG)).toBe(true);
  });

  test("returns false when ExecStart runs bare -js (the dormant trap)", () => {
    expect(systemdUnitConfigArgPresent(bareUnit(), CONFIG)).toBe(false);
  });

  test("returns false when -c points at a different config", () => {
    const unit = bareUnit().replace(
      `ExecStart=${NATS_BIN} -js`,
      `ExecStart=${NATS_BIN} -js -c /other.conf`,
    );
    expect(systemdUnitConfigArgPresent(unit, CONFIG)).toBe(false);
  });
});

describe("systemdUnitServiceId — the systemd analogue of the plist Label", () => {
  test("derives the service id from a unit file path's basename", () => {
    expect(
      systemdUnitServiceId("/home/jc/.config/systemd/user/nats-server.service", bareUnit()),
    ).toBe("nats-server.service");
  });

  test("falls back to a synthesized id from Description when path has no .service basename", () => {
    // Defensive: a non-.service path still yields a usable id (never undefined).
    const id = systemdUnitServiceId("/tmp/whatever", bareUnit());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
