/**
 * S4 (#738) — `network-adapters.ts` live plist-writer tests.
 *
 * Pins the MAJOR review fix: the live plist writer renders its
 * `<key>ProgramArguments</key>` block via S3's canonical
 * `renderProgramArguments` (`src/common/nats/nats-plist-loader.ts`), the single
 * source of truth — NOT a bespoke copy. These tests write a real temp plist and
 * assert the spliced block is byte-identical to what S3 emits, so the two
 * render paths can never drift again.
 *
 * Scope: the plist port only (a temp plist file). No registry / daemon / leaf
 * I/O — `ensureConfigLoaded` / `dropConfigArg` are exercised directly off the
 * live ports bundle.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildLivePorts, type LivePortsConfig } from "../network-adapters";
import {
  ensureConfigArg,
  renderProgramArguments,
} from "../../../../common/nats/nats-plist-loader";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "s4-adapters-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const NATS_CONFIG = "/Users/andreas/.config/nats/local.conf";

/** A minimal nats-server plist running bare `nats-server -js` (the bring-up trap). */
function barePlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    "\t<string>homebrew.mxcl.nats-server</string>",
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    "\t\t<string>/opt/homebrew/bin/nats-server</string>",
    "\t\t<string>-js</string>",
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function cfgFor(plistPath: string): LivePortsConfig {
  return {
    networkId: "metafactory",
    principalId: "andreas",
    stackId: "andreas/meta-factory",
    natsConfigPath: NATS_CONFIG,
    plistPath,
  };
}

describe("live plist writer uses S3's canonical renderProgramArguments", () => {
  test("ensureConfigLoaded splices the EXACT block S3 renders (no drift)", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");

    const ports = buildLivePorts(cfgFor(plistPath));
    ports.plist.ensureConfigLoaded(NATS_CONFIG);

    const after = readFileSync(plistPath, "utf-8");

    // The canonical expectation: bare args + `-c <config>` appended, rendered
    // by S3's renderProgramArguments — the SINGLE source of truth.
    const expectedArgs = ensureConfigArg(
      ["/opt/homebrew/bin/nats-server", "-js"],
      NATS_CONFIG,
    );
    const expectedBlock = renderProgramArguments(expectedArgs);

    expect(after).toContain(expectedBlock);
    // The -c flag + path are present; the rest of the plist is intact.
    expect(after).toContain("<string>-c</string>");
    expect(after).toContain(`<string>${NATS_CONFIG}</string>`);
    expect(after).toContain("<key>RunAtLoad</key>");
    expect(after).toContain("homebrew.mxcl.nats-server");
  });

  test("ensureConfigLoaded is idempotent — already-correct plist is a no-op", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");
    const ports = buildLivePorts(cfgFor(plistPath));

    ports.plist.ensureConfigLoaded(NATS_CONFIG);
    const first = readFileSync(plistPath, "utf-8");
    ports.plist.ensureConfigLoaded(NATS_CONFIG);
    const second = readFileSync(plistPath, "utf-8");

    expect(second).toBe(first);
  });

  test("dropConfigArg removes the -c flag via the canonical renderer", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    // Start from a plist that already loads the config.
    const loaded = barePlist().replace(
      "\t\t<string>-js</string>\n\t</array>",
      `\t\t<string>-js</string>\n\t\t<string>-c</string>\n\t\t<string>${NATS_CONFIG}</string>\n\t</array>`,
    );
    writeFileSync(plistPath, loaded, "utf-8");

    const ports = buildLivePorts(cfgFor(plistPath));
    ports.plist.dropConfigArg(NATS_CONFIG);

    const after = readFileSync(plistPath, "utf-8");
    const expectedBlock = renderProgramArguments([
      "/opt/homebrew/bin/nats-server",
      "-js",
    ]);
    expect(after).toContain(expectedBlock);
    expect(after).not.toContain("<string>-c</string>");
    expect(after).not.toContain(`<string>${NATS_CONFIG}</string>`);
  });
});
