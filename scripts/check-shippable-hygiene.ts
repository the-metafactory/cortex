#!/usr/bin/env bun
/**
 * check-shippable-hygiene.ts — L2 shippable-config hygiene gate.
 *
 * Design doc §4 L2 (compass#81, wired by compass#87). A DETERMINISTIC whole-tree
 * check that FAILS when deployment-specific content lands in a shippable path:
 *
 *   - a live platform id (Discord/Slack snowflake) in an agent fragment
 *   - an internal-domain email in an agent fragment
 *   - a real (non-placeholder) identity in seed/migration SQL
 *   - a presence-bearing fragment that never declared itself shippable
 *   - an unparseable YAML fragment (fail-closed — cannot verify ⇒ block)
 *
 * It is the STRUCTURAL layer: it does not know client names (that is L1's hashed
 * denylist + L3's lens). It enforces the convention that everything in a
 * shippable path is either a `.example` template or a `# audience: generic`
 * fragment whose platform ids are all `__ENV__` placeholders / zeroed sentinels.
 * Real deployment fragments live only in `~/.config/cortex/`, never in the repo.
 *
 * OUTPUT IS MASKED. Findings carry a rule id + `file:line` + a static shape
 * descriptor — NEVER the matched literal (a fixture test asserts this). So the
 * gate itself never re-leaks what it catches, and it stays clean under L1's own
 * scanner.
 *
 * Exit codes: 0 = clean · 1 = one or more BLOCK findings · 2 = internal error.
 *
 * Usage:
 *   bun scripts/check-shippable-hygiene.ts            # scan CWD (repo root)
 *   bun scripts/check-shippable-hygiene.ts --root .   # explicit root
 *   bun scripts/check-shippable-hygiene.ts --json
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, relative, sep, basename } from "path";
import { spawnSync } from "child_process";
import { parse as parseYaml } from "yaml";

export interface Finding {
  rule: string;
  file: string; // repo-relative POSIX-ish path
  line: number; // 1-indexed
  shape: string; // masked shape descriptor — never the matched literal
  severity: "block";
  remediation?: string;
}

export interface ScanOptions {
  root: string;
}

// ── path helpers ──────────────────────────────────────────────────────────
const IGNORE_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "out",
  ".cache",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** List candidate files under root. Prefer git (honors .gitignore, includes
 *  tracked + untracked-non-ignored); fall back to an fs walk for non-git dirs
 *  (temp fixtures). Either way we drop the hard ignore segments. */
function listFiles(root: string): string[] {
  const git = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let rels: string[];
  if (git.status === 0 && typeof git.stdout === "string" && git.stdout.length) {
    rels = git.stdout.split("\0").filter(Boolean);
  } else {
    rels = walk(root, root);
  }
  return rels.filter((r) => !r.split("/").some((seg) => IGNORE_SEGMENTS.has(seg)));
}

function walk(dir: string, root: string): string[] {
  const out: string[] = [];
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORE_SEGMENTS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, root));
    else if (e.isFile()) out.push(toPosix(relative(root, abs)));
  }
  return out;
}

// ── categorization ──────────────────────────────────────────────────────────
type Category = "fragment-yaml" | "fragment-md" | "seed" | null;

const EXCLUDE_RE = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)fixtures?(\/|$)/,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
];

function isExample(p: string): boolean {
  return p.endsWith(".example");
}
function isExcluded(p: string): boolean {
  return EXCLUDE_RE.some((re) => re.test(p));
}

/** Static shippable-fragment / seed globs (repo-root anchored where noted),
 *  UNION the manifest-derived paths. */
