#!/usr/bin/env bun
/**
 * xdg-audit — deterministic discovery + gate for the XDG Base Directory
 * migration (cortex epic #1867).
 *
 * READ-ONLY by construction: no write/mkdir/unlink/chmod calls exist in this
 * file. Safe to run on a live machine at any time.
 *
 * Two scan domains:
 *   --repos    pattern-registry scan over git-tracked files (default: cortex,
 *              arc, metafactory-discord; override the roots with positional args)
 *   --machine  live inventory: dangling symlinks, plist exec paths,
 *              settings.json hooks, packages.db rows, WAL sidecars,
 *              occupied cutover destinations, grove-vs-cortex divergence,
 *              pidfile liveness
 *
 * ── THE REPO GATE ──────────────────────────────────────────────────────────
 * `bun xdg-audit.ts --repos` is a DETERMINISTIC gate. Exit code = number of
 * *gated* findings (capped at 99). A raw pattern hit is gated UNLESS it is:
 *
 *   1. ADVISORY by a deterministic class rule (never counts toward the gate):
 *        • a test file (`__tests__/` or `*.test.ts`) — fixtures that exercise
 *          the migration are by design;
 *        • a comment-only line in a CODE file (trimmed line starts with `//`,
 *          `*`, `/*`, or — in a `.sh` file — `#`). Comments cannot break runtime.
 *      `.md` / `.yaml` / `.yml` / `.example` lines are NEVER advisory — docs
 *      stay fully gated so stale instructions get fixed, not hidden.
 *
 *   2. INLINE-ALLOWED: the matched line (or the line immediately above it)
 *      carries `xdg-audit:allow(<reason>)`. The reason text is REQUIRED; a bare
 *      `xdg-audit:allow` with no `(reason)` is a hard gate error. Use this for
 *      the rare RUNTIME line that legitimately names a legacy path (a resolver
 *      legacy-fallback constant, a migration/cleanup step).
 *
 *   3. ALLOWLIST-ALLOWED: it matches an entry in the checked-in
 *      `scripts/xdg-audit-allow.yaml`. Each entry needs ALL of
 *      {pattern, path, match, reason, owner}; `match` is a narrow content
 *      regex so a bare path glob cannot silently allow future new lines in the
 *      same file. Unknown pattern-ids and unused entries are surfaced as
 *      warnings so dead allows get pruned.
 *
 * Every suppression is therefore explicit and reviewable, and the gate keeps
 * biting on any NEW stale reference outside those three escape hatches.
 *
 * Usage:
 *   bun xdg-audit.ts --repos                 # the gate (exit 0 == clean)
 *   bun xdg-audit.ts --repos --verbose       # + list the advisory findings
 *   bun xdg-audit.ts --repos <root>...       # gate specific checkouts
 *   bun xdg-audit.ts --machine               # live-machine preflight
 *   bun xdg-audit.ts --repos --wave 4        # postcondition for one wave
 *   bun xdg-audit.ts --repos --json          # machine-readable
 */

