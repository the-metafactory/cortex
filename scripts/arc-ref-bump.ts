#!/usr/bin/env bun
/**
 * arc-ref-bump.ts — the version-compare + Dockerfile ARG-rewrite core for the
 * automated container ref-bump workflow (cortex#2246, generalized in
 * cortex#2267 to also track CORTEX_REF).
 *
 * WHY THIS EXISTS
 * ---------------
 * The L4 container (`deploy/compose/Dockerfile.cortex`) pins BOTH
 * `ARG ARC_REF=<tag>` and `ARG CORTEX_REF=<tag>` for reproducibility. Those
 * upstreams move, and a pinned OLDER ref eventually drifts out of sync with the
 * host — e.g. an older arc can't parse newer adapter manifests and `arc install`
 * fails in the container (cortex#2243: v0.40.2 predated the `{host,reason}`
 * manifest shape), or an older CORTEX_REF builds a pre-fix cortex so a container
 * test still hits already-fixed bugs (cortex#2267). The principal decision is to
 * KEEP the pins (reproducible builds; un-pinning to `main` sacrifices
 * reproducibility + adds supply-chain exposure) but AUTOMATE the bump
 * dependabot/renovate-style: a scheduled workflow proposes bumps as reviewable,
 * build-gated PRs.
 *
 * This module is the small, UNIT-TESTABLE core the workflow (.github/workflows/
 * arc-ref-bump.yml) shells out to — semver compare + ARG rewrite — so that
 * logic is NOT buried in inline YAML. The workflow owns the side effects
 * (resolve latest release via `gh api`, `docker build` gate, open the PR); this
 * script owns the pure decision + the exact byte-level Dockerfile edit. The core
 * is parametrized on the ARG NAME (`ARC_REF` or `CORTEX_REF`) so the workflow
 * runs the SAME code path for each pin.
 *
 * REPRODUCIBILITY INVARIANT: this script only ever rewrites the ARG to another
 * PINNED TAG. It never converts the Dockerfile to an unpinned build-time fetch.
 *
 * COMPOSE DRIFT (cortex#2267): the Dockerfile ARG default is NOT the only place a
 * pin lives. `deploy/compose/docker-compose.yaml` also carries
 * `build.args.<NAME>: ${<NAME>:-<tag>}`, and on the PRIMARY deploy path
 * (`docker compose build` / `up -d`) that `build.args` value is passed as
 * `--build-arg` and OVERRIDES the Dockerfile ARG default. So bumping ONLY the
 * Dockerfile would leave the compose default authoritative-but-stale and the
 * deployed image would silently build the pre-bump ref. Therefore, when `--write`
 * bumps the Dockerfile ARG, this script ALSO rewrites the matching
 * `${<NAME>:-<tag>}` default in the compose file — IF that token is present.
 * `ARC_REF` is Dockerfile-only (absent from compose), so its compose sync is a
 * clean no-op; `CORTEX_REF` is present in both and is kept in lockstep.
 *
 * Usage:
 *   bun scripts/arc-ref-bump.ts --latest <tag> [--arg-name <NAME>]
 *                               [--dockerfile <path>] [--compose <path>]
 *                               [--write] [--github-output]
 *
 *   --latest <tag>        REQUIRED. The upstream's latest release tag (e.g.
 *                         v0.42.1 for arc, v6.10.2 for cortex), resolved by the
 *                         workflow via `gh api …/releases/latest`.
 *   --arg-name <NAME>     Which pinned ARG to compare/rewrite. One of
 *                         ARC_REF | CORTEX_REF. Defaults to ARC_REF for
 *                         backward compatibility.
 *   --dockerfile <path>   Dockerfile to read/rewrite. Defaults to
 *                         deploy/compose/Dockerfile.cortex relative to CWD.
 *   --compose <path>      Compose file whose `${<NAME>:-<tag>}` default is kept
 *                         in lockstep with the Dockerfile ARG. Defaults to
 *                         deploy/compose/docker-compose.yaml relative to CWD. A
 *                         missing/unreadable compose file is a non-fatal skip;
 *                         an arg absent from a readable compose is a clean no-op.
 *   --write               Actually rewrite the file(s) when a bump is warranted.
 *                         Without it the script is a dry-run (decision only).
 *   --github-output       Append bumped/old/new to $GITHUB_OUTPUT (for the
 *                         workflow to gate its build + PR steps on).
 *
 * Exit codes:
 *   0  decision made cleanly (whether or not a bump was warranted)
 *   2  usage error (missing --latest, unknown --arg-name, bad flag)
 *   3  Dockerfile unreadable, or its `ARG <NAME>=` definition line is
 *      missing/malformed, or --latest is not a parseable semver tag, or a
 *      READABLE compose file carries a malformed `${<NAME>:-}` default (empty/
 *      invalid tag) for the arg being bumped — fail LOUD, never silent.
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
export const DEFAULT_COMPOSE = "deploy/compose/docker-compose.yaml";

/** The ARG names this tool knows how to compare/rewrite. */
export const KNOWN_ARG_NAMES = ["ARC_REF", "CORTEX_REF"] as const;
export type ArgName = (typeof KNOWN_ARG_NAMES)[number];

