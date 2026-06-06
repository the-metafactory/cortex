/**
 * S3 (Network Join Control Plane, #737) — nats-server plist-loader tests.
 *
 * The plist loader closes the "configured-but-dormant" trap from bring-up:
 * the homebrew launchd plist (`homebrew.mxcl.nats-server.plist`) previously
 * ran bare `nats-server -js` and never loaded the rendered config, so the
 * leaf remote was written but the server ignored it. This unit takes the
 * plist's `ProgramArguments` + the config path and returns the corrected
 * arguments that include `-c <config>` — IDEMPOTENT (no-op when already
 * present). It does NOT write the plist or restart the daemon; S4 applies.
 *
 * Tests assert on returned arrays + rendered XML ONLY. No live plist is read
 * or written (fixtures, not `~/Library/LaunchAgents/...`).
 */

import { describe, expect, test } from "bun:test";

import {
  ensureConfigArg,
  plistConfigArgPresent,
  renderProgramArguments,
} from "../nats-plist-loader";

const NATS_BIN = "/opt/homebrew/opt/nats-server/bin/nats-server";
const CONFIG = "/Users/andreas/.config/nats/local.conf";

describe("ensureConfigArg", () => {
  test("adds -c <config> when the dormant plist runs bare -js", () => {
    const args = ensureConfigArg([NATS_BIN, "-js"], CONFIG);
    expect(args).toEqual([NATS_BIN, "-js", "-c", CONFIG]);
  });

  test("is a no-op when -c <config> is already present (idempotent)", () => {
    const already = [NATS_BIN, "-js", "-c", CONFIG];
    const args = ensureConfigArg(already, CONFIG);
    expect(args).toEqual(already);
  });

  test("repoints -c when present but pointing at a different config", () => {
    const stale = [NATS_BIN, "-js", "-c", "/old/path/other.conf"];
    const args = ensureConfigArg(stale, CONFIG);
    expect(args).toEqual([NATS_BIN, "-js", "-c", CONFIG]);
    // Exactly one -c flag — no duplicate config args.
    expect(args.filter((a) => a === "-c")).toHaveLength(1);
  });

  test("supports the --config=<path> long form already present (no-op)", () => {
    const already = [NATS_BIN, "-js", `--config=${CONFIG}`];
    const args = ensureConfigArg(already, CONFIG);
    expect(args).toEqual(already);
  });

  test("supports the --config <path> split long form already present (no-op)", () => {
    const already = [NATS_BIN, "-js", "--config", CONFIG];
    const args = ensureConfigArg(already, CONFIG);
    expect(args).toEqual(already);
  });

  test("does not mutate the input array (pure)", () => {
    const input = [NATS_BIN, "-js"];
    const out = ensureConfigArg(input, CONFIG);
    expect(input).toEqual([NATS_BIN, "-js"]);
    expect(out).not.toBe(input);
  });

  test("throws on an empty ProgramArguments (no binary to invoke)", () => {
    expect(() => ensureConfigArg([], CONFIG)).toThrow();
  });

  test("throws on a non-absolute config path (launchd needs an absolute path)", () => {
    expect(() => ensureConfigArg([NATS_BIN, "-js"], "local.conf")).toThrow();
  });

  test("is idempotent across repeated application (apply twice == apply once)", () => {
    const once = ensureConfigArg([NATS_BIN, "-js"], CONFIG);
    const twice = ensureConfigArg(once, CONFIG);
    expect(twice).toEqual(once);
  });
});

describe("plistConfigArgPresent", () => {
  test("detects the short -c form", () => {
    expect(plistConfigArgPresent([NATS_BIN, "-js", "-c", CONFIG], CONFIG)).toBe(
      true,
    );
  });

  test("detects the --config=<path> long form", () => {
    expect(
      plistConfigArgPresent([NATS_BIN, "-js", `--config=${CONFIG}`], CONFIG),
    ).toBe(true);
  });

  test("returns false when only -js is present (the dormant trap)", () => {
    expect(plistConfigArgPresent([NATS_BIN, "-js"], CONFIG)).toBe(false);
  });

  test("returns false when -c points at a different config", () => {
    expect(
      plistConfigArgPresent([NATS_BIN, "-js", "-c", "/other.conf"], CONFIG),
    ).toBe(false);
  });
});

describe("renderProgramArguments — launchd plist XML for S4 to write", () => {
  test("renders the corrected ProgramArguments as a plist <array> block", () => {
    const xml = renderProgramArguments([NATS_BIN, "-js", "-c", CONFIG]);
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain("<array>");
    expect(xml).toContain(`<string>${NATS_BIN}</string>`);
    expect(xml).toContain("<string>-js</string>");
    expect(xml).toContain("<string>-c</string>");
    expect(xml).toContain(`<string>${CONFIG}</string>`);
    expect(xml).toContain("</array>");
  });

  test("escapes XML metacharacters in arguments (no injection into the plist)", () => {
    const xml = renderProgramArguments([NATS_BIN, "-c", "/a&b/c<d>.conf"]);
    expect(xml).toContain("/a&amp;b/c&lt;d&gt;.conf");
    expect(xml).not.toContain("/a&b/c<d>.conf");
  });

  test("is byte-stable for the same arguments (idempotent render)", () => {
    const args = [NATS_BIN, "-js", "-c", CONFIG];
    expect(renderProgramArguments(args)).toBe(renderProgramArguments(args));
  });
});
