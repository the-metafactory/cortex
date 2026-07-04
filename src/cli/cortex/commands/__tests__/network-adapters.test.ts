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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import { parse as parseYaml } from "yaml";

import {
  buildDryRunPorts,
  buildLeafStatePort,
  buildLivePorts,
  DEFAULT_MONITOR_URL,
  type LivePortsConfig,
} from "../network-adapters";
import { leaveNetwork } from "../network-lib";
import { brandVerified, type RenderLeafInputs } from "../network-ports";
import type { NetworkDescriptor } from "../../../../common/registry/types";
import {
  ensureConfigArg,
  renderProgramArguments,
} from "../../../../common/nats/nats-plist-loader";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import { generateStackIdentity } from "../../../../bus/stack-provisioning";
import {
  InMemoryRegistryStore,
  rosterFromPrincipals,
  membersFromPrincipals,
  rosterFromAdmissions,
} from "../../../../services/network-registry/src/store";
import type { AdmissionRequest } from "../../../../services/network-registry/src/types";
import registryApp from "../../../../services/network-registry/src/index";
import type { Env } from "../../../../services/network-registry/src/index";
import {
  makeRegistryKey,
  resetStores,
} from "../../../../services/network-registry/__tests__/helpers";
import type {
  SignedAssertion,
  PrincipalRecord,
} from "../../../../services/network-registry/src/types";

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
    // #763 — pin darwin so the launchd-plist adapter is selected deterministically
    // (on Linux CI the default platform would otherwise route to systemd and
    // reject the .plist descriptor as a mismatch).
    platform: "darwin",
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

// =============================================================================
// #754 — the live leaf-file port wires local.conf to INCLUDE the rendered leaf
// (close the dormant-leaf gap). Round-trips a real temp nats config; dry-run
// is inert.
// =============================================================================

/** A representative operator-mode local.conf with ZERO include directives. */
function bareLocalConf(): string {
  return [
    "// nats-server operator-mode config.",
    "system_account: ADSYSACCOUNT",
    "jetstream { store_dir: /Users/andreas/.config/nats/js }",
    "",
  ].join("\n");
}

function cfgWithConfig(natsConfigPath: string): LivePortsConfig {
  return {
    networkId: "metafactory",
    principalId: "andreas",
    stackId: "andreas/meta-factory",
    natsConfigPath,
    plistPath: "/nonexistent/plist", // not exercised here
  };
}

describe("#754 live leaf-include wiring", () => {
  test("ensureInclude adds the include directive to local.conf (was dormant)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");

    const ports = buildLivePorts(cfgWithConfig(conf));
    ports.leafFile.ensureInclude("metafactory");

    const after = readFileSync(conf, "utf-8");
    expect(after).toContain('include "leafnodes-metafactory.conf"');
    // Original content preserved.
    expect(after).toContain("system_account: ADSYSACCOUNT");
  });

  test("cortex#1483 (join-4): ensureInclude writes a timestamped .bak of the PRIOR local.conf before mutating", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.ensureInclude("metafactory");

    const baks = readdirSync(dir).filter((f) => f.startsWith("local.conf.bak-join-"));
    expect(baks.length).toBe(1);
    expect(readFileSync(join(dir, baks[0]!), "utf-8")).toBe(original);
    // The live file carries the NEW content, not the backed-up original.
    expect(readFileSync(conf, "utf-8")).toContain('include "leafnodes-metafactory.conf"');
  });

  test("cortex#1483 (join-4): a byte-stable ensureInclude re-run writes NO extra .bak (no-op, nothing to protect)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.ensureInclude("metafactory"); // mutates → 1 backup
    ports.leafFile.ensureInclude("metafactory"); // idempotent no-op → no 2nd backup

    const baks = readdirSync(dir).filter((f) => f.startsWith("local.conf.bak-join-"));
    expect(baks.length).toBe(1);
  });

  test("ensureInclude is idempotent + byte-stable on the live file", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.ensureInclude("metafactory");
    const first = readFileSync(conf, "utf-8");
    ports.leafFile.ensureInclude("metafactory");
    const second = readFileSync(conf, "utf-8");
    expect(second).toBe(first);
  });

  test("ensure → removeInclude round-trips local.conf back to original bytes", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.ensureInclude("metafactory");
    ports.leafFile.removeInclude("metafactory");
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  test("multiple networks each get their own include directive", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.ensureInclude("metafactory");
    ports.leafFile.ensureInclude("research");
    const after = readFileSync(conf, "utf-8");
    expect(after).toContain('include "leafnodes-metafactory.conf"');
    expect(after).toContain('include "leafnodes-research.conf"');

    // removeInclude drops exactly one.
    ports.leafFile.removeInclude("metafactory");
    const final = readFileSync(conf, "utf-8");
    expect(final).not.toContain('include "leafnodes-metafactory.conf"');
    expect(final).toContain('include "leafnodes-research.conf"');
  });

  test("dry-run ensureInclude / removeInclude write NOTHING (inert)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");

    const ports = buildDryRunPorts(cfgWithConfig(conf));
    ports.leafFile.ensureInclude("metafactory");
    ports.leafFile.removeInclude("metafactory");

    // The file on disk is untouched.
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });
});

// =============================================================================
// O-3 (cortex#1053) — the LIVE convertToOperatorMode adapter round-trips a real
// temp nats config: an anonymous bus + a leaf package → the on-disk config gains
// the operator-mode blocks, keeps its own identity, and adds NO leaf include.
// =============================================================================

/** The anonymous / hard-isolated bus shape (sop-stack-onboarding §Step 2). */
function anonLocalConf(): string {
  return [
    "server_name: community-andreas",
    "listen: 127.0.0.1:4224",
    "http: 127.0.0.1:8224",
    "jetstream {",
    "  store_dir: /Users/andreas/.config/nats/community-jetstream",
    "  domain: community-andreas",
    "}",
    "",
  ].join("\n");
}

// Public-repo-safe fake leaf package (obvious `eyJ…` / `A…`-shaped fixtures).
const FAKE_PACKAGE = {
  operatorJwt:
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_OPERATOR.sig",
  account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
  accountJwt:
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_ACCOUNT.sig",
};

