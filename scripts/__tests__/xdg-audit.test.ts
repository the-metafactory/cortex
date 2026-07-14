// Hermetic self-test for the xdg-audit REPO GATE (cortex#1867).
//
// Pins the gate's core contract so it can't silently rot into a no-op:
//   (a) a planted stale RUNTIME literal makes the gate exit NONZERO and report it;
//   (b) the same line carrying `xdg-audit:allow(reason)` exits 0;
//   (c) an allowlist entry whose content-regex does NOT match a line must NOT
//       suppress a DIFFERENT line in the same file (narrow-match guarantee);
//   plus: bare `xdg-audit:allow` (no reason) is a hard gate error, and the
//   class rules (test files / code comments) are advisory, not gated.
//
// Runs entirely in a scratch git repo under a temp dir — never touches the real
// dev checkouts. The allowlist is supplied via $XDG_AUDIT_ALLOWLIST so the test
// is independent of the shipped scripts/xdg-audit-allow.yaml.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const AUDIT = join(REPO_ROOT, "scripts", "xdg-audit.ts");

let scratch: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Run the gate against `root` with an optional scratch allowlist. */
function runGate(root: string, allowlistPath?: string) {
  const env = { ...process.env, XDG_AUDIT_ALLOWLIST: allowlistPath ?? "/nonexistent-allowlist.yaml" };
  const r = spawnSync("bun", [AUDIT, "--repos", root, "--json"], { encoding: "utf8", env });
  let json: any = {};
  try { json = JSON.parse(r.stdout); } catch { /* leave empty; assertions below will surface it */ }
  return { status: r.status ?? -1, json, stderr: r.stderr, stdout: r.stdout };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xdg-audit-selftest-"));
  git(scratch, "init", "-q");
  git(scratch, "config", "user.email", "t@t");
  git(scratch, "config", "user.name", "t");
  // A RUNTIME literal (non-comment, non-test) — the kind the gate must catch.
  writeFileSync(join(scratch, "runtime.ts"), [
    'export const CONFIG = "~/.config/cortex/bot.yaml";  // planted stale runtime literal',
    'export const OTHER = "~/.config/grove/other.yaml";  // a DIFFERENT line, same file',
  ].join("\n") + "\n");
  // A code COMMENT line (advisory) + a TEST-file line (advisory).
  writeFileSync(join(scratch, "commented.ts"), '// legacy note: ~/.config/cortex/legacy.yaml\n');
  mkdirSync(join(scratch, "__tests__"), { recursive: true });
  writeFileSync(join(scratch, "__tests__", "fixture.test.ts"), 'const p = "~/.config/cortex/x";\n');
  git(scratch, "add", "-A");
});

afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe("xdg-audit gate — self-test (cortex#1867)", () => {
  test("(a) planted stale runtime literal → NONZERO exit + reported", () => {
    const { status, json } = runGate(scratch);
    expect(status).toBeGreaterThan(0);
    const runtimeGated = (json.gated ?? []).filter((f: any) => f.relPath === "runtime.ts");
    expect(runtimeGated.length).toBe(2); // both runtime.ts literals are gated
    // the comment line and the test-file line are advisory, NOT gated
    expect((json.gated ?? []).some((f: any) => f.relPath === "commented.ts")).toBe(false);
    expect((json.gated ?? []).some((f: any) => f.relPath.includes("__tests__"))).toBe(false);
    expect(json.summary.advisory.comment).toBeGreaterThanOrEqual(1);
    expect(json.summary.advisory.test).toBeGreaterThanOrEqual(1);
  });

  test("(b) same line with xdg-audit:allow(reason) → exit 0", () => {
    const allowed = mkdtempSync(join(tmpdir(), "xdg-audit-selftest-b-"));
    git(allowed, "init", "-q");
    git(allowed, "config", "user.email", "t@t");
    git(allowed, "config", "user.name", "t");
    writeFileSync(join(allowed, "runtime.ts"),
      'export const CONFIG = "~/.config/cortex/bot.yaml"; // xdg-audit:allow(test — deliberate legacy literal)\n');
    git(allowed, "add", "-A");
    const { status, json } = runGate(allowed);
    expect(status).toBe(0);
    expect(json.summary.gated).toBe(0);
    expect(json.summary.allowed.inline).toBe(1);
    rmSync(allowed, { recursive: true, force: true });
  });

  test("(b') bare xdg-audit:allow (no reason) is a hard gate error", () => {
    const bare = mkdtempSync(join(tmpdir(), "xdg-audit-selftest-bare-"));
    git(bare, "init", "-q");
    git(bare, "config", "user.email", "t@t");
    git(bare, "config", "user.name", "t");
    writeFileSync(join(bare, "runtime.ts"),
      'export const CONFIG = "~/.config/cortex/bot.yaml"; // xdg-audit:allow\n');
    git(bare, "add", "-A");
    const { status, json } = runGate(bare);
    expect(status).toBeGreaterThan(0);
    expect(json.summary.errors.some((e: string) => /bare 'xdg-audit:allow'/.test(e))).toBe(true);
    rmSync(bare, { recursive: true, force: true });
  });

  test("(c) allowlist entry with a non-matching regex does NOT suppress a different line", () => {
    // Entry matches ONLY the `cortex/bot.yaml` line; the sibling `grove/other.yaml`
    // line must stay gated.
    const allowFile = join(scratch, "scratch-allow.yaml");
    writeFileSync(allowFile, [
      "allow:",
      "  - pattern: config-tree",
      "    path: runtime.ts",
      "    match: cortex/bot\\.yaml",
      "    reason: only the bot.yaml line is by-design",
      "    owner: self-test",
    ].join("\n") + "\n");
    const { status, json } = runGate(scratch, allowFile);
    // one line suppressed (bot.yaml), the other (grove/other.yaml) still gated
    expect(json.summary.allowed.list).toBe(1);
    const gatedRuntime = (json.gated ?? []).filter((f: any) => f.relPath === "runtime.ts");
    expect(gatedRuntime.length).toBe(1);
    expect(gatedRuntime[0].content).toContain("grove/other.yaml");
    expect(status).toBeGreaterThan(0); // the un-allowed line keeps the gate red
  });
});
