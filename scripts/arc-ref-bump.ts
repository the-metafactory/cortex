#!/usr/bin/env bun
/**
 * arc-ref-bump.ts — the version-compare + Dockerfile ARG-rewrite core for the
 * automated `ARC_REF` bump workflow (cortex#2246).
 *
 * WHY THIS EXISTS
 * ---------------
 * The L4 container (`deploy/compose/Dockerfile.cortex`) pins
 * `ARG ARC_REF=<tag>` for reproducibility. arc releases move, and adapter
 * manifests evolve with arc — so a pinned OLDER arc eventually can't parse
 * NEWER adapter manifests and `arc install` fails in the container (exactly
 * cortex#2243: v0.40.2 predated the `{host,reason}` manifest shape). The
 * principal decision is to KEEP the pin (reproducible builds; un-pinning to
 * `main` sacrifices reproducibility + adds supply-chain exposure) but AUTOMATE
 * the bump dependabot/renovate-style: a scheduled workflow proposes bumps as
 * reviewable, build-gated PRs.
 *
 * This module is the small, UNIT-TESTABLE core the workflow (.github/workflows/
 * arc-ref-bump.yml) shells out to — semver compare + ARG rewrite — so that
 * logic is NOT buried in inline YAML. The workflow owns the side effects
 * (resolve latest release via `gh api`, `docker build` gate, open the PR); this
 * script owns the pure decision + the exact byte-level Dockerfile edit.
 *
 * REPRODUCIBILITY INVARIANT: this script only ever rewrites the ARG to another
 * PINNED TAG. It never converts the Dockerfile to an unpinned build-time fetch.
 *
 * Usage:
 *   bun scripts/arc-ref-bump.ts --latest <tag> [--dockerfile <path>] [--write]
 *                               [--github-output]
 *
 *   --latest <tag>        REQUIRED. arc's latest release tag (e.g. v0.42.1),
 *                         resolved by the workflow via `gh api …/releases/latest`.
 *   --dockerfile <path>   Dockerfile to read/rewrite. Defaults to
 *                         deploy/compose/Dockerfile.cortex relative to CWD.
 *   --write               Actually rewrite the file when a bump is warranted.
 *                         Without it the script is a dry-run (decision only).
 *   --github-output       Append bumped/old/new to $GITHUB_OUTPUT (for the
 *                         workflow to gate its build + PR steps on).
 *
 * Exit codes:
 *   0  decision made cleanly (whether or not a bump was warranted)
 *   2  usage error (missing --latest, bad flag)
 *   3  Dockerfile unreadable, or its ARG ARC_REF= line is missing/malformed,
 *      or --latest is not a parseable semver tag — fail LOUD, never silent.
 */

import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { resolve } from "path";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or [] for a final release. */
  prerelease: string[];
}

export const DEFAULT_DOCKERFILE = "deploy/compose/Dockerfile.cortex";

/**
 * Parse a semver tag with an optional leading `v`. Returns null for anything
 * that is not a clean MAJOR.MINOR.PATCH[-prerelease] (build metadata after `+`
 * is ignored per semver §10). Deliberately strict: a malformed value must be
 * detectable so the caller can fail loud rather than "bump" to garbage.
 */
export function parseSemver(input: string): Semver | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().replace(/^v/, "");
  // core [+ optional -prerelease] [+ optional +build]; build is discarded.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/**
 * Compare two semver values. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Prerelease handling follows semver §11: a version WITH a prerelease has
 * LOWER precedence than the same core version WITHOUT one; identifiers are
 * compared left-to-right (numeric < alphanumeric; numeric compared as ints).
 */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  // Core equal — a final release outranks any prerelease of the same core.
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a is final, b is prerelease
  if (bp.length === 0) return -1; // a is prerelease, b is final
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    // i < len <= both lengths, so both are defined (noUncheckedIndexedAccess).
    const x = ap[i] as string;
    const y = bp[i] as string;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ap.length !== bp.length) return ap.length < bp.length ? -1 : 1;
  return 0;
}

/**
 * Extract the current pinned value of the `ARG ARC_REF=<value>` line — the ARG
 * DEFINITION that carries a default, NOT the bare `ARG ARC_REF` re-declaration
 * inside the build stage (which has no `=` and no value). Returns null when no
 * definition line with a value is present (malformed / missing).
 */
export function readArcRef(dockerfile: string): string | null {
  const m = /^ARG[ \t]+ARC_REF=(\S+)[ \t]*$/m.exec(dockerfile);
  return m ? (m[1] ?? null) : null;
}

export interface RewriteResult {
  /** The (possibly unchanged) Dockerfile content. */
  content: string;
  /** True only when the ARG value actually changed. */
  changed: boolean;
  /** The value before rewrite (null if the ARG line was missing/malformed). */
  oldRef: string | null;
}