describe("O-3 live convertToOperatorMode — round-trip a real temp nats config", () => {
  test("anonymous bus + leaf package → conf gains operator-mode blocks, keeps identity, no leaf include", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    writeFileSync(conf, anonLocalConf(), "utf-8");

    const ports = buildLivePorts(cfgWithConfig(conf));
    const result = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);

    expect(result.status).toBe("converted");
    const after = readFileSync(conf, "utf-8");
    // operator-mode blocks rendered
    expect(after).toContain(`operator: ${FAKE_PACKAGE.operatorJwt}`);
    expect(after).toContain("resolver: MEMORY");
    expect(after).toContain(`${FAKE_PACKAGE.account}: ${FAKE_PACKAGE.accountJwt}`);
    // the stack's own identity/ports/JS domain preserved
    expect(after).toContain("server_name: community-andreas");
    expect(after).toContain("listen: 127.0.0.1:4224");
    expect(after).toContain("domain: community-andreas");
    // NO leaf include — join renders its own
    expect(after).not.toMatch(/include[ \t]+["']leafnodes-/);
  });

  test("cortex#1483 (join-4): a converting write backs up the PRE-conversion bytes to a timestamped .bak", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    const original = anonLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    const result = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    expect(result.status).toBe("converted");

    const baks = readdirSync(dir).filter((f) => f.startsWith("community.conf.bak-join-"));
    expect(baks.length).toBe(1);
    expect(readFileSync(join(dir, baks[0]!), "utf-8")).toBe(original);
  });

  test("already-operator-mode bus under the SAME operator → 'already', file unchanged + leaf can be added", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    writeFileSync(conf, anonLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    // First convert, then re-convert: byte-stable no-op.
    ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    const afterFirst = readFileSync(conf, "utf-8");
    const second = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    expect(second.status).toBe("already");
    expect(readFileSync(conf, "utf-8")).toBe(afterFirst);

    // And the converted bus can now take a leaf include (the join's next step).
    ports.leafFile.ensureInclude("metafactory");
    const withLeaf = readFileSync(conf, "utf-8");
    expect(withLeaf).toContain('include "leafnodes-metafactory.conf"');
    // still operator-mode + identity intact
    expect(withLeaf).toContain(`operator: ${FAKE_PACKAGE.operatorJwt}`);
    expect(withLeaf).toContain("server_name: community-andreas");
  });

  test("missing operator JWT → refuse, the on-disk config is untouched (fail-fast preserved)", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    const original = anonLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    const result = ports.leafFile.convertToOperatorMode({
      ...FAKE_PACKAGE,
      operatorJwt: "",
    });
    expect(result.status).toBe("refuse");
    // nothing written
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  test("an already-operator-mode bus under a DIFFERENT operator → refuse (never clobber)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf(); // carries system_account → operator-mode-ish
    const foreign = [
      original.trimEnd(),
      "operator: eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.A_DIFFERENT_OPERATOR.sig",
      "",
    ].join("\n");
    writeFileSync(conf, foreign, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    const result = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    expect(result.status).toBe("refuse");
    // the foreign config is left exactly as-is.
    expect(readFileSync(conf, "utf-8")).toBe(foreign);
  });

  test("dry-run convertToOperatorMode surfaces the decision but writes NOTHING", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    const original = anonLocalConf();
    writeFileSync(conf, original, "utf-8");

    const ports = buildDryRunPorts(cfgWithConfig(conf));
    const result = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    // The decision is a READ — identical to live: it WOULD convert.
    expect(result.status).toBe("converted");
    // ...but nothing was written.
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  // ---------------------------------------------------------------------------
  // Security-review MAJOR (#1058) — the converting write is ATOMIC (tmp+rename),
  // so a SIGKILL/OOM mid-write can never leave nats-server a truncated config.
  // ---------------------------------------------------------------------------
  test("the converting write goes via a tmp file + rename (no .tmp left behind)", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    writeFileSync(conf, anonLocalConf(), "utf-8");

    const ports = buildLivePorts(cfgWithConfig(conf));
    const result = ports.leafFile.convertToOperatorMode(FAKE_PACKAGE);
    expect(result.status).toBe("converted");

    // The rename CONSUMED the tmp file — none is left in the dir, and the final
    // config carries the full converted bytes (atomic: old-or-new, never partial).
    expect(existsSync(`${conf}.tmp`)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (result.status !== "converted") throw new Error("expected converted");
    expect(readFileSync(conf, "utf-8")).toBe(result.conf);
  });

  test("a FAILED converting write leaves the original config intact (atomic, never truncated)", () => {
    const dir = freshDir();
    const conf = join(dir, "community.conf");
    const original = anonLocalConf();
    writeFileSync(conf, original, "utf-8");

    // Make the config's directory read-only so the `.tmp` write throws EACCES
    // BEFORE the rename — the original file's bytes must be untouched (the whole
    // point of tmp+rename: the target is only ever swapped atomically, never
    // opened for truncation in place).
    chmodSync(dir, 0o500);
    try {
      const ports = buildLivePorts(cfgWithConfig(conf));
      expect(() => ports.leafFile.convertToOperatorMode(FAKE_PACKAGE)).toThrow();
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach can clean up
    }
    // The original config survived verbatim — no partial/corrupt write.
    expect(readFileSync(conf, "utf-8")).toBe(original);
    expect(existsSync(`${conf}.tmp`)).toBe(false);
  });

  test("restoreLeafState's base-config rewrite is ALSO atomic (no .tmp left behind)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    // A base config WITHOUT the leaf include directive — restoring a snapshot
    // that records "directive-present" makes restoreLeafState rewrite the base
    // config (the path the MAJOR flagged). Assert it goes atomic.
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    ports.leafFile.restoreLeafState({
      networkId: "metafactory",
      includeFile: undefined,
      natsConfig: "directive-present", // → ensureLeafInclude rewrites the base config
    });

    expect(existsSync(`${conf}.tmp`)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // The directive was added (the rewrite happened, atomically).
    expect(readFileSync(conf, "utf-8")).toContain('include "leafnodes-metafactory.conf"');
  });
});

// =============================================================================
// #756 — the config-store port is CONFIG-SPLIT-AWARE: it writes
// policy.federated.networks[] to the per-stack split path
// (~/.config/cortex/<slug>/stacks/<slug>.yaml) when the per-stack dir exists,
// falling back to the flat legacy path otherwise. The join's policy block must
// land in the file the DAEMON composes, not a stray orphan.
//
// expandTilde() reads $HOME, so each test points $HOME at a temp dir and builds
// the layout under <tmp>/.config/cortex/.
// =============================================================================

const realHome = homedir();

function withHome(home: string, fn: () => void): void {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function cfgForStack(slug: string): LivePortsConfig {
  return {
    networkId: "metafactory",
    principalId: "andreas",
    stackId: `andreas/${slug}`,
    natsConfigPath: "/Users/andreas/.config/nats/local.conf",
    plistPath: "/nonexistent/plist",
  };
}

function sampleNetwork(id: string): PolicyFederatedNetwork {
  return {
    id,
    leaf_node: id,
    peers: [],
    accept_subjects: ["federated.andreas.meta-factory.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
  };
}

describe("#756 config-split-aware policy write", () => {
  test("writes to <slug>/stacks/<slug>.yaml when the per-stack split dir exists", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    // Build the config-split layout: the per-stack dir with its system marker.
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(
      join(cortexDir, "meta-factory", "system", "system.yaml"),
      "nats:\n  url: nats://localhost:4222\n",
      "utf-8",
    );

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    });

    const splitPath = join(cortexDir, "meta-factory", "stacks", "meta-factory.yaml");
    const flatPath = join(cortexDir, "stacks", "meta-factory.yaml");
    // The policy block landed in the SPLIT path (the file the daemon composes).
    expect(existsSync(splitPath)).toBe(true);
    // And NOT in the flat orphan path.
    expect(existsSync(flatPath)).toBe(false);

    const parsed = parseYaml(readFileSync(splitPath, "utf-8")) as {
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    expect(parsed.policy?.federated?.networks?.[0]?.id).toBe("metafactory");
  });

  test("derives the slug from the part AFTER the `/` in --stack", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");

    withHome(home, () => {
      // stackId = "andreas/meta-factory" → slug "meta-factory" (NOT "andreas").
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    });

    expect(existsSync(join(cortexDir, "meta-factory", "stacks", "meta-factory.yaml"))).toBe(true);
    expect(existsSync(join(cortexDir, "andreas", "stacks", "andreas.yaml"))).toBe(false);
  });

  test("idempotent: replace network-by-id, preserving the rest of the policy block", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    const stacksDir = join(cortexDir, "meta-factory", "stacks");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");
    mkdirSync(stacksDir, { recursive: true });
    // An EXISTING stack file with principals/roles/agents + a hand-pinned peer
    // network — none of which the join must clobber.
    const existing = [
      "policy:",
      "  principals:",
      "    - id: andreas",
      "      roles: [operator]",
      "  agents:",
      "    - id: echo",
      "  federated:",
      "    networks:",
      "      - id: metafactory",
      "        leaf_node: metafactory",
      "        peers:",
      "          - principal_id: jc",
      "            stack_id: jc/sage-host",
      "            principal_pubkey: UHANDPINNEDKEY",
      "        accept_subjects: [federated.andreas.meta-factory.>]",
      "        deny_subjects: []",
      "        announce_capabilities: []",
      "        max_hop: 1",
      "      - id: research",
      "        leaf_node: research",
      "        peers: []",
      "        accept_subjects: [federated.andreas.meta-factory.>]",
      "        deny_subjects: []",
      "        announce_capabilities: []",
      "        max_hop: 1",
      "",
    ].join("\n");
    const splitPath = join(stacksDir, "meta-factory.yaml");
    writeFileSync(splitPath, existing, "utf-8");

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      const current = ports.configStore.readNetworks();
      // Replace metafactory by id (idempotent merge done by the orchestrator;
      // here we simulate it), keep research untouched.
      const replaced = current.map((n) =>
        n.id === "metafactory" ? { ...sampleNetwork("metafactory"), max_hop: 2 } : n,
      );
      ports.configStore.writeNetworks(replaced);
    });

    const parsed = parseYaml(readFileSync(splitPath, "utf-8")) as {
      policy?: {
        principals?: { id: string }[];
        agents?: { id: string }[];
        federated?: { networks?: PolicyFederatedNetwork[] };
      };
    };
    // The rest of the policy block is intact.
    expect(parsed.policy?.principals?.[0]?.id).toBe("andreas");
    expect(parsed.policy?.agents?.[0]?.id).toBe("echo");
    // Both networks still present; research untouched; metafactory replaced.
    const nets = parsed.policy?.federated?.networks ?? [];
    expect(nets.map((n) => n.id).sort()).toEqual(["metafactory", "research"]);
    const meta = nets.find((n) => n.id === "metafactory")!;
    expect(meta.max_hop).toBe(2);
    const research = nets.find((n) => n.id === "research")!;
    // research's hand state is preserved verbatim.
    expect(research.max_hop).toBe(1);
  });

  test("preserves a peer's hand-pinned pubkey on an unrelated network", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    const stacksDir = join(cortexDir, "meta-factory", "stacks");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");
    mkdirSync(stacksDir, { recursive: true });
    const existing = [
      "policy:",
      "  federated:",
      "    networks:",
      "      - id: research",
      "        leaf_node: research",
      "        peers:",
      "          - principal_id: jc",
      "            stack_id: jc/sage-host",
      "            principal_pubkey: UHANDPINNEDKEY12345",
      "        accept_subjects: [federated.andreas.meta-factory.>]",
      "        deny_subjects: []",
      "        announce_capabilities: []",
      "        max_hop: 1",
      "",
    ].join("\n");
    const splitPath = join(stacksDir, "meta-factory.yaml");
    writeFileSync(splitPath, existing, "utf-8");

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      const current = ports.configStore.readNetworks();
      // Join a DIFFERENT network — research must be untouched.
      ports.configStore.writeNetworks([...current, sampleNetwork("metafactory")]);
    });

    const parsed = parseYaml(readFileSync(splitPath, "utf-8")) as {
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    const research = parsed.policy?.federated?.networks?.find((n) => n.id === "research");
    expect(research?.peers?.[0]?.principal_pubkey).toBe("UHANDPINNEDKEY12345");
  });

  test("falls back to the flat legacy path when no per-stack split dir exists", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    // No per-stack dir / marker — legacy flat layout.
    mkdirSync(cortexDir, { recursive: true });

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    });

    expect(existsSync(join(cortexDir, "stacks", "meta-factory.yaml"))).toBe(true);
    expect(existsSync(join(cortexDir, "meta-factory", "stacks", "meta-factory.yaml"))).toBe(false);
  });

  test("dry-run writeNetworks is inert even on the split layout", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");

    withHome(home, () => {
      const ports = buildDryRunPorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    });

    // Nothing written anywhere.
    expect(existsSync(join(cortexDir, "meta-factory", "stacks", "meta-factory.yaml"))).toBe(false);
    expect(existsSync(join(cortexDir, "stacks", "meta-factory.yaml"))).toBe(false);
    // Sanity: we never touched the real home.
    expect(realHome).not.toBe(home);
  });

  // ---------------------------------------------------------------------------
  // C-1349 Slice 1 — write-guard + payload-key install.
  // ---------------------------------------------------------------------------

  // Clearly-FAKE 32-byte key (all-zero base64) — never realistic K material.
  const FAKE_K = Buffer.alloc(32).toString("base64");

  function encryptedNetwork(id: string): PolicyFederatedNetwork {
    return {
      ...sampleNetwork(id),
      encryption: "enabled",
      payload_key: FAKE_K,
      payload_key_id: `${id}/k1`,
    };
  }

  test("installs the payload key K + kid, round-trips it, and clamps the file to 0600", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    const stacksDir = join(cortexDir, "meta-factory", "stacks");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([encryptedNetwork("metafactory")]);
    });

    const splitPath = join(stacksDir, "meta-factory.yaml");
    const parsed = parseYaml(readFileSync(splitPath, "utf-8")) as {
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    const net = parsed.policy?.federated?.networks?.[0];
    expect(net?.encryption).toBe("enabled");
    expect(net?.payload_key).toBe(FAKE_K);
    expect(net?.payload_key_id).toBe("metafactory/k1");
    // 0600 — K is a secret at rest.
    expect(statSync(splitPath).mode & 0o777).toBe(0o600);
  });

  test("writes a timestamped .pre-join backup before overwriting an existing file", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    const stacksDir = join(cortexDir, "meta-factory", "stacks");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");
    mkdirSync(stacksDir, { recursive: true });
    const splitPath = join(stacksDir, "meta-factory.yaml");
    const original =
      "policy:\n  federated:\n    networks:\n      - id: research\n        leaf_node: research\n        peers: []\n        accept_subjects: [federated.andreas.meta-factory.>]\n        deny_subjects: []\n        announce_capabilities: []\n        max_hop: 1\n";
    writeFileSync(splitPath, original, "utf-8");

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    });

    const backups = readdirSync(stacksDir).filter((f) => f.includes(".pre-join-") && f.endsWith(".bak"));
    expect(backups.length).toBe(1);
    // The backup holds the ORIGINAL content verbatim (recoverable).
    expect(readFileSync(join(stacksDir, backups[0]!), "utf-8")).toBe(original);
  });

  test("validate-before-write: a malformed payload_key is REFUSED and the file is left untouched", () => {
    const home = freshDir();
    const cortexDir = join(home, ".config", "cortex");
    const stacksDir = join(cortexDir, "meta-factory", "stacks");
    mkdirSync(join(cortexDir, "meta-factory", "system"), { recursive: true });
    writeFileSync(join(cortexDir, "meta-factory", "system", "system.yaml"), "{}\n", "utf-8");
    mkdirSync(stacksDir, { recursive: true });
    const splitPath = join(stacksDir, "meta-factory.yaml");
    const original =
      "policy:\n  federated:\n    networks:\n      - id: research\n        leaf_node: research\n        peers: []\n        accept_subjects: [federated.andreas.meta-factory.>]\n        deny_subjects: []\n        announce_capabilities: []\n        max_hop: 1\n";
    writeFileSync(splitPath, original, "utf-8");

    // A payload_key that is NOT 32 bytes when base64-decoded — the schema refine
    // the daemon enforces at boot must reject it BEFORE any write.
    const bad: PolicyFederatedNetwork = {
      ...sampleNetwork("metafactory"),
      encryption: "enabled",
      payload_key: "dG9vLXNob3J0", // "too-short" — 9 bytes, not 32
      payload_key_id: "metafactory/k1",
    };

    withHome(home, () => {
      const ports = buildLivePorts(cfgForStack("meta-factory"));
      expect(() => ports.configStore.writeNetworks([bad])).toThrow(/schema validation/);
    });

    // The original file is BYTE-IDENTICAL — the refused write never mutated it,
    // and never leaked the key into the error path.
    expect(readFileSync(splitPath, "utf-8")).toBe(original);
  });
});

