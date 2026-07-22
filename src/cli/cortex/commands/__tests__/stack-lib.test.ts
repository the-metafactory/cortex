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
import { parse as parseYaml } from "yaml";

import {
  discoverStacks,
  assertAligned,
  renderScaffold,
  resolveStackArtifacts,
  readJoinedNetworkIds,
  parseLeafIncludeFiles,
  retiredSeedPath,
  codeCapabilityBashAllowlist,
  CODE_GIT_VERBS,
  CODE_GIT_WRITE_VERBS,
  CODE_GH_PR_VERBS,
  CODE_GH_ISSUE_VERBS,
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

  test("system/system.yaml does NOT emit a LIVE bus/bot credsPath a single-stack never mints (cortex#2264)", () => {
    // cortex#2264: a from-scratch, NON-federated scaffold must NOT ship an
    // active `nats.credsPath` — a single-stack quickstart never runs
    // `cortex network make-live`, so `<slug>-bot.creds` is never minted, and a
    // live path made the runtime fail the bus connect ENOENT (silent bus death
    // behind the boot gate). The key is DOCUMENTED (commented) with a note that
    // make-live adds it back; it must not appear as a live YAML mapping.
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    // No ACTIVE (uncommented, indented mapping) credsPath key.
    expect(system?.contents).not.toMatch(/^\s*credsPath:/m);
    // The bot-creds path is still documented as a commented reference so
    // make-live's derivation + the `-bot` distinction stay discoverable.
    expect(system?.contents).toContain("# credsPath: ~/.config/nats/demo-bot.creds");
    // The commented reference names make-live as the thing that adds it back.
    expect(system?.contents).toMatch(/make-live/);
    // Guardrail: the bus path (if ever uncommented) must stay DISTINCT from the
    // federation default `~/.config/nats/<slug>.creds` for the same slug.
    expect(system?.contents).not.toMatch(/^\s*credsPath: ~\/\.config\/nats\/demo\.creds/m);
  });

  test("the PARSED system.yaml the daemon loads has no nats.credsPath (cortex#2264)", () => {
    // The runtime only attempts creds-auth when `nats.credsPath` is a set value
    // (runtime.ts: `...(nats.credsPath ? { credsPath } : {})`). Prove the daemon's
    // loaded VIEW carries no such key — a commented line must not parse to one.
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    const parsed = parseYaml(system?.contents ?? "") as { nats?: { credsPath?: unknown } };
    expect(parsed.nats).toBeDefined();
    expect(parsed.nats?.credsPath).toBeUndefined();
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

  test("system/system.yaml's nats.name is slug-scoped, not the generic 'cortex' (cortex#2055)", () => {
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    // Slug-scoped client connection label so multi-stack hosts are distinguishable.
    expect(system?.contents).toMatch(/^\s*name:\s*cortex-demo\s*$/m);
    // Must NOT ship the old generic non-slug default.
    expect(system?.contents).not.toMatch(/^\s*name:\s*cortex\s*$/m);
  });

  // cortex#2097 — the scaffold documents the dispatch cwd fallback's
  // canonical default, slug-scoped, as a COMMENTED line (the dir itself is
  // created out-of-band by `stack.ts`'s --apply write, not by this pure
  // renderer — see stack-cli.test.ts for the disk-side assertion).
  test("system/system.yaml documents claude.workspaceDir's canonical default, commented + slug-scoped (cortex#2097)", () => {
    const files = renderScaffold(inputs);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    expect(system?.contents).toContain(
      "# workspaceDir: ~/.local/share/metafactory/cortex/demo/workspace",
    );
    // Commented, not active — `stack create` never forces the key into the
    // parsed config; the daemon resolves the same default at runtime absent it.
    expect(system?.contents).not.toMatch(/^\s*workspaceDir:/m);
  });
});

// =============================================================================
// cortex#2331 (7a) — the code-capability bash allowlist
// =============================================================================

describe("codeCapabilityBashAllowlist", () => {
  // ---------------------------------------------------------------------------
  // cortex#2331 (7a) review F3 — VERB-SET LOCK. Pin the exact verb sets so a
  // future edit that widens them (adds `merge`, `reset`, `gh api`, …) trips a
  // failing test, not a silent authority expansion. Exact-equality on the
  // approved lists + negative assertions against the dangerous verbs.
  // ---------------------------------------------------------------------------
  test("(F3) the gh pr verb set is EXACTLY [create, view, list, diff, checks]", () => {
    expect([...CODE_GH_PR_VERBS]).toEqual(["create", "view", "list", "diff", "checks"]);
  });

  test("(F3) the git WRITE verb set is EXACTLY the approved eight", () => {
    expect([...CODE_GIT_WRITE_VERBS]).toEqual([
      "checkout",
      "switch",
      "add",
      "commit",
      "push",
      "pull",
      "restore",
      "stash",
    ]);
  });

  test("(F3) the gh issue verb set is EXACTLY [view, list, comment, create]", () => {
    expect([...CODE_GH_ISSUE_VERBS]).toEqual(["view", "list", "comment", "create"]);
  });

  test("(F3 negative) the git rule pattern contains NO reset/rebase/merge", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const gitRule = al.rules.find((r) => r.pattern.startsWith("^git"));
    expect(gitRule).toBeDefined();
    for (const forbidden of ["reset", "rebase", "merge"]) {
      expect(gitRule?.pattern).not.toContain(forbidden);
    }
  });

  test("(F3 negative) no gh rule pattern contains 'merge' or 'api'", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const ghRules = al.rules.filter((r) => r.pattern.startsWith("^gh"));
    expect(ghRules.length).toBeGreaterThan(0);
    for (const ghRule of ghRules) {
      expect(ghRule.pattern).not.toContain("merge");
      expect(ghRule.pattern).not.toContain("api");
    }
  });

  test("(F2) the gh issue rule is present and pinned to the granted repo", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const issueRule = al.rules.find((r) => r.pattern.startsWith("^gh\\s+issue"));
    expect(issueRule).toBeDefined();
    for (const verb of CODE_GH_ISSUE_VERBS) {
      expect(issueRule?.pattern).toContain(verb);
    }
    expect(issueRule?.repos).toEqual(["the-metafactory/cortex"]);
  });

  test("(F2) the gh pr comment rule is present and pinned to the granted repo", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const prCommentRule = al.rules.find((r) => r.pattern === "^gh\\s+pr\\s+comment\\b");
    expect(prCommentRule).toBeDefined();
    expect(prCommentRule?.repos).toEqual(["the-metafactory/cortex"]);
  });

  test("git rule carries the exact read + write verb set, unscoped (repo scoping is cwd)", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const gitRule = al.rules.find((r) => r.pattern.startsWith("^git"));
    expect(gitRule).toBeDefined();
    // Every declared git verb appears in the alternation…
    for (const verb of CODE_GIT_VERBS) {
      expect(gitRule?.pattern).toContain(verb);
    }
    // …the write verbs the coding loop needs are present…
    for (const verb of ["checkout", "switch", "add", "commit", "push", "pull", "restore", "stash"]) {
      expect(gitRule?.pattern).toContain(verb);
    }
    // …and git rules are NEVER repo-scoped (that field governs gh only).
    expect(gitRule?.repos).toBeUndefined();
  });

  test("gh rule carries the exact pr verbs, pinned to the granted repo", () => {
    const al = codeCapabilityBashAllowlist(["the-metafactory/cortex"]);
    const ghRule = al.rules.find((r) => r.pattern.startsWith("^gh"));
    expect(ghRule).toBeDefined();
    for (const verb of CODE_GH_PR_VERBS) {
      expect(ghRule?.pattern).toContain(verb);
    }
    expect(ghRule?.repos).toEqual(["the-metafactory/cortex"]);
  });

  test("with no granted repo the gh rule ships UNSCOPED (falls back to github.repos)", () => {
    const al = codeCapabilityBashAllowlist([]);
    const ghRule = al.rules.find((r) => r.pattern.startsWith("^gh"));
    expect(ghRule?.repos).toBeUndefined();
  });

  test("retains the read-only utility floor (bashAllowlist REPLACES DEFAULT_CONFIG)", () => {
    const al = codeCapabilityBashAllowlist([]);
    const patterns = al.rules.map((r) => r.pattern);
    // A code agent must not lose ls/cat/pwd when its allowlist replaces the floor.
    expect(patterns).toContain("^ls\\b");
    expect(patterns).toContain("^cat\\b");
    expect(patterns).toContain("^pwd$");
  });
});

