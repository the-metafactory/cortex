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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

import { parse as parseYaml } from "yaml";

import {
  buildDryRunPorts,
  buildLeafStatePort,
  buildLivePorts,
  DEFAULT_MONITOR_URL,
  resolveDaemonLabel,
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
} from "../../../../services/network-registry/src/store";
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
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
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
// #800 — the cortex DAEMON restart target is resolved from the configured
// nats plist's <key>Label</key> (suffix-shared with the cortex daemon label),
// NOT from the stack slug. The peer bug: slug `default`, but the real plists
// are `…cortex.meta-factory` / `…nats.meta-factory` → a slug-derived
// `…cortex.default` label always 113/503s.
// =============================================================================

/** A nats-server plist whose Label is `ai.meta-factory.nats.<suffix>`. */
function natsPlistWithLabel(suffix: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>ai.meta-factory.nats.${suffix}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array><string>/opt/homebrew/bin/nats-server</string></array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

describe("#800 daemon restart label resolves from nats_infra.plist_path", () => {
  test("slug ≠ plist suffix → daemon label uses the PLIST suffix, not the slug", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats.plist");
    // The peer case: real nats plist suffix is `meta-factory`...
    writeFileSync(plistPath, natsPlistWithLabel("meta-factory"), "utf-8");

    const cfg: LivePortsConfig = {
      networkId: "metafactory-community",
      principalId: "jc",
      // ...but the stack slug is `default` (the slug-guess bug source).
      stackId: "jc/default",
      natsConfigPath: "/Users/jc/.config/nats/local.conf",
      plistPath,
      platform: "darwin",
    };

    // The daemon label maps `…nats.meta-factory` → `…cortex.meta-factory`,
    // NOT the slug-derived `…cortex.default`.
    expect(resolveDaemonLabel(cfg)).toBe("ai.meta-factory.cortex.meta-factory");
    expect(resolveDaemonLabel(cfg)).not.toBe("ai.meta-factory.cortex.default");
  });

  test("slug == plist suffix → unchanged (label matches the slug, as before)", () => {
    const dir = freshDir();
    const plistPath = join(dir, "nats.plist");
    writeFileSync(plistPath, natsPlistWithLabel("community"), "utf-8");
    const cfg: LivePortsConfig = {
      networkId: "community",
      principalId: "andreas",
      stackId: "andreas/community",
      natsConfigPath: "/x/local.conf",
      plistPath,
      platform: "darwin",
    };
    expect(resolveDaemonLabel(cfg)).toBe("ai.meta-factory.cortex.community");
  });

  test("a plist already carrying a `.cortex.` label is used verbatim", () => {
    const dir = freshDir();
    const plistPath = join(dir, "daemon.plist");
    writeFileSync(
      plistPath,
      natsPlistWithLabel("x").replace("nats.x", "cortex.work"),
      "utf-8",
    );
    const cfg: LivePortsConfig = {
      networkId: "n",
      principalId: "andreas",
      stackId: "andreas/default",
      natsConfigPath: "/x/local.conf",
      plistPath,
      platform: "darwin",
    };
    expect(resolveDaemonLabel(cfg)).toBe("ai.meta-factory.cortex.work");
  });

  test("no readable plist label → falls back to the slug-derived label", () => {
    const cfg: LivePortsConfig = {
      networkId: "n",
      principalId: "jc",
      stackId: "jc/default",
      natsConfigPath: "/x/local.conf",
      plistPath: "/nonexistent/nats.plist",
      platform: "darwin",
    };
    // No plist to read → the slug fallback (best effort) rather than a guess at
    // the suffix.
    expect(resolveDaemonLabel(cfg)).toBe("ai.meta-factory.cortex.default");
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