import { existsSync, lstatSync, readlinkSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { parse as parseYaml } from "yaml";

const HOME = homedir();
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const JSON_OUT = flag("--json");
const VERBOSE = flag("--verbose");
const WAVE = opt("--wave");
const REF = opt("--ref"); // e.g. origin/main; default = working tree (tracked files)
const DO_REPOS = flag("--repos") || (!flag("--machine"));
const DO_MACHINE = flag("--machine") || (!flag("--repos"));

// ---------------------------------------------------------------- registry
// The registry IS the spec. wave/issue map to the epic's wave table.
// Update in lockstep with cortex#1867's wave-table comment.
interface Pattern {
  id: string;
  re: string;               // ERE for git grep -E
  clazz: string;
  wave: number;             // wave whose completion zeroes this pattern
  issue: string;
  note?: string;
  // Optional post-match content filter: a finding is DROPPED (never a hit)
  // when the matched line still matches `re` only via the excluded sub-path.
  // Used to carve out a by-design sibling of a legacy path (e.g. events/raw,
  // which stays under ~/.claude permanently — standard §6) without weakening
  // what the pattern otherwise catches.
  exclude?: string;
}
const PATTERNS: Pattern[] = [
  { id: "bin-home",        re: '(\\$HOME|\\$\\{HOME\\}|~|__HOME__)/bin/',                clazz: "bin",    wave: 3, issue: "cortex#1866",  note: "legacy ~/bin exec/target" },
  { id: "config-tree",     re: '\\.config/(cortex|grove)([/"\x27]|$)',                   clazz: "config", wave: 4, issue: "cortex#1869",  note: "legacy config tree literal" },
  { id: "grove-state",     re: '\\.config/grove/state',                                  clazz: "state",  wave: 5, issue: "cortex#1903",  note: "legacy pidfile/state dir" },
  { id: "legacy-share",    re: '\\.local/share/(cortex|grove)([/"\x27]|$)',              clazz: "data",   wave: 5, issue: "cortex#1902",  note: "pre-suite data tree" },
  // events/raw stays under ~/.claude permanently (standard §6) → excluded.
  // events/published, bare .claude/events, and .claude/relay still gated.
  { id: "claude-events",   re: '\\.claude/(events|relay)',                               clazz: "data",   wave: 5, issue: "cortex#1902/#1903", note: "events/relay under ~/.claude", exclude: '\\.claude/events/raw' },
  { id: "pkg-repos",       re: '\\.config/metafactory/pkg/repos',                        clazz: "repos",  wave: 5, issue: "arc#287",      note: "hardcoded package-repos path (G-02/G-04)" },
  { id: "systemd-userdir", re: '\\.config/systemd/user',                                 clazz: "config", wave: 4, issue: "G-38 (new)",   note: "must honor $XDG_CONFIG_HOME" },
  { id: "stale-pai-root",  re: '\\.config/(pai|arc)/pkg',                                clazz: "repos",  wave: 5, issue: "arc#287",      note: "dead roots from prior migrations (G-58)" },
];
const PATTERN_IDS = new Set(PATTERNS.map(p => p.id));
const EXCLUDES = [":!node_modules", ":!*.lock", ":!dist", ":!build", ":!.git"];
// The gate never scans its own tool/allowlist/self-test — they name legacy
// paths and carry example allow-markers by nature (any path with "xdg-audit").
const isSelfFile = (relPath: string) => relPath.includes("xdg-audit");
const DEFAULT_REPOS = [
  join(HOME, "Developer", "cortex"),
  join(HOME, "Developer", "arc"),
  join(HOME, "Developer", "metafactory-discord"),
];

type FindingClass =
  | "gated"
  | "advisory:test"
  | "advisory:comment"
  | "allow:inline"
  | "allow:list";

interface Finding {
  domain: "repos" | "machine";
  pattern: string;
  clazz: string;
  wave: number;
  issue: string;
  location: string;        // repoName/relPath:line
  relPath: string;         // repo-relative path (for allowlist glob matching)
  content: string;         // full matched line (untruncated)
  excerpt: string;         // trimmed + capped for display
  klass: FindingClass;     // gate disposition
  allowRef?: string;       // which inline reason / allowlist entry suppressed it
}
const findings: Finding[] = [];
const infos: string[] = [];
const gateErrors: string[] = [];   // structural errors → force a nonzero exit
const gateWarnings: string[] = []; // non-fatal (unused / unknown allowlist entries)
let rawExceptionCount = 0;         // findings dropped by a pattern `exclude` rule

// ---------------------------------------------------------------- allowlist
interface AllowEntry {
  pattern: string;
  path: string;
  match: string;
  reason: string;
  owner: string;
  _glob?: Bun.Glob;
  _re?: RegExp;
  _used?: boolean;
  _idx: number;
}
// The allowlist is CENTRAL: it lives beside the tool (cortex/scripts/) and
// applies to EVERY scanned repo. That keeps the gate + its policy one unit, so
// a single cortex PR can adjudicate cross-repo (arc/discord) findings. Path
// globs are repo-relative; scope cross-repo collisions with the `match` regex.
function loadAllowlist(file: string): AllowEntry[] {
  if (!existsSync(file)) return [];
  let doc: unknown;
  try { doc = parseYaml(readFileSync(file, "utf8")); }
  catch (e) { gateErrors.push(`allowlist parse error: ${(e as Error).message.slice(0, 80)}`); return []; }
  const raw = (doc as { allow?: unknown })?.allow;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { gateErrors.push(`allowlist: top-level 'allow:' must be a list`); return []; }
  const out: AllowEntry[] = [];
  raw.forEach((e: Record<string, unknown>, i: number) => {
    const missing = (["pattern", "path", "match", "reason", "owner"] as const).filter(k => typeof e?.[k] !== "string" || (e[k] as string).trim() === "");
    if (missing.length) { gateErrors.push(`allowlist entry #${i}: missing/empty field(s): ${missing.join(", ")}`); return; }
    const entry: AllowEntry = {
      pattern: e.pattern as string, path: e.path as string, match: e.match as string,
      reason: e.reason as string, owner: e.owner as string, _idx: i,
    };
    if (!PATTERN_IDS.has(entry.pattern)) gateWarnings.push(`allowlist entry #${i}: unknown pattern-id "${entry.pattern}" (inert — prune or fix)`);
    try { entry._re = new RegExp(entry.match); }
    catch (err) { gateErrors.push(`allowlist entry #${i}: invalid match regex /${entry.match}/: ${(err as Error).message.slice(0, 60)}`); return; }
    try { entry._glob = new Bun.Glob(entry.path); }
    catch { gateErrors.push(`allowlist entry #${i}: invalid path glob "${entry.path}"`); return; }
    out.push(entry);
  });
  return out;
}

// ---------------------------------------------------------------- classify
const fileLineCache = new Map<string, string[]>();
function fileLines(root: string, relPath: string): string[] {
  const abs = join(root, relPath);
  let v = fileLineCache.get(abs);
  if (v) return v;
  try { v = readFileSync(abs, "utf8").split("\n"); } catch { v = []; }
  fileLineCache.set(abs, v);
  return v;
}
function ext(relPath: string): string {
  const m = relPath.match(/\.([a-z0-9]+)$/i);
  return m?.[1] ? m[1].toLowerCase() : "";
}
const ALLOW_RE = /xdg-audit:allow/;
const ALLOW_REASON_RE = /xdg-audit:allow\(\s*([^)]+?)\s*\)/;