// =============================================================================
// #805 / #807 — the config-store port resolves its write target from the
// daemon's REAL `--config` (LivePortsConfig.cortexConfigPath), layout-aware,
// NOT from cfg.stackId + a hardcoded `~/.config/cortex`.
//
// The split-brain bug (#805): `cortex network join` wrote the policy block to a
// file the daemon never read. On JC's single-file `cortex.yaml` (stack.id
// `jc/default`) the slug-derived path was `~/.config/cortex/stacks/default.yaml`
// while the daemon loads `~/.config/cortex/cortex.yaml`. #807 is the config-split
// corner where the on-disk dir/basename differs from the stack.id slug. Mirror
// `resolve_stack_agent_config_path` in scripts/lib/plist-render.sh — the daemon
// and the join MUST agree on which file carries `policy:`.
//
// These fixtures pin cortexConfigPath at a tmp file and never touch
// ~/.config/cortex (no $HOME override needed — resolution is config-path-driven).
// =============================================================================

/**
 * A fake DaemonLocatorIO seam (#813) that reports a single installed cortex
 * daemon whose `--config` is `loadedConfig`. Lets the live write-path tests pass
 * the fail-closed guard without a real installed daemon. Pass a non-matching
 * `loadedConfig` (or omit it) to exercise the refuse-on-mismatch branch.
 */
function fakeDaemonLocator(loadedConfig: string | undefined): LivePortsConfig["daemonLocatorOverride"] {
  const dir = "/fake/LaunchAgents";
  const plistName = "ai.meta-factory.cortex.stack.plist";
  const plistXml =
    loadedConfig === undefined
      ? "" // no daemon
      : [
          "<key>ProgramArguments</key>",
          "<array>",
          "<string>/usr/local/bin/bun</string>",
          "<string>run</string>",
          "<string>src/cortex.ts</string>",
          "<string>--config</string>",
          `<string>${loadedConfig}</string>`,
          "</array>",
        ].join("\n");
  return {
    launchAgentsDir: dir,
    systemdUserDir: "/fake/systemd",
    io: {
      exists: (p) => p === dir,
      listDir: (p) => (p === dir && loadedConfig !== undefined ? [plistName] : []),
      readFile: () => plistXml,
    },
  };
}

function cfgWithCortexConfig(stackId: string, cortexConfigPath: string): LivePortsConfig {
  return {
    networkId: "metafactory",
    principalId: stackId.split("/")[0] ?? "andreas",
    stackId,
    natsConfigPath: NATS_CONFIG,
    plistPath: "/nonexistent/plist",
    platform: "darwin",
    cortexConfigPath,
    // #813 — a matching fake daemon so the fail-closed guard admits the write.
    daemonLocatorOverride: fakeDaemonLocator(cortexConfigPath),
  };
}

