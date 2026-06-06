/**
 * #754 — leaf-include WIRING tests (RED-first).
 *
 * The dormant-leaf bug: `cortex network join --apply` rendered the per-network
 * `leafnodes-<network>.conf` and ensured the launchd plist loads `local.conf`,
 * but NOTHING ever made `local.conf` actually `include` the rendered leaf file.
 * nats-server loaded `local.conf`, which never referenced the leaf → the leaf
 * sat configured-but-dormant (the exact S3/DD-6 trap).
 *
 * The fix mirrors the plist `ensureConfigArg` idempotent-ensure pattern at the
 * nats-config text level: {@link ensureLeafInclude} adds a top-level
 * `include "leafnodes-<network>.conf"` directive when absent (no-op +
 * byte-stable when present), {@link removeLeafInclude} removes exactly that one
 * directive on leave. Both are pure over the nats-config TEXT — no live
 * `~/.config/nats/local.conf` is read or written here.
 */

import { describe, expect, test } from "bun:test";

import {
  ensureLeafInclude,
  leafIncludeDirectivePresent,
  leafIncludeFileName,
  removeLeafInclude,
} from "../leaf-remote-renderer";

// A representative operator-mode local.conf (NSC operator JWT + resolver +
// system_account), the shape the live config carries — with ZERO include
// directives (the bug).
const LOCAL_CONF = [
  "// nats-server operator-mode config (hand-built bring-up).",
  "system_account: ADSYSACCOUNT",
  "resolver: {",
  "  type: full",
  "  dir: /Users/andreas/.config/nats/jwt",
  "}",
  "jetstream {",
  "  store_dir: /Users/andreas/.config/nats/js",
  "}",
  "",
].join("\n");

describe("leafIncludeFileName (reused — same name everywhere)", () => {
  test("the directive references the SAME file the leaf writer writes", () => {
    expect(leafIncludeFileName("metafactory")).toBe("leafnodes-metafactory.conf");
  });
});

describe("ensureLeafInclude", () => {
  test("adds a top-level include directive when absent", () => {
    const next = ensureLeafInclude(LOCAL_CONF, "metafactory");
    expect(next).toContain('include "leafnodes-metafactory.conf"');
    // The original config is preserved verbatim (we only append).
    expect(next).toContain("system_account: ADSYSACCOUNT");
    expect(next).toContain("store_dir: /Users/andreas/.config/nats/js");
  });

  test("places the include at TOP LEVEL (not nested inside a block)", () => {
    const next = ensureLeafInclude(LOCAL_CONF, "metafactory");
    // The include line must not be indented (top-level HOCON) and must sit
    // outside the resolver/jetstream braces.
    const line = next
      .split("\n")
      .find((l) => l.includes('include "leafnodes-metafactory.conf"'));
    expect(line).toBeDefined();
    expect(line).toBe('include "leafnodes-metafactory.conf"');
  });

  test("is a no-op when the directive is already present (idempotent)", () => {
    const once = ensureLeafInclude(LOCAL_CONF, "metafactory");
    const twice = ensureLeafInclude(once, "metafactory");
    expect(twice).toBe(once);
  });

  test("is byte-stable across repeated application", () => {
    const once = ensureLeafInclude(LOCAL_CONF, "metafactory");
    const twice = ensureLeafInclude(once, "metafactory");
    const thrice = ensureLeafInclude(twice, "metafactory");
    expect(thrice).toBe(once);
  });

  test("matches an existing directive regardless of quote/whitespace shape", () => {
    // A hand-written single-quoted directive with extra spaces still counts as
    // present — we must not add a duplicate.
    const handWritten = LOCAL_CONF + "include   'leafnodes-metafactory.conf'\n";
    const next = ensureLeafInclude(handWritten, "metafactory");
    expect(next).toBe(handWritten);
    // exactly one include for this network.
    expect(
      next.match(/include\s+["']leafnodes-metafactory\.conf["']/g)?.length,
    ).toBe(1);
  });

  test("multiple networks each get their own include (idempotent, OQ3-clean)", () => {
    let cfg = ensureLeafInclude(LOCAL_CONF, "metafactory");
    cfg = ensureLeafInclude(cfg, "research");
    expect(cfg).toContain('include "leafnodes-metafactory.conf"');
    expect(cfg).toContain('include "leafnodes-research.conf"');
    // Re-ensuring either is a no-op.
    expect(ensureLeafInclude(cfg, "metafactory")).toBe(cfg);
    expect(ensureLeafInclude(cfg, "research")).toBe(cfg);
  });

  test("rejects an invalid network id (cannot smuggle a directive)", () => {
    expect(() => ensureLeafInclude(LOCAL_CONF, "../etc/passwd")).toThrow();
    expect(() => ensureLeafInclude(LOCAL_CONF, "Bad Id")).toThrow();
  });

  test("an empty config still gets a valid top-level include", () => {
    const next = ensureLeafInclude("", "metafactory");
    expect(next).toContain('include "leafnodes-metafactory.conf"');
  });
});

describe("leafIncludeDirectivePresent", () => {
  test("false on a config with no includes (the bug)", () => {
    expect(leafIncludeDirectivePresent(LOCAL_CONF, "metafactory")).toBe(false);
  });

  test("true once ensured", () => {
    const next = ensureLeafInclude(LOCAL_CONF, "metafactory");
    expect(leafIncludeDirectivePresent(next, "metafactory")).toBe(true);
  });

  test("does not confuse one network's include for another", () => {
    const next = ensureLeafInclude(LOCAL_CONF, "metafactory");
    expect(leafIncludeDirectivePresent(next, "research")).toBe(false);
  });
});

describe("removeLeafInclude", () => {
  test("removes exactly the one network's include directive", () => {
    let cfg = ensureLeafInclude(LOCAL_CONF, "metafactory");
    cfg = ensureLeafInclude(cfg, "research");
    const after = removeLeafInclude(cfg, "metafactory");
    expect(after).not.toContain('include "leafnodes-metafactory.conf"');
    // research's include survives.
    expect(after).toContain('include "leafnodes-research.conf"');
  });

  test("is a no-op when the directive is absent (idempotent)", () => {
    expect(removeLeafInclude(LOCAL_CONF, "metafactory")).toBe(LOCAL_CONF);
  });

  test("ensure → remove round-trips back to the original config (byte-stable)", () => {
    const ensured = ensureLeafInclude(LOCAL_CONF, "metafactory");
    const removed = removeLeafInclude(ensured, "metafactory");
    expect(removed).toBe(LOCAL_CONF);
  });

  test("removes a hand-written single-quoted / extra-space directive too", () => {
    const handWritten = LOCAL_CONF + "include   'leafnodes-metafactory.conf'\n";
    const after = removeLeafInclude(handWritten, "metafactory");
    expect(after).not.toContain("leafnodes-metafactory.conf");
  });

  test("rejects an invalid network id", () => {
    expect(() => removeLeafInclude(LOCAL_CONF, "../x")).toThrow();
  });
});