/** Detect + validate an inline allow on a specific physical line. */
function inlineAllowOn(line: string | undefined, where: string): { allowed: boolean; reason?: string } {
  if (line === undefined || !ALLOW_RE.test(line)) return { allowed: false };
  const m = line.match(ALLOW_REASON_RE);
  if (!m || !m[1] || m[1].trim() === "") {
    gateErrors.push(`invalid inline allow at ${where}: bare 'xdg-audit:allow' with no (reason) — reason text is required`);
    return { allowed: false };
  }
  return { allowed: true, reason: m[1].trim() };
}

// ---------------------------------------------------------------- repo scan
function repoScan(root: string, allowlist: AllowEntry[]) {
  if (!existsSync(join(root, ".git"))) { infos.push(`skip (not a git repo): ${root}`); return; }
  const repoName = root.split("/").pop() ?? root;
  for (const p of PATTERNS) {
    const refArgs = REF ? [REF] : [];
    const proc = Bun.spawnSync(
      ["git", "-C", root, "grep", "-nIE", p.re, ...refArgs, "--", ".", ...EXCLUDES],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString();
    if (!out) continue;
    const excludeRe = p.exclude ? new RegExp(p.exclude, "g") : null;
    const baseRe = new RegExp(p.re);
    for (const line of out.split("\n")) {
      if (!line) continue;
      // parse `file:line:content` (or `ref:file:line:content` under --ref)
      const parts = line.split(":");
      const relPath = REF ? parts[1]! : parts[0]!;
      const lineNo = Number(REF ? parts[2] : parts[1]);
      const content = (REF ? parts.slice(3) : parts.slice(2)).join(":");
      if (isSelfFile(relPath)) continue; // never gate the gate

      // pattern-level exclusion (e.g. events/raw): drop if the ONLY reason the
      // line matched is the excluded sub-path.
      if (excludeRe) {
        const stripped = content.replace(excludeRe, "");
        if (!baseRe.test(stripped)) { rawExceptionCount++; continue; }
      }

      const f: Finding = {
        domain: "repos", pattern: p.id, clazz: p.clazz, wave: p.wave, issue: p.issue,
        location: `${repoName}/${relPath}:${lineNo}`, relPath,
        content, excerpt: content.trim().slice(0, 120), klass: "gated",
      };

      // (2) inline allow — on the matched line, or the line immediately above.
      // Line-above lookup needs the working tree; under --ref only the matched
      // line (from grep output) is checked.
      const self = inlineAllowOn(content, f.location);
      let above: { allowed: boolean; reason?: string } = { allowed: false };
      if (!self.allowed && !REF && Number.isFinite(lineNo) && lineNo > 1) {
        above = inlineAllowOn(fileLines(root, relPath)[lineNo - 2], `${repoName}/${relPath}:${lineNo - 1}`);
      }
      if (self.allowed || above.allowed) {
        f.klass = "allow:inline";
        f.allowRef = (self.reason ?? above.reason)!;
        findings.push(f);
        continue;
      }

      // (1) advisory class rules — test files, then code comments.
      const e = ext(relPath);
      const isTest = /(^|\/)__tests__\//.test(relPath) || /\.test\.ts$/.test(relPath);
      if (isTest) { f.klass = "advisory:test"; findings.push(f); continue; }
      const neverAdvisory = e === "md" || e === "yaml" || e === "yml" || relPath.endsWith(".example");
      if (!neverAdvisory) {
        const t = content.trim();
        const isComment = t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || (e === "sh" && t.startsWith("#"));
        if (isComment) { f.klass = "advisory:comment"; findings.push(f); continue; }
      }

      // (3) allowlist
      const hit = allowlist.find(a => a.pattern === p.id && a._glob!.match(relPath) && a._re!.test(content));
      if (hit) { hit._used = true; f.klass = "allow:list"; f.allowRef = `#${hit._idx} ${hit.reason}`; findings.push(f); continue; }

      // otherwise: gated
      findings.push(f);
    }
  }
}

// ------------------------------------------------------------- machine scan
const LEGACY_TREES = ["/bin/", "/.config/cortex", "/.config/grove", "/pkg/repos/"];
function treeOf(p: string): string | null {
  if (p.startsWith(join(HOME, "bin") + "/")) return "~/bin";
  for (const t of LEGACY_TREES.slice(1)) if (p.includes(t)) return t.replace(/^\//, "~/").replace("/pkg/repos/", "pkg/repos");
  return null;
}

function pushMachine(f: Omit<Finding, "relPath" | "content" | "excerpt" | "klass"> & { excerpt: string }) {
  findings.push({ ...f, relPath: "", content: f.excerpt, klass: "gated" });
}

function scanSymlinks(dir: string, wave: number, issue: string) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let target = ""; try { target = readlinkSync(p); } catch { continue; }
    const abs = target.startsWith("/") ? target : join(dir, target);
    if (!existsSync(abs)) {
      pushMachine({ domain: "machine", pattern: "dangling-symlink", clazz: "symlink", wave, issue,
        location: p.replace(HOME, "~"), excerpt: `→ ${target.replace(HOME, "~")} (MISSING)` });
    } else if (abs.includes("/pkg/repos/")) {
      pushMachine({ domain: "machine", pattern: "pkg-repos-symlink", clazz: "repos", wave: 5, issue: "arc#287",
        location: p.replace(HOME, "~"), excerpt: `→ pkg/repos (needs re-link on repos move)` });
    }
  }
}