describe("#805/#807 policy write resolves from cortexConfigPath", () => {
  test("#805 single-file: monolith --config → policy lands in the monolith itself", () => {
    const dir = freshDir();
    const monolith = join(dir, "cortex.yaml");
    // No system/system.yaml beside it → legacy monolith layout. JC's stack.id is
    // `jc/default`, but the slug must NOT steer the write here.
    writeFileSync(monolith, "stack:\n  id: jc/default\n", "utf-8");

    const ports = buildLivePorts(cfgWithCortexConfig("jc/default", monolith));
    ports.configStore.writeNetworks([sampleNetwork("metafactory")]);

    // The policy block landed in cortex.yaml itself (the file the daemon reads),
    // NOT in <dir>/stacks/default.yaml (the pre-#805 split-brain orphan).
    const parsed = parseYaml(readFileSync(monolith, "utf-8")) as {
      stack?: { id?: string };
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    expect(parsed.policy?.federated?.networks?.[0]?.id).toBe("metafactory");
    // Pre-existing keys preserved (merge, not overwrite).
    expect(parsed.stack?.id).toBe("jc/default");
    // The split-brain orphan was NOT created.
    expect(existsSync(join(dir, "stacks", "default.yaml"))).toBe(false);
  });

  test("#807 config-split: dir has system/system.yaml → policy lands in <dir>/stacks/<basename>.yaml", () => {
    const tmp = freshDir();
    const researchDir = join(tmp, "research");
    mkdirSync(join(researchDir, "system"), { recursive: true });
    writeFileSync(join(researchDir, "system", "system.yaml"), "{}\n", "utf-8");
    // The daemon's --config is the per-stack sentinel <dir>/research.yaml.
    const sentinel = join(researchDir, "research.yaml");
    writeFileSync(sentinel, "stack:\n  id: andreas/research\n", "utf-8");

    const ports = buildLivePorts(cfgWithCortexConfig("andreas/research", sentinel));
    ports.configStore.writeNetworks([sampleNetwork("metafactory")]);

    const target = join(researchDir, "stacks", "research.yaml");
    expect(existsSync(target)).toBe(true);
    const parsed = parseYaml(readFileSync(target, "utf-8")) as {
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    expect(parsed.policy?.federated?.networks?.[0]?.id).toBe("metafactory");
    // Not written to the sentinel itself.
    const sentinelParsed = parseYaml(readFileSync(sentinel, "utf-8")) as {
      policy?: unknown;
    };
    expect(sentinelParsed.policy).toBeUndefined();
  });

  test("#807 drift corner: target keyed off --config dir/basename, NOT stackId slug", () => {
    // JC's drift: on-disk dir basename is `meta-factory`, but stack.id is
    // `jc/default`. The write must follow the --config dir/basename
    // (meta-factory/stacks/meta-factory.yaml), never the stackId slug (default).
    const tmp = freshDir();
    const metaDir = join(tmp, "meta-factory");
    mkdirSync(join(metaDir, "system"), { recursive: true });
    writeFileSync(join(metaDir, "system", "system.yaml"), "{}\n", "utf-8");
    const sentinel = join(metaDir, "meta-factory.yaml");
    writeFileSync(sentinel, "stack:\n  id: jc/default\n", "utf-8");

    const ports = buildLivePorts(cfgWithCortexConfig("jc/default", sentinel));
    ports.configStore.writeNetworks([sampleNetwork("metafactory")]);

    // Keyed off the dirname/basename of --config.
    expect(existsSync(join(metaDir, "stacks", "meta-factory.yaml"))).toBe(true);
    // NOT keyed off the stackId slug `default`.
    expect(existsSync(join(metaDir, "stacks", "default.yaml"))).toBe(false);
    expect(existsSync(join(tmp, "default", "stacks", "default.yaml"))).toBe(false);
  });

  test("read/write symmetry: writeNetworks then readNetworks round-trips the same file", () => {
    // Single-file (#805) layout — both ops must hit cortex.yaml, not diverge.
    const dir = freshDir();
    const monolith = join(dir, "cortex.yaml");
    writeFileSync(monolith, "stack:\n  id: jc/default\n", "utf-8");

    const ports = buildLivePorts(cfgWithCortexConfig("jc/default", monolith));
    expect(ports.configStore.readNetworks()).toEqual([]);
    ports.configStore.writeNetworks([sampleNetwork("metafactory")]);
    const roundTripped = ports.configStore.readNetworks();
    expect(roundTripped.map((n) => n.id)).toEqual(["metafactory"]);

    // And the config-split layout round-trips through its <dir>/stacks file too.
    const tmp = freshDir();
    const splitDir = join(tmp, "research");
    mkdirSync(join(splitDir, "system"), { recursive: true });
    writeFileSync(join(splitDir, "system", "system.yaml"), "{}\n", "utf-8");
    const sentinel = join(splitDir, "research.yaml");
    writeFileSync(sentinel, "{}\n", "utf-8");

    const splitPorts = buildLivePorts(cfgWithCortexConfig("andreas/research", sentinel));
    expect(splitPorts.configStore.readNetworks()).toEqual([]);
    splitPorts.configStore.writeNetworks([sampleNetwork("metafactory")]);
    expect(splitPorts.configStore.readNetworks().map((n) => n.id)).toEqual(["metafactory"]);
  });

  test("#813 fail-closed: no daemon loads the resolved --config → refuse, nothing written", () => {
    const dir = freshDir();
    const monolith = join(dir, "cortex.yaml");
    writeFileSync(monolith, "stack:\n  id: jc/default\n", "utf-8");
    const original = readFileSync(monolith, "utf-8");

    // No installed daemon references this --config (fakeDaemonLocator(undefined)
    // → empty LaunchAgents). The live write path must REFUSE and not mutate.
    const cfg: LivePortsConfig = {
      ...cfgWithCortexConfig("jc/default", monolith),
      daemonLocatorOverride: fakeDaemonLocator(undefined),
    };
    const ports = buildLivePorts(cfg);

    expect(() => ports.configStore.writeNetworks([sampleNetwork("metafactory")])).toThrow(
      /no running cortex daemon loads --config/,
    );
    // Actionable hint points at the per-stack path shape.
    expect(() => ports.configStore.writeNetworks([sampleNetwork("metafactory")])).toThrow(
      /~\/.config\/cortex\/<stack>\/<stack>\.yaml/,
    );
    // The principal's file is untouched — no orphan policy block.
    expect(readFileSync(monolith, "utf-8")).toBe(original);
  });

  test("#813 comment-preservation: in-place monolith write keeps header + inline comments", () => {
    const dir = freshDir();
    const monolith = join(dir, "cortex.yaml");
    // A hand-maintained monolith with a header comment (incl. DO NOT EDIT) and
    // an inline comment on a key the join must NOT clobber.
    const handMaintained = [
      "# cortex.yaml — DO NOT EDIT BY HAND",
      "# managed by the principal",
      "stack:",
      "  id: jc/default  # the canonical stack id",
      "principal:",
      "  id: jc",
      "",
    ].join("\n");
    writeFileSync(monolith, handMaintained, "utf-8");

    const ports = buildLivePorts(cfgWithCortexConfig("jc/default", monolith));
    ports.configStore.writeNetworks([sampleNetwork("metafactory")]);

    const after = readFileSync(monolith, "utf-8");
    // Comments survive the in-place rewrite (parseYaml→stringifyYaml would strip).
    expect(after).toContain("# cortex.yaml — DO NOT EDIT BY HAND");
    expect(after).toContain("# managed by the principal");
    expect(after).toContain("# the canonical stack id");
    // All prior keys preserved + the policy block added.
    const parsed = parseYaml(after) as {
      stack?: { id?: string };
      principal?: { id?: string };
      policy?: { federated?: { networks?: PolicyFederatedNetwork[] } };
    };
    expect(parsed.stack?.id).toBe("jc/default");
    expect(parsed.principal?.id).toBe("jc");
    expect(parsed.policy?.federated?.networks?.[0]?.id).toBe("metafactory");
  });
});

// =============================================================================
// #757 — the live nats-server port restarts the service named by the --plist's
// <key>Label</key>. The dry-run port is inert; error branches (missing plist /
// missing label) never spawn launchctl. We do NOT exercise the real launchctl
// spawn in tests (the S4 SAFETY rule — no live mutation).
// =============================================================================

describe("#757 nats-server restart port", () => {
  test("dry-run nats-server restart is inert (no spawn, ok)", async () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats-server.plist");
    writeFileSync(plistPath, barePlist(), "utf-8");
    const ports = buildDryRunPorts(cfgFor(plistPath));
    expect(ports.natsServer).toBeDefined();
    const res = await ports.natsServer!.restart();
    expect(res.ok).toBe(true);
  });

  test("live restart fails cleanly when the plist is absent (no spawn)", async () => {
    const cfg: LivePortsConfig = {
      networkId: "metafactory",
      principalId: "andreas",
      stackId: "andreas/meta-factory",
      natsConfigPath: "/x/local.conf",
      plistPath: "/nonexistent/nats-server.plist",
      // Pin darwin (launchd): the assertion is about the plist-not-found path.
      // Without it the Linux CI host defaults to systemd and never inspects
      // `plistPath`, so the "plist not found" reason never appears (cortex#771
      // — pre-existing #757/#763 host-platform leak surfaced here).
      platform: "darwin",
    };
    const ports = buildLivePorts(cfg);
    const res = await ports.natsServer!.restart();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("plist not found");
  });

  test("live restart fails cleanly when the plist has no Label (no spawn)", async () => {
    const dir = freshDir();
    const plistPath = join(dir, "no-label.plist");
    // A plist with ProgramArguments but NO <key>Label</key>.
    writeFileSync(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>ProgramArguments</key>",
        "\t<array><string>/opt/homebrew/bin/nats-server</string></array>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
      "utf-8",
    );
    const ports = buildLivePorts(cfgFor(plistPath));
    const res = await ports.natsServer!.restart();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Label");
  });
});

// =============================================================================
// #821 — live adapter: creds-existence pre-flight + leaf-state snapshot/restore
// + the post-restart health probe. Temp dirs only; no real ~/.config/nats, no
// real server, no real spawn.
// =============================================================================

describe("#821 live leaf-file pre-flight + rollback adapters", () => {
  test("credsExist is true for a present file, false for a missing one", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const credsPath = join(dir, "andreas.creds");
    writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\n", "utf-8");

    const ports = buildLivePorts(cfgWithConfig(conf));
    expect(ports.leafFile.credsExist(credsPath)).toBe(true);
    expect(ports.leafFile.credsExist(join(dir, "does-not-exist.creds"))).toBe(false);
    // Empty path → false (never treat "" as present).
    expect(ports.leafFile.credsExist("")).toBe(false);
  });

  test("snapshot → mutate → restore reverts the include file + directive to prior state", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    // Snapshot the PRIOR state: no include file, directive NOT present.
    const snap = ports.leafFile.snapshotLeafState("metafactory");
    expect(snap.includeFile).toBeUndefined();
    expect(snap.natsConfig).toBeUndefined(); // directive absent pre-join

    // Mutate: write the leaf include file + ensure the include directive.
    ports.leafFile.write({
      descriptor: brandVerified(descriptorForLeaf("metafactory")),
      binding: {
        credentials: "/Users/andreas/.config/nats/andreas.creds",
        account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
      },
    });
    ports.leafFile.ensureInclude("metafactory");
    expect(existsSync(join(dir, "leafnodes-metafactory.conf"))).toBe(true);
    expect(readFileSync(conf, "utf-8")).toContain('include "leafnodes-metafactory.conf"');

    // Roll back: the include file is removed (it didn't exist pre-join) and the
    // join-added directive is dropped — restoring the base config to its prior
    // bytes WITHOUT ever deleting the base file.
    ports.leafFile.restoreLeafState(snap);
    expect(existsSync(join(dir, "leafnodes-metafactory.conf"))).toBe(false);
    expect(existsSync(conf)).toBe(true); // base config NEVER deleted
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  test("C-1224: the written leaf include file is mode 0600 even under a permissive umask (secret-at-rest)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    // Force a permissive umask so a bare `writeFileSync(..., mode: 0o600)` would
    // be masked to 0640/0644 without the explicit chmod-back. The write must
    // still land 0600 (the secret lives inside the file for Model B).
    const prevUmask = process.umask(0o022);
    try {
      ports.leafFile.write({
        descriptor: brandVerified(descriptorForLeaf("metafactory")),
        binding: {
          credentials: "/Users/andreas/.config/nats/andreas.creds",
          account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
        },
      });
    } finally {
      process.umask(prevUmask);
    }

    const leafPath = join(dir, "leafnodes-metafactory.conf");
    expect(existsSync(leafPath)).toBe(true);
    // Mask off the file-type bits; only the permission bits must equal 0600.
    expect(statSync(leafPath).mode & 0o777).toBe(0o600);
  });

  test("cortex#1483 (join-4): a RE-write of the leaf include backs up the PRIOR bytes to a timestamped .bak", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    const binding = {
      credentials: "/Users/andreas/.config/nats/andreas.creds",
      account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    };
    // First write — nothing to back up yet.
    ports.leafFile.write({ descriptor: brandVerified(descriptorForLeaf("metafactory")), binding });
    const leafPath = join(dir, "leafnodes-metafactory.conf");
    const firstWrite = readFileSync(leafPath, "utf-8");
    expect(readdirSync(dir).some((f) => f.startsWith("leafnodes-metafactory.conf.bak-join-"))).toBe(false);

    // A re-join re-renders the SAME network — the prior bytes must be .bak'd.
    ports.leafFile.write({ descriptor: brandVerified(descriptorForLeaf("metafactory")), binding });
    const baks = readdirSync(dir).filter((f) => f.startsWith("leafnodes-metafactory.conf.bak-join-"));
    expect(baks.length).toBe(1);
    expect(readFileSync(join(dir, baks[0]!), "utf-8")).toBe(firstWrite);
  });

  test("restore rewrites a pre-existing include file back to its prior bytes + keeps a pre-existing directive", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    // The base config ALREADY includes the directive (a prior working join).
    const base = bareLocalConf() + 'include "leafnodes-metafactory.conf"\n';
    writeFileSync(conf, base, "utf-8");
    const includePath = join(dir, "leafnodes-metafactory.conf");
    const priorInclude = "leafnodes {\n  remotes: [ /* prior working remote */ ]\n}\n";
    writeFileSync(includePath, priorInclude, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    const snap = ports.leafFile.snapshotLeafState("metafactory");
    expect(snap.includeFile).toBe(priorInclude);
    expect(snap.natsConfig).toBe("directive-present"); // directive WAS present

    // Overwrite the include file (simulating the crashing join's write)...
    writeFileSync(includePath, "leafnodes { remotes: [ /* BAD no-account */ ] }\n", "utf-8");
    // ...then roll back — the prior working include bytes are restored AND the
    // pre-existing directive is kept (idempotent ensure).
    ports.leafFile.restoreLeafState(snap);
    expect(readFileSync(includePath, "utf-8")).toBe(priorInclude);
    expect(readFileSync(conf, "utf-8")).toContain('include "leafnodes-metafactory.conf"');
  });

  test("NIT: restore NEVER deletes the base config, even when its prior snapshot had no directive", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    // Snapshot (no directive), then the join writes the include + directive...
    const snap = ports.leafFile.snapshotLeafState("metafactory");
    ports.leafFile.write({
      descriptor: brandVerified(descriptorForLeaf("metafactory")),
      binding: { credentials: "/x/andreas.creds", account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX" },
    });
    ports.leafFile.ensureInclude("metafactory");
    // ...rollback. The base config must still EXIST (only the directive dropped).
    ports.leafFile.restoreLeafState(snap);
    expect(existsSync(conf)).toBe(true);
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  test("dry-run restoreLeafState is inert (writes nothing)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const original = bareLocalConf();
    writeFileSync(conf, original, "utf-8");
    const ports = buildDryRunPorts(cfgWithConfig(conf));
    const snap = ports.leafFile.snapshotLeafState("metafactory");
    // Mutate the file out-of-band, then call the dry-run restore — it must NOT
    // touch disk (the file keeps the out-of-band content).
    writeFileSync(conf, "mutated\n", "utf-8");
    ports.leafFile.restoreLeafState(snap);
    expect(readFileSync(conf, "utf-8")).toBe("mutated\n");
  });

  test("isHealthy probes the monitor and reports healthy on a 200", async () => {
    // Stand up a tiny local server that answers /healthz 200.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === "/healthz"
          ? new Response("ok", { status: 200 })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const cfg: LivePortsConfig = {
        ...cfgWithConfig("/x/local.conf"),
        monitorUrl: `http://127.0.0.1:${(server.port ?? 0).toString()}`,
      };
      const ports = buildLivePorts(cfg);
      const res = await ports.natsServer!.isHealthy();
      expect(res.healthy).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("isHealthy reports UNhealthy when the monitor is unreachable (server down)", async () => {
    const cfg: LivePortsConfig = {
      ...cfgWithConfig("/x/local.conf"),
      // A port nothing is listening on → connection refused → unhealthy.
      monitorUrl: "http://127.0.0.1:1",
    };
    const ports = buildLivePorts(cfg);
    const res = await ports.natsServer!.isHealthy();
    expect(res.healthy).toBe(false);
    if (!res.healthy) expect(res.reason).toContain("unreachable");
  });

  test("dry-run isHealthy is trivially healthy (never probes)", async () => {
    const ports = buildDryRunPorts(cfgWithConfig("/x/local.conf"));
    const res = await ports.natsServer!.isHealthy();
    expect(res.healthy).toBe(true);
  });

  test("#831 isHealthy is INCONCLUSIVE (healthy) when the bus declares no monitor", async () => {
    // JC's single-file local.conf had no http_port → resolveMonitorBase fell
    // back to :8222 and the probe ECONNREFUSED-rolled-back a GOOD join. With no
    // monitor configured the probe is inconclusive, not a failure → healthy:true.
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "listen: 127.0.0.1:4222\n", "utf-8"); // no http_port
    const ports = buildLivePorts(cfgWithConfig(conf)); // no monitorUrl
    const res = await ports.natsServer!.isHealthy();
    expect(res.healthy).toBe(true);
  });

  test("#831 a CONFIGURED-but-down monitor still reports UNhealthy (safety intact)", async () => {
    const ports = buildLivePorts({ ...cfgWithConfig("/x/local.conf"), monitorUrl: "http://127.0.0.1:1" });
    const res = await ports.natsServer!.isHealthy();
    expect(res.healthy).toBe(false);
  });

  test("MAJOR: isHealthy TIMES OUT (healthy:false) when the monitor accepts but never responds", async () => {
    // A nats-server that accepts the monitor TCP connection but HANGS (never
    // sends a response) is exactly the deadlock the probe exists to catch. An
    // unbounded fetch would hang joinNetwork forever; the probe must abort and
    // report healthy:false within its timeout. The handler returns a Promise
    // that never resolves → the connection is accepted, the response never comes.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {
          /* never resolves — simulate a hung monitor */
        });
      },
    });
    try {
      const cfg: LivePortsConfig = {
        ...cfgWithConfig("/x/local.conf"),
        monitorUrl: `http://127.0.0.1:${(server.port ?? 0).toString()}`,
        // Short timeout so the test asserts the bound without a real 5s wait.
        healthProbeTimeoutMs: 250,
      };
      const ports = buildLivePorts(cfg);
      const started = Date.now();
      const res = await ports.natsServer!.isHealthy();
      const elapsed = Date.now() - started;
      expect(res.healthy).toBe(false);
      if (!res.healthy) expect(res.reason.toLowerCase()).toContain("timed out");
      // Resolved promptly via the abort — well under a multi-second hang.
      expect(elapsed).toBeLessThan(3000);
    } finally {
      server.stop(true);
    }
  });

  test("MAJOR: isHealthy probes the bus's OWN monitor port DERIVED from the nats config (community :8224)", async () => {
    // Stand up a probe-target server, then write a nats config naming THAT port
    // via `http_port:` — with NO --monitor-url. The probe must derive + hit it.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === "/healthz"
          ? new Response("ok", { status: 200 })
          : new Response("nf", { status: 404 });
      },
    });
    try {
      const dir = freshDir();
      const conf = join(dir, "community.conf");
      writeFileSync(
        conf,
        [
          "operator: /x/operator.creds",
          "system_account: ADSYSACCOUNT",
          "port: 4224",
          `http_port: ${(server.port ?? 0).toString()}`,
          "",
        ].join("\n"),
        "utf-8",
      );
      // No monitorUrl flag → must derive the port from the config.
      const ports = buildLivePorts(cfgWithConfig(conf));
      const res = await ports.natsServer!.isHealthy();
      expect(res.healthy).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("MAJOR: explicit --monitor-url WINS over the config-derived port", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });
    try {
      const dir = freshDir();
      const conf = join(dir, "community.conf");
      // Config says a DIFFERENT (dead) port; the flag must win.
      writeFileSync(conf, ["http_port: 9", ""].join("\n"), "utf-8");
      const cfg: LivePortsConfig = {
        ...cfgWithConfig(conf),
        monitorUrl: `http://127.0.0.1:${(server.port ?? 0).toString()}`,
      };
      const ports = buildLivePorts(cfg);
      const res = await ports.natsServer!.isHealthy();
      expect(res.healthy).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("MAJOR-1 / cortex#1495: validateConfig is three-state (valid | invalid | skipped), never a silent fail-open", async () => {
    // The live adapter shells out to `nats-server -t`. We can't guarantee the
    // binary's presence on CI, so assert the result is a well-formed three-state
    // outcome: `valid`/`skipped` when the config is fine or the binary is missing,
    // `invalid` (with a reason) only on a real -t failure. Crucially there is NO
    // `ok:true` fail-open path any more — a missing binary is `skipped`, not `valid`.
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));
    const res = await ports.natsServer!.validateConfig();
    if (res.status === "invalid") {
      expect(res.reason).toContain("nats-server");
    } else if (res.status === "skipped") {
      expect(res.reason).toContain("nats-server");
    } else {
      expect(res.status).toBe("valid");
    }
  });

  test("MAJOR-1: dry-run validateConfig is inert (valid, never spawns)", async () => {
    const ports = buildDryRunPorts(cfgWithConfig("/x/local.conf"));
    const res = await ports.natsServer!.validateConfig();
    expect(res.status).toBe("valid");
  });

  test("NIT-1: credsExist rejects a directory, a 0-byte file, and a non-creds file", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, bareLocalConf(), "utf-8");
    const ports = buildLivePorts(cfgWithConfig(conf));

    // A directory at the creds path → not a usable creds file.
    const asDir = join(dir, "creds-dir");
    mkdirSync(asDir, { recursive: true });
    expect(ports.leafFile.credsExist(asDir)).toBe(false);

    // A 0-byte file → dormant trap, rejected.
    const empty = join(dir, "empty.creds");
    writeFileSync(empty, "", "utf-8");
    expect(ports.leafFile.credsExist(empty)).toBe(false);

    // A non-empty file WITHOUT the NATS creds marker → rejected.
    const notCreds = join(dir, "random.creds");
    writeFileSync(notCreds, "just some text\n", "utf-8");
    expect(ports.leafFile.credsExist(notCreds)).toBe(false);

    // A genuine creds file (carries the marker) → accepted.
    const good = join(dir, "andreas.creds");
    writeFileSync(
      good,
      "-----BEGIN NATS USER JWT-----\neyJ0...\n------END NATS USER JWT------\n",
      "utf-8",
    );
    expect(ports.leafFile.credsExist(good)).toBe(true);
  });
});

