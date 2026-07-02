// Tests for the vocabulary-migration ratchet (scripts/check-carveouts.sh).
//
// compass#98 F18 — proves the widened `[Oo]perator|OPERATOR` recall catches
// SCREAMING_SNAKE operator forms (OPERATOR_ID, OPERATOR_PUBKEY, HOME_OPERATOR,
// bare OPERATOR) that the pre-F18 `[Oo]perator` recall was blind to, while the
// whole tree stays green (carve-outs intact).
//
// SELF-CONFLICT DISCIPLINE (mirrors check-shippable-hygiene.test.ts): the
// deprecated token this suite asserts on is CONSTRUCTED AT RUNTIME by
// concatenation, never written as a literal, so this test file never itself
// trips a vocabulary/hygiene gate. The actual violating tokens live only in the
// `.txt` fixtures (which the whole-tree scan — code/doc extensions only — never
// globs, keeping the tree green while the fixtures stay catchable on demand).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GATE = join(REPO_ROOT, "scripts", "check-carveouts.sh");
const GEN = join(REPO_ROOT, "scripts", "gen-vocab-ratchet.ts");
const MANIFEST = join(REPO_ROOT, "scripts", "vocab-ratchet.json");
const FIXTURES = join(REPO_ROOT, "src", "__tests__", "fixtures", "vocab-ratchet");

// Runtime-built deprecated token — never a literal in this file.
const OP = "OPER" + "ATOR";

function runGate(...args: string[]): { code: number; out: string } {
  const res = spawnSync("bash", [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe("check-carveouts vocab ratchet (F18)", () => {
  test("flags SCREAMING_SNAKE operator forms in the screaming fixture", () => {
    const { code, out } = runGate(join(FIXTURES, "operator-screaming.txt"));
    expect(code).toBe(1);
    // Each SCREAMING_SNAKE form is caught by the widened all-caps recall.
    expect(out).toContain(`${OP}_ID`);
    expect(out).toContain(`${OP}_PUBKEY`);
    expect(out).toContain(`HOME_${OP}`);
    // Exactly the four fixture violation lines, nothing incidental.
    expect(out).toContain("4 ungated");
  });

  test("passes on the canonical (principal) clean fixture", () => {
    const { code, out } = runGate(join(FIXTURES, "operator-clean.txt"));
    expect(code).toBe(0);
    expect(out).toContain("PASS");
  });

  test(
    "whole-tree scan is green — carve-outs intact",
    () => {
      // Same scan the CI 'Vocab carve-out gate' job runs. A widened-recall
      // regression (a legit all-caps survivor losing its carve-out) fails here.
      const { code, out } = runGate();
      expect(out).toContain("PASS");
      expect(code).toBe(0);
    },
    30_000,
  );
});

describe("vocab-ratchet manifest (F17)", () => {
  test("generator reproduces the committed manifest (drift guard)", () => {
    // `--check` re-derives terms from CONTEXT.md + embedded carve-outs and diffs
    // against the committed JSON. It ALSO re-runs generation-time validation
    // (throws if a ratchet-enforced alias is not a CONTEXT.md-deprecated term),
    // so a green --check proves both no-drift AND manifest-validates-CONTEXT.md.
    const res = spawnSync("bun", [GEN, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(`${res.stdout}${res.stderr}`).toContain("OK");
    expect(res.status).toBe(0);
  });

  test("every ratchet-enforced alias is a deprecated term in CONTEXT.md", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      terms: { ratchetEnforced: string[] }[];
    };
    const context = readFileSync(join(REPO_ROOT, "CONTEXT.md"), "utf8").toLowerCase();
    const enforced = manifest.terms.flatMap((t) => t.ratchetEnforced);
    expect(enforced.length).toBeGreaterThan(0);
    for (const alias of enforced) {
      expect(context.includes(alias.toLowerCase())).toBe(true);
    }
  });

  test("gate fails closed (exit 2) when the manifest is absent", () => {
    // Copy the gate into a throwaway tree with NO manifest: the gate must refuse
    // to run rather than pass vacuously on zero patterns.
    const dir = mkdtempSync(join(tmpdir(), "vocab-ratchet-"));
    try {
      mkdirSync(join(dir, "scripts"));
      copyFileSync(GATE, join(dir, "scripts", "check-carveouts.sh"));
      const res = spawnSync("bash", [join(dir, "scripts", "check-carveouts.sh")], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(res.status).toBe(2);
      expect(`${res.stdout}${res.stderr}`).toContain("manifest not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
