#!/usr/bin/env bun
/**
 * `cortex config merge` — merge a package-declared capability/policy fragment
 * into a cortex stack's config-split layers (F-6a, cortex#858).
 *
 * WHY THIS EXISTS
 * ---------------
 * When arc installs a package onto a cortex stack (e.g. the `dev-loop`
 * blueprint), the package's manifests declare the **capabilities** the new
 * agents provide and the **policy** entries (principals + roles) that grant
 * them. Today a principal must hand-edit `stacks/{stack-id}.yaml` to wire those
 * in. F-6a delivers an automated, validated, idempotent merge so the arc
 * install lifecycle (design §6.2 step 3) can compose config without a human in
 * the loop.
 *
 * This slice ships the cortex-side verb only. The arc-side `cortex_config`
 * manifest field + the `arc install` step-6c hook that CALLS this verb are a
 * follow-up (cortex#858 "Arc Install Integration" + companion arc work).
 *
 * SCOPE — capabilities + policy ONLY
 * ----------------------------------
 * A merge fragment is a constrained subset of a cortex.yaml: it may carry
 * `capabilities[]` and/or `policy{ principals[], roles[] }` and NOTHING else.
 * It is NOT a full CortexConfig (which requires `principal` + `agents[]`); a
 * fragment on its own is meaningless. The fragment is validated against
 * `CapabilityMergeFragmentSchema` (this file), then MERGED onto the stack's
 * existing config, and the COMPOSED WHOLE is validated against
 * `CortexConfigSchema` before anything is written.
 *
 * MERGE SEMANTICS — id-keyed append, fragment-wins on conflict
 * ------------------------------------------------------------
 * `capabilities[]`, `policy.principals[]`, `policy.roles[]` are id-keyed
 * collections, NOT replace-wholesale arrays. The loader's `deepMerge`
 * (loader.ts:254) replaces arrays wholesale — correct for `nats.subjects[]`,
 * WRONG here (it would drop every capability already declared on the stack).
 * So this verb does an id-keyed UNION:
 *   - id absent from the target → APPEND the fragment entry.
 *   - id already present + byte-identical → SKIP (idempotent no-op + note).
 *   - id already present + DIFFERENT → fragment WINS (replace the entry),
 *     and a `changed:` note records the override.
 * Scalar/object policy sub-keys outside the three id-keyed arrays are
 * deep-merged fragment-wins via the same recursive merge as the loader.
 *
 * IDEMPOTENCY
 * -----------
 * Running the same fragment twice yields the same file on the second run:
 * every entry matches an existing id byte-for-byte → all SKIP. This lets arc
 * retry a partially-failed install safely.
 *
 * ROLLBACK (--rollback)
 * ---------------------
 * Given a fragment, REMOVE the corresponding capabilities/policy ids from the
 * target (uninstall / recovery). Removal is by id; the post-removal config is
 * re-validated against `CortexConfigSchema` so a rollback can't leave the stack
 * in a state that won't load (e.g. an agent still referencing a removed
 * capability surfaces as a Zod error, exit 1, no write).
 *
 * Usage:
 *   bun src/cli/cortex/commands/config-merge.ts \
 *     --config <cortex.yaml|config-dir> \
 *     --fragment <fragment.yaml> \
 *     [--stack <stack-id>] [--dry-run] [--rollback] [-h|--help]
 *
 * Flags:
 *   --config DIR/FILE   Stack config-split dir (or legacy single cortex.yaml).
 *   --fragment FILE     YAML fragment (capabilities + policy only).
 *   --stack ID          Target stack id ({principal}/{stack}); required when
 *                       the config dir holds more than one stacks/*.yaml.
 *   --dry-run           Print the diff, validate, exit 0 — NO write.
 *   --rollback          Remove the fragment's ids instead of merging them in.
 *   -h, --help          Show this help.
 *
 * Exit codes:
 *   0  — merged / rolled-back successfully (or idempotent no-op).
 *   1  — failure (read/parse/schema error, ambiguous target, validation fail).
 *   2  — usage error (bad flags, missing required arg).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import YAML from "yaml";
import { z } from "zod/v4";

import { composeRawConfig } from "../../../common/config/loader";
import { CapabilitySchema } from "../../../common/types/capability";
import {
  CortexConfigSchema,
  PolicyPrincipalSchema,
  PolicyRoleSchema,
} from "../../../common/types/cortex-config";

// =============================================================================
// Fragment schema — capabilities + policy ONLY (the constrained subset)
// =============================================================================

/**
 * The policy subset a fragment may carry. Mirrors the id-keyed arrays of the
 * full `PolicySchema` but WITHOUT the `superRefine` cross-field guards — those
 * only make sense on the composed WHOLE (a fragment's role refs resolve against
 * the merged config, not the fragment in isolation). Structural per-entry
 * validation (id grammar, required fields) still runs via the reused
 * `PolicyPrincipalSchema` / `PolicyRoleSchema`.
 *
 * `.strict()` so a fragment author can't smuggle extra policy keys (e.g. a
 * `superRefine`-only field) past the subset boundary.
 */