function categorize(p: string, manifestPaths: Set<string>): Category {
  if (isExcluded(p)) return null;

  const isYaml = /\.ya?ml$/.test(p);
  const isMd = /\.md$/.test(p);
  const isSql = /\.sql$/.test(p);
  const seedNamed = /seed/i.test(basename(p)) && /\.(sql|ts|json)$/.test(p);
  const inMigrations = /(^|\/)migrations(\/|$)/.test(p);

  // Agent fragments (root-anchored static globs).
  const isAgentsDir = p.startsWith("agents.d/") && isYaml;
  const isPersona = p.startsWith("personas/") && isMd;
  const isArcManifest = /^arc-manifest[^/]*\.ya?ml$/.test(p); // root manifests

  const fromManifest = manifestPaths.has(p);

  if (isAgentsDir || isArcManifest) return "fragment-yaml";
  if (isPersona) return "fragment-md";
  if ((inMigrations && isSql) || seedNamed) return "seed";

  // Manifest-derived widening: a fragment/seed shipped from a novel path.
  if (fromManifest) {
    if (isYaml) return "fragment-yaml";
    if (isMd) return "fragment-md";
    if (isSql || seedNamed) return "seed";
  }
  return null;
}

/** Repo-relative existing files declared under any arc-manifest's `provides`. */
function deriveManifestPaths(root: string, files: string[]): Set<string> {
  const out = new Set<string>();
  const manifests = files.filter((f) => /^arc-manifest[^/]*\.ya?ml$/.test(f) || /(^|\/)arc-manifest[^/]*\.ya?ml$/.test(f));
  for (const m of manifests) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(root, m), "utf8"));
    } catch {
      continue; // parse failure surfaces via the fragment rule below
    }
    const provides = (doc as { provides?: unknown })?.provides;
    if (!provides) continue;
    for (const s of collectStrings(provides)) {
      // Only repo-relative paths (skip ~/, /abs, $ENV, and logical keys).
      if (/^[~/$]/.test(s)) continue;
      if (!/[./]/.test(s)) continue; // ignore bare logical names like "agent.yaml"? keep those with a dot
      const candidate = toPosix(s);
      if (existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile()) {
        out.add(candidate);
      }
    }
  }
  return out;
}

function collectStrings(node: unknown): string[] {
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (typeof n === "string") out.push(n);
    else if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === "object") Object.values(n as Record<string, unknown>).forEach(visit);
  };
  visit(node);
  return out;
}

// ── detectors (all masked) ───────────────────────────────────────────────────
// Standalone 17–20 digit run NOT embedded in an identifier/placeholder
// (adjacent word chars — letters/digits/underscore — disqualify it, so
// `__PIER_GUILD_ID__` and longer numbers never match, but "123…" and bare
// `guildId: 123…` do).
const SNOWFLAKE_RE = /(?<![\w])(\d{17,20})(?![\w])/g;
const INTERNAL_EMAIL_RE = /([A-Za-z0-9._%+-]+)@meta-factory\.(?:ai|dev|io)\b/gi;
const ANY_EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const SANCTIONED_LOCALPARTS = new Set(["noreply", "no-reply", "support"]);
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
]);
const PLACEHOLDER_EMAIL_TLDS = [".example", ".test", ".invalid", ".localhost"];

function isZeroedId(id: string): boolean {
  return /^(\d)\1*$/.test(id); // all-zero or all-same-digit sentinel
}
function isPlaceholderEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PLACEHOLDER_EMAIL_DOMAINS.has(d)) return true;
  return PLACEHOLDER_EMAIL_TLDS.some((t) => d === t.slice(1) || d.endsWith(t));
}

const MARKER_RE = /^\s*#\s*audience:\s*generic\b/;

function scanFile(rel: string, category: Exclude<Category, null>, content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  const head = lines.slice(0, 30);
  const hasGenericMarker = head.some((l) => MARKER_RE.test(l));

  if (category === "fragment-yaml") {
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = parseYaml(content);
    } catch {
      parseOk = false;
      findings.push({
        rule: "unparseable-fragment",
        file: rel,
        line: 1,
        shape: "unparseable YAML in a shippable fragment — cannot verify hygiene (fail-closed)",
        severity: "block",
        remediation: "fix the YAML so the hygiene gate can verify it; unparseable fragments fail closed",
      });
    }
    // Undeclared deployment fragment: presence-bearing but not marked generic.
    if (parseOk && parsed && typeof parsed === "object" && "presence" in (parsed as object) && !hasGenericMarker) {
      findings.push({
        rule: "presence-fragment-missing-marker",
        file: rel,
        line: 1,
        shape: "presence-bearing agent fragment is not declared shippable",
        severity: "block",
        remediation:
          'add "# audience: generic" to the first comment block (first 30 lines), or move this deployment fragment to ~/.config/cortex/ — it must not ship',
      });
    }
    findings.push(...scanForIds(rel, lines));
    findings.push(...scanForInternalEmails(rel, lines));
  } else if (category === "fragment-md") {
    findings.push(...scanForIds(rel, lines));
    findings.push(...scanForInternalEmails(rel, lines));
  } else if (category === "seed") {
    findings.push(...scanForSeedIdentities(rel, lines));
  }
  return findings;
}