// =============================================================================
// #762 — federated registerStack() announces caps INTO the network (roster)
// =============================================================================

describe("#762 registerStack announces capabilities into the network", () => {
  /** The shape the registry route receives (mirror of RegistrationClaimShape). */
  interface CapturedClaim {
    claim: {
      principal_id: string;
      principal_pubkey: string;
      stacks: { stack_id: string }[];
      capabilities: { id: string; networks?: string[] }[];
      // ADR-0018 Gap-A/Gap-B (BLOCK-1) — the register hook stamps this onto the
      // PENDING admission row; the federated join MUST set it.
      network_id?: string;
    };
  }

  /**
   * Stub global fetch to capture the POSTed registration body and return a
   * 201. Restores the real fetch on cleanup. Fakes only — no live mutation.
   */
  function withFetchCapture(
    fn: (capture: { last?: CapturedClaim }) => Promise<void>,
  ): Promise<void> {
    const real = globalThis.fetch;
    const capture: { last?: CapturedClaim } = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method =
        url instanceof Request ? url.method : (init?.method ?? "GET");
      // C-820 — registerStack now does a GET merge-read (union the announce into
      // the principal's existing caps) BEFORE the POST. These tests model a
      // FIRST registration with nothing on record, so the GET returns 404
      // (absent) → the union falls back to the announce verbatim, exactly the
      // shape these tests assert on the captured POST.
      if (method === "GET") {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      // registerStackIdentity always sends a JSON string body — parse it.
      const body = typeof init?.body === "string" ? init.body : "";
      capture.last = JSON.parse(body) as CapturedClaim;
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    return fn(capture).finally(() => {
      globalThis.fetch = real;
    });
  }

  function cfgWithSeed(
    seedPath: string,
    announceCapabilities: string[],
  ): LivePortsConfig {
    return {
      networkId: "metafactory",
      principalId: "jc",
      stackId: "jc/sage-host",
      registryUrl: "https://registry.meta-factory.ai",
      seedPath,
      natsConfigPath: "/x/local.conf",
      plistPath: "/nonexistent/plist",
      announceCapabilities,
    };
  }

  test("announces each declared cap with networks:[networkId] → principal lands in roster", async () => {
    const dir = freshDir();
    const seedPath = join(dir, "jc.nk");
    generateStackIdentity({ seedPath }); // real seed file (no network I/O)

    await withFetchCapture(async (capture) => {
      const ports = buildLivePorts(cfgWithSeed(seedPath, ["chat", "release"]));
      const res = await ports.registry.registerStack();
      expect(res.ok).toBe(true);

      const claim = capture.last!.claim;
      // Every announced cap carries networks:[networkId] — the implicit-
      // membership key the registry roster reads.
      expect(claim.capabilities).toEqual([
        { id: "chat", networks: ["metafactory"] },
        { id: "release", networks: ["metafactory"] },
      ]);

      // PROOF the shape lands in the roster: feed the captured claim into the
      // registry's own derivation. The principal now appears as a member.
      const store = new InMemoryRegistryStore();
      await store.putPrincipal(
        claim.principal_id,
        claim.principal_pubkey,
        claim.stacks,
        claim.capabilities,
      );
      const principals = await store.listPrincipals();
      expect(membersFromPrincipals(principals, "metafactory")).toEqual(["jc"]);
      const roster = rosterFromPrincipals(principals, "metafactory");
      expect(roster.members[0]?.principal_id).toBe("jc");
      expect(roster.members[0]?.capabilities).toEqual(["chat", "release"]);
    });
  });

    // ADR-0018 Gap-A/Gap-B (BLOCK-1) — the REAL join producer
    // (`registerStack` → `registerWithCapabilities` → `buildRegistrationClaim`)
    // MUST pin the registration to the joined network (`network_id`), or the
    // register hook raises a network-LESS PENDING row that can never enter the
    // named-network roster — even after an admin `admit`.
    test("a real join pins the claim to network_id → ADMITTED row lands in rosterFromAdmissions", async () => {
      const dir = freshDir();
      const seedPath = join(dir, "jc.nk");
      generateStackIdentity({ seedPath });

      await withFetchCapture(async (capture) => {
        const ports = buildLivePorts(cfgWithSeed(seedPath, ["chat"]));
        const res = await ports.registry.registerStack();
        expect(res.ok).toBe(true);

        const claim = capture.last!.claim;
        // The join is network-PINNED (NOT null/undefined) — this is the BLOCK-1 fix.
        expect(claim.network_id).toBe("metafactory");

        // PROOF the pinned row, once ADMITTED, lands in the admission-sourced
        // roster. Mirror the register hook: store the principal, raise the
        // (now network-pinned) admission row, admit it, derive the roster.
        const store = new InMemoryRegistryStore();
        await store.putPrincipal(
          claim.principal_id,
          claim.principal_pubkey,
          claim.stacks,
          claim.capabilities,
        );
        const admitted: AdmissionRequest[] = [
          {
            request_id: "req-1",
            principal_id: claim.principal_id,
            peer_pubkey: claim.principal_pubkey,
            requested_scope: `federated.${claim.principal_id}.>`,
            network_id: claim.network_id!, // the pinned network
            status: "ADMITTED",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            granted_by: "admin-pubkey",
            sealed_secret: null,
            hub_authorized_at: null,
          },
        ];
        const principals = await store.listPrincipals();
        const roster = rosterFromAdmissions(admitted, principals, "metafactory");
        expect(roster.members.map((m) => m.principal_id)).toEqual(["jc"]);
        expect(roster.members[0]?.capabilities).toEqual(["chat"]);

        // CONTROL — had the join NOT pinned the network (the pre-fix bug), the
        // same admission machinery with a network-less row yields an EMPTY
        // roster: proof the pin is load-bearing, not incidental.
        const networkless: AdmissionRequest[] = [{ ...admitted[0]!, network_id: null }];
        expect(rosterFromAdmissions(networkless, principals, "metafactory").members).toEqual([]);
      });
    });

  test("a cap targeting ANOTHER network is NOT in this network's roster", async () => {
    const store = new InMemoryRegistryStore();
    // jc announced chat into "metafactory"; andreas announced chat into "other".
    await store.putPrincipal("jc", "k1", [{ stack_id: "jc/sage-host" }], [
      { id: "chat", networks: ["metafactory"] },
    ]);
    await store.putPrincipal("andreas", "k2", [{ stack_id: "andreas/meta-factory" }], [
      { id: "chat", networks: ["other"] },
    ]);
    const principals = await store.listPrincipals();
    // Only jc is in metafactory; andreas (targets "other") is NOT.
    expect(membersFromPrincipals(principals, "metafactory")).toEqual(["jc"]);
    expect(membersFromPrincipals(principals, "other")).toEqual(["andreas"]);
  });

  test("empty announceCapabilities → registers with NO cap (pre-#762 empty-roster path)", async () => {
    const dir = freshDir();
    const seedPath = join(dir, "jc.nk");
    generateStackIdentity({ seedPath });

    await withFetchCapture(async (capture) => {
      const ports = buildLivePorts(cfgWithSeed(seedPath, []));
      const res = await ports.registry.registerStack();
      expect(res.ok).toBe(true);
      // No capability announced → the principal does NOT join the roster.
      expect(capture.last!.claim.capabilities).toEqual([]);
      const store = new InMemoryRegistryStore();
      const c = capture.last!.claim;
      await store.putPrincipal(c.principal_id, c.principal_pubkey, c.stacks, c.capabilities);
      const principals = await store.listPrincipals();
      expect(membersFromPrincipals(principals, "metafactory")).toEqual([]);
    });
  });
});

// =============================================================================
// C-791 — `cortex network join` register step supports multi-stack principals.
//
// These tests drive the REAL network-registry Worker route end-to-end (the same
// route #787's per-stack-pubkeys tests use), so the add-stack authorization +
// rotation gate run EXACTLY as in production — no re-implemented verifier. We
// stub `globalThis.fetch` to route the adapter's register/GET calls into
// `registryApp.fetch(request, env)`.
// =============================================================================

describe("C-791 — registerStack supports a principal's 2nd+ stack", () => {
  let env: Env;
  let registryPubkey = "";

  /** Route `globalThis.fetch` into the live registry Worker for the duration of `fn`. */
  function withLiveRegistry(fn: () => Promise<void>): Promise<void> {
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    return fn().finally(() => {
      globalThis.fetch = real;
    });
  }

  const REGISTRY_URL = "http://localhost";

  function cfg(overrides: Partial<LivePortsConfig>): LivePortsConfig {
    return {
      networkId: "metafactory",
      principalId: "andreas",
      stackId: "andreas/meta-factory",
      registryUrl: REGISTRY_URL,
      // C-791 — the merge-read is signature-verified, so the live join pins the
      // registry pubkey (from policy.federated.registry.pubkey in production).
      registryPubkey,
      natsConfigPath: "/x/local.conf",
      plistPath: "/nonexistent/plist",
      platform: "darwin",
      announceCapabilities: [],
      ...overrides,
    };
  }

  async function getRecord(
    principalId: string,
  ): Promise<{ stacks: { stack_id: string; stack_pubkey?: string }[]; capabilities: { id: string; networks?: string[] }[] }> {
    const res = await registryApp.fetch(
      new Request(`${REGISTRY_URL}/principals/${principalId}`),
      env,
    );
    if (res.status === 404) return { stacks: [], capabilities: [] };
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    return { stacks: json.payload.stacks, capabilities: json.payload.capabilities };
  }

  async function getStacks(principalId: string): Promise<{ stack_id: string; stack_pubkey?: string }[]> {
    return (await getRecord(principalId)).stacks;
  }

  /** Networks tagged on the principal's `capabilities[]` (the roster-membership key). */
  async function networksOnRecord(principalId: string): Promise<string[]> {
    const { capabilities } = await getRecord(principalId);
    const nets = new Set<string>();
    for (const c of capabilities) for (const n of c.networks ?? []) nets.add(n);
    return [...nets].sort();
  }

  // Fresh registry + keys per test.
  async function setup(): Promise<void> {
    resetStores();
    const reg = await makeRegistryKey();
    registryPubkey = reg.publicKey;
    env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  test("first-stack join (no --principal-seed) registers, principal absent ⇒ unchanged", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    generateStackIdentity({ seedPath: rootSeed });

    await withLiveRegistry(async () => {
      const ports = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      const res = await ports.registry.registerStack();
      expect(res.ok).toBe(true);
      const stacks = await getStacks("andreas");
      expect(stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
    });
  });

  test("2nd-stack join WITH --principal-seed succeeds (no 409) + preserves the existing stack", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk"); // andreas/meta-factory (the root)
    const communitySeed = join(dir, "community.nk"); // andreas/community (2nd stack)
    const rootMat = generateStackIdentity({ seedPath: rootSeed });
    const communityMat = generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      // Establish the principal via a first-stack join (root signs its own).
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);

      // 2nd-stack join: the joining stack key (community) ≠ the registered root.
      // WITHOUT --principal-seed this would 409 at the rotation gate. WITH it,
      // the root signs the add-stack claim and existing stacks are merged.
      const second = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
        }),
      );
      const res = await second.registry.registerStack();
      expect(res.ok).toBe(true); // NOT a 409

      // Both stacks survive, each with its own pubkey; root unchanged.
      const stacks = await getStacks("andreas");
      const byId = Object.fromEntries(stacks.map((s) => [s.stack_id, s.stack_pubkey]));
      expect(Object.keys(byId).sort()).toEqual(["andreas/community", "andreas/meta-factory"]);
      expect(byId["andreas/meta-factory"]).toBe(rootMat.pubkeyB64);
      expect(byId["andreas/community"]).toBe(communityMat.pubkeyB64);
    });
  });

  test("2nd-stack join WITHOUT --principal-seed 409s (no auth relaxation) — root-auth still required", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);

      // No --principal-seed: the community key signs + declares itself as
      // principal_pubkey ≠ registered root → the registry's rotation gate
      // rejects it (409). This proves #787's root-authorization is NOT relaxed:
      // a non-root key cannot add a stack via the join path either.
      const second = buildLivePorts(
        cfg({ networkId: "community-net", stackId: "andreas/community", seedPath: communitySeed }),
      );
      const res = await second.registry.registerStack();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("HTTP 409");

      // The community stack was NOT added.
      const stacks = await getStacks("andreas");
      expect(stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
    });
  });

  test("idempotent: a FULLY-CONVERGED re-join (stack + caps on record) is a NO-OP skip", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);
      // Add community WITH caps announced into community-net (root-signed).
      const add = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
          announceCapabilities: ["chat.relay"],
        }),
      );
      expect((await add.registry.registerStack()).ok).toBe(true);

      // Re-run the SAME community join (stack pubkey + caps already on record):
      // converged ⇒ skip. No 409, even without --principal-seed.
      const rejoin = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          announceCapabilities: ["chat.relay"],
        }),
      );
      const res = await rejoin.registry.registerStack();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.note).toContain("idempotent");

      const stacks = await getStacks("andreas");
      expect(stacks.map((s) => s.stack_id).sort()).toEqual([
        "andreas/community",
        "andreas/meta-factory",
      ]);
    });
  });

  test("MAJOR 1 — an already-registered stack whose network caps are NOT yet announced STILL announces (lands in roster)", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      // meta-factory established.
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);

      // community registered out-of-band (the provision-stack path) WITHOUT any
      // network caps — the real #791 scenario. Roster for community-net is empty.
      const provision = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
          announceCapabilities: [], // no caps yet
        }),
      );
      expect((await provision.registry.registerStack()).ok).toBe(true);
      expect(await networksOnRecord("andreas")).toEqual([]); // NOT in any roster

      // Now `cortex network join community-net` with caps to announce. The stack
      // pubkey is already on record, but the caps are NOT — so the join must NOT
      // skip; it must announce so the principal lands in community-net's roster.
      const joinWithCaps = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
          announceCapabilities: ["chat.relay"],
        }),
      );
      const res = await joinWithCaps.registry.registerStack();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.note).not.toContain("idempotent"); // did NOT skip

      // The principal is now in community-net's roster (cap tagged with it).
      expect(await networksOnRecord("andreas")).toContain("community-net");
    });
  });

  test("MAJOR 2 — adding a 2nd stack PRESERVES the prior-network capability/roster membership", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      // meta-factory joins the `metafactory` network WITH a cap → in that roster.
      const first = buildLivePorts(
        cfg({
          networkId: "metafactory",
          stackId: "andreas/meta-factory",
          seedPath: rootSeed,
          announceCapabilities: ["code-review.ts"],
        }),
      );
      expect((await first.registry.registerStack()).ok).toBe(true);
      expect(await networksOnRecord("andreas")).toEqual(["metafactory"]);

      // Add community into `community-net` WITH its own cap. The full-overwrite
      // register MUST NOT drop meta-factory's metafactory-tagged cap.
      const add = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
          announceCapabilities: ["chat.relay"],
        }),
      );
      expect((await add.registry.registerStack()).ok).toBe(true);

      // BOTH networks survive on the capability set → BOTH rosters intact.
      expect(await networksOnRecord("andreas")).toEqual(["community-net", "metafactory"]);
    });
  });

  test("MAJOR 3 SECURITY — a TAMPERED principal-read fails closed (merge aborts, no overwrite)", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);
    });

    // Now route the principal GET through a MALICIOUS proxy that tampers the
    // payload (drops a stack) while leaving the (now-invalid) signature. The
    // verified merge-read must REJECT it and the add-stack must abort.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const res = await registryApp.fetch(req, env);
      if (req.method === "GET" && req.url.includes("/principals/")) {
        const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
        // Tamper: wipe the stacks array but keep the original signature.
        json.payload = { ...json.payload, stacks: [] };
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return res;
    }) as typeof globalThis.fetch;
    try {
      const add = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
        }),
      );
      const res = await add.registry.registerStack();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/did not verify|unverified|merge/i);
    } finally {
      globalThis.fetch = real;
    }

    // The registry still holds only meta-factory (the tampered merge never applied).
    const stacks = await getStacks("andreas");
    expect(stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
  });

  test("MAJOR 3 SECURITY — no pinned registry pubkey fails closed on the add-stack merge-read", async () => {
    await setup();
    const dir = freshDir();
    const rootSeed = join(dir, "root.nk");
    const communitySeed = join(dir, "community.nk");
    generateStackIdentity({ seedPath: rootSeed });
    generateStackIdentity({ seedPath: communitySeed });

    await withLiveRegistry(async () => {
      const first = buildLivePorts(cfg({ stackId: "andreas/meta-factory", seedPath: rootSeed }));
      expect((await first.registry.registerStack()).ok).toBe(true);

      // Add-stack with NO registryPubkey pinned → the merge-read can't verify →
      // fail closed (never re-attest off an unverifiable read).
      const add = buildLivePorts(
        cfg({
          networkId: "community-net",
          stackId: "andreas/community",
          seedPath: communitySeed,
          rootSeedPath: rootSeed,
          registryPubkey: undefined,
        }),
      );
      const res = await add.registry.registerStack();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/no pinned registry pubkey|unverif/i);
      const stacks = await getStacks("andreas");
      expect(stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
    });
  });
});

