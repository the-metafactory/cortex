/**
 * C-1351 Slice 1 — `cortex stack delete` (local teardown) CLI tests.
 *
 * Covers: the DEFAULT-safe dry-run plan (touches nothing), the --apply teardown
 * (config dir + this stack's OWN nats conf removed, shared network-keyed leaf
 * files PRESERVED per #1384, seed RETIRED not deleted), idempotency (2nd run is
 * a clean no-op), the joined-network refusal (fail-closed, both modes), the
 * --confirm destructive-action gate, --purge-seeds, and the per-artifact
 * failure branch (continue + record + non-zero exit, #1384).
 *
 * NEVER touches the real home — every test points --config-dir / --nats-dir /
 * --launch-agents-dir at fresh tmp dirs, and never creates a plist (so the
 * launchd path is skipped and no real `launchctl` runs). Mirrors the
 * stack-cli.test.ts real-tmp-fs harness.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchStack } from "../stack";

const tmpDirs: string[] = [];
function freshRoots(): { configDir: string; natsDir: string; launchAgentsDir: string } {
  const base = mkdtempSync(join(tmpdir(), "c1351-delete-"));
  tmpDirs.push(base);
  const configDir = join(base, "config", "cortex");
  const natsDir = join(base, "config", "nats");
  const launchAgentsDir = join(base, "LaunchAgents");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(natsDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  return { configDir, natsDir, launchAgentsDir };
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Seed a split-layout stack under <configDir>/<slug>/. `networks` (default
 *  none) populates policy.federated.networks[] to exercise the joined gate. */
function seedSplitStack(
  configDir: string,
  slug: string,
  opts: { principal?: string; networks?: string[] } = {},
): void {
  const principal = opts.principal ?? "andreas";
  const dir = join(configDir, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), "nats:\n  url: nats://127.0.0.1:4222\n");
  writeFileSync(join(dir, `${slug}.yaml`), "pointer: true\n");
  let policyBlock = "";
  if (opts.networks !== undefined && opts.networks.length > 0) {
    const entries = opts.networks
      .map((id) => `      - id: ${id}\n        leaf_node: ${id}\n`)
      .join("");
    policyBlock = `policy:\n  federated:\n    networks:\n${entries}`;
  }
  writeFileSync(
    join(dir, "stacks", `${slug}.yaml`),
    `principal:\n  id: ${principal}\nstack:\n  id: ${principal}/${slug}\n${policyBlock}`,
  );
}

/** Seed the nats material (rendered conf + optional leaf include + seed). */
function seedNatsMaterial(
  natsDir: string,
  slug: string,
  opts: { leafNetwork?: string; seed?: boolean } = {},
): void {
  let conf = `port: 4222\nserver_name: ${slug}\n`;
  if (opts.leafNetwork !== undefined) {
    conf += `include "leafnodes-${opts.leafNetwork}.conf"\n`;
    writeFileSync(join(natsDir, `leafnodes-${opts.leafNetwork}.conf`), "leafnodes { remotes: [] }\n");
  }
  writeFileSync(join(natsDir, `${slug}.conf`), conf);
  if (opts.seed !== false) writeFileSync(join(natsDir, `cortex-${slug}.nk`), "SU_FAKE_SEED\n");
}

function delArgs(
  slug: string,
  roots: { configDir: string; natsDir: string; launchAgentsDir: string },
  extra: string[] = [],
): string[] {
  return [
    "delete",
    slug,
    "--config-dir",
    roots.configDir,
    "--nats-dir",
    roots.natsDir,
    "--launch-agents-dir",
    roots.launchAgentsDir,
    ...extra,
  ];
}

// =============================================================================
// dry-run (DEFAULT)
// =============================================================================

describe("delete — dry-run (default)", () => {
  test("prints the teardown plan and touches NOTHING", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    seedNatsMaterial(roots.natsDir, "research");

    const res = await dispatchStack(delArgs("research", roots));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("teardown plan");
    expect(res.stdout).toContain("config-split stack dir");
    expect(res.stdout).toContain("[retire] signing seed");
    // Nothing removed.
    expect(existsSync(join(roots.configDir, "research"))).toBe(true);
    expect(existsSync(join(roots.natsDir, "research.conf"))).toBe(true);
    expect(existsSync(join(roots.natsDir, "cortex-research.nk"))).toBe(true);
  });

  test("absent artifacts show as skip; nothing-to-remove when the stack is gone", async () => {
    const roots = freshRoots();
    const res = await dispatchStack(delArgs("ghost", roots));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nothing to remove");
  });
});

// =============================================================================
// apply teardown + idempotency
// =============================================================================

