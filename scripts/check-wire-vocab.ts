#!/usr/bin/env bun
//
// check-wire-vocab.ts — the Myelin-layer-model vocabulary gate.
//
// This is the enforceable form of the notation decision (myelin#240) as
// specified by compass/standards/domain-grounding.md §5. It EXTENDS cortex's
// existing "Vocab carve-out gate" (scripts/check-carveouts.sh, the 0002
// operator/bot/broadcast ratchet) with the wire-layer-notation rule set —
// check-carveouts.sh owns the R-cluster term migration; this script owns the
// M-notation layer-model rules the carve-out gate never knew (proven by the
// live `L7`/`protocol stack` residuals fixed in compass#125).
//
// Rule set (standard §5.1). Canonical: M-notation (M1–M7); reconciled name
// "Myelin layer model".
//   V1  "the Myelin stack"      (banned alias — stack is a deployment unit)  → BLOCKING
//   V2  "the seven-layer stack" (banned alias — same reason)                 → BLOCKING
//   V3  "protocol stack"        (banned alias for the M2–M6 layers)          → BLOCKING
//   V4  bare  \bL[1-7]\b  used as a live Myelin-layer reference              → WARN (burn-in)
//
// V4 is the drift-prone one (standard §5.2): L1–L7 ≡ M1–M7 is a DECLARED,
// legal historical alias (CONTEXT-MAP), so a blanket ban is wrong. It also
// collides with FOREIGN L-namespaces cortex legitimately uses (OSI layers,
// arc's DD-L deployment decisions, the confidentiality program's L1/L2/L5
// governance layers, the Rebuff prompt-injection L0/L1 scorer tiers). Cleaning
// the ~30 genuine Myelin-layer L-refs in the historical design docs to
// M-notation is a separate doc sweep (its own follow-up issue), so V4 ships
// WARN-ONLY during a burn-in — the same posture cortex uses for every new
// whole-tree gate (cf. the confidentiality-gate warn-only burn-in). Promote it
// to blocking with --enforce-l4 (or CORTEX_WIRE_VOCAB_ENFORCE_L4=1) once the
// sweep lands.
//
// §5.2 allowlist (never fails, both V1–V3 and V4):
//   - fenced code blocks (```) and blockquotes (>) — verbatim / illustrative
//   - a line matching a FOREIGN-namespace marker (§N, governance,
//     data-classification, confidentiality, OSI, DD-L, compose/container,
//     Rebuff/prompt-injection, systemd/auto-renderer) — not the Myelin model
//   - an inline `vocab-allow: <reason>` marker (escape hatch; must name a reason)
//
// §2.2 no-drift check: every `specs/rfc/rfc-*.md` path named in the
// wire_grounding routing table (docs/agents-md/wire-grounding.md) must resolve
// to a real file in the myelin pack. Resolves myelin via $MYELIN_RFC_DIR, a
// sibling ../myelin checkout, or `gh api` — SKIPS (non-blocking) with a notice
// if myelin is unreachable, so CI stays green without a myelin checkout.
//
// Scope: tracked PROSE + CONFIG only (*.md, *.yaml, *.yml) — not code
// identifiers, which have their own naming rules. The generated repo-root
// CLAUDE.md is excluded (it is regenerated from the scanned section files by
// `arc upgrade compass`; flagging it would double-flag its sources).
//
// Exit: 0 clean, 1 blocking violation (V1–V3, or a confirmed missing RFC path),
// 2 usage/environment error.

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const ENFORCE_L4 =
  process.argv.includes("--enforce-l4") ||
  process.env.CORTEX_WIRE_VOCAB_ENFORCE_L4 === "1";

// ── file walk ──────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
]);
// Generated artifact — regenerated from the scanned agents-md section files.
const EXCLUDE_FILES = new Set(["CLAUDE.md"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue; // race on a deleted path; skip
    }
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(md|ya?ml)$/.test(entry)) yield p;
  }
}

// ── §5.2 allowlist markers ───────────────────────────────────────────────────
// Foreign L-namespaces + governance/quote markers. A line matching any of these
// is exempt (it is not a Myelin-layer reference, or it is a record we must not
// rewrite).
const FOREIGN_MARKER =
  /§\s*\d|governance|data-classification|confidentialit|\bOSI\b|\bDD-L\d|compose|container|\bframes\b|Rebuff|prompt-injection|scanPrompt|scorer|systemd|auto-renderer|linger|rollback|compass#8[147]|Phase L\d|\bL\d gate\b|gate \(warn|warn-only/i;
const INLINE_ALLOW = /vocab-allow:\s*\S/i;

// ── rules ────────────────────────────────────────────────────────────────────
type Rule = {
  id: string;
  re: RegExp;
  blocking: boolean;
  canonical: string;
};
const RULES: Rule[] = [
  { id: "V1", re: /the\s+Myelin\s+stack/i, blocking: true, canonical: '"the Myelin layer model"' },
  { id: "V2", re: /the\s+seven[-\s]layer\s+stack/i, blocking: true, canonical: '"the Myelin layer model"' },
  { id: "V3", re: /protocol\s+stack/i, blocking: true, canonical: '"M2–M6 protocol layers" / "the Myelin layer model"' },
  { id: "V4", re: /\bL[1-7]\b/, blocking: ENFORCE_L4, canonical: "the matching M[1-7]" },
];