function scanPlists() {
  const dir = join(HOME, "Library", "LaunchAgents");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".plist")) continue;
    const p = join(dir, name);
    let text = ""; try { text = readFileSync(p, "utf8"); } catch { continue; }
    if (!/cortex|grove|metafactory/i.test(text)) continue;
    const paths = [...text.matchAll(/<string>(\/[^<]+)<\/string>/g)]
      .map(m => m[1])
      .filter((x): x is string => typeof x === "string");
    for (const path of paths) {
      if (!path.startsWith("/Users/") && !path.startsWith(HOME)) continue;
      if (path.includes(":")) {
        const seg = path.split(":").find(s => treeOf(s));
        if (seg) pushMachine({ domain: "machine", pattern: "plist-PATH-legacy-segment", clazz: "plist",
          wave: 3, issue: "cortex#1866", location: `~/Library/LaunchAgents/${name}`,
          excerpt: `PATH includes ${seg.replace(HOME, "~")}` });
        continue;
      }
      const tree = treeOf(path);
      const missing = !existsSync(path.split(" ")[0] ?? path);
      if (tree || missing) {
        pushMachine({ domain: "machine", pattern: missing ? "plist-missing-path" : "plist-legacy-path",
          clazz: "plist", wave: tree === "~/bin" ? 3 : tree === "pkg/repos" ? 5 : 4,
          issue: tree === "~/bin" ? "cortex#1866" : tree === "pkg/repos" ? "arc#287+G-03" : "cortex#1869",
          location: `~/Library/LaunchAgents/${name}`,
          excerpt: `${path.replace(HOME, "~").slice(0, 90)}${missing ? " (MISSING)" : ""}` });
      }
    }
  }
}

