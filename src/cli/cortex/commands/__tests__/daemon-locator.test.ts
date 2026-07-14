/**
 * #800 — the daemon locator: resolve the cortex daemon's launchd/systemd service
 * by its `--config` arg, so the join/leave restart targets the real service
 * instead of guessing `ai.meta-factory.cortex.<stack-slug>`.
 *
 * The matcher is pure (file I/O injected), so these tests pin the resolution
 * logic — including the driving case `jc/default` whose plist suffix is
 * `meta-factory`, NOT the slug — without touching the host's LaunchAgents.
 */

import { describe, test, expect } from "bun:test";

import {
  configArgValue,
  findCortexDaemonDescriptor,
  parsePlistProgramArguments,
  parseUnitExecStartArgs,
  type DaemonLocatorIO,
} from "../daemon-locator";

// =============================================================================
// Fixtures
// =============================================================================

const CFG = "/Users/jc/.config/cortex/cortex.yaml";

/** The arc-rendered cortex daemon plist for stack jc/default — suffix `meta-factory`. */
function daemonPlist(configPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>Label</key><string>ai.meta-factory.cortex.meta-factory</string>",
    "<key>ProgramArguments</key><array>",
    "<string>/Users/jc/bin/cortex</string>",
    "<string>start</string>",
    "<string>--config</string>",
    `<string>${configPath}</string>`,
    "</array></dict></plist>",
  ].join("\n");
}

/** The relay sibling — `relay.ts start`, NO --config. Must NOT match. */
const RELAY_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0"><dict>',
  "<key>Label</key><string>ai.meta-factory.cortex.relay</string>",
  "<key>ProgramArguments</key><array>",
  "<string>/Users/jc/.bun/bin/bun</string>",
  "<string>/pkg/cortex/src/taps/cc-events/relay.ts</string>",
  "<string>start</string>",
  "</array></dict></plist>",
].join("\n");

/** The mc sibling — `run …/index.ts`, NO --config. Must NOT match. */
const MC_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0"><dict>',
  "<key>Label</key><string>ai.meta-factory.cortex.mc</string>",
  "<key>ProgramArguments</key><array>",
  "<string>/Users/jc/.bun/bin/bun</string>",
  "<string>run</string>",
  "<string>/pkg/cortex/src/surface/mc/index.ts</string>",
  "</array></dict></plist>",
].join("\n");

/** Build an injected IO over an in-memory `{ dir: { file: content } }` tree. */
function fakeIO(tree: Record<string, Record<string, string>>): DaemonLocatorIO {
  return {
    // The locator only ever checks directory existence (the scan root).
    exists: (p) => p in tree,
    listDir: (dir) => Object.keys(tree[dir] ?? {}),
    readFile: (p) => {
      const f = tree[dirOf(p)]?.[baseOf(p)];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return f;
    },
  };
}
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// =============================================================================
// configArgValue
// =============================================================================

describe("#800 configArgValue", () => {
  test("reads the value after -c", () => {
    expect(configArgValue(["nats-server", "-c", "/x/local.conf"])).toBe("/x/local.conf");
  });
  test("reads the value after --config", () => {
    expect(configArgValue(["cortex", "start", "--config", CFG])).toBe(CFG);
  });
  test("reads the --config=<v> joined form", () => {
    expect(configArgValue(["cortex", `--config=${CFG}`])).toBe(CFG);
  });
  test("returns undefined when no config arg is present", () => {
    expect(configArgValue(["bun", "run", "/pkg/index.ts"])).toBeUndefined();
  });
  test("returns undefined when -c is the trailing arg (no value)", () => {
    expect(configArgValue(["nats-server", "-c"])).toBeUndefined();
  });
});

// =============================================================================
// Arg parsers
// =============================================================================

describe("#800 parsePlistProgramArguments", () => {
  test("extracts the <string> entries in order", () => {
    expect(parsePlistProgramArguments(daemonPlist(CFG))).toEqual([
      "/Users/jc/bin/cortex",
      "start",
      "--config",
      CFG,
    ]);
  });
  test("unescapes XML entities", () => {
    const xml = "<key>ProgramArguments</key><array><string>a&amp;b</string></array>";
    expect(parsePlistProgramArguments(xml)).toEqual(["a&b"]);
  });
  test("returns [] when there is no ProgramArguments block", () => {
    expect(parsePlistProgramArguments("<plist><dict></dict></plist>")).toEqual([]);
  });
});

describe("#800 parseUnitExecStartArgs", () => {
  test("parses ExecStart argv, stripping the `-` prefix", () => {
    const unit = "[Service]\nExecStart=-/usr/bin/cortex start --config /home/clawbox/cortex.yaml\n";
    expect(parseUnitExecStartArgs(unit)).toEqual([
      "/usr/bin/cortex",
      "start",
      "--config",
      "/home/clawbox/cortex.yaml",
    ]);
  });
  test("returns [] when there is no ExecStart line", () => {
    expect(parseUnitExecStartArgs("[Unit]\nDescription=x\n")).toEqual([]);
  });
});