const FragmentPolicySchema = z
  .object({
    principals: z.array(PolicyPrincipalSchema).default([]),
    roles: z.array(PolicyRoleSchema).default([]),
  })
  .strict();

/**
 * A merge fragment: capabilities + policy ONLY. `.strict()` rejects any other
 * top-level key (`agents`, `principal`, `nats`, …) so a caller can't sneak a
 * transport/identity change in through the merge path — those are NOT a
 * package's to declare. At least one of the two blocks must be present (an
 * empty fragment is a caller error, not a silent no-op).
 */
export const CapabilityMergeFragmentSchema = z
  .object({
    capabilities: z.array(CapabilitySchema).optional(),
    policy: FragmentPolicySchema.optional(),
  })
  .strict()
  .refine(
    (f) => f.capabilities !== undefined || f.policy !== undefined,
    {
      message:
        "fragment must declare at least one of `capabilities:` or `policy:` — an empty fragment merges nothing",
    },
  );

export type CapabilityMergeFragment = z.infer<typeof CapabilityMergeFragmentSchema>;

// =============================================================================
// Pure merge core — no file I/O
// =============================================================================

/** A note describing one entry's disposition during a merge or rollback. */
export interface MergeNote {
  kind: "capability" | "principal" | "role";
  id: string;
  /** added: new entry. skipped: byte-identical idempotent no-op. changed:
   * fragment overrode an existing different entry. removed: rollback removed
   * it. absent: rollback target id was not present (no-op removal). */
  action: "added" | "skipped" | "changed" | "removed" | "absent";
}

