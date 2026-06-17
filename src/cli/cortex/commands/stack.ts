#!/usr/bin/env bun
/**
 * `cortex stack <subcommand>` — C-808 (#808) born-aligned stack scaffolding.
 *
 * The PREVENT-side complement to v5.3.8's `warn_stack_identity_drift` (the
 * DETECT side — `scripts/lib/plist-render.sh` + `docs/adr/0004-stack-slug-
 * authority.md`). That detector WARNS at `arc upgrade` time when a stack's
 * filesystem locator (dir basename / `cortex.<slug>.yaml` filename) drifts from
 * `stack.id`'s trailing segment. THIS command makes that drift structurally
 * IMPOSSIBLE for a stack it creates:
 *
 *   - dir basename == slug (the positional), and
 *   - `stack.id = {principal}/{slug}` (derived, never free-typed), and
 *   - an `assertAligned` self-check refuses to write unless all three agree.
 *
 * And UNIQUE within the principal: it refuses if the target dir exists, OR if
 * scanning the existing stacks (split-layout dirs + legacy `cortex*.yaml`
 * monoliths) finds any whose `stack.id` already equals `{principal}/{slug}`.
 *
 * Subcommands:
 *   create <slug>   Scaffold a config-split stack skeleton (the
 *                   docs/config-layout/ template, filled). DRY-RUN by default
 *                   (prints the file set it WOULD write, touches nothing);
 *                   `--apply` writes for real. NEVER overwrites an existing dir.
 *   list            Discovered stacks + their stack.id + aligned/drift flag.
 *
 * SAFETY (mirrors `cortex network`): `create` is dry-run unless `--apply`, so
 * an accidental run during development is inert. It never generates signing
 * keys — `stack.nkey_seed_path` is set to the conventional path and
 * `arc upgrade Cortex` auto-provisions the seed on first install
 * (taps/.../postupgrade.sh §2 — the existing flow).
 *
 * Exit codes: 0 success · 1 operational failure (conflict / write error) · 2 usage.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";
import {
  assertAligned,
  discoverStacks,
  renderScaffold,
  type ScaffoldFile,
} from "./stack-lib";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type StackSubcommand = "create" | "list";

/**
 * Slug + principal grammar. A slug is a single `{stack_id}` segment of the
 * `stack.id` `{principal}/{stack_id}` grammar (src/common/types/stack.ts):
 * lowercase, letter-prefixed, alphanumeric + hyphen/underscore. The principal
 * half matches `PrincipalConfigSchema.id` (provision-stack.ts) — the narrower
 * no-underscore form. Born-aligning to that schema is the whole point (#808):
 * we never write a stack.id the loader would later reject.
 */
const SLUG_RE = /^[a-z][a-z0-9_-]*$/;
const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Default config dir (same canonical path the daemon + network CLI use). */
const DEFAULT_CONFIG_DIR = "~/.config/cortex";
/** Default agent id for the scaffolded stack. */
const DEFAULT_AGENT_ID = "luna";