function scanSettingsHooks() {
  const p = join(HOME, ".claude", "settings.json");
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const cmds = [...text.matchAll(/(\/Users\/[\w.-]+|~)\/[^"\s]+/g)].map(m => m[0]);
  let repos = 0;
  for (const c of new Set(cmds)) {
    if (/[*?()]/.test(c)) continue; // permission globs, not file paths
    const abs = c.replace(/^~/, HOME);
    if (abs.includes("/pkg/repos/")) repos++;
    if (!existsSync(abs)) {
      pushMachine({ domain: "machine", pattern: "settings-hook-missing", clazz: "hooks", wave: 5, issue: "arc#287",
        location: "~/.claude/settings.json", excerpt: `${c.replace(HOME, "~").slice(0, 100)} (MISSING)` });
    }
  }
  if (repos) infos.push(`settings.json: ${repos} unique pkg/repos paths (re-resolve on repos move — arc#287/G-02)`);
}

function scanPackagesDb() {
  const p = join(HOME, ".config", "metafactory", "packages.db");
  if (!existsSync(p)) return;
  try {
    const db = new Database(`file://${p}?immutable=1`, { readonly: true });
    const rows = db.query("SELECT name, install_path FROM skills").all() as { name: string; install_path: string }[];
    for (const r of rows) {
      if (!existsSync(r.install_path)) {
        pushMachine({ domain: "machine", pattern: "db-stale-install-path", clazz: "db", wave: 5, issue: "arc#287",
          location: `packages.db:${r.name}`, excerpt: `${r.install_path.replace(HOME, "~")} (MISSING)` });
      }
    }
    infos.push(`packages.db: ${rows.length} install_path rows (all rewritten on repos move — arc#287/G-02)`);
    db.close();
  } catch (e) { infos.push(`packages.db: unreadable (${(e as Error).message.slice(0, 60)})`); }
}

function scanWalSidecars() {
  const roots = ["cortex", "grove"].flatMap(t => [join(HOME, ".config", t), join(HOME, ".local", "share", t)]);
  const walk = (d: string, depth: number) => {
    if (depth > 4 || !existsSync(d)) return;
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(db|sqlite)-wal$/.test(e.name)) {
        let size = 0; try { size = statSync(p).size; } catch {}
        pushMachine({ domain: "machine", pattern: "hot-wal-sidecar", clazz: "db", wave: 5, issue: "cortex#1902/G-54",
          location: p.replace(HOME, "~"), excerpt: `-wal ${size}B (checkpoint before any copy)` });
      }
    }
  };
  roots.forEach(r => walk(r, 0));
}

function scanOccupiedDestinations() {
  const binDir = join(HOME, "bin");
  if (!existsSync(binDir)) return;
  for (const name of readdirSync(binDir)) {
    const src = join(binDir, name);
    let st; try { st = lstatSync(src); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let tgt = ""; try { tgt = readlinkSync(src); } catch { continue; }
    if (!tgt.includes("/pkg/repos/")) continue; // only suite-managed tools
    const dest = join(HOME, ".local", "bin", name);
    if (existsSync(dest)) {
      let dst; try { dst = lstatSync(dest); } catch { continue; }
      let dtgt = ""; if (dst.isSymbolicLink()) { try { dtgt = readlinkSync(dest); } catch {} }
      if (dtgt !== tgt) {
        pushMachine({ domain: "machine", pattern: "occupied-destination", clazz: "bin", wave: 3, issue: "cortex#1866/G-41",
          location: dest.replace(HOME, "~"),
          excerpt: dst.isSymbolicLink() ? `≠ ~/bin target (→ ${dtgt.replace(HOME, "~").slice(0, 60)})` : `regular file blocks cutover (SymlinkConflictError)` });
      }
    }
  }
}

function scanTreeDivergence() {
  const a = join(HOME, ".config", "grove"), b = join(HOME, ".config", "cortex");
  if (!existsSync(a) || !existsSync(b)) return;
  const la = new Set(readdirSync(a)), lb = new Set(readdirSync(b));
  const onlyA = [...la].filter(x => !lb.has(x)), onlyB = [...lb].filter(x => !la.has(x));
  if (onlyA.length || onlyB.length) {
    pushMachine({ domain: "machine", pattern: "dual-tree-divergence", clazz: "config", wave: 4, issue: "cortex#1869/G-42",
      location: "~/.config/{grove,cortex}",
      excerpt: `grove-only: [${onlyA.join(", ").slice(0, 60)}] cortex-only: [${onlyB.join(", ").slice(0, 60)}] — merge policy required` });
  }
}

function scanPidfiles() {
  for (const dir of [join(HOME, ".config", "grove", "state"), join(HOME, ".local", "share", "cortex")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".pid")) continue;
      const p = join(dir, name);
      let pid = 0; try { pid = parseInt(readFileSync(p, "utf8").trim(), 10); } catch { continue; }
      let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
      pushMachine({ domain: "machine", pattern: alive ? "live-pidfile" : "stale-pidfile", clazz: "state", wave: 5, issue: "cortex#1903",
        location: p.replace(HOME, "~"), excerpt: `pid ${pid} ${alive ? "ALIVE (gate must bootout first)" : "stale"}` });
    }
  }
}