describe("delete — apply", () => {
  test("--apply --confirm tears down config + OWN nats conf; PRESERVES shared leaf file; seed RETIRED (#1384)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    seedNatsMaterial(roots.natsDir, "research", { leafNetwork: "metafactory" });

    const res = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research"]));

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("torn down");
    // Config dir (incl. pointer) + this stack's OWN rendered nats conf gone.
    expect(existsSync(join(roots.configDir, "research"))).toBe(false);
    expect(existsSync(join(roots.natsDir, "research.conf"))).toBe(false);
    // #1384 (MAJOR) — the shared, network-keyed leaf file is PRESERVED: it is
    // owned by `cortex network leave`, and a live sibling stack on the same
    // network may still include it. Deleting it here would break the sibling.
    expect(existsSync(join(roots.natsDir, "leafnodes-metafactory.conf"))).toBe(true);
    // Seed RETIRED (renamed), not deleted.
    expect(existsSync(join(roots.natsDir, "cortex-research.nk"))).toBe(false);
    const retired = readdirSync(roots.natsDir).filter((f) => f.startsWith("cortex-research.nk.retired-"));
    expect(retired.length).toBe(1);
  });

  test("second run is a clean idempotent no-op (no throw, exit 0)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    seedNatsMaterial(roots.natsDir, "research");

    const first = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research"]));
    expect(first.exitCode).toBe(0);

    const second = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research"]));
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("nothing to remove");
  });

  test("--purge-seeds wipes the seed (no retired sibling left)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    seedNatsMaterial(roots.natsDir, "research");

    const res = await dispatchStack(
      delArgs("research", roots, ["--apply", "--confirm", "research", "--purge-seeds"]),
    );
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(roots.natsDir, "cortex-research.nk"))).toBe(false);
    const retired = readdirSync(roots.natsDir).filter((f) => f.includes(".retired-"));
    expect(retired.length).toBe(0);
  });
});

// =============================================================================
// joined-network gate (fail-closed)
// =============================================================================

describe("delete — joined-network refusal", () => {
  test("refuses (exit 1) when joined, with the leave-first message — dry-run", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research", { networks: ["metafactory"] });
    seedNatsMaterial(roots.natsDir, "research");

    const res = await dispatchStack(delArgs("research", roots));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("still joined");
    expect(res.stderr).toContain("cortex network leave metafactory --apply");
    // Fail-closed: nothing removed.
    expect(existsSync(join(roots.configDir, "research"))).toBe(true);
  });

  test("refuses under --apply too (never orphans a live roster membership)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research", { networks: ["metafactory", "othernet"] });

    const res = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research"]));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("2 network(s)");
    expect(existsSync(join(roots.configDir, "research"))).toBe(true);
  });
});

// =============================================================================
// --confirm destructive-action gate
// =============================================================================

describe("delete — --confirm gate", () => {
  test("--apply without --confirm → usage error (exit 2)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    const res = await dispatchStack(delArgs("research", roots, ["--apply"]));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--confirm");
    // Nothing removed.
    expect(existsSync(join(roots.configDir, "research"))).toBe(true);
  });

  test("--confirm mismatch → usage error (exit 2, never a glob)", async () => {
    const roots = freshRoots();
    seedSplitStack(roots.configDir, "research");
    const res = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "reseach"]));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("does not match");
    expect(existsSync(join(roots.configDir, "research"))).toBe(true);
  });

  test("invalid slug → usage error (exit 2)", async () => {
    const roots = freshRoots();
    const res = await dispatchStack(delArgs("Bad Slug", roots));
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be lowercase");
  });
});

describe("delete — apply, per-artifact failure branch (#1384)", () => {
  // Force ONE artifact removal to fail deterministically + hermetically: seed the
  // rendered nats conf as a NON-EMPTY DIRECTORY where a file is expected, so the
  // `remove-file` op (`rmSync(path, { force: true })`, no `recursive`) throws.
  // The other artifacts remove cleanly — proving the loop CONTINUES past failure.
  function seedWithUnremovableConf(roots: {
    configDir: string;
    natsDir: string;
    launchAgentsDir: string;
  }): void {
    seedSplitStack(roots.configDir, "research");
    writeFileSync(join(roots.natsDir, "cortex-research.nk"), "SU_FAKE_SEED\n");
    const confAsDir = join(roots.natsDir, "research.conf");
    mkdirSync(confAsDir, { recursive: true });
    writeFileSync(join(confAsDir, "blocker"), "x\n"); // non-empty → non-recursive rm throws
  }

  test("--json: records the failure, continues, exits NON-ZERO with per-action failed flag + failed_count", async () => {
    const roots = freshRoots();
    seedWithUnremovableConf(roots);

    const res = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research", "--json"]));

    // Partial teardown is NOT a success — the exit code is the machine signal.
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stdout) as {
      status: string;
      items: { label: string; path: string; failed?: string; failed_reason?: string }[];
      data: Record<string, string>;
    };
    expect(env.data.applied).toBe("true");
    expect(env.data.failed_count).toBe("1");
    const failed = env.items.find((i) => i.failed === "true");
    expect(failed).toBeDefined();
    expect(failed!.label).toBe("rendered nats config");
    expect(typeof failed!.failed_reason).toBe("string");
    // The loop CONTINUED: the config-split dir was still removed and the seed
    // still retired despite the earlier per-artifact failure.
    expect(existsSync(join(roots.configDir, "research"))).toBe(false);
    const retired = readdirSync(roots.natsDir).filter((f) => f.startsWith("cortex-research.nk.retired-"));
    expect(retired.length).toBe(1);
  });

  test("human mode: surfaces the ⚠ failure + PARTIAL banner, exits NON-ZERO", async () => {
    const roots = freshRoots();
    seedWithUnremovableConf(roots);

    const res = await dispatchStack(delArgs("research", roots, ["--apply", "--confirm", "research"]));

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/⚠ rendered nats config teardown failed \(continuing\)/);
    expect(res.stdout).toMatch(/PARTIAL teardown/);
  });
});