// =============================================================================
// C-797 — leaf-state port reads the authoritative /leafz view
// =============================================================================

describe("C-797 buildLeafStatePort (/leafz monitor)", () => {
  function leafCfg(monitorUrl?: string): LivePortsConfig {
    return {
      networkId: "metafactory",
      principalId: "andreas",
      stackId: "andreas/meta-factory",
      natsConfigPath: NATS_CONFIG,
      ...(monitorUrl !== undefined && { monitorUrl }),
    };
  }

  /** Stub global fetch, recording the URL hit, returning the given /leafz body. */
  function stubFetch(
    body: unknown,
    opts: { ok?: boolean; throws?: boolean } = {},
  ): { urls: string[]; restore: () => void } {
    const real = globalThis.fetch;
    const urls: string[] = [];
    // The leafz adapter always calls fetch() with a string URL (mirrors the
    // existing withFetchCapture stub in this file).
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (opts.throws === true) throw new Error("ECONNREFUSED");
      return {
        ok: opts.ok ?? true,
        async json() {
          return body;
        },
      } as Response;
    }) as typeof globalThis.fetch;
    return { urls, restore: () => (globalThis.fetch = real) };
  }

  test("always wires a port (never undefined) — C-797 status reads leafz by default", () => {
    // Pre-#797 this returned undefined when monitorUrl was omitted → link:unknown.
    expect(typeof buildLeafStatePort(leafCfg()).linkStates).toBe("function");
  });

  test("defaults to the local nats-server monitor when --monitor-url is omitted", async () => {
    const f = stubFetch({ leafs: [] });
    try {
      await buildLeafStatePort(leafCfg()).linkStates();
      expect(f.urls).toEqual([`${DEFAULT_MONITOR_URL}/leafz`]);
    } finally {
      f.restore();
    }
  });

  test("honors an explicit --monitor-url override (trailing slash trimmed)", async () => {
    const f = stubFetch({ leafs: [] });
    try {
      await buildLeafStatePort(leafCfg("http://127.0.0.1:8224/")).linkStates();
      expect(f.urls).toEqual(["http://127.0.0.1:8224/leafz"]);
    } finally {
      f.restore();
    }
  });

  test("maps a connected leaf to 'established', keyed by the leaf-node name", async () => {
    const f = stubFetch({
      leafs: [{ name: "shared-hub", in_msgs: 12, out_msgs: 4 }],
    });
    try {
      const states = await buildLeafStatePort(leafCfg()).linkStates();
      expect(states["shared-hub"]).toEqual({
        state: "established",
        inMsgs: 12,
        outMsgs: 4,
      });
    } finally {
      f.restore();
    }
  });

  test("falls back to the bound account when /leafz omits the leaf name", async () => {
    const f = stubFetch({ leafs: [{ account: "ALOCALACCOUNT", in_msgs: 1 }] });
    try {
      const states = await buildLeafStatePort(leafCfg()).linkStates();
      expect(states.ALOCALACCOUNT?.state).toBe("established");
    } finally {
      f.restore();
    }
  });

  test("degrades to {} when the monitor is unreachable (status → 'unknown')", async () => {
    const f = stubFetch(undefined, { throws: true });
    try {
      const states = await buildLeafStatePort(leafCfg()).linkStates();
      expect(states).toEqual({});
    } finally {
      f.restore();
    }
  });

  test("degrades to {} on a non-200 monitor response", async () => {
    const f = stubFetch({ leafs: [{ name: "x" }] }, { ok: false });
    try {
      const states = await buildLeafStatePort(leafCfg()).linkStates();
      expect(states).toEqual({});
    } finally {
      f.restore();
    }
  });
});


