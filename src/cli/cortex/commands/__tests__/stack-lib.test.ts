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
    agentId: "luna",
    displayName: "Demo",
    seedPath: "~/.config/nats/cortex-demo.nk",
  };

  test("emits the full file set", () => {
    const files = renderScaffold(inputs);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual(
      ["demo.yaml", "personas/luna.md", "stacks/demo.yaml", "surfaces/surfaces.yaml", "system/system.yaml"].sort(),
    );
  });

  test("stacks/<slug>.yaml carries the born-aligned identity + seed path", () => {
    const files = renderScaffold(inputs);
    const stack = files.find((f) => f.relPath === "stacks/demo.yaml");
    expect(stack?.contents).toContain("id: andreas/demo");
    expect(stack?.contents).toContain("nkey_seed_path: ~/.config/nats/cortex-demo.nk");
    expect(stack?.contents).toContain("luna");
  });

  test("does NOT inline any signing seed material (key auto-provisioned later)", () => {
    const files = renderScaffold(inputs);
    const all = files.map((f) => f.contents).join("\n");
    // No SU… seed ever appears in scaffolded output.
    expect(all).not.toMatch(/\bSU[A-Z0-9]{20,}/);
  });
});
