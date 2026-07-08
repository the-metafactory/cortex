/**
 * normalize-config tests — TDD-first, covering the pure normalizeVocab logic
 * and the CLI main path.
 *
 * Test cases:
 *   1. top-level home_operator renamed to home_principal
 *   2. policy.principals[].home_operator renamed (the JC case)
 *   3. nested occurrences renamed recursively
 *   4. operatorId NOT renamed — only warned
 *   5. top-level operator: block NOT renamed — only warned
 *   6. NSC / NATS operator config NOT renamed (deep nats: block)
 *   7. idempotent — no home_operator → no renames, no warnings
 *   8. normalized output passes CortexConfigSchema.parse
 *   + schema validation surfaces when config is still invalid after rename
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";

import { normalizeVocab, runNormalizeConfig } from "../normalize-config";
import { CortexConfigSchema } from "../../../../common/types/cortex-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid cortex.yaml shape that satisfies CortexConfigSchema. */
const MINIMAL_VALID: Record<string, unknown> = {
  principal: { id: "jcfischer", dataResidency: "CH" },
  agents: [
    {
      id: "sage",
      displayName: "Sage",
      persona: "./personas/sage.md",
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
  renderers: [],
  claude: { model: "claude-opus-4-5", apiKey: "env:ANTHROPIC_API_KEY" },
};

type StringRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 1. Pure normalizeVocab — rename logic
// ---------------------------------------------------------------------------

describe("normalizeVocab", () => {
  // Case 1: top-level home_operator renamed
  test("renames top-level home_operator to home_principal", () => {
    const raw: StringRecord = { home_operator: "jcfischer", id: "jcfischer" };
    const { result, renames, warnings } = normalizeVocab(raw);
    const r = result as StringRecord;
    expect(r.home_principal).toBe("jcfischer");
    expect(r.home_operator).toBeUndefined();
    expect(renames).toHaveLength(1);
    expect(renames[0]).toContain("home_operator");
    expect(warnings).toHaveLength(0);
  });

  // Case 2: policy.principals[].home_operator renamed (the JC case)
  test("renames home_operator inside policy.principals[] (JC case)", () => {
    const raw: StringRecord = {
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
          { id: "echo", home_operator: "echo", home_stack: "echo/default", role: [] },
        ],
        roles: [],
      },
    };
    const { result, renames, warnings } = normalizeVocab(raw);
    const policy = (result as StringRecord).policy as StringRecord;
    const principals = policy.principals as StringRecord[];
    expect(principals[0]?.home_principal).toBe("jcfischer");
    expect(principals[0]?.home_operator).toBeUndefined();
    expect(principals[1]?.home_principal).toBe("echo");
    expect(principals[1]?.home_operator).toBeUndefined();
    expect(renames).toHaveLength(2);
    expect(warnings).toHaveLength(0);
  });

  // Case 3: nested occurrences renamed recursively
  test("renames home_operator at arbitrary nesting depth", () => {
    const raw: StringRecord = {
      level1: {
        level2: {
          home_operator: "deep-value",
          other: "keep",
        },
      },
    };
    const { result, renames } = normalizeVocab(raw);
    const l1 = (result as StringRecord).level1 as StringRecord;
    const l2 = l1.level2 as StringRecord;
    expect(l2.home_principal).toBe("deep-value");
    expect(l2.home_operator).toBeUndefined();
    expect(l2.other).toBe("keep");
    expect(renames).toHaveLength(1);
  });

  // Case 4: operatorId NOT renamed — only warned
  test("does NOT rename operatorId, emits warning instead", () => {
    const raw: StringRecord = { operatorId: "some-id", id: "ok" };
    const { result, renames, warnings } = normalizeVocab(raw);
    // operatorId must remain untouched
    expect((result as StringRecord).operatorId).toBe("some-id");
    expect(renames).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("operatorId"))).toBe(true);
  });

  // Case 5: top-level operator: block NOT renamed — only warned
  test("does NOT rename top-level operator: block, emits warning", () => {
    const raw: StringRecord = {
      operator: { id: "jcfischer", displayName: "JC" },
      principal: { id: "jcfischer" },
    };
    const { result, renames, warnings } = normalizeVocab(raw);
    // operator block must remain
    expect((result as StringRecord).operator).toBeDefined();
    expect(renames).toHaveLength(0);
    expect(warnings.some((w) => w.includes("operator"))).toBe(true);
  });

  // Case 6: deep nats: block with operator keys NOT touched (NSC context)
  test("does NOT rename operator keys inside nats: block", () => {
    const raw: StringRecord = {
      nats: {
        url: "nats://localhost:4222",
        operator_account: "my-operator",
      },
    };
    const { result, renames } = normalizeVocab(raw);
    const nats = (result as StringRecord).nats as StringRecord;
    // operator_account is not home_operator — must not be renamed
    expect(nats.operator_account).toBe("my-operator");
    expect(renames).toHaveLength(0);
  });

  // Case 7: idempotent — no home_operator → no renames, no warnings
  test("is idempotent when no home_operator is present", () => {
    const raw: StringRecord = {
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_principal: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    };
    const { result, renames, warnings } = normalizeVocab(raw);
    expect(renames).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    // Structure is unchanged
    const policy = (result as StringRecord).policy as StringRecord;
    const principals = policy.principals as StringRecord[];
    expect(principals[0]?.home_principal).toBe("jcfischer");
  });

  // Case 8: normalized output passes CortexConfigSchema
  test("output passes CortexConfigSchema.parse after renaming home_operator", () => {
    const raw: StringRecord = {
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    };
    const { result } = normalizeVocab(raw);
    // Must not throw
    expect(() => CortexConfigSchema.parse(result)).not.toThrow();
  });

  test("key collision: home_operator + home_principal in same block → warn, NOT rename (no clobber)", () => {
    // Both keys present in one object — renaming would overwrite home_principal.
    const raw: StringRecord = {
      policy: {
        principals: [
          {
            id: "jc",
            home_operator: "LEGACY_VALUE",
            home_principal: "CANONICAL_VALUE",
            home_stack: "jc/default",
            role: [],
          },
        ],
      },
    };
    const { result, renames, warnings } = normalizeVocab(raw);
    // No rename performed.
    expect(renames).toHaveLength(0);
    // A collision warning is emitted, naming both keys.
    expect(warnings.some((w) => w.includes("Key collision") && w.includes("home_principal"))).toBe(true);
    // Neither value is clobbered — both keys survive untouched for manual resolution.
    const principal = (result as { policy: { principals: StringRecord[] } }).policy.principals[0]!;
    expect(principal.home_principal).toBe("CANONICAL_VALUE");
    expect(principal.home_operator).toBe("LEGACY_VALUE");
  });

  test("key collision is order-independent (canonical key declared first)", () => {
    // home_principal appears BEFORE home_operator — guard must still catch it.
    const raw: StringRecord = {
      principals: [{ home_principal: "A", home_operator: "B" }],
    };
    const { renames, warnings } = normalizeVocab(raw);
    expect(renames).toHaveLength(0);
    expect(warnings.some((w) => w.includes("Key collision"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI integration — runNormalizeConfig (file I/O path)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "normalize-config-test-"));
});

function writeTmp(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("runNormalizeConfig — file I/O", () => {
  test("--help exits 0", async () => {
    const code = await runNormalizeConfig(["--help"]);
    expect(code).toBe(0);
  });

  test("missing input exits 1", async () => {
    const code = await runNormalizeConfig([]);
    expect(code).toBe(1);
  });

  test("renames home_operator in fixture and writes backup", async () => {
    const fixtureRaw = YAML.stringify({
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    }, { indent: 2, lineWidth: 0 });

    const inputPath = writeTmp("cortex.yaml", fixtureRaw);
    const code = await runNormalizeConfig([inputPath]);
    expect(code).toBe(0);

    // Input file now has home_principal
    const written = readFileSync(inputPath, "utf-8");
    const parsed = YAML.parse(written) as StringRecord;
    const policy = parsed.policy as StringRecord;
    const principals = policy.principals as StringRecord[];
    expect(principals[0]?.home_principal).toBe("jcfischer");
    expect(principals[0]?.home_operator).toBeUndefined();

    // Backup file exists
    const files = readdirSync(tmpDir);
    const backup = files.find((f) => f.includes(".pre-normalize-") && f.endsWith(".bak"));
    expect(backup).toBeDefined();
  });

  test("--out writes to separate output file, does not modify input", async () => {
    const fixtureRaw = YAML.stringify({
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    }, { indent: 2, lineWidth: 0 });

    const inputPath = writeTmp("input.yaml", fixtureRaw);
    const outPath = join(tmpDir, "output.yaml");

    const code = await runNormalizeConfig([inputPath, "--out", outPath]);
    expect(code).toBe(0);

    // Input is unchanged
    const inputParsed = YAML.parse(readFileSync(inputPath, "utf-8")) as StringRecord;
    const inputPolicy = inputParsed.policy as StringRecord;
    const inputPrincipals = inputPolicy.principals as StringRecord[];
    expect(inputPrincipals[0]?.home_operator).toBe("jcfischer");

    // Output has the rename
    const outputParsed = YAML.parse(readFileSync(outPath, "utf-8")) as StringRecord;
    const outPolicy = outputParsed.policy as StringRecord;
    const outPrincipals = outPolicy.principals as StringRecord[];
    expect(outPrincipals[0]?.home_principal).toBe("jcfischer");
    expect(outPrincipals[0]?.home_operator).toBeUndefined();
  });

  test("--check reports changes without writing", async () => {
    const fixtureRaw = YAML.stringify({
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    }, { indent: 2, lineWidth: 0 });

    const inputPath = writeTmp("check.yaml", fixtureRaw);
    const originalLen = readFileSync(inputPath).length;

    const code = await runNormalizeConfig([inputPath, "--check"]);
    expect(code).toBe(0);

    // File is NOT modified — same length and same content
    const afterLen = readFileSync(inputPath).length;
    expect(afterLen).toBe(originalLen);
    const parsed = YAML.parse(readFileSync(inputPath, "utf-8")) as StringRecord;
    const policy = parsed.policy as StringRecord;
    const principals = policy.principals as StringRecord[];
    expect(principals[0]?.home_operator).toBe("jcfischer");
  });

  test("idempotent input exits 0 with no write", async () => {
    const fixtureRaw = YAML.stringify({
      ...MINIMAL_VALID,
      policy: {
        principals: [
          { id: "jcfischer", home_principal: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    }, { indent: 2, lineWidth: 0 });

    const inputPath = writeTmp("idempotent.yaml", fixtureRaw);
    const originalContent = readFileSync(inputPath, "utf-8");

    const code = await runNormalizeConfig([inputPath]);
    expect(code).toBe(0);

    // No backup created (nothing to rename)
    const files = readdirSync(tmpDir);
    const backup = files.find((f) => f.includes(".pre-normalize-") && f.endsWith(".bak"));
    expect(backup).toBeUndefined();

    // Content unchanged
    expect(readFileSync(inputPath, "utf-8")).toBe(originalContent);
  });

  test("--strict exits 2 when ambiguous legacy keys detected", async () => {
    const fixtureRaw = YAML.stringify({
      ...MINIMAL_VALID,
      // Top-level operator: block triggers ambiguous-key warning
      operator: { id: "jcfischer" },
    }, { indent: 2, lineWidth: 0 });

    const inputPath = writeTmp("strict.yaml", fixtureRaw);
    const code = await runNormalizeConfig([inputPath, "--strict"]);
    expect(code).toBe(2);
  });

  test("config still invalid after rename exits 1 with schema error", async () => {
    // A config missing required agents[] — after rename it still won't parse
    const raw: StringRecord = {
      principal: { id: "jcfischer" },
      // agents: intentionally missing — schema will reject
      policy: {
        principals: [
          { id: "jcfischer", home_operator: "jcfischer", home_stack: "jcfischer/default", role: [] },
        ],
        roles: [],
      },
    };
    const inputPath = writeTmp("invalid.yaml", YAML.stringify(raw, { indent: 2, lineWidth: 0 }));
    const code = await runNormalizeConfig([inputPath]);
    expect(code).toBe(1);
  });

  test("real fixture file normalizes and validates correctly", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "normalize-fixture.yaml",
    );
    const outPath = join(tmpDir, "normalized-fixture.yaml");
    const code = await runNormalizeConfig([fixturePath, "--out", outPath]);
    expect(code).toBe(0);

    const normalized = YAML.parse(readFileSync(outPath, "utf-8")) as StringRecord;
    const policy = normalized.policy as StringRecord;
    const principals = policy.principals as StringRecord[];
    // Both principals should have home_principal now
    expect(principals[0]?.home_principal).toBeDefined();
    expect(principals[0]?.home_operator).toBeUndefined();
    expect(principals[1]?.home_principal).toBeDefined();
    expect(principals[1]?.home_operator).toBeUndefined();
    // And validate against schema
    expect(() => CortexConfigSchema.parse(normalized)).not.toThrow();
  });
});