/**
 * Guard: only a known, charset-safe ARG name may be spliced into the line
 * regexes below. This both restricts the tool to the two pins we track AND
 * closes any regex-injection surface — the name is never attacker-controlled
 * once it has passed this gate.
 */
export function isKnownArgName(name: string): name is ArgName {
  return (KNOWN_ARG_NAMES as readonly string[]).includes(name);
}

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
 * Extract the current pinned value of the `ARG <argName>=<value>` line — the ARG
 * DEFINITION that carries a default, NOT the bare `ARG <argName>` re-declaration
 * inside the build stage (which has no `=` and no value). Returns null when no
 * definition line with a value is present (malformed / missing). Throws on an
 * unknown argName so a caller can never inject an arbitrary regex.
 */
export function readRef(dockerfile: string, argName: string): string | null {
  if (!isKnownArgName(argName)) throw new Error(`unknown ARG name: "${argName}"`);
  const m = new RegExp(`^ARG[ \\t]+${argName}=(\\S+)[ \\t]*$`, "m").exec(dockerfile);
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
 * Rewrite the `ARG <argName>=<value>` definition line to `newRef`. Idempotent:
 * if the current value already equals newRef, content is returned unchanged
 * with changed=false. If the ARG definition line is missing/malformed, oldRef
 * is null and nothing is rewritten (the caller must fail loud).
 *
 * Only the DEFINITION line (with `=<value>`) is touched; the bare re-declaration
 * `ARG <argName>` is left intact so the build stage still inherits the default.
 */
export function rewriteRef(dockerfile: string, argName: string, newRef: string): RewriteResult {
  const oldRef = readRef(dockerfile, argName); // validates argName
  if (oldRef === null) return { content: dockerfile, changed: false, oldRef: null };
  if (oldRef === newRef) return { content: dockerfile, changed: false, oldRef };
  const content = dockerfile.replace(
    new RegExp(`^(ARG[ \\t]+${argName}=)\\S+([ \\t]*)$`, "m"),
    `$1${newRef}$2`,
  );
  return { content, changed: content !== dockerfile, oldRef };
}

export interface ComposeRewriteResult {
  /** The (possibly unchanged) compose content. */
  content: string;
  /** True only when the `${<argName>:-<tag>}` default actually changed. */
  changed: boolean;
  /** The default value before rewrite; null when the arg's default form is absent. */
  oldRef: string | null;
  /** True when a `${<argName>:-...}` default form is present at all. */
  present: boolean;
  /** True when present but the default is empty/whitespace (malformed). */
  malformed: boolean;
}

/**
 * Rewrite the compose `${<argName>:-<tag>}` default to `newRef`, preserving the
 * `${...:-...}` shape EXACTLY (reproducibility invariant: only ever a pinned
 * tag). This is the compose-side counterpart to `rewriteRef`, needed because a
 * compose `build.args` value is passed as `--build-arg` and OVERRIDES the
 * Dockerfile ARG default on the primary deploy path — so the two must move in
 * lockstep or the deployed image silently builds the stale ref (cortex#2267).
 *
 * The three shapes a caller must distinguish:
 *   - absent   (present=false): the arg has no `${…:-…}` default here — e.g.
 *              ARC_REF, which is Dockerfile-only. A clean NO-OP, never an error.
 *   - malformed (malformed=true): `${<argName>:-}` with an empty/whitespace
 *              default. Mirrors the Dockerfile's missing/malformed discipline —
 *              the caller fails LOUD (exit 3) rather than writing garbage.
 *   - present + valid: rewrite to `newRef` (idempotent when already equal).
 *
 * Only the FIRST occurrence is targeted (compose declares each default once),
 * mirroring the single-line discipline of the Dockerfile rewrite. Throws on an
 * unknown argName so a caller can never splice an arbitrary regex.
 */
export function rewriteComposeDefault(
  compose: string,
  argName: string,
  newRef: string,
): ComposeRewriteResult {
  if (!isKnownArgName(argName)) throw new Error(`unknown ARG name: "${argName}"`);
  const re = new RegExp(`\\$\\{${argName}:-([^}]*)\\}`);
  const m = re.exec(compose);
  if (!m) {
    return { content: compose, changed: false, oldRef: null, present: false, malformed: false };
  }
  const current = m[1] ?? "";
  if (current.trim() === "") {
    // `${<argName>:-}` — an empty/invalid pinned default. Malformed, fail loud.
    return { content: compose, changed: false, oldRef: null, present: true, malformed: true };
  }
  if (current === newRef) {
    return { content: compose, changed: false, oldRef: current, present: true, malformed: false };
  }
  // Function replacement so a `$` in newRef is never treated as a backreference.
  const content = compose.replace(re, () => `\${${argName}:-${newRef}}`);
  return { content, changed: content !== compose, oldRef: current, present: true, malformed: false };
}

export interface Decision {
  argName: ArgName;
  oldRef: string;
  latestRef: string;
  /** True when latestRef is strictly newer than oldRef. */
  shouldBump: boolean;
}

/**
 * Pure decision: given the current pinned ref and the latest release ref,
 * should we bump? Throws on unparseable input so the CLI can exit 3 (loud).
 */
export function decideBump(argName: ArgName, oldRef: string, latestRef: string): Decision {
  const cur = parseSemver(oldRef);
  const latest = parseSemver(latestRef);
  if (!cur) throw new Error(`current ${argName} is not a parseable semver tag: "${oldRef}"`);
  if (!latest) throw new Error(`--latest is not a parseable semver tag: "${latestRef}"`);
  return { argName, oldRef, latestRef, shouldBump: compareSemver(latest, cur) > 0 };
}

interface ParsedArgs {
  latest?: string;
  argName: ArgName;
  dockerfile: string;
  compose: string;
  write: boolean;
  githubOutput: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    argName: "ARC_REF",
    dockerfile: DEFAULT_DOCKERFILE,
    compose: DEFAULT_COMPOSE,
    write: false,
    githubOutput: false,
  };
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
      case "--arg-name": {
        const name = value(++i, "--arg-name");
        if (!isKnownArgName(name)) {
          throw new Error(`--arg-name must be one of ${KNOWN_ARG_NAMES.join(", ")} (got "${name}")`);
        }
        out.argName = name;
        break;
      }
      case "--dockerfile":
        out.dockerfile = value(++i, "--dockerfile");
        break;
      case "--compose":
        out.compose = value(++i, "--compose");
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
  const { argName } = args;

  const path = resolve(args.dockerfile);
  let dockerfile: string;
  try {
    dockerfile = readFileSync(path, "utf8");
  } catch {
    process.stderr.write(`arc-ref-bump: cannot read Dockerfile at ${path}\n`);
    return 3;
  }

  const oldRef = readRef(dockerfile, argName);
  if (oldRef === null) {
    process.stderr.write(
      `arc-ref-bump: no 'ARG ${argName}=<value>' definition line found in ${path} (missing/malformed)\n`,
    );
    return 3;
  }

  let decision: Decision;
  try {
    decision = decideBump(argName, oldRef, args.latest);
  } catch (e) {
    process.stderr.write(`arc-ref-bump: ${(e as Error).message}\n`);
    return 3;
  }

  if (!decision.shouldBump) {
    process.stdout.write(
      `arc-ref-bump: no bump — pinned ${argName}=${oldRef} is already >= latest release ${args.latest}.\n`,
    );
    if (args.githubOutput) emitGithubOutput({ bumped: "false", old: oldRef, new: oldRef });
    return 0;
  }

  const { content, changed } = rewriteRef(dockerfile, argName, args.latest);
  if (!changed) {
    // shouldBump was true but the rewrite was a no-op — treat as loud failure
    // rather than silently reporting a phantom bump.
    process.stderr.write(
      `arc-ref-bump: decided to bump ${argName} ${oldRef} -> ${args.latest} but the ARG rewrite made no change (malformed line?)\n`,
    );
    return 3;
  }

  // ── Compose side: keep the `${<argName>:-<tag>}` default in lockstep with the
  //    Dockerfile ARG (cortex#2267). Computed BEFORE any write so a malformed
  //    compose default fails loud (exit 3) without leaving a half-applied bump.
  const composePath = resolve(args.compose);
  const composeToken = "${" + argName + ":-<tag>}";
  let composeText: string | null = null;
  try {
    composeText = readFileSync(composePath, "utf8");
  } catch {
    // Compose is optional for a given arg — a missing/unreadable file is a
    // non-fatal skip (the Dockerfile bump still stands), not an error.
    process.stderr.write(
      `arc-ref-bump: compose file at ${composePath} is missing/unreadable — skipping compose sync (non-fatal).\n`,
    );
  }

  let composeContent: string | null = null;
  let composeChanged = false;
  if (composeText !== null) {
    const cr = rewriteComposeDefault(composeText, argName, args.latest);
    if (cr.malformed) {
      process.stderr.write(
        `arc-ref-bump: '${composeToken}' default in ${composePath} is malformed (empty/invalid tag)\n`,
      );
      return 3;
    }
    if (!cr.present) {
      process.stdout.write(
        `arc-ref-bump: no '${composeToken}' default in ${composePath} — compose sync is a no-op for ${argName}.\n`,
      );
    } else if (!cr.changed) {
      process.stdout.write(
        `arc-ref-bump: compose default ${argName} already at ${args.latest} in ${composePath} — no change.\n`,
      );
    } else {
      composeContent = cr.content;
      composeChanged = true;
    }
  }

  if (args.write) {
    writeFileSync(path, content);
    process.stdout.write(`arc-ref-bump: bumped ${argName} ${oldRef} -> ${args.latest} in ${path}.\n`);
    if (composeChanged && composeContent !== null) {
      writeFileSync(composePath, composeContent);
      process.stdout.write(
        `arc-ref-bump: bumped compose default ${argName} -> ${args.latest} in ${composePath}.\n`,
      );
    }
  } else {
    process.stdout.write(
      `arc-ref-bump: WOULD bump ${argName} ${oldRef} -> ${args.latest} (dry-run; pass --write to apply).\n`,
    );
    if (composeChanged) {
      process.stdout.write(
        `arc-ref-bump: WOULD also bump compose default ${argName} -> ${args.latest} in ${composePath} (dry-run).\n`,
      );
    }
  }
  if (args.githubOutput) emitGithubOutput({ bumped: "true", old: oldRef, new: args.latest });
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