// =============================================================================
// #799 — the live leaf-file port renders a NO-ACCOUNT remote for a $G/default
// bus (binding rides in the creds JWT) and an account-bound remote for an
// operator-mode bus. Round-trips a real temp nats config + leaf dir.
// =============================================================================

function descriptorForLeaf(networkId: string): NetworkDescriptor {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    members: [],
  };
}

describe("#799 live leaf write renders no-account vs account-bound by bus type", () => {
  test("$G/default bus + creds → leaf include file has NO account line", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    // A $G/default-account bus: no account tree (no operator-mode key,
    // no `accounts{}`, no resolver_preload).
    writeFileSync(conf, "jetstream { store_dir: /x/js }\nhttp: localhost:8222\n", "utf-8");

    const cfg: LivePortsConfig = {
      networkId: "metafactory-community",
      principalId: "jc",
      stackId: "jc/default",
      natsConfigPath: conf,
      plistPath: "/nonexistent/plist",
    };
    const ports = buildLivePorts(cfg);

    // The orchestrator decides the bind mode is creds-only → it passes a binding
    // with NO account. Here we drive the port directly with that binding.
    const inputs: RenderLeafInputs = {
      descriptor: brandVerified(descriptorForLeaf("metafactory-community")),
      binding: { credentials: "/Users/jc/.config/nats/jc.creds" },
    };
    ports.leafFile.write(inputs);

    const leaf = readFileSync(join(dir, "leafnodes-metafactory-community.conf"), "utf-8");
    expect(leaf).toContain('credentials: "/Users/jc/.config/nats/jc.creds"');
    expect(leaf).toContain('url: "tls://hub.meta-factory.ai:7422"');
    // The critical assertion: NO account line (would crash a $G nats-server).
    expect(leaf).not.toContain("account:");

    // And resolveBindMode for this bus + creds returns creds-only.
    const mode = ports.leafFile.resolveBindMode(undefined, true);
    expect(mode.mode).toBe("creds-only");
  });

  test("operator-mode bus that defines the account → leaf has the account line", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const account = "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX";
    writeFileSync(
      conf,
      `operator: /x/operator.creds\nresolver_preload: {\n  ${account}: eyJ...\n}\n`,
      "utf-8",
    );
    const cfg: LivePortsConfig = {
      networkId: "metafactory",
      principalId: "andreas",
      stackId: "andreas/meta-factory",
      natsConfigPath: conf,
      plistPath: "/nonexistent/plist",
    };
    const ports = buildLivePorts(cfg);

    // resolveBindMode says operator-account for this bus + the defined account.
    const mode = ports.leafFile.resolveBindMode(account, true);
    expect(mode.mode).toBe("operator-account");

    const inputs: RenderLeafInputs = {
      descriptor: brandVerified(descriptorForLeaf("metafactory")),
      binding: { credentials: "/Users/andreas/.config/nats/andreas.creds", account },
    };
    ports.leafFile.write(inputs);
    const leaf = readFileSync(join(dir, "leafnodes-metafactory.conf"), "utf-8");
    expect(leaf).toContain(`account: ${account}`);
  });

  test("no creds at all → resolveBindMode refuses (can't authenticate)", () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "jetstream { store_dir: /x/js }\n", "utf-8");
    const ports = buildLivePorts({
      networkId: "n",
      principalId: "jc",
      stackId: "jc/default",
      natsConfigPath: conf,
      plistPath: "/nonexistent/plist",
    });
    const mode = ports.leafFile.resolveBindMode(undefined, false);
    expect(mode.mode).toBe("refuse");
  });
});

