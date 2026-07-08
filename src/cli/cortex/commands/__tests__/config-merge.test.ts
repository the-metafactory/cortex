/**
 * config-merge tests (F-6a, cortex#858) — TDD-first, mirroring the
 * normalize-config test style: pure merge functions with fixtures + the CLI
 * file-I/O path (runConfigMerge against a tmp config-split dir).
 *
 * Coverage:
 *   Pure
 *     1. CapabilityMergeFragmentSchema — accepts caps-only, policy-only, both
 *     2. CapabilityMergeFragmentSchema — rejects empty, rejects extra keys
 *     3. mergeFragmentIntoLayer — append new capability into empty layer
 *     4. mergeFragmentIntoLayer — idempotent (same fragment twice → skipped)
 *     5. mergeFragmentIntoLayer — fragment-wins on id-match-but-different
 *     6. mergeFragmentIntoLayer — policy principals + roles id-keyed append
 *     7. mergeFragmentIntoLayer — does not mutate input
 *     8. removeFragmentFromLayer — removes by id; absent id is a no-op
 *     9. summariseNotes — added/skipped/changed phrasing + idempotent marker
 *    10. deepMerge edge cases via id-keyed merge (empty base / null policy)
 *   CLI (file I/O)
 *    11. --help exits 0
 *    12. missing --config / --fragment → exit 2 (usage)
 *    13. merge into config-split stacks/research.yaml + writes backup
 *    14. idempotent: second run = no write (no new backup)
 *    15. --dry-run: validates, prints diff, no write
 *    16. --stack required when >1 stack file; selects correct file
 *    17. --rollback removes the capability
 *    18. merged config that breaks CortexConfigSchema → exit 1, no write
 *    19. fragment with extra top-level key → exit 1 (schema reject)
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";

import {
  CapabilityMergeFragmentSchema,
  mergeFragmentIntoLayer,
  removeFragmentFromLayer,
  summariseNotes,
  resolveTarget,
  runConfigMerge,
  type CapabilityMergeFragment,
} from "../config-merge";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CAP_DEV: Rec = {
  id: "dev.implement",
  description: "Dev agent implementation",
  tags: ["dev"],
  provided_by: ["dev-agent"],
};

const CAP_DEV_V2: Rec = {
  id: "dev.implement",
  description: "Dev agent implementation (revised)",
  tags: ["dev", "code"],
  provided_by: ["dev-agent"],
};

const ROLE_DEVELOP: Rec = {
  id: "develop",
  capabilities: ["dev.implement"],
};

const PRINCIPAL_DEV: Rec = {
  id: "dev-agent",
  home_principal: "andreas",
  home_stack: "andreas/research",
  role: ["develop"],
};

function fragment(partial: Rec): CapabilityMergeFragment {
  return CapabilityMergeFragmentSchema.parse(partial);
}

// A complete, valid cortex.yaml shape for a config-split stack layer. Combined
// with the minimal system.yaml below it composes into a valid CortexConfig.
function stackLayer(extra: Rec = {}): Rec {
  return {
    principal: { id: "andreas", displayName: "Andreas", discordId: "111111111111111111" },
    stack: { id: "andreas/research" },
    agents: [
      {
        id: "dev-agent",
        displayName: "Dev Agent",
        persona: "./personas/dev.md",
        presence: {
          discord: {
            token: "DISCORD_TOKEN",
            guildId: "111111111111111111",
            agentChannelId: "222222222222222222",
            logChannelId: "333333333333333333",
          },
        },
      },
    ],
    ...extra,
  };
}

const SYSTEM_YAML = YAML.stringify({
  claude: { model: "claude-opus-4-5", apiKey: "env:ANTHROPIC_API_KEY" },
});

// ---------------------------------------------------------------------------
// 1–2. Fragment schema
// ---------------------------------------------------------------------------

describe("CapabilityMergeFragmentSchema", () => {
  test("accepts capabilities-only", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({ capabilities: [CAP_DEV] });
    expect(f.success).toBe(true);
  });

  test("accepts policy-only", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({
      policy: { principals: [PRINCIPAL_DEV], roles: [ROLE_DEVELOP] },
    });
    expect(f.success).toBe(true);
  });

  test("accepts both capabilities + policy", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({
      capabilities: [CAP_DEV],
      policy: { roles: [ROLE_DEVELOP] },
    });
    expect(f.success).toBe(true);
  });

  test("rejects empty fragment (no capabilities, no policy)", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({});
    expect(f.success).toBe(false);
  });

  test("rejects extra top-level key (agents)", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({
      capabilities: [CAP_DEV],
      agents: [{ id: "x" }],
    });
    expect(f.success).toBe(false);
  });

  test("rejects extra policy sub-key", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({
      policy: { principals: [], roles: [], superRefineTrap: true },
    });
    expect(f.success).toBe(false);
  });

  test("rejects malformed capability id (uppercase)", () => {
    const f = CapabilityMergeFragmentSchema.safeParse({
      capabilities: [{ ...CAP_DEV, id: "Dev.Implement" }],
    });
    expect(f.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3–7. mergeFragmentIntoLayer
// ---------------------------------------------------------------------------

describe("mergeFragmentIntoLayer", () => {
  test("appends a new capability into an empty layer", () => {
    const { layer, notes } = mergeFragmentIntoLayer({}, fragment({ capabilities: [CAP_DEV] }));
    const caps = layer.capabilities as Rec[];
    expect(caps).toHaveLength(1);
    expect(caps[0]?.id).toBe("dev.implement");
    expect(notes).toEqual([{ kind: "capability", id: "dev.implement", action: "added" }]);
  });

  test("idempotent — same fragment twice yields skipped on second", () => {
    const f = fragment({ capabilities: [CAP_DEV] });
    const first = mergeFragmentIntoLayer({}, f);
    const second = mergeFragmentIntoLayer(first.layer, f);
    expect((second.layer.capabilities as Rec[])).toHaveLength(1);
    expect(second.notes).toEqual([{ kind: "capability", id: "dev.implement", action: "skipped" }]);
  });

  test("fragment wins on id-match-but-different (changed)", () => {
    const base = mergeFragmentIntoLayer({}, fragment({ capabilities: [CAP_DEV] })).layer;
    const { layer, notes } = mergeFragmentIntoLayer(base, fragment({ capabilities: [CAP_DEV_V2] }));
    const caps = layer.capabilities as Rec[];
    expect(caps).toHaveLength(1);
    expect(caps[0]?.description).toBe("Dev agent implementation (revised)");
    expect(notes).toEqual([{ kind: "capability", id: "dev.implement", action: "changed" }]);
  });

  test("policy principals + roles id-keyed append", () => {
    const { layer, notes } = mergeFragmentIntoLayer(
      {},
      fragment({ policy: { principals: [PRINCIPAL_DEV], roles: [ROLE_DEVELOP] } }),
    );
    const policy = layer.policy as Rec;
    expect((policy.principals as Rec[])).toHaveLength(1);
    expect((policy.roles as Rec[])).toHaveLength(1);
    expect(notes.some((n) => n.kind === "principal" && n.action === "added")).toBe(true);
    expect(notes.some((n) => n.kind === "role" && n.action === "added")).toBe(true);
  });

  test("merges into an existing policy without dropping prior principals", () => {
    const existing: Rec = {
      policy: {
        principals: [{ id: "andreas", home_principal: "andreas", home_stack: "andreas/research", role: [] }],
        roles: [],
      },
    };
    const { layer } = mergeFragmentIntoLayer(existing, fragment({ policy: { principals: [PRINCIPAL_DEV] } }));
    const principals = (layer.policy as Rec).principals as Rec[];
    expect(principals.map((p) => p.id).sort()).toEqual(["andreas", "dev-agent"]);
  });

  test("does not mutate input layer", () => {
    const input: Rec = { capabilities: [structuredClone(CAP_DEV)] };
    const snapshot = JSON.stringify(input);
    mergeFragmentIntoLayer(input, fragment({ capabilities: [CAP_DEV_V2] }));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 8. removeFragmentFromLayer
// ---------------------------------------------------------------------------

describe("removeFragmentFromLayer", () => {
  test("removes a capability by id", () => {
    const base = mergeFragmentIntoLayer({}, fragment({ capabilities: [CAP_DEV] })).layer;
    const { layer, notes } = removeFragmentFromLayer(base, fragment({ capabilities: [CAP_DEV] }));
    expect((layer.capabilities as Rec[])).toHaveLength(0);
    expect(notes).toEqual([{ kind: "capability", id: "dev.implement", action: "removed" }]);
  });

  test("absent id is a no-op (absent note)", () => {
    const { layer, notes } = removeFragmentFromLayer({}, fragment({ capabilities: [CAP_DEV] }));
    expect((layer.capabilities as Rec[])).toHaveLength(0);
    expect(notes).toEqual([{ kind: "capability", id: "dev.implement", action: "absent" }]);
  });

  test("removes policy principals + roles by id", () => {
    const base = mergeFragmentIntoLayer(
      {},
      fragment({ policy: { principals: [PRINCIPAL_DEV], roles: [ROLE_DEVELOP] } }),
    ).layer;
    const { layer } = removeFragmentFromLayer(
      base,
      fragment({ policy: { principals: [PRINCIPAL_DEV], roles: [ROLE_DEVELOP] } }),
    );
    const policy = layer.policy as Rec;
    expect((policy.principals as Rec[])).toHaveLength(0);
    expect((policy.roles as Rec[])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. summariseNotes
// ---------------------------------------------------------------------------

describe("summariseNotes", () => {
  test("phrases added + skipped", () => {
    const s = summariseNotes([
      { kind: "capability", id: "a", action: "added" },
      { kind: "capability", id: "b", action: "added" },
      { kind: "role", id: "r", action: "skipped" },
    ]);
    expect(s).toContain("2 capabilities added");
    expect(s).toContain("1 roles skipped");
  });

  test("marks idempotent no-op when every note is skipped/absent", () => {
    const s = summariseNotes([{ kind: "capability", id: "a", action: "skipped" }]);
    expect(s).toContain("idempotent no-op");
  });

  test("empty notes → no changes", () => {
    expect(summariseNotes([])).toBe("no changes");
  });
});

// ---------------------------------------------------------------------------
// CLI file-I/O — runConfigMerge against tmp config-split dirs
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-merge-test-"));
});

/** Build a config-split dir with system/ + one (or more) stack files. */
function makeSplitDir(stacks: Record<string, Rec>): string {
  const dir = join(tmpDir, `cfg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), SYSTEM_YAML, "utf-8");
  for (const [name, content] of Object.entries(stacks)) {
    writeFileSync(join(dir, "stacks", `${name}.yaml`), YAML.stringify(content, { lineWidth: 0 }), "utf-8");
  }
  return dir;
}

function writeFragment(name: string, content: Rec): string {
  const p = join(tmpDir, name);
  writeFileSync(p, YAML.stringify(content, { lineWidth: 0 }), "utf-8");
  return p;
}

describe("runConfigMerge — CLI", () => {
  test("--help exits 0", async () => {
    expect(await runConfigMerge(["--help"])).toBe(0);
  });

  test("missing --config exits 2 (usage)", async () => {
    expect(await runConfigMerge(["--fragment", "x.yaml"])).toBe(2);
  });

  test("missing --fragment exits 2 (usage)", async () => {
    expect(await runConfigMerge(["--config", "x"])).toBe(2);
  });

  test("unknown flag exits 2 (usage)", async () => {
    expect(await runConfigMerge(["--nope"])).toBe(2);
  });

  test("merges a capability into a single-stack split dir + writes backup", async () => {
    const dir = makeSplitDir({ research: stackLayer() });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });

    const code = await runConfigMerge(["--config", dir, "--fragment", frag]);
    expect(code).toBe(0);

    const written = YAML.parse(readFileSync(join(dir, "stacks", "research.yaml"), "utf-8")) as Rec;
    const caps = written.capabilities as Rec[];
    expect(caps.map((c) => c.id)).toContain("dev.implement");

    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-config-merge-"));
    expect(backups.length).toBe(1);
  });

  test("#883 backup file is created with mode 0o600 (secret-at-rest)", async () => {
    // The backup can carry platform tokens (Discord/Slack/Mattermost) from
    // the source cortex.yaml. It must not be world-readable. Mirrors the
    // chmod-600 enforcement on cortex.yaml itself (#644 / TC-4a).
    const dir = makeSplitDir({ research: stackLayer() });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });

    const code = await runConfigMerge(["--config", dir, "--fragment", frag]);
    expect(code).toBe(0);

    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-config-merge-"));
    expect(backups.length).toBe(1);
    const backupPath = join(dir, "stacks", backups[0]!);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  test("idempotent — second run writes nothing (no second backup)", async () => {
    const dir = makeSplitDir({ research: stackLayer() });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });

    expect(await runConfigMerge(["--config", dir, "--fragment", frag])).toBe(0);
    expect(await runConfigMerge(["--config", dir, "--fragment", frag])).toBe(0);

    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-config-merge-"));
    expect(backups.length).toBe(1); // only the first run produced a backup
  });

  test("--dry-run validates + prints diff but does NOT write", async () => {
    const dir = makeSplitDir({ research: stackLayer() });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });
    const before = readFileSync(join(dir, "stacks", "research.yaml"), "utf-8");

    const code = await runConfigMerge(["--config", dir, "--fragment", frag, "--dry-run"]);
    expect(code).toBe(0);

    const after = readFileSync(join(dir, "stacks", "research.yaml"), "utf-8");
    expect(after).toBe(before);
    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-config-merge-"));
    expect(backups.length).toBe(0);
  });

  test("--stack required when >1 stack file; selects the right one", async () => {
    const dir = makeSplitDir({
      research: stackLayer(),
      work: stackLayer({ stack: { id: "andreas/work" } }),
    });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });

    // No --stack with 2 stack files → exit 1 (ambiguous target).
    expect(await runConfigMerge(["--config", dir, "--fragment", frag])).toBe(1);

    // --stack by declared id selects work.yaml.
    const code = await runConfigMerge(["--config", dir, "--fragment", frag, "--stack", "andreas/work"]);
    expect(code).toBe(0);

    const work = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    expect((work.capabilities as Rec[]).map((c) => c.id)).toContain("dev.implement");
    const research = YAML.parse(readFileSync(join(dir, "stacks", "research.yaml"), "utf-8")) as Rec;
    expect(research.capabilities).toBeUndefined(); // untouched
  });

  test("--rollback removes the capability", async () => {
    const dir = makeSplitDir({ research: stackLayer({ capabilities: [CAP_DEV] }) });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });

    const code = await runConfigMerge(["--config", dir, "--fragment", frag, "--rollback"]);
    expect(code).toBe(0);

    const written = YAML.parse(readFileSync(join(dir, "stacks", "research.yaml"), "utf-8")) as Rec;
    expect((written.capabilities as Rec[])).toHaveLength(0);
  });

  test("merge that breaks CortexConfigSchema → exit 1, no write", async () => {
    // Capability whose provided_by names a non-existent agent → the
    // composed-whole superRefine (dangling provider) fails.
    const dir = makeSplitDir({ research: stackLayer() });
    const badCap = { ...CAP_DEV, provided_by: ["ghost-agent"] };
    const frag = writeFragment("frag.yaml", { capabilities: [badCap] });
    const before = readFileSync(join(dir, "stacks", "research.yaml"), "utf-8");

    const code = await runConfigMerge(["--config", dir, "--fragment", frag]);
    expect(code).toBe(1);

    const after = readFileSync(join(dir, "stacks", "research.yaml"), "utf-8");
    expect(after).toBe(before); // original intact
  });

  test("fragment with extra top-level key → exit 1 (schema reject)", async () => {
    const dir = makeSplitDir({ research: stackLayer() });
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV], nats: { subjects: [] } });
    expect(await runConfigMerge(["--config", dir, "--fragment", frag])).toBe(1);
  });

  test("nonexistent --config exits 1", async () => {
    const frag = writeFragment("frag.yaml", { capabilities: [CAP_DEV] });
    expect(await runConfigMerge(["--config", join(tmpDir, "nope"), "--fragment", frag])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveTarget — single-file legacy form
// ---------------------------------------------------------------------------

describe("resolveTarget", () => {
  test("single-file legacy: target IS the cortex.yaml", () => {
    const p = join(tmpDir, "cortex.yaml");
    writeFileSync(p, YAML.stringify(stackLayer()), "utf-8");
    const t = resolveTarget(p, undefined);
    expect(t.singleFile).toBe(true);
    expect(t.filePath).toBe(p);
  });

  test("single-file + --stack → throws", () => {
    const p = join(tmpDir, "cortex.yaml");
    writeFileSync(p, YAML.stringify(stackLayer()), "utf-8");
    expect(() => resolveTarget(p, "andreas/research")).toThrow();
  });

  test("split dir with 1 stack + no --stack → that stack", () => {
    const dir = makeSplitDir({ research: stackLayer() });
    const t = resolveTarget(dir, undefined);
    expect(t.singleFile).toBe(false);
    expect(t.filePath.endsWith("research.yaml")).toBe(true);
  });

  test("merges into single-file legacy config end-to-end", async () => {
    const p = join(tmpDir, "cortex.yaml");
    // Single-file form carries `claude` inline (no system/ layer to supply it).
    const single = stackLayer({ claude: { model: "claude-opus-4-5", apiKey: "env:ANTHROPIC_API_KEY" } });
    writeFileSync(p, YAML.stringify(single, { lineWidth: 0 }), "utf-8");
    chmodSync(p, 0o600); // single-file loader enforces chmod 600 (TC-4a)
    const frag = join(tmpDir, "frag.yaml");
    writeFileSync(frag, YAML.stringify({ capabilities: [CAP_DEV] }, { lineWidth: 0 }), "utf-8");

    const code = await runConfigMerge(["--config", p, "--fragment", frag]);
    expect(code).toBe(0);
    const written = YAML.parse(readFileSync(p, "utf-8")) as Rec;
    expect((written.capabilities as Rec[]).map((c) => c.id)).toContain("dev.implement");
    expect(existsSync(p)).toBe(true);
  });
});