export interface MergeResult {
  /** The merged target-layer object (deep clone; inputs are not mutated). */
  layer: Record<string, unknown>;
  notes: MergeNote[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stable structural equality via canonical JSON (key order is irrelevant for
 * config objects parsed from YAML; YAML.parse yields plain objects/arrays/
 * scalars so JSON round-trips losslessly). Used to detect byte-identical
 * idempotent entries. */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  if (v === undefined) return "null";
  return JSON.stringify(v);
}

/** An id-keyed entry — the shape capabilities / principals / roles all share. */
interface IdEntry {
  readonly id: string;
}

/** Coerce the on-disk `base` value (which arrives as `unknown` from YAML.parse)
 * into a cloned array of records. A missing/non-array base contributes []. */
function cloneBaseArray(base: unknown): Record<string, unknown>[] {
  if (!Array.isArray(base)) return [];
  return base.map((e) => structuredClone(e) as Record<string, unknown>);
}

/**
 * Merge an id-keyed collection: append new ids, skip byte-identical, replace
 * (fragment-wins) on id-match-but-different. Returns a new array + notes.
 */
function mergeIdKeyed(
  base: unknown,
  incoming: readonly IdEntry[],
  kind: MergeNote["kind"],
): { merged: Record<string, unknown>[]; notes: MergeNote[] } {
  const out = cloneBaseArray(base);
  const notes: MergeNote[] = [];
  for (const entry of incoming) {
    const id = entry.id;
    const idx = out.findIndex((e) => String(e.id) === id);
    const clone = structuredClone(entry) as unknown as Record<string, unknown>;
    if (idx === -1) {
      out.push(clone);
      notes.push({ kind, id, action: "added" });
    } else if (deepEqual(out[idx], entry)) {
      notes.push({ kind, id, action: "skipped" });
    } else {
      out[idx] = clone;
      notes.push({ kind, id, action: "changed" });
    }
  }
  return { merged: out, notes };
}

/**
 * Remove ids of an id-keyed collection (rollback). Returns a new array + notes.
 */
function removeIdKeyed(
  base: unknown,
  incoming: readonly IdEntry[],
  kind: MergeNote["kind"],
): { merged: Record<string, unknown>[]; notes: MergeNote[] } {
  const out = cloneBaseArray(base);
  const notes: MergeNote[] = [];
  for (const entry of incoming) {
    const id = entry.id;
    const idx = out.findIndex((e) => String(e.id) === id);
    if (idx === -1) {
      notes.push({ kind, id, action: "absent" });
    } else {
      out.splice(idx, 1);
      notes.push({ kind, id, action: "removed" });
    }
  }
  return { merged: out, notes };
}

/**
 * Merge `fragment` into `layer` (the target stack-layer object), id-keyed
 * append fragment-wins. PURE — `layer` is not mutated. Empty result arrays are
 * pruned so an unchanged block doesn't materialise as `capabilities: []`.
 */
export function mergeFragmentIntoLayer(
  layer: Record<string, unknown>,
  fragment: CapabilityMergeFragment,
): MergeResult {
  const out: Record<string, unknown> = structuredClone(layer);
  const notes: MergeNote[] = [];

  if (fragment.capabilities !== undefined) {
    const { merged, notes: n } = mergeIdKeyed(out.capabilities, fragment.capabilities, "capability");
    out.capabilities = merged;
    notes.push(...n);
  }

  if (fragment.policy !== undefined) {
    const policy: Record<string, unknown> = isPlainObject(out.policy)
      ? structuredClone(out.policy)
      : {};
    if (fragment.policy.principals.length > 0) {
      const { merged, notes: n } = mergeIdKeyed(policy.principals, fragment.policy.principals, "principal");
      policy.principals = merged;
      notes.push(...n);
    }
    if (fragment.policy.roles.length > 0) {
      const { merged, notes: n } = mergeIdKeyed(policy.roles, fragment.policy.roles, "role");
      policy.roles = merged;
      notes.push(...n);
    }
    out.policy = policy;
  }

  return { layer: out, notes };
}

/**
 * Rollback: remove the fragment's ids from `layer`. PURE. Mirror of
 * `mergeFragmentIntoLayer`.
 */
export function removeFragmentFromLayer(
  layer: Record<string, unknown>,
  fragment: CapabilityMergeFragment,
): MergeResult {
  const out: Record<string, unknown> = structuredClone(layer);
  const notes: MergeNote[] = [];

  if (fragment.capabilities !== undefined) {
    const { merged, notes: n } = removeIdKeyed(out.capabilities, fragment.capabilities, "capability");
    out.capabilities = merged;
    notes.push(...n);
  }

  if (fragment.policy !== undefined && isPlainObject(out.policy)) {
    const policy: Record<string, unknown> = structuredClone(out.policy);
    if (fragment.policy.principals.length > 0) {
      const { merged, notes: n } = removeIdKeyed(policy.principals, fragment.policy.principals, "principal");
      policy.principals = merged;
      notes.push(...n);
    }
    if (fragment.policy.roles.length > 0) {
      const { merged, notes: n } = removeIdKeyed(policy.roles, fragment.policy.roles, "role");
      policy.roles = merged;
      notes.push(...n);
    }
    out.policy = policy;
  }

  return { layer: out, notes };
}

/**
 * Summarise notes into a human line, e.g.
 *   "2 capabilities added, 1 skipped; 1 role changed".
 * Returns "no changes" when every note is a no-op (skipped/absent).
 */
export function summariseNotes(notes: MergeNote[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const key = `${n.action}:${n.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order: MergeNote["action"][] = ["added", "changed", "removed", "skipped", "absent"];
  const kindPlural: Record<MergeNote["kind"], string> = {
    capability: "capabilities",
    principal: "principals",
    role: "roles",
  };
  const parts: string[] = [];
  for (const action of order) {
    for (const kind of ["capability", "principal", "role"] as MergeNote["kind"][]) {
      const c = counts.get(`${action}:${kind}`);
      if (c !== undefined && c > 0) {
        parts.push(`${c} ${kindPlural[kind]} ${action}`);
      }
    }
  }
  if (parts.length === 0) return "no changes";
  const effective = notes.some(
    (n) => n.action === "added" || n.action === "changed" || n.action === "removed",
  );
  return effective ? parts.join(", ") : `${parts.join(", ")} (idempotent no-op)`;
}

// =============================================================================
// Target-layer resolution
// =============================================================================

/** The marker file whose presence selects the config-split directory layout. */
const LAYOUT_MARKER = join("system", "system.yaml");

export interface ResolvedTarget {
  /** Absolute path to the layer file the merge writes to. */
  filePath: string;
  /** The config dir to re-compose for whole-config validation. */
  configDir: string;
  /** Path to hand `composeRawConfig` (the config dir's pointer / the file). */
  composePath: string;
  /** True for the legacy single-file form (target IS the cortex.yaml). */
  singleFile: boolean;
}

function listStackFiles(stacksDir: string): string[] {
  if (!existsSync(stacksDir)) return [];
  return readdirSync(stacksDir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => join(stacksDir, f));
}

/** Read a stack file's declared `stack.id` (or undefined if not declared). */
function readStackId(filePath: string): string | undefined {
  try {
    const parsed = YAML.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (isPlainObject(parsed) && isPlainObject(parsed.stack) && typeof parsed.stack.id === "string") {
      return parsed.stack.id;
    }
  } catch {
    // A malformed stack file surfaces later during re-compose; for target
    // resolution we just treat its id as undeclared (it won't match --stack).
    return undefined;
  }
  return undefined;
}

/**
 * Resolve which file the merge writes to from `--config` + optional `--stack`.
 *
 *  - Single-file legacy (`--config` points at a cortex.yaml with no sibling
 *    system/system.yaml): the target IS that file.
 *  - Config-split dir: target a `stacks/*.yaml`. `--stack` matches a file's
 *    declared `stack.id` (or the file basename without extension). With no
 *    `--stack`: one stack file → use it; zero or many → error.
 *
 * Throws (Error) with a clear, target-naming message on any ambiguity.
 */
export function resolveTarget(configPath: string, stackId: string | undefined): ResolvedTarget {
  const resolved = resolve(configPath);
  const stat = existsSync(resolved) ? statSync(resolved) : undefined;
  if (stat === undefined) {
    throw new Error(`--config path does not exist: ${resolved}`);
  }

  // Determine the config dir + the system marker location.
  const configDir = stat.isDirectory() ? resolved : dirname(resolved);
  const markerPath = join(configDir, LAYOUT_MARKER);

  if (!existsSync(markerPath)) {
    // Single-file legacy form. The target IS the cortex.yaml file. When
    // `--config` is a directory with no marker we can't pick a single file.
    if (stat.isDirectory()) {
      throw new Error(
        `--config ${resolved} is a directory with no ${LAYOUT_MARKER} marker — ` +
          `point --config at the single cortex.yaml file, or at a config-split dir`,
      );
    }
    if (stackId !== undefined) {
      throw new Error(
        `--stack ${stackId} given but --config ${resolved} is a single-file (legacy) config with no stacks/ layer`,
      );
    }
    return { filePath: resolved, configDir, composePath: resolved, singleFile: true };
  }

  // Config-split dir. Pick a stacks/*.yaml.
  const stacksDir = join(configDir, "stacks");
  const stackFiles = listStackFiles(stacksDir);
  if (stackFiles.length === 0) {
    throw new Error(`config-split dir ${configDir} has no stacks/*.yaml layer to merge into`);
  }

  // composePath: the composer keys layout detection off `dirname(path)` and
  // looks for `dirname(path)/system/system.yaml`. So we MUST hand it a path
  // whose dirname is the config dir (NOT the marker file itself — passing the
  // marker would make dirname = `<configDir>/system`, miss the nested marker,
  // and fall into the single-file branch that chmod-600-gates the marker).
  // A virtual pointer basename inside configDir is the correct shape; the file
  // need not exist because the marker presence selects the directory layout.
  const composePath = join(configDir, "config-merge-pointer.yaml");

  if (stackId === undefined) {
    const [only] = stackFiles;
    if (stackFiles.length === 1 && only !== undefined) {
      return { filePath: only, configDir, composePath, singleFile: false };
    }
    const names = stackFiles.map((f) => f.replace(`${stacksDir}/`, "")).join(", ");
    throw new Error(
      `config-split dir ${configDir} has ${stackFiles.length} stack files (${names}); ` +
        `pass --stack <id> to pick one`,
    );
  }

  // Match --stack against declared stack.id OR the file basename (no ext).
  const wanted = stackId;
  const wantedTail = stackId.includes("/") ? stackId.slice(stackId.lastIndexOf("/") + 1) : stackId;
  for (const file of stackFiles) {
    const declaredId = readStackId(file);
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, "");
    if (declaredId === wanted || base === wanted || base === wantedTail) {
      return { filePath: file, configDir, composePath, singleFile: false };
    }
  }
  const names = stackFiles.map((f) => f.replace(`${stacksDir}/`, "")).join(", ");
  throw new Error(
    `--stack ${stackId} matched no stack file in ${stacksDir} (have: ${names}). ` +
      `Match against a file's declared stack.id or its basename.`,
  );
}

// =============================================================================
// Timestamped backup helper (mirrors normalize-config)
// =============================================================================

function buildBackupPath(filePath: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  return `${filePath}.pre-config-merge-${stamp}.bak`;
}

// =============================================================================
// CLI argument parsing — hand-rolled (mirrors normalize-config)
// =============================================================================

export interface ParsedArgs {
  config: string | undefined;
  fragment: string | undefined;
  stack: string | undefined;
  dryRun: boolean;
  rollback: boolean;
  help: boolean;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} requires a value argument`);
  }
  return next;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    config: undefined,
    fragment: undefined,
    stack: undefined,
    dryRun: false,
    rollback: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--rollback") {
      args.rollback = true;
    } else if (a === "--config") {
      args.config = takeValue(argv, i, "--config");
      i++;
    } else if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length);
    } else if (a === "--fragment") {
      args.fragment = takeValue(argv, i, "--fragment");
      i++;
    } else if (a.startsWith("--fragment=")) {
      args.fragment = a.slice("--fragment=".length);
    } else if (a === "--stack") {
      args.stack = takeValue(argv, i, "--stack");
      i++;
    } else if (a.startsWith("--stack=")) {
      args.stack = a.slice("--stack=".length);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    "cortex config merge — merge a capability/policy fragment into a stack's config-split layers\n\n" +
      "Usage:\n" +
      "  bun src/cli/cortex/commands/config-merge.ts --config <dir|cortex.yaml> --fragment <fragment.yaml> [options]\n\n" +
      "Options:\n" +
      "  --config DIR/FILE   Stack config-split dir (or legacy single cortex.yaml)\n" +
      "  --fragment FILE     YAML fragment (capabilities + policy ONLY)\n" +
      "  --stack ID          Target stack id; required when >1 stacks/*.yaml exist\n" +
      "  --dry-run           Print the diff, validate, exit 0 — no write\n" +
      "  --rollback          Remove the fragment's ids instead of merging them in\n" +
      "  -h, --help          Show this help\n\n" +
      "Exit codes: 0 ok | 1 failure | 2 usage error\n",
  );
}

// =============================================================================
// Main — exported for testing
// =============================================================================

/**
 * Load + structurally validate the fragment file. Throws on read/parse/schema
 * error with a message the caller surfaces verbatim.
 */
export function loadFragment(fragmentPath: string): CapabilityMergeFragment {
  const resolved = resolve(fragmentPath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf-8");
  } catch (err) {
    throw new Error(`cannot read fragment ${resolved}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`invalid YAML in fragment ${resolved}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const validated = CapabilityMergeFragmentSchema.safeParse(parsed ?? {});
  if (!validated.success) {
    throw new Error(`fragment ${resolved} failed CapabilityMergeFragmentSchema: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Run the config-merge workflow. Exported so the in-process test harness can
 * call it without spawning a subprocess. Returns the exit code.
 *
 * @param argv  Arguments following the script name (process.argv.slice(2))
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function runConfigMerge(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.config) {
    process.stderr.write("Error: --config is required\n\n");
    printHelp();
    return 2;
  }
  if (!args.fragment) {
    process.stderr.write("Error: --fragment is required\n\n");
    printHelp();
    return 2;
  }

  // 1. Load + validate the fragment structurally.
  let fragment: CapabilityMergeFragment;
  try {
    fragment = loadFragment(args.fragment);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 2. Resolve the target layer file.
  let target: ResolvedTarget;
  try {
    target = resolveTarget(args.config, args.stack);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 3. Read the target layer file as-is.
  let originalText: string;
  try {
    originalText = readFileSync(target.filePath, "utf-8");
  } catch (err) {
    process.stderr.write(
      `Error: cannot read target ${target.filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  let layer: Record<string, unknown>;
  try {
    const parsed = YAML.parse(originalText) as unknown;
    layer = isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    process.stderr.write(
      `Error: invalid YAML in target ${target.filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // 4. Merge (or remove for rollback) — pure, fragment-wins, id-keyed.
  const { layer: mergedLayer, notes } = args.rollback
    ? removeFragmentFromLayer(layer, fragment)
    : mergeFragmentIntoLayer(layer, fragment);

  const verb = args.rollback ? "rollback" : "merge";
  const summary = summariseNotes(notes);
  process.stderr.write(`config ${verb}: target ${target.filePath}\n`);
  process.stderr.write(`config ${verb}: ${summary}\n`);
  for (const n of notes) {
    process.stderr.write(`  ${n.action.padEnd(8)} ${n.kind} ${n.id}\n`);
  }

  const newText = YAML.stringify(mergedLayer, { indent: 2, lineWidth: 0 });

  // 5. Validate the COMPOSED WHOLE against CortexConfigSchema BEFORE write.
  //    We compose by writing the candidate to a temp copy of the layer? No —
  //    re-compose deterministically by substituting our merged layer for the
  //    on-disk one in-memory: easiest correct path is to write, re-compose,
  //    validate, and roll back on failure. To avoid a write-then-revert dance
  //    we compose against the merged layer directly for the single-file form,
  //    and for the split form we stage the write under a backup so a failed
  //    validation restores the original.
  const composedValidation = validateComposed(target, newText, originalText);
  if (!composedValidation.ok) {
    process.stderr.write(
      `config ${verb}: composed config failed CortexConfigSchema — NOT writing.\n` +
        `  ${composedValidation.error}\n`,
    );
    return 1;
  }

  // 6. Dry-run: report + exit, no write.
  if (args.dryRun) {
    process.stderr.write(`config ${verb} --dry-run: validation PASSED; no file written\n`);
    if (newText !== originalText) {
      process.stdout.write(renderDiff(target.filePath, originalText, newText));
    }
    return 0;
  }

  // 7. Idempotent no-op: nothing changed → don't rewrite or drop a backup
  //    (rewriting would reformat the file + falsely signal a modification).
  if (newText === originalText) {
    process.stderr.write(`config ${verb}: target already in desired state — nothing written\n`);
    return 0;
  }

  // 8. Timestamped backup, then in-place write.
  const backupPath = buildBackupPath(target.filePath);
  try {
    writeFileSync(backupPath, originalText, "utf-8");
    process.stderr.write(`config ${verb}: backup saved to ${backupPath}\n`);
  } catch (err) {
    process.stderr.write(
      `Error: cannot write backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  try {
    writeFileSync(target.filePath, newText, "utf-8");
    process.stderr.write(`config ${verb}: wrote ${target.filePath}\n`);
  } catch (err) {
    process.stderr.write(
      `Error: cannot write ${target.filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // 9. Re-compose from disk + re-validate (belt-and-braces; the in-memory
  //    validation in step 5 already passed, but a disk re-compose catches any
  //    serialization surprise — e.g. a YAML anchor the stringify introduced).
  try {
    const recomposed = composeRawConfig(target.composePath);
    const reval = CortexConfigSchema.safeParse(recomposed);
    if (!reval.success) {
      // Restore from backup — never leave the stack in an unloadable state.
      writeFileSync(target.filePath, originalText, "utf-8");
      process.stderr.write(
        `config ${verb}: post-write re-compose FAILED validation — restored original from backup.\n` +
          `  ${reval.error.message}\n`,
      );
      return 1;
    }
  } catch (err) {
    writeFileSync(target.filePath, originalText, "utf-8");
    process.stderr.write(
      `config ${verb}: post-write re-compose threw — restored original from backup.\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stderr.write(`config ${verb}: ${summary} — OK\n`);
  return 0;
}

/**
 * Validate the composed whole with the merged layer substituted in. For the
 * single-file form the merged layer IS the whole config. For the split form we
 * compose with the on-disk layers but swap our merged candidate in for the
 * target layer by writing it, composing, then restoring — done here behind a
 * try/finally so a validation failure never leaves the disk dirty.
 */
function validateComposed(
  target: ResolvedTarget,
  newLayerText: string,
  originalLayerText: string,
): { ok: true } | { ok: false; error: string } {
  if (target.singleFile) {
    // The whole config is the single file — validate the merged candidate.
    let parsed: unknown;
    try {
      parsed = YAML.parse(newLayerText);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const res = CortexConfigSchema.safeParse(parsed);
    return res.success ? { ok: true } : { ok: false, error: res.error.message };
  }

  // Split form: temporarily stage the candidate layer on disk, compose, then
  // ALWAYS restore the original (try/finally) so this validation is pure from
  // the disk's point of view.
  let composed: Record<string, unknown>;
  try {
    writeFileSync(target.filePath, newLayerText, "utf-8");
    composed = composeRawConfig(target.composePath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    writeFileSync(target.filePath, originalLayerText, "utf-8");
  }
  const res = CortexConfigSchema.safeParse(composed);
  return res.success ? { ok: true } : { ok: false, error: res.error.message };
}

/** A minimal line-oriented diff for --dry-run output (added/removed prefixes). */
function renderDiff(label: string, before: string, after: string): string {
  const b = before.split("\n");
  const a = after.split("\n");
  const bSet = new Set(b);
  const aSet = new Set(a);
  const lines: string[] = [`--- ${label} (current)`, `+++ ${label} (merged)`];
  for (const line of a) {
    if (!bSet.has(line)) lines.push(`+ ${line}`);
  }
  for (const line of b) {
    if (!aSet.has(line)) lines.push(`- ${line}`);
  }
  return lines.join("\n") + "\n";
}

// =============================================================================
// Entry point
// =============================================================================

if (import.meta.main) {
  runConfigMerge(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`Fatal: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