describe("renderScaffold — code capability (cortex#2331 7a)", () => {
  const base: ScaffoldInputs = {
    slug: "demo",
    principal: "andreas",
    stackId: "andreas/demo",
    agentId: "luna",
    displayName: "Luna",
    seedPath: "~/.config/nats/cortex-demo.nk",
  };

  test("(b) chat-only scaffold writes NO bashAllowlist (unchanged floor)", () => {
    const files = renderScaffold(base);
    const system = files.find((f) => f.relPath === "system/system.yaml");
    expect(system?.contents).not.toContain("bashAllowlist");
    const parsed = parseYaml(system?.contents ?? "") as { claude?: { bashAllowlist?: unknown } };
    expect(parsed.claude?.bashAllowlist).toBeUndefined();
    // And the agent stays chat-only in the stack catalog + runtime.
    const stack = files.find((f) => f.relPath === "stacks/demo.yaml");
    expect(stack?.contents).not.toContain("id: code");
  });

  test("(a) code scaffold writes the allowlist with the exact verb set + repo pinning", () => {
    const files = renderScaffold({ ...base, capabilities: ["chat", "code"], grantedRepos: ["the-metafactory/cortex"] });
    const system = files.find((f) => f.relPath === "system/system.yaml");
    const parsed = parseYaml(system?.contents ?? "") as {
      claude?: { bashAllowlist?: { rules: { pattern: string; repos?: string[] }[]; repos: string[] } };
    };
    const al = parsed.claude?.bashAllowlist;
    expect(al).toBeDefined();
    const gitRule = al?.rules.find((r) => r.pattern.startsWith("^git"));
    for (const verb of ["checkout", "switch", "add", "commit", "push", "pull", "restore", "stash", "log", "status"]) {
      expect(gitRule?.pattern).toContain(verb);
    }
    const ghRule = al?.rules.find((r) => r.pattern.startsWith("^gh"));
    expect(ghRule?.pattern).toContain("create");
    expect(ghRule?.repos).toEqual(["the-metafactory/cortex"]);

    // The agent declares chat + code in BOTH the catalog and its runtime.
    const stack = files.find((f) => f.relPath === "stacks/demo.yaml");
    expect(stack?.contents).toContain("id: code");
    const parsedStack = parseYaml(stack?.contents ?? "") as {
      agents?: { runtime?: { capabilities?: string[] } }[];
      capabilities?: { id: string }[];
    };
    expect(parsedStack.agents?.[0]?.runtime?.capabilities).toEqual(["chat", "code"]);
    expect((parsedStack.capabilities ?? []).map((c) => c.id).sort()).toEqual(["chat", "code"]);
  });

  test("code scaffold WITHOUT a granted repo writes the allowlist but leaves gh unscoped", () => {
    const files = renderScaffold({ ...base, capabilities: ["chat", "code"], grantedRepos: [] });
    const system = files.find((f) => f.relPath === "system/system.yaml");
    const parsed = parseYaml(system?.contents ?? "") as {
      claude?: { bashAllowlist?: { rules: { pattern: string; repos?: string[] }[] } };
    };
    const ghRule = parsed.claude?.bashAllowlist?.rules.find((r) => r.pattern.startsWith("^gh"));
    expect(ghRule).toBeDefined();
    expect(ghRule?.repos).toBeUndefined();
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