type Finding = { file: string; line: number; rule: Rule; text: string };
const blockingFindings: Finding[] = [];
const warnFindings: Finding[] = [];

for (const abs of walk(REPO_ROOT)) {
  const rel = relative(REPO_ROOT, abs);
  if (EXCLUDE_FILES.has(rel)) continue;

  const lines = readFileSync(abs, "utf8").split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue; // fenced code — verbatim, exempt
    if (/^\s*>/.test(line)) continue; // blockquote — quotation, exempt
    if (INLINE_ALLOW.test(line)) continue; // explicit escape hatch
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      // Foreign-namespace / governance / quote lines are legal (§5.2).
      if (FOREIGN_MARKER.test(line)) continue;
      const f: Finding = { file: rel, line: i + 1, rule, text: line.trim().slice(0, 140) };
      (rule.blocking ? blockingFindings : warnFindings).push(f);
    }
  }
}

// ── §2.2 no-drift check ───────────────────────────────────────────────────────
const TABLE = join(REPO_ROOT, "docs/agents-md/wire-grounding.md");
let driftExit = 0;
function resolveMyelinRfc(): { kind: "dir"; dir: string } | { kind: "gh" } | null {
  const envDir = process.env.MYELIN_RFC_DIR;
  if (envDir && existsSync(envDir)) return { kind: "dir", dir: envDir };
  for (const d of [
    join(REPO_ROOT, "..", "myelin", "specs", "rfc"),
    join(process.env.HOME ?? "", "Developer", "myelin", "specs", "rfc"),
  ]) {
    if (existsSync(d)) return { kind: "dir", dir: d };
  }
  // gh api fallback — works when a token with myelin read access is present.
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return { kind: "gh" };
  } catch {
    return null;
  }
}

function checkNoDrift(): void {
  if (!existsSync(TABLE)) {
    console.log("no-drift: no wire-grounding.md routing table — skipping.");
    return;
  }
  const body = readFileSync(TABLE, "utf8");
  // Match both the full `specs/rfc/rfc-*.md` form (standard §2.2 grep) and the
  // bare `rfc-*.md` filename form this table uses (path prefix in the header).
  const paths = [
    ...new Set(
      [...body.matchAll(/(?:specs\/rfc\/)?(rfc-[a-z0-9-]+\.md)/g)]
        .map((m) => m[1])
        .filter((x): x is string => Boolean(x)),
    ),
  ].sort();
  if (paths.length === 0) {
    console.log("no-drift: routing table names no RFC paths — skipping.");
    return;
  }
  const src = resolveMyelinRfc();
  if (!src) {
    console.log(
      `no-drift: myelin pack not reachable (set MYELIN_RFC_DIR, add a ../myelin checkout, or 'gh auth login') — SKIPPING the ${paths.length}-path drift check (non-blocking).`,
    );
    return;
  }
  let ghListing: Set<string> | null = null;
  if (src.kind === "gh") {
    try {
      const out = execSync(
        "gh api repos/the-metafactory/myelin/contents/specs/rfc --jq '.[].name'",
        { encoding: "utf8" },
      );
      ghListing = new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
    } catch {
      console.log("no-drift: gh api call failed — SKIPPING drift check (non-blocking).");
      return;
    }
  }
  const missing: string[] = [];
  for (const p of paths) {
    const name = p.split("/").pop()!;
    const ok = src.kind === "dir" ? existsSync(join(src.dir, name)) : ghListing!.has(name);
    if (!ok) missing.push(p);
  }
  if (missing.length) {
    driftExit = 1;
    for (const m of missing) console.error(`no-drift: FAIL — routing target missing in myelin: ${m}`);
  } else {
    console.log(`no-drift: PASS — all ${paths.length} RFC path(s) resolve in the myelin pack.`);
  }
}

// ── report ────────────────────────────────────────────────────────────────────
function printGroup(title: string, findings: Finding[]): void {
  if (!findings.length) return;
  console.error(`\n${title}`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule.id}] ${f.text}`);
    console.error(`      → use ${f.rule.canonical}`);
  }
}

checkNoDrift();

console.log("──────────────────────────────────────────────────────────────");
if (warnFindings.length) {
  console.error(
    `check-wire-vocab: WARN — ${warnFindings.length} bare L[1-7] Myelin-layer reference(s) (V4 burn-in; non-blocking until the L→M doc sweep + --enforce-l4)`,
  );
  printGroup("V4 (warn — convert to M-notation, or mark foreign with `vocab-allow: <reason>`):", warnFindings);
}

if (blockingFindings.length) {
  printGroup("BLOCKING vocabulary violations (standard §5.1):", blockingFindings);
  console.error(
    `\ncheck-wire-vocab: FAIL — ${blockingFindings.length} blocking layer-model vocabulary violation(s).`,
  );
  console.error("See compass/standards/domain-grounding.md §5. Fix the wording, or (for a verbatim record) add an inline `vocab-allow: <reason>` marker.");
  process.exit(1);
}

if (driftExit !== 0) {
  console.error("\ncheck-wire-vocab: FAIL — RFC routing table names a path that does not exist in myelin (standard §2.2).");
  process.exit(1);
}

console.log("check-wire-vocab: PASS — no blocking layer-model vocabulary violations.");
process.exit(0);