// -------------------------------------------------------------------- main
if (DO_REPOS) {
  const extra = args.filter(a => !a.startsWith("--") && a !== WAVE && a !== REF && existsSync(a));
  // positional repo roots REPLACE the defaults (point the gate at fresh
  // checkouts / worktrees); with none given, scan the canonical dev checkouts.
  const roots = extra.length ? extra : DEFAULT_REPOS;
  // The allowlist is co-located with the tool; $XDG_AUDIT_ALLOWLIST overrides
  // it (hermetic self-tests supply their own).
  const allowlist = loadAllowlist(process.env.XDG_AUDIT_ALLOWLIST || join(import.meta.dir, "xdg-audit-allow.yaml"));
  for (const r of roots) repoScan(r, allowlist);
  for (const a of allowlist) if (!a._used) gateWarnings.push(`unused allowlist entry #${a._idx}: {pattern:${a.pattern}, path:${a.path}} — prune it`);
}
if (DO_MACHINE) {
  scanSymlinks(join(HOME, "bin"), 3, "cortex#1866");
  scanSymlinks(join(HOME, ".local", "bin"), 3, "cortex#1866");
  for (const d of ["skills", "bin", "agents", "commands", "hooks"]) scanSymlinks(join(HOME, ".claude", d), 5, "arc#287");
  scanPlists(); scanSettingsHooks(); scanPackagesDb(); scanWalSidecars();
  scanOccupiedDestinations(); scanTreeDivergence(); scanPidfiles();
}

// ------------------------------------------------------------------ report
const waveFilter = (f: Finding) => (WAVE ? f.wave === Number(WAVE) : true);
const scoped = findings.filter(waveFilter);
const gated = scoped.filter(f => f.klass === "gated");
const advisoryTest = scoped.filter(f => f.klass === "advisory:test");
const advisoryComment = scoped.filter(f => f.klass === "advisory:comment");
const allowInline = scoped.filter(f => f.klass === "allow:inline");
const allowList = scoped.filter(f => f.klass === "allow:list");
const allowListEntries = new Set(allowList.map(f => f.allowRef?.split(" ")[0])).size;

