/**
 * C-808 — `cortex stack` pure-logic tests.
 *
 * The discovery scan (TS replica of plist-render.sh's discover_stack_slugs +
 * extract_stack_id_slug), the born-aligned scaffold renderer, and the
 * alignment self-check — all pure over a tmp dir / plain inputs. The CLI wiring
 * is covered by stack-cli.test.ts.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  discoverStacks,
  assertAligned,
  renderScaffold,
  resolveStackArtifacts,
  readJoinedNetworkIds,
  parseLeafIncludeFiles,
  retiredSeedPath,
  type ScaffoldInputs,
} from "../stack-lib";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c808-stack-lib-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function seedSplit(cfg: string, slug: string, stackId: string): void {
  const dir = join(cfg, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), "nats:\n  url: x\n");
  writeFileSync(join(dir, "stacks", `${slug}.yaml`), `stack:\n  id: ${stackId}\n`);
}

// =============================================================================
// discoverStacks
// =============================================================================

describe("discoverStacks", () => {
  test("finds split-layout stacks and reads stack.id", () => {
    const cfg = freshDir();
    seedSplit(cfg, "research", "andreas/research");
    seedSplit(cfg, "work", "andreas/work");
    const found = discoverStacks(cfg);
    const ids = found.map((s) => s.stackId).sort();
    expect(ids).toEqual(["andreas/research", "andreas/work"]);
    expect(found.every((s) => s.aligned)).toBe(true);
  });

  test("flags drift when dir basename != stack.id trailing segment", () => {
    const cfg = freshDir();
    seedSplit(cfg, "old-dir", "andreas/work");
    const found = discoverStacks(cfg);
    expect(found).toHaveLength(1);
    expect(found[0]?.slugLocator).toBe("old-dir");
    expect(found[0]?.stackId).toBe("andreas/work");
    expect(found[0]?.aligned).toBe(false);
  });

  test("finds legacy monolith cortex.<slug>.yaml", () => {
    const cfg = freshDir();
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "cortex.community.yaml"), "stack:\n  id: andreas/community\n");
    const found = discoverStacks(cfg);
    expect(found).toHaveLength(1);
    expect(found[0]?.stackId).toBe("andreas/community");
    expect(found[0]?.slugLocator).toBe("community");
  });

  test("directory layout wins over a same-slug legacy monolith (no dup)", () => {
    const cfg = freshDir();
    seedSplit(cfg, "research", "andreas/research");
    writeFileSync(join(cfg, "cortex.research.yaml"), "stack:\n  id: andreas/research\n");
    const found = discoverStacks(cfg);
    expect(found.filter((s) => s.slugLocator === "research")).toHaveLength(1);
  });

  test("missing config dir → empty", () => {
    expect(discoverStacks(join(tmpdir(), "c808-does-not-exist-xyz"))).toEqual([]);
  });

  test("a stack with no parseable stack.id still surfaces (id undefined)", () => {
    const cfg = freshDir();
    const dir = join(cfg, "weird");
    mkdirSync(join(dir, "system"), { recursive: true });
    mkdirSync(join(dir, "stacks"), { recursive: true });
    writeFileSync(join(dir, "system", "system.yaml"), "nats:\n  url: x\n");
    writeFileSync(join(dir, "stacks", "weird.yaml"), "principal:\n  id: andreas\n");
    const found = discoverStacks(cfg);
    expect(found).toHaveLength(1);
    expect(found[0]?.stackId).toBeUndefined();
  });
});

// =============================================================================
// assertAligned (the #808 structural guarantee)
// =============================================================================

describe("assertAligned", () => {
  test("passes when dir == slug == trailing segment of stack.id", () => {
    expect(() => assertAligned("demo", "andreas/demo")).not.toThrow();
  });

  test("throws when stack.id trailing segment != slug", () => {
    expect(() => assertAligned("demo", "andreas/other")).toThrow();
  });
});

// =============================================================================
// renderScaffold
// =============================================================================

describe("renderScaffold", () => {
  const inputs: ScaffoldInputs = {
    slug: "demo",
    principal: "andreas",
    stackId: "andreas/demo",
    agentId: "assistant",
    displayName: "Demo",
    seedPath: "~/.config/nats/cortex-demo.nk",
  };

  test("emits the full file set", () => {
    const files = renderScaffold(inputs);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual(
      ["demo.yaml", "personas/assistant.md", "stacks/demo.yaml", "surfaces/surfaces.yaml", "system/system.yaml"].sort(),
    );
  });

  test("stacks/<slug>.yaml carries the born-aligned identity + seed path", () => {
    const files = renderScaffold(inputs);
    const stack = files.find((f) => f.relPath === "stacks/demo.yaml");
    expect(stack?.contents).toContain("id: andreas/demo");
    expect(stack?.contents).toContain("nkey_seed_path: ~/.config/nats/cortex-demo.nk");
    expect(stack?.contents).toContain("assistant");
  });

  test("system/system.yaml seeds the bus/bot credsPath (~/.config/nats/<slug>-bot.creds), distinct from the federation default", () => {
    // v5.30.2 (C-1265c): a from-scratch stack carries nats.credsPath explicitly,
    // so `cortex network make-live` needs no --creds flag. The path is the
    // daemon's OWN bus/bot creds under the agents account. The `-bot` suffix is
    // load-bearing: it keeps this DISTINCT from provision's federation-user
    // default `~/.config/nats/<slug>.creds` (different NATS account → must be a
    // different file, or the second mint clobbers the first).
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    expect(system?.contents).toContain("credsPath: ~/.config/nats/demo-bot.creds");
    // The bus path must NOT equal the federation default for the same slug.
    expect(system?.contents).not.toContain("credsPath: ~/.config/nats/demo.creds");
  });

  test("does NOT inline any signing seed material (key auto-provisioned later)", () => {
    const files = renderScaffold(inputs);
    const all = files.map((f) => f.contents).join("\n");
    // No SU… seed ever appears in scaffolded output.
    expect(all).not.toMatch(/\bSU[A-Z0-9]{20,}/);
  });

  // cortex#2052: the machine-wide system.yaml must NOT ship a per-stack
  // `identity:` block. It previously carried a non-slug seedPath
  // (~/.config/nats/cortex.nk) and a placeholder publicKey the provisioner
  // never reconciled — per-stack identity is authoritative in stacks/<slug>.yaml.
  test("system/system.yaml ships NO active identity block (cortex#2052 — #3/#4)", () => {
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    // No active (uncommented) `identity:` key, and no active seedPath/publicKey.
    expect(system?.contents).not.toMatch(/^\s*identity:\s*$/m);
    expect(system?.contents).not.toMatch(/^\s*seedPath:/m);
    expect(system?.contents).not.toMatch(/^\s*publicKey:/m);
    // #3: the old non-slug seed path must not appear anywhere in the file.
    expect(system?.contents).not.toContain("cortex.nk");
  });

  test("system/system.yaml's commented identity reference is slug-aware + points at stacks/ (cortex#2052)", () => {
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    // The commented reference documents the slug-aware seed path…
    expect(system?.contents).toContain("~/.config/nats/cortex-demo.nk");
    // …and redirects to the authoritative per-stack identity source.
    expect(system?.contents).toContain("stacks/demo.yaml");
    expect(system?.contents).toMatch(/#\s*identity:/);
  });

  test("system/system.yaml's nats.url carries a review-the-port note (cortex#2052 — #2)", () => {
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    expect(system?.contents).toMatch(/url:\s*nats:\/\/127\.0\.0\.1:4222\s+#.*port/i);
  });
});

// =============================================================================
// C-1351 Slice 1 — teardown pure helpers
// =============================================================================

describe("resolveStackArtifacts", () => {
  test("computes the conventional local artifact paths for a slug", () => {
    const art = resolveStackArtifacts(
      { configDir: "/cfg/cortex", natsDir: "/cfg/nats", launchAgentsDir: "/la" },
      "research",
    );
    expect(art.configStackDir).toBe("/cfg/cortex/research");
    expect(art.policyConfigFile).toBe("/cfg/cortex/research/stacks/research.yaml");
    expect(art.natsConf).toBe("/cfg/nats/research.conf");
    expect(art.seed).toBe("/cfg/nats/cortex-research.nk");
    expect(art.daemonPlist).toBe("/la/ai.meta-factory.cortex.research.plist");
    expect(art.natsPlist).toBe("/la/ai.meta-factory.nats.research.plist");
  });
});

describe("readJoinedNetworkIds", () => {
  test("empty for an absent file", () => {
    expect(readJoinedNetworkIds(join(freshDir(), "nope.yaml"))).toEqual([]);
  });

  test("empty when no policy.federated.networks block", () => {
    const dir = freshDir();
    const f = join(dir, "s.yaml");
    writeFileSync(f, "principal:\n  id: andreas\nstack:\n  id: andreas/research\n");
    expect(readJoinedNetworkIds(f)).toEqual([]);
  });

  test("returns the joined network ids (mirrors readNetworks read path)", () => {
    const dir = freshDir();
    const f = join(dir, "s.yaml");
    writeFileSync(
      f,
      "policy:\n  federated:\n    networks:\n      - id: metafactory\n        leaf_node: metafactory\n      - id: othernet\n        leaf_node: othernet\n",
    );
    expect(readJoinedNetworkIds(f)).toEqual(["metafactory", "othernet"]);
  });
});

describe("parseLeafIncludeFiles", () => {
  test("empty for an absent conf", () => {
    expect(parseLeafIncludeFiles(join(freshDir(), "none.conf"))).toEqual([]);
  });

  test("resolves each `include \"leafnodes-*.conf\"` to an absolute path in the conf dir", () => {
    const dir = freshDir();
    const conf = join(dir, "research.conf");
    writeFileSync(
      conf,
      'port: 4222\ninclude "leafnodes-metafactory.conf"\ninclude "leafnodes-othernet.conf"\n',
    );
    expect(parseLeafIncludeFiles(conf)).toEqual([
      join(dir, "leafnodes-metafactory.conf"),
      join(dir, "leafnodes-othernet.conf"),
    ]);
  });

  test("ignores non-leaf includes", () => {
    const dir = freshDir();
    const conf = join(dir, "research.conf");
    writeFileSync(conf, 'include "resolver.conf"\ninclude "leafnodes-net.conf"\n');
    expect(parseLeafIncludeFiles(conf)).toEqual([join(dir, "leafnodes-net.conf")]);
  });
});

describe("retiredSeedPath", () => {
  test("appends .retired-<stamp> (retire, not destroy)", () => {
    expect(retiredSeedPath("/nats/cortex-research.nk", "2026-07-02T00-00-00-000Z")).toBe(
      "/nats/cortex-research.nk.retired-2026-07-02T00-00-00-000Z",
    );
  });
});