// =============================================================================
// #801 — `leave` (live) preserves the base `-c <config>` plist arg. Drives the
// REAL leave orchestration over live FILE ports, but injects a NO-OP daemon
// port so no `launchctl` is ever spawned (the S4 SAFETY rule — no live
// mutation/exec in tests). After leaving the last network, the plist STILL
// carries `-c <config>` so nats-server stays startable.
// =============================================================================

describe("#801 leave preserves the base -c arg (nats stays startable)", () => {
  test("after leave with NO networks remaining, the plist still has -c <config>", async () => {
    const dir = freshDir();
    const conf = join(dir, "local.conf");
    const plistPath = join(dir, "nats.plist");

    // Base config that INCLUDES one leaf, and a plist already loading `-c conf`.
    writeFileSync(
      conf,
      ['system_account: ADSYS', 'include "leafnodes-metafactory.conf"', ""].join("\n"),
      "utf-8",
    );
    writeFileSync(join(dir, "leafnodes-metafactory.conf"), "leafnodes { remotes: [] }\n", "utf-8");
    // Plist with -c <conf> already present + a real nats Label.
    writeFileSync(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>Label</key>",
        "\t<string>ai.meta-factory.nats.meta-factory</string>",
        "\t<key>ProgramArguments</key>",
        "\t<array>",
        "\t\t<string>/opt/homebrew/bin/nats-server</string>",
        "\t\t<string>-c</string>",
        `\t\t<string>${conf}</string>`,
        "\t</array>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
      "utf-8",
    );

    // A stack config carrying the one joined network, in the flat layout under a
    // temp HOME (so the live ConfigStorePort reads/writes it).
    const home = freshDir();
    const stacksDir = join(home, ".config", "cortex", "stacks");
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      join(stacksDir, "default.yaml"),
      [
        "policy:",
        "  federated:",
        "    networks:",
        "      - id: metafactory",
        "        leaf_node: metafactory",
        "        peers: []",
        "        accept_subjects: [federated.jc.default.>]",
        "        deny_subjects: []",
        "        announce_capabilities: []",
        "        max_hop: 1",
        "",
      ].join("\n"),
      "utf-8",
    );

    const cfg: LivePortsConfig = {
      networkId: "metafactory",
      principalId: "jc",
      stackId: "jc/default",
      natsConfigPath: conf,
      plistPath,
      platform: "darwin",
    };

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const ports = buildLivePorts(cfg);
      // Inject a no-op daemon port — the live file teardown is what we assert on;
      // we must NOT spawn launchctl in a test (S4 SAFETY rule).
      const noSpawnPorts = {
        ...ports,
        daemon: { async restart() { return { ok: true } as const; } },
      };
      await leaveNetwork("metafactory", noSpawnPorts);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }

    // The base config is intact and STILL referenced by the plist `-c` arg
    // (the #801 fix: leave NEVER strips it).
    const plistAfter = readFileSync(plistPath, "utf-8");
    expect(plistAfter).toContain("<string>-c</string>");
    expect(plistAfter).toContain(`<string>${conf}</string>`);

    // The network-specific teardown DID happen: the include directive is gone +
    // the leaf file deleted + the policy entry removed.
    const confAfter = readFileSync(conf, "utf-8");
    expect(confAfter).not.toContain('include "leafnodes-metafactory.conf"');
    expect(confAfter).toContain("system_account: ADSYS"); // base config intact
    expect(existsSync(join(dir, "leafnodes-metafactory.conf"))).toBe(false);
  });
});

// =============================================================================
// #800 — the daemon-restart port resolves the cortex daemon's service from the
// `--config` arg (cortexConfigPath), NOT the guessed `cortex.<slug>` label. The
// dry-run port is inert; error branches (no config threaded / no matching
// service) never spawn launchctl. The resolution logic itself is covered by
// daemon-locator.test.ts; here we pin the PORT's behaviour + reasons.
// =============================================================================

describe("#800 daemon restart port", () => {
  test("dry-run daemon restart is inert (no spawn, ok)", async () => {
    const ports = buildDryRunPorts({
      networkId: "metafactory",
      principalId: "jc",
      stackId: "jc/default",
      cortexConfigPath: "/Users/jc/.config/cortex/cortex.yaml",
      platform: "darwin",
    });
    const res = await ports.daemon.restart();
    expect(res.ok).toBe(true);
  });

  test("live restart fails cleanly when no cortex config path is threaded", async () => {
    const ports = buildLivePorts({
      networkId: "metafactory",
      principalId: "jc",
      stackId: "jc/default",
      platform: "darwin",
      // cortexConfigPath intentionally unset.
    });
    const res = await ports.daemon.restart();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("cortexConfigPath");
  });

  test("live restart fails cleanly when no installed service matches the config (no spawn)", async () => {
    const ports = buildLivePorts({
      networkId: "metafactory",
      principalId: "jc",
      stackId: "jc/default",
      // A config path no installed plist/unit references → resolves to nothing.
      cortexConfigPath: "/tmp/cortex-c800-nonexistent-config.yaml",
      platform: "darwin",
    });
    const res = await ports.daemon.restart();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no cortex daemon service found");
  });
});
