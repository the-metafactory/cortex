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
 *              arc, metafactory-discord; add more roots as positional args)
 *   --machine  live inventory: dangling symlinks, plist exec paths,
 *              settings.json hooks, packages.db rows, WAL sidecars,
 *              occupied cutover destinations, grove-vs-cortex divergence,
 *              pidfile liveness
 *
 * Every finding carries {pattern, class, wave, issue, location, excerpt}.
 * Exit code = min(unresolved finding count, 99) → usable as a wave gate:
 *   preflight:      bun xdg-audit.ts --machine            (must be clean-enough)
 *   postcondition:  bun xdg-audit.ts --repos --wave 4     (must be 0 after wave 4)
 *
 * Suppression: a source line containing `xdg-audit:allow` is skipped
 * (use for migration code that must reference legacy paths by design).
 */

import { existsSync, lstatSync, readlinkSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";

const HOME = homedir();
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const JSON_OUT = flag("--json");
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
}
const PATTERNS: Pattern[] = [
  { id: "bin-home",        re: '(\\$HOME|\\$\\{HOME\\}|~|__HOME__)/bin/',                clazz: "bin",    wave: 3, issue: "cortex#1866",  note: "legacy ~/bin exec/target" },
  { id: "config-tree",     re: '\\.config/(cortex|grove)([/"\x27]|$)',                   clazz: "config", wave: 4, issue: "cortex#1869",  note: "legacy config tree literal" },
  { id: "grove-state",     re: '\\.config/grove/state',                                  clazz: "state",  wave: 5, issue: "cortex#1903",  note: "legacy pidfile/state dir" },
  { id: "legacy-share",    re: '\\.local/share/(cortex|grove)([/"\x27]|$)',              clazz: "data",   wave: 5, issue: "cortex#1902",  note: "pre-suite data tree" },
  { id: "claude-events",   re: '\\.claude/(events|relay)',                               clazz: "data",   wave: 5, issue: "cortex#1902/#1903", note: "events/relay under ~/.claude" },
  { id: "pkg-repos",       re: '\\.config/metafactory/pkg/repos',                        clazz: "repos",  wave: 5, issue: "arc#287",      note: "hardcoded package-repos path (G-02/G-04)" },
  { id: "systemd-userdir", re: '\\.config/systemd/user',                                 clazz: "config", wave: 4, issue: "G-38 (new)",   note: "must honor $XDG_CONFIG_HOME" },
  { id: "stale-pai-root",  re: '\\.config/(pai|arc)/pkg',                                clazz: "repos",  wave: 5, issue: "arc#287",      note: "dead roots from prior migrations (G-58)" },
];
const EXCLUDES = [":!node_modules", ":!*.lock", ":!dist", ":!build", ":!.git"];
const DEFAULT_REPOS = [
  join(HOME, "Developer", "cortex"),
  join(HOME, "Developer", "arc"),
  join(HOME, "Developer", "metafactory-discord"),
];

interface Finding {
  domain: "repos" | "machine";
  pattern: string;
  clazz: string;
  wave: number;
  issue: string;
  location: string;
  excerpt: string;
}
const findings: Finding[] = [];
const infos: string[] = [];

