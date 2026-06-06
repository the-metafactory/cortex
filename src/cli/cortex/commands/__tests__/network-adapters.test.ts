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
  buildLivePorts,
  type LivePortsConfig,
} from "../network-adapters";
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