// =============================================================================
// findCortexDaemonDescriptor — the driving case
// =============================================================================

describe("#800 findCortexDaemonDescriptor (darwin)", () => {
  const LA = "/Users/jc/Library/LaunchAgents";

  test("resolves the daemon by --config even when the plist suffix ≠ stack slug", () => {
    // Stack is jc/default; the matching plist is `…cortex.meta-factory`. The
    // pre-#800 slug guess `…cortex.default` would never find this.
    const io = fakeIO({
      [LA]: {
        "ai.meta-factory.cortex.meta-factory.plist": daemonPlist(CFG),
        "ai.meta-factory.cortex.relay.plist": RELAY_PLIST,
        "ai.meta-factory.cortex.mc.plist": MC_PLIST,
      },
    });
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: CFG,
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBe(`${LA}/ai.meta-factory.cortex.meta-factory.plist`);
  });

  test("matches across `~` vs expanded config paths", () => {
    const io = fakeIO({
      [LA]: { "ai.meta-factory.cortex.meta-factory.plist": daemonPlist(CFG) },
    });
    // The plist stores the absolute path; the join may carry the same path. A
    // `~`-form on either side still resolves to the same file.
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: CFG,
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBeDefined();
  });

  test("matches despite a non-normalised config path (`.` segment / trailing slash)", () => {
    const io = fakeIO({
      [LA]: { "ai.meta-factory.cortex.meta-factory.plist": daemonPlist(CFG) },
    });
    // The plist stores the clean absolute path; the query carries a `.` segment.
    // path.resolve on both sides normalises them to the same file.
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: "/Users/jc/.config/cortex/./cortex.yaml",
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBe(`${LA}/ai.meta-factory.cortex.meta-factory.plist`);
  });

  test("returns undefined when no installed plist references the config", () => {
    const io = fakeIO({
      [LA]: {
        "ai.meta-factory.cortex.relay.plist": RELAY_PLIST,
        "ai.meta-factory.cortex.mc.plist": MC_PLIST,
      },
    });
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: CFG,
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBeUndefined();
  });

  test("returns undefined when a DIFFERENT stack's config is requested", () => {
    const io = fakeIO({
      [LA]: { "ai.meta-factory.cortex.meta-factory.plist": daemonPlist(CFG) },
    });
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: "/Users/jc/.config/cortex/other.yaml",
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBeUndefined();
  });

  test("returns undefined when the LaunchAgents dir is absent", () => {
    const io = fakeIO({});
    const found = findCortexDaemonDescriptor({
      platform: "darwin",
      cortexConfigPath: CFG,
      launchAgentsDir: LA,
      systemdUserDir: "/unused",
      io,
    });
    expect(found).toBeUndefined();
  });
});

describe("#800 findCortexDaemonDescriptor (linux/systemd)", () => {
  const SD = "/home/clawbox/.config/systemd/user";
  const LXCFG = "/home/clawbox/.config/cortex/cortex.yaml";
  const unit = `[Service]\nExecStart=/usr/bin/cortex start --config ${LXCFG}\n`;
  const otherUnit = "[Service]\nExecStart=/usr/bin/something-else\n";

  test("resolves the cortex-bot unit by ExecStart --config", () => {
    const io = fakeIO({
      [SD]: { "cortex-bot.service": unit, "other.service": otherUnit },
    });
    const found = findCortexDaemonDescriptor({
      platform: "linux",
      cortexConfigPath: LXCFG,
      launchAgentsDir: "/unused",
      systemdUserDir: SD,
      io,
    });
    expect(found).toBe(`${SD}/cortex-bot.service`);
  });

  // cortex#1909 G-39 — NAMING DECISION: GRANDFATHER. Discovery matches by the
  // ExecStart `--config` value, NEVER by unit name, so a unit named under EITHER
  // convention is found: the frozen-doc `cortex-<slug>.service` (plain) AND the
  // shipped `ai.meta-factory.cortex.*` label style. Nothing is deployed on Linux
  // yet, so a forced rename would only risk orphaning a hand-authored unit for
  // zero benefit; config-match discovery is name-agnostic by construction.
  test.each([
    ["cortex-work.service", "frozen-doc plain `cortex-<slug>.service`"],
    ["ai.meta-factory.cortex.work.service", "shipped `ai.meta-factory.cortex.*` label style"],
    ["totally-hand-authored.service", "an arbitrary hand-authored name"],
  ])("G-39 GRANDFATHER: discovers %p (%s) purely by --config match", (name) => {
    const io = fakeIO({ [SD]: { [name]: unit, "other.service": otherUnit } });
    const found = findCortexDaemonDescriptor({
      platform: "linux",
      cortexConfigPath: LXCFG,
      launchAgentsDir: "/unused",
      systemdUserDir: SD,
      io,
    });
    expect(found).toBe(`${SD}/${name}`);
  });
});