// ---------------------------------------------------------------- repo scan
function repoScan(root: string) {
  if (!existsSync(join(root, ".git"))) { infos.push(`skip (not a git repo): ${root}`); return; }
  for (const p of PATTERNS) {
    const refArgs = REF ? [REF] : [];
    const proc = Bun.spawnSync(
      ["git", "-C", root, "grep", "-nIE", p.re, ...refArgs, "--", ".", ...EXCLUDES],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = proc.stdout.toString();
    if (!out) continue;
    for (const line of out.split("\n")) {
      if (!line) continue;
      if (line.includes("xdg-audit:allow")) continue;
      if (line.includes("xdg-audit.ts")) continue; // self
      const [loc, ...rest] = REF
        ? [line.split(":").slice(0, 3).join(":"), line.split(":").slice(3).join(":")]
        : [line.split(":").slice(0, 2).join(":"), line.split(":").slice(2).join(":")];
      findings.push({
        domain: "repos", pattern: p.id, clazz: p.clazz, wave: p.wave, issue: p.issue,
        location: `${root.split("/").pop()}/${loc}`,
        excerpt: rest.join(":").trim().slice(0, 120),
      });
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

function scanSymlinks(dir: string, wave: number, issue: string) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let target = ""; try { target = readlinkSync(p); } catch { continue; }
    const abs = target.startsWith("/") ? target : join(dir, target);
    if (!existsSync(abs)) {
      findings.push({ domain: "machine", pattern: "dangling-symlink", clazz: "symlink", wave, issue,
        location: p.replace(HOME, "~"), excerpt: `→ ${target.replace(HOME, "~")} (MISSING)` });
    } else if (abs.includes("/pkg/repos/")) {
      findings.push({ domain: "machine", pattern: "pkg-repos-symlink", clazz: "repos", wave: 5, issue: "arc#287",
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
      // colon-joined values are PATH lists, not file paths: flag only if a
      // segment sits under a legacy tree, and never as "missing"
      if (path.includes(":")) {
        const seg = path.split(":").find(s => treeOf(s));
        if (seg) findings.push({ domain: "machine", pattern: "plist-PATH-legacy-segment", clazz: "plist",
          wave: 3, issue: "cortex#1866", location: `~/Library/LaunchAgents/${name}`,
          excerpt: `PATH includes ${seg.replace(HOME, "~")}` });
        continue;
      }
      const tree = treeOf(path);
      const missing = !existsSync(path.split(" ")[0] ?? path);
      if (tree || missing) {
        findings.push({ domain: "machine", pattern: missing ? "plist-missing-path" : "plist-legacy-path",
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
      findings.push({ domain: "machine", pattern: "settings-hook-missing", clazz: "hooks", wave: 5, issue: "arc#287",
        location: "~/.claude/settings.json", excerpt: `${c.replace(HOME, "~").slice(0, 100)} (MISSING)` });
    }
  }
  if (repos) infos.push(`settings.json: ${repos} unique pkg/repos paths (re-resolve on repos move — arc#287/G-02)`);
}

function scanPackagesDb() {
  const p = join(HOME, ".config", "metafactory", "packages.db");
  if (!existsSync(p)) return;
  try {
    // immutable=1: read-only open that tolerates a WAL db without -shm access
    const db = new Database(`file://${p}?immutable=1`, { readonly: true });
    const rows = db.query("SELECT name, install_path FROM skills").all() as { name: string; install_path: string }[];
    for (const r of rows) {
      if (!existsSync(r.install_path)) {
        findings.push({ domain: "machine", pattern: "db-stale-install-path", clazz: "db", wave: 5, issue: "arc#287",
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
        findings.push({ domain: "machine", pattern: "hot-wal-sidecar", clazz: "db", wave: 5, issue: "cortex#1902/G-54",
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
        findings.push({ domain: "machine", pattern: "occupied-destination", clazz: "bin", wave: 3, issue: "cortex#1866/G-41",
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
    findings.push({ domain: "machine", pattern: "dual-tree-divergence", clazz: "config", wave: 4, issue: "cortex#1869/G-42",
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
      findings.push({ domain: "machine", pattern: alive ? "live-pidfile" : "stale-pidfile", clazz: "state", wave: 5, issue: "cortex#1903",
        location: p.replace(HOME, "~"), excerpt: `pid ${pid} ${alive ? "ALIVE (gate must bootout first)" : "stale"}` });
    }
  }
}

// -------------------------------------------------------------------- main
if (DO_REPOS) {
  const extra = args.filter(a => !a.startsWith("--") && a !== WAVE && a !== REF && existsSync(a));
  for (const r of [...DEFAULT_REPOS, ...extra]) repoScan(r);
}
if (DO_MACHINE) {
  scanSymlinks(join(HOME, "bin"), 3, "cortex#1866");
  scanSymlinks(join(HOME, ".local", "bin"), 3, "cortex#1866");
  for (const d of ["skills", "bin", "agents", "commands", "hooks"]) scanSymlinks(join(HOME, ".claude", d), 5, "arc#287");
  scanPlists(); scanSettingsHooks(); scanPackagesDb(); scanWalSidecars();
  scanOccupiedDestinations(); scanTreeDivergence(); scanPidfiles();
}

const filtered = WAVE ? findings.filter(f => f.wave === Number(WAVE)) : findings;
if (JSON_OUT) {
  console.log(JSON.stringify({ findings: filtered, infos, total: filtered.length }, null, 1));
} else {
  const byWave = new Map<number, Finding[]>();
  for (const f of filtered) { if (!byWave.has(f.wave)) byWave.set(f.wave, []); byWave.get(f.wave)!.push(f); }
  for (const w of [...byWave.keys()].sort((a, b) => a - b)) {
    const fs = byWave.get(w)!;
    console.log(`\n━━ WAVE ${w} — ${fs.length} site(s) ━━━━━━━━━━━━━━━━━━━━━━━`);
    const byPat = new Map<string, Finding[]>();
    for (const f of fs) { if (!byPat.has(f.pattern)) byPat.set(f.pattern, []); byPat.get(f.pattern)!.push(f); }
    for (const [pat, group] of byPat) {
      console.log(`  ${pat} (${group.length}) → ${group[0]?.issue}`);
      for (const f of group.slice(0, 8)) console.log(`    ${f.location}  ${f.excerpt}`);
      if (group.length > 8) console.log(`    … +${group.length - 8} more (use --json for full list)`);
    }
  }
  for (const i of infos) console.log(`\nℹ ${i}`);
  console.log(`\nTOTAL: ${filtered.length} unresolved site(s)${WAVE ? ` in wave ${WAVE}` : ""}`);
}
process.exit(Math.min(filtered.length, 99));
