// cortex#2338 — arc-manifest.yaml `owns:` + `scripts.purge` declaration
// tests. Mirrors manifest-hooks-casing.test.ts's pattern: parse the manifest
// directly and assert shape/safety properties, rather than depending on arc
// as a library (arc is a sibling CLI repo, not an npm dependency here).
//
// The safety rules replicated below (entry shape, containment/overlap) are
// deliberately kept BYTE-FOR-BYTE equivalent to arc's own load-time gate
// (arc/src/lib/owns.ts validateOwns + containmentRoot/pathsNest) — the two
// checks are independent implementations of the SAME contract, so a
// regression here should also fail `arc validate` (verified separately by
// running the real `arc validate` against this repo — see the PR notes) and
// vice versa. If arc's rules ever change, this file's replica must be
// updated to match — that drift risk is the tradeoff for not depending on
// arc as a library.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "arc-manifest.yaml");

type OwnsClass = "config" | "state" | "userData";
const OWNS_CLASSES: OwnsClass[] = ["config", "state", "userData"];

interface Manifest {
  owns?: Partial<Record<OwnsClass, string[]>>;
  scripts?: Record<string, string>;
}

const manifest = parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;

// ─── Replica of arc/src/lib/owns.ts's per-entry safety rules ──────────────
function entryViolations(entry: string): string[] {
  const rules: string[] = [];
  if (entry.startsWith("/")) {
    rules.push(`must be ~-rooted, not an absolute path ('${entry}')`);
    return rules;
  }
  if (!entry.startsWith("~/")) {
    rules.push(`must start with '~/' (got '${entry}')`);
    return rules;
  }
  const tail = entry.slice(2);
  const segments = tail.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    rules.push("has an empty tail after '~/' — this would sweep the whole home tree");
    return rules;
  }
  if (segments.includes("..")) {
    rules.push(`must not contain a '..' segment ('${entry}')`);
  }
  if (segments[0] === "*" || segments[0] === "**") {
    rules.push(`must not begin with a '*'/'**' segment ('${entry}')`);
  }
  return rules;
}

// ─── Replica of arc's containmentRoot / pathsNest (home is opaque here —
// comparison is purely on the tilde-relative tail, which is equivalent for
// nesting purposes since every entry shares the same ~ root). ─────────────
const GLOB_MAGIC_RE = /[*?[\]{}]/;

function containmentRoot(entry: string): string {
  const tail = entry.startsWith("~/") ? entry.slice(2) : entry.replace(/^~/, "");
  const solid: string[] = [];
  for (const seg of tail.split("/")) {
    if (seg.length === 0) continue;
    if (GLOB_MAGIC_RE.test(seg)) break;
    solid.push(seg);
  }
  return solid.join("/");
}

function pathsNest(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

describe("arc-manifest.yaml — owns: declaration (cortex#2338)", () => {
  test("manifest declares owns.config, owns.state, and owns.userData (sanity — guards a parse regression silently passing everything)", () => {
    expect(manifest.owns).toBeDefined();
    expect(manifest.owns?.config?.length ?? 0).toBeGreaterThan(0);
    expect(manifest.owns?.state?.length ?? 0).toBeGreaterThan(0);
    expect(manifest.owns?.userData?.length ?? 0).toBeGreaterThan(0);
  });

  test("every owns entry is a safe ~-rooted path (arc's validateOwns entry rules)", () => {
    for (const cls of OWNS_CLASSES) {
      for (const entry of manifest.owns?.[cls] ?? []) {
        const violations = entryViolations(entry);
        expect(violations).toEqual([]);
      }
    }
  });

  test("owns.userData never overlaps a declared owns.config/owns.state entry (arc's never-delete containment rule)", () => {
    const deletables = [
      ...(manifest.owns?.config ?? []).map((entry) => ({ entry, cls: "config" as const })),
      ...(manifest.owns?.state ?? []).map((entry) => ({ entry, cls: "state" as const })),
    ];
    for (const ud of manifest.owns?.userData ?? []) {
      const udRoot = containmentRoot(ud);
      for (const del of deletables) {
        const delRoot = containmentRoot(del.entry);
        const overlaps = pathsNest(udRoot, delRoot);
        expect(overlaps).toBe(false);
      }
    }
  });

  test("owns.config/owns.state entries are cortex-exclusive canonical XDG trees, not the shared ~/.config/nats or ~/.claude/{relay,events} dirs (cortex#2338 shared-tree caution)", () => {
    const deletables = [...(manifest.owns?.config ?? []), ...(manifest.owns?.state ?? [])];
    for (const entry of deletables) {
      expect(entry.startsWith("~/.config/nats")).toBe(false);
      expect(entry.startsWith("~/.claude/relay")).toBe(false);
      expect(entry.startsWith("~/.claude/events")).toBe(false);
    }
  });

  test("owns.userData names the per-stack workspace root under the data dir (the coding-tier agent's checkout — never-delete guarantee)", () => {
    const userData = manifest.owns?.userData ?? [];
    expect(userData).toContain("~/.local/share/metafactory/cortex/*/workspace");
  });
});

describe("arc-manifest.yaml — scripts.purge (cortex#2338)", () => {
  test("scripts.purge is declared and points at an existing, executable file", () => {
    const rel = manifest.scripts?.purge;
    expect(rel).toBeDefined();
    const abs = join(REPO_ROOT, rel!.replace(/^\.\//, ""));
    expect(existsSync(abs)).toBe(true);
    const mode = statSync(abs).mode;
    // eslint-disable-next-line no-bitwise
    expect((mode & 0o100) !== 0).toBe(true); // owner-executable bit set
  });

  test("scripts/purge.sh sources purge-supervision.sh and calls both sweep functions", () => {
    const script = readFileSync(join(REPO_ROOT, "scripts", "purge.sh"), "utf-8");
    expect(script).toContain("purge-supervision.sh");
    expect(script).toContain("purge_systemd_instances");
    expect(script).toContain("purge_launchd_instances");
  });
});