const SPEC: SubcommandSpec<StackSubcommand> = {
  cliName: "stack",
  subcommands: {
    create: {
      positionals: ["slug"],
      flags: {
        "--principal": "value",
        "--display-name": "value",
        "--agent": "value",
        "--config-dir": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
    list: {
      positionals: [],
      flags: {
        "--config-dir": "value",
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

// =============================================================================
// Helpers
// =============================================================================

/** Expand a leading `~/` to $HOME (same treatment as the loader's expandTilde,
 *  re-implemented locally so the command stays free of loader coupling). */
function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function optionalValueFlag(
  flags: FlagMap,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * `create` writes to disk; the DEFAULT is dry-run (safe). `--apply` opts into
 * the real write; `--dry-run` is accepted explicitly. Both together is a usage
 * error. Mirrors `cortex network`'s `resolveApply`.
 */
function resolveApply(
  flags: FlagMap,
): { ok: true; apply: boolean } | { ok: false; reason: string } {
  const apply = flags["--apply"] === true;
  const dry = flags["--dry-run"] === true;
  if (apply && dry) {
    return { ok: false, reason: "--apply and --dry-run are mutually exclusive" };
  }
  return { ok: true, apply };
}

/**
 * Resolve the principal: explicit `--principal`, else infer from the config dir
 * when EXACTLY one principal is present across the discovered stacks, else a
 * usage error naming the flag. Inferring from a single principal is the common
 * case (one human owns every stack on the host); ambiguity (0 or 2+) is a
 * deliberate usage error so we never guess wrong.
 */
function resolvePrincipal(
  flags: FlagMap,
  configDir: string,
): { ok: true; principal: string } | { ok: false; reason: string } {
  const flagged = optionalValueFlag(flags, "--principal");
  if (flagged !== undefined) return { ok: true, principal: flagged };

  // Infer: collect distinct principal halves of every discovered stack.id.
  const principals = new Set<string>();
  for (const s of discoverStacks(configDir)) {
    if (s.stackId === undefined) continue;
    const principalHalf = s.stackId.split("/")[0];
    if (principalHalf !== undefined && principalHalf.length > 0) principals.add(principalHalf);
  }
  if (principals.size === 1) {
    const only = [...principals][0];
    if (only !== undefined) return { ok: true, principal: only };
  }
  const detail =
    principals.size === 0
      ? "no existing stack to infer it from"
      : `${principals.size.toString()} distinct principals present (${[...principals].sort().join(", ")})`;
  return {
    ok: false,
    reason: `--principal is required (${detail})`,
  };
}

// =============================================================================
// create
// =============================================================================

function runCreate(
  slug: string,
  flags: FlagMap,
  json: boolean,
): ExitResult {
  // --- validate slug -------------------------------------------------------
  if (!SLUG_RE.test(slug)) {
    return usageError(
      "create",
      `slug "${slug}" must be lowercase alphanumeric + hyphen/underscore, letter-prefixed (the {stack_id} segment grammar)`,
      json,
    );
  }

  const configDir = expandTildePath(optionalValueFlag(flags, "--config-dir") ?? DEFAULT_CONFIG_DIR);

  // --- resolve + validate principal ---------------------------------------
  const principalRes = resolvePrincipal(flags, configDir);
  if (!principalRes.ok) return usageError("create", principalRes.reason, json);
  const principal = principalRes.principal;
  if (!PRINCIPAL_ID_RE.test(principal)) {
    return usageError(
      "create",
      `principal "${principal}" must be lowercase alphanumeric + hyphen, letter-prefixed`,
      json,
    );
  }

  // --- agent + display name ------------------------------------------------
  const agentId = optionalValueFlag(flags, "--agent") ?? DEFAULT_AGENT_ID;
  if (!PRINCIPAL_ID_RE.test(agentId)) {
    return usageError(
      "create",
      `--agent "${agentId}" must be lowercase alphanumeric + hyphen, letter-prefixed`,
      json,
    );
  }
  const displayName = optionalValueFlag(flags, "--display-name") ?? capitalize(agentId);
  // --display-name is the one free-form input — it gets interpolated into the
  // generated YAML (stacks/<slug>.yaml `displayName:`) and the persona stub.
  // Reject control characters (the YAML-injection vector: a newline payload
  // could inject sibling keys — a forged nkey_pub, extra roles); the YAML emit
  // also JSON-quotes the scalar as defense-in-depth (stack-lib renderScaffold).
  // Allow ordinary printable text (spaces, unicode, punctuation), capped.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(displayName) || displayName.length > 64) {
    return usageError(
      "create",
      `--display-name must be a single line of printable text (≤64 chars, no control characters)`,
      json,
    );
  }

  // --- derive the born-aligned stack id ------------------------------------
  const stackId = `${principal}/${slug}`;
  const seedPath = `~/.config/nats/cortex-${slug}.nk`;

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("create", applyRes.reason, json);

  const targetDir = join(configDir, slug);

  // --- uniqueness: dir collision ------------------------------------------
  // Never overwrite. Refuse a dir that already exists BEFORE the scan so a
  // partial/foreign dir is a clear, specific error.
  if (existsSync(targetDir)) {
    return opError(
      "create",
      `refusing to create: ${targetDir} already exists (never overwriting). Remove or rename it, or pick a different slug.`,
      json,
    );
  }

  // --- uniqueness: duplicate stack.id within the principal -----------------
  // Scan existing stacks (split dirs + legacy monoliths) for the SAME stack.id.
  // A differently-named dir whose stack.id == {principal}/{slug} would create
  // the exact two-stacks-one-identity ambiguity #808 prevents.
  for (const existing of discoverStacks(configDir)) {
    if (existing.stackId === stackId) {
      return opError(
        "create",
        `refusing to create: stack.id "${stackId}" is already used by ${existing.configPath} (locator slug "${existing.slugLocator}", ${existing.layout} layout). Stack ids must be unique within a principal.`,
        json,
      );
    }
  }

  // --- alignment self-check (the #808 structural guarantee) ----------------
  // dir basename == slug == trailing segment of the stack.id we're about to
  // write. Throws on a mismatch — that would be a bug in THIS command, not a
  // principal input error (those were rejected above). Belt-and-braces before
  // any disk write.
  try {
    assertAligned(slug, stackId);
  } catch (err) {
    return opError("create", err instanceof Error ? err.message : String(err), json);
  }

  // --- render --------------------------------------------------------------
  const files = renderScaffold({ slug, principal, stackId, agentId, displayName, seedPath });

  // --- dry-run (DEFAULT): print the file set, touch NOTHING ----------------
  if (!applyRes.apply) {
    return renderPlan(slug, principal, stackId, agentId, seedPath, targetDir, files, false, json);
  }

  // --- apply: write the file set -------------------------------------------
  try {
    for (const f of files) {
      const dest = join(targetDir, f.relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.contents);
    }
  } catch (err) {
    // Roll back the partial scaffold so a mid-write failure (ENOSPC, EACCES on
    // a subpath, …) doesn't leave a half-written, non-loadable dir that the
    // dir-collision guard (above) would then refuse to re-create. targetDir was
    // confirmed ABSENT before the scan, so the whole subtree is owned by this
    // command — safe to remove. force:true swallows already-gone.
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      // Best-effort cleanup; surface it so the principal knows a manual rm may
      // be needed, but the original write error stays the primary failure.
      process.stderr.write(
        `  ⚠ stack create: rollback of ${targetDir} failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
      );
    }
    return opError(
      "create",
      `write failed (partial scaffold rolled back): ${err instanceof Error ? err.message : String(err)}`,
      json,
    );
  }

  return renderPlan(slug, principal, stackId, agentId, seedPath, targetDir, files, true, json);
}

function renderPlan(
  slug: string,
  principal: string,
  stackId: string,
  agentId: string,
  seedPath: string,
  targetDir: string,
  files: ScaffoldFile[],
  applied: boolean,
  json: boolean,
): ExitResult {
  if (json) {
    return ok(
      renderJson(
        envelopeOk(
          files.map((f) => ({ path: join(targetDir, f.relPath) })),
          {
            slug,
            principal,
            stack_id: stackId,
            agent: agentId,
            seed_path: seedPath,
            aligned: "true",
            applied: applied ? "true" : "false",
          },
        ),
      ),
    );
  }

  const lines: string[] = [];
  lines.push(`cortex stack create ${slug}: ${applied ? "created" : "dry-run"}`);
  if (!applied) lines.push("  (dry-run — no disk mutation; pass --apply to write)");
  lines.push("");
  lines.push(`  principal:  ${principal}`);
  lines.push(`  stack.id:   ${stackId}   (born aligned: dir == slug == trailing segment)`);
  lines.push(`  agent:      ${agentId}`);
  lines.push(`  seed path:  ${seedPath}   (auto-provisioned by 'arc upgrade Cortex' — NOT generated here)`);
  lines.push("");
  lines.push(`  ${applied ? "wrote" : "would write"} under ${targetDir}:`);
  for (const f of files) lines.push(`    • ${f.relPath}`);
  lines.push("");
  if (applied) {
    lines.push("Next steps:");
    lines.push("  1. Fill the <REPLACE_ME> markers (Discord token/guild/channels, your Discord id).");
    lines.push(`  2. Provision the signing seed: arc upgrade Cortex   (auto-provisions ${seedPath} on first install)`);
    lines.push(`  3. Point your daemon at the pointer: cortex start --config ${join(targetDir, `${slug}.yaml`)}`);
    lines.push(`  4. Federate (optional): cortex network join <network>   (run from this stack's config)`);
  } else {
    lines.push("Re-run with --apply to write these files.");
  }
  lines.push("");
  return ok(lines.join("\n"));
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// =============================================================================
// list
// =============================================================================

function runList(
  flags: FlagMap,
  json: boolean,
): ExitResult {
  const configDir = expandTildePath(optionalValueFlag(flags, "--config-dir") ?? DEFAULT_CONFIG_DIR);
  const stacks = discoverStacks(configDir);

  if (json) {
    return ok(
      renderJson(
        envelopeOk(
          stacks.map((s) => ({
            slug_locator: s.slugLocator,
            stack_id: s.stackId ?? "",
            layout: s.layout,
            aligned: s.aligned === undefined ? "unknown" : s.aligned ? "true" : "false",
          })),
          { config_dir: configDir, count: stacks.length.toString() },
        ),
      ),
    );
  }

  if (stacks.length === 0) {
    return ok(`cortex stack list: no stacks under ${configDir}\n`);
  }
  const lines = [`cortex stack list (${configDir}):`, ""];
  for (const s of stacks) {
    const flag =
      s.aligned === undefined ? "no stack.id" : s.aligned ? "aligned" : "DRIFT";
    lines.push(`  ${s.slugLocator}  →  ${s.stackId ?? "(no stack.id)"}  [${s.layout}, ${flag}]`);
  }
  lines.push("");
  return ok(lines.join("\n"));
}

// =============================================================================
// Result builders
// =============================================================================

function ok(stdout: string): ExitResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function usageError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex stack ${sub}: ${reason}\n${topLevelHelp()}`;
  return { exitCode: 2, stdout: "", stderr };
}

/** Operational failure (exit 1) — a conflict or write error, distinct from a
 *  CLI-grammar mistake (exit 2). */
function opError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex stack ${sub}: ${reason}\n`;
  return { exitCode: 1, stdout: "", stderr };
}

// =============================================================================
// Dispatcher
// =============================================================================

// Returns a Promise to match the passthrough contract in src/cortex.ts (and the
// `dispatchNetwork` / `dispatchProvisionStack` siblings), even though every
// handler is synchronous (no disk I/O is awaited — `stack` neither talks to the
// bus nor the registry). Declared non-`async` so the linter's require-await rule
// is satisfied; the explicit `Promise.resolve` wrapping keeps the awaited shape.
export function dispatchStack(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return Promise.resolve({ exitCode: 2 as const, stdout: "", stderr: `cortex stack: ${err.message}\n${topLevelHelp()}` });
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return Promise.resolve({ exitCode: 0 as const, stdout: topLevelHelp(), stderr: "" });
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return Promise.resolve({ exitCode: 2 as const, stdout: "", stderr: `cortex stack: ${msg}\n${topLevelHelp()}` });
  }

  switch (parsed.subcommand) {
    case "create":
      return Promise.resolve(runCreate(parsed.positionals.slug ?? "", parsed.flags, json));
    case "list":
      return Promise.resolve(runList(parsed.flags, json));
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex stack — scaffold + inspect cortex stacks (C-808, #808)

Usage:
  cortex stack create <slug> [--principal <id>] [--apply] [options]
  cortex stack list [--config-dir <path>] [--json]

The prevent-side complement to the install-time slug<->stack.id drift detector
(warn_stack_identity_drift / ADR-0004). \`create\` scaffolds a config-split stack
BORN ALIGNED — dir basename == slug == trailing segment of stack.id — so that
drift can NEVER form for a stack created this way, and UNIQUE within the
principal (refuses a dir collision OR a duplicate stack.id).

Subcommands:
  create  Scaffold a config-split stack skeleton (the docs/config-layout/
          template, filled with your real slug/principal/agent; <REPLACE_ME>
          kept only for true secrets — Discord token/guild/channels + the
          post-first-boot nkey_pub). Derives stack.id = {principal}/{slug};
          sets stack.nkey_seed_path to the conventional ~/.config/nats/
          cortex-<slug>.nk and does NOT generate the seed — 'arc upgrade Cortex'
          auto-provisions it on first install. NEVER overwrites an existing dir.
  list    Show discovered stacks (split-layout dirs + legacy cortex*.yaml
          monoliths) with their stack.id and an aligned/DRIFT flag.

Safety:
  create defaults to DRY-RUN (prints the file set it WOULD write, touches
  nothing). Pass --apply to write. --apply and --dry-run are mutually exclusive.

Flags (create):
  --principal <id>      The principal half of stack.id. Default: inferred from
                        the single existing principal under --config-dir; if
                        zero or 2+ principals are present, it is REQUIRED.
  --display-name <name> The agent's display name (default: capitalized agent id).
  --agent <id>          The agent id on the scaffolded stack (default: luna).
  --config-dir <path>   Config dir to create the stack under (default:
                        ~/.config/cortex). The stack lands at <config-dir>/<slug>/.
  --apply               Write the files (default: dry-run).
  --json                Emit a { status, items, data, error } envelope.

Flags (list):
  --config-dir <path>   Config dir to scan (default: ~/.config/cortex).
  --json                Emit a { status, items, data, error } envelope.
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchStack(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