if (JSON_OUT) {
  console.log(JSON.stringify({
    // `findings` + `total` are the gate-relevant (gated) inventory and the
    // exit-code basis — kept stable for the --machine doctor-preflight contract
    // (src/__tests__/xdg-migration-guard.e2e.test.ts). `gated` is an explicit
    // alias; `summary` + `allFindings` carry the richer repo-gate breakdown.
    findings: gated,
    total: gated.length,
    gated,
    summary: {
      gated: gated.length,
      advisory: { test: advisoryTest.length, comment: advisoryComment.length },
      allowed: { inline: allowInline.length, list: allowList.length, listEntries: allowListEntries, rawException: rawExceptionCount },
      errors: gateErrors, warnings: gateWarnings,
    },
    allFindings: VERBOSE ? scoped : undefined,
    infos,
  }, null, 1));
} else {
  const byWave = new Map<number, Finding[]>();
  for (const f of gated) { if (!byWave.has(f.wave)) byWave.set(f.wave, []); byWave.get(f.wave)!.push(f); }
  for (const w of [...byWave.keys()].sort((a, b) => a - b)) {
    const fs = byWave.get(w)!;
    console.log(`\n━━ WAVE ${w} — ${fs.length} GATED site(s) ━━━━━━━━━━━━━━━━━━━━━━━`);
    const byPat = new Map<string, Finding[]>();
    for (const f of fs) { if (!byPat.has(f.pattern)) byPat.set(f.pattern, []); byPat.get(f.pattern)!.push(f); }
    for (const [pat, group] of byPat) {
      console.log(`  ${pat} (${group.length}) → ${group[0]?.issue}`);
      for (const f of group.slice(0, 12)) console.log(`    ${f.location}  ${f.excerpt}`);
      if (group.length > 12) console.log(`    … +${group.length - 12} more (use --json for full list)`);
    }
  }
  if (VERBOSE) {
    const dump = (title: string, fs: Finding[]) => {
      if (!fs.length) return;
      console.log(`\n┄┄ ${title} (${fs.length}) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`);
      for (const f of fs) console.log(`    ${f.location}  ${f.excerpt}${f.allowRef ? `  ⟨${f.allowRef.slice(0, 60)}⟩` : ""}`);
    };
    dump("ADVISORY — test files", advisoryTest);
    dump("ADVISORY — code comments", advisoryComment);
    dump("ALLOWED — inline", allowInline);
    dump("ALLOWED — allowlist", allowList);
  }
  for (const i of infos) console.log(`\nℹ ${i}`);

  console.log(`\n━━ SUMMARY${WAVE ? ` (wave ${WAVE})` : ""} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  GATED (counts toward exit): ${gated.length}`);
  console.log(`  advisory  · test files:    ${advisoryTest.length}`);
  console.log(`  advisory  · code comments: ${advisoryComment.length}`);
  console.log(`  allowed   · inline:        ${allowInline.length}`);
  console.log(`  allowed   · allowlist:     ${allowList.length} (across ${allowListEntries} entr${allowListEntries === 1 ? "y" : "ies"})`);
  console.log(`  allowed   · raw-exception: ${rawExceptionCount} (.claude/events/raw — permanent, standard §6)`);
  for (const w of gateWarnings) console.log(`  ⚠ ${w}`);
  for (const e of gateErrors) console.log(`  ✖ GATE ERROR: ${e}`);
  console.log(`\n  GATE: ${gated.length === 0 && gateErrors.length === 0 ? "PASS ✓ (exit 0)" : `FAIL ✗ (exit ${Math.min(99, Math.max(1, gated.length + gateErrors.length))})`}`);
}

// exit code = gated count; structural errors force a nonzero exit even at gated=0.
const exitCode = gateErrors.length ? Math.min(99, Math.max(1, gated.length + gateErrors.length)) : Math.min(99, gated.length);
process.exit(exitCode);