function scanForIds(rel: string, lines: string[]): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SNOWFLAKE_RE)) {
      const id = m[1];
      if (!id || isZeroedId(id)) continue;
      out.push({
        rule: "agent-fragment-live-platform-id",
        file: rel,
        line: i + 1,
        shape: `live ${id.length}-digit platform id (snowflake) in a shippable fragment — must be an __ENV__ placeholder or zeroed sentinel`,
        severity: "block",
        remediation: "replace the literal id with an __ENV__ placeholder resolved at cortex load; keep real ids in ~/.config/cortex/",
      });
    }
  });
  return out;
}

function scanForInternalEmails(rel: string, lines: string[]): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(INTERNAL_EMAIL_RE)) {
      const local = (m[1] ?? "").toLowerCase();
      if (SANCTIONED_LOCALPARTS.has(local)) continue;
      out.push({
        rule: "agent-fragment-internal-email",
        file: rel,
        line: i + 1,
        shape: "internal-domain email in a shippable fragment",
        severity: "block",
        remediation: "remove the real address; use a sanctioned system address (noreply@/support@) or a placeholder",
      });
    }
  });
  return out;
}

function scanForSeedIdentities(rel: string, lines: string[]): Finding[] {
  const out: Finding[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ANY_EMAIL_RE)) {
      const domain = m[1];
      if (!domain || isPlaceholderEmailDomain(domain)) continue;
      out.push({
        rule: "seed-real-identity",
        file: rel,
        line: i + 1,
        shape: "non-placeholder email/identity in seed/migration data",
        severity: "block",
        remediation: "seed only RFC-reserved placeholder identities (e.g. operator@example.com)",
      });
    }
  });
  return out;
}

// ── entry points ─────────────────────────────────────────────────────────────
export function scanTree(opts: ScanOptions): Finding[] {
  const root = opts.root;
  const files = listFiles(root);
  const manifestPaths = deriveManifestPaths(root, files);
  const findings: Finding[] = [];
  for (const rel of files) {
    const category = categorize(rel, manifestPaths);
    if (!category) continue;
    if (isExample(rel)) continue; // .example templates are exempt (design §4 L2)
    let content: string;
    try {
      const abs = join(root, rel);
      if (statSync(abs).size > 2 * 1024 * 1024) continue; // fragments are tiny; skip huge blobs
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanFile(rel, category, content));
  }
  // Deterministic ordering: file, then line, then rule.
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  if (!findings.length) return "check-shippable-hygiene: clean — 0 findings.";
  const lines = [`check-shippable-hygiene: ${findings.length} BLOCK finding(s):`, ""];
  for (const f of findings) {
    lines.push(`  BLOCK ${f.file}:${f.line} [${f.rule}] ${f.shape}`);
    if (f.remediation) lines.push(`        ↳ fix: ${f.remediation}`);
  }
  return lines.join("\n");
}

function emitGithubAnnotations(findings: Finding[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const f of findings) {
    // Masked message only — never the literal.
    process.stdout.write(`::error file=${f.file},line=${f.line}::[${f.rule}] ${f.shape}\n`);
  }
}

function main(argv: string[]): number {
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i] ?? root;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("usage: bun scripts/check-shippable-hygiene.ts [--root <path>] [--json]\n");
      return 0;
    }
  }
  let findings: Finding[];
  try {
    findings = scanTree({ root });
  } catch (err) {
    process.stderr.write(`check-shippable-hygiene: internal error — ${(err as Error).message}\n`);
    return 2; // fail-closed on our own error
  }
  if (json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
  } else {
    process.stdout.write(formatFindings(findings) + "\n");
  }
  emitGithubAnnotations(findings);
  return findings.length ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