/**
 * Rewrite the `ARG ARC_REF=<value>` definition line to `newRef`. Idempotent:
 * if the current value already equals newRef, content is returned unchanged
 * with changed=false. If the ARG definition line is missing/malformed, oldRef
 * is null and nothing is rewritten (the caller must fail loud).
 *
 * Only the DEFINITION line (with `=<value>`) is touched; the bare re-declaration
 * `ARG ARC_REF` is left intact so the build stage still inherits the default.
 */
export function rewriteArcRef(dockerfile: string, newRef: string): RewriteResult {
  const oldRef = readArcRef(dockerfile);
  if (oldRef === null) return { content: dockerfile, changed: false, oldRef: null };
  if (oldRef === newRef) return { content: dockerfile, changed: false, oldRef };
  const content = dockerfile.replace(
    /^(ARG[ \t]+ARC_REF=)\S+([ \t]*)$/m,
    `$1${newRef}$2`,
  );
  return { content, changed: content !== dockerfile, oldRef };
}

export interface Decision {
  oldRef: string;
  latestRef: string;
  /** True when latestRef is strictly newer than oldRef. */
  shouldBump: boolean;
}

/**
 * Pure decision: given the current pinned ref and the latest release ref,
 * should we bump? Throws on unparseable input so the CLI can exit 3 (loud).
 */
export function decideBump(oldRef: string, latestRef: string): Decision {
  const cur = parseSemver(oldRef);
  const latest = parseSemver(latestRef);
  if (!cur) throw new Error(`current ARC_REF is not a parseable semver tag: "${oldRef}"`);
  if (!latest) throw new Error(`--latest is not a parseable semver tag: "${latestRef}"`);
  return { oldRef, latestRef, shouldBump: compareSemver(latest, cur) > 0 };
}

interface ParsedArgs {
  latest?: string;
  dockerfile: string;
  write: boolean;
  githubOutput: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { dockerfile: DEFAULT_DOCKERFILE, write: false, githubOutput: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--latest":
        out.latest = value(++i, "--latest");
        break;
      case "--dockerfile":
        out.dockerfile = value(++i, "--dockerfile");
        break;
      case "--write":
        out.write = true;
        break;
      case "--github-output":
        out.githubOutput = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function emitGithubOutput(kv: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const body = Object.entries(kv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  appendFileSync(file, body + "\n");
}

export function main(argv: string[]): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`arc-ref-bump: ${(e as Error).message}\n`);
    return 2;
  }
  if (!args.latest) {
    process.stderr.write("arc-ref-bump: --latest <tag> is required\n");
    return 2;
  }

  const path = resolve(args.dockerfile);
  let dockerfile: string;
  try {
    dockerfile = readFileSync(path, "utf8");
  } catch {
    process.stderr.write(`arc-ref-bump: cannot read Dockerfile at ${path}\n`);
    return 3;
  }

  const oldRef = readArcRef(dockerfile);
  if (oldRef === null) {
    process.stderr.write(
      `arc-ref-bump: no 'ARG ARC_REF=<value>' definition line found in ${path} (missing/malformed)\n`,
    );
    return 3;
  }

  let decision: Decision;
  try {
    decision = decideBump(oldRef, args.latest);
  } catch (e) {
    process.stderr.write(`arc-ref-bump: ${(e as Error).message}\n`);
    return 3;
  }

  if (!decision.shouldBump) {
    process.stdout.write(
      `arc-ref-bump: no bump — pinned ${oldRef} is already >= latest release ${args.latest}.\n`,
    );
    if (args.githubOutput) emitGithubOutput({ bumped: "false", old: oldRef, new: oldRef });
    return 0;
  }

  const { content, changed } = rewriteArcRef(dockerfile, args.latest);
  if (!changed) {
    // shouldBump was true but the rewrite was a no-op — treat as loud failure
    // rather than silently reporting a phantom bump.
    process.stderr.write(
      `arc-ref-bump: decided to bump ${oldRef} -> ${args.latest} but the ARG rewrite made no change (malformed line?)\n`,
    );
    return 3;
  }

  if (args.write) {
    writeFileSync(path, content);
    process.stdout.write(`arc-ref-bump: bumped ARC_REF ${oldRef} -> ${args.latest} in ${path}.\n`);
  } else {
    process.stdout.write(
      `arc-ref-bump: WOULD bump ARC_REF ${oldRef} -> ${args.latest} (dry-run; pass --write to apply).\n`,
    );
  }
  if (args.githubOutput) emitGithubOutput({ bumped: "true", old: oldRef, new: args.latest });
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
