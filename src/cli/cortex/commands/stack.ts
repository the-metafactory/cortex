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
 * `arc upgrade cortex` auto-provisions the seed on first install
 * (taps/.../postupgrade.sh §2 — the existing flow).
 *
 * Exit codes: 0 success · 1 operational failure (conflict / write error) · 2 usage.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { homedir } from "os";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";
import {
  assertAligned,
  discoverStacks,
  readJoinedNetworkIds,
  renderScaffold,
  resolveStackArtifacts,
  retiredSeedPath,
  type ScaffoldFile,
  type TeardownRoots,
} from "./stack-lib";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type StackSubcommand = "create" | "list" | "delete";

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
/** Default NATS material dir (rendered `<slug>.conf`, leaf includes, seed). */
const DEFAULT_NATS_DIR = "~/.config/nats";
/** Default launchd LaunchAgents dir (the daemon + nats plists, macOS). */
const DEFAULT_LAUNCH_AGENTS_DIR = "~/Library/LaunchAgents";
/** Default agent id for the scaffolded stack — neutral placeholder, not a personal persona name (#1338). */
const DEFAULT_AGENT_ID = "assistant";

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
    delete: {
      positionals: ["slug"],
      flags: {
        "--config-dir": "value",
        // Advanced overrides for non-standard installs (default to the
        // conventional ~/.config/nats and ~/Library/LaunchAgents). Also the
        // seam the tests point at tmp dirs so teardown never touches the real
        // home. Mirrors `cortex network`'s explicit --nats-config / --plist
        // override posture.
        "--nats-dir": "value",
        "--launch-agents-dir": "value",
        // Destructive-action confirmation: the literal slug must be typed after
        // --confirm when --apply is set (never a glob).
        "--confirm": "value",
        // Full key destruction. Default is retire-not-delete for the signing
        // seed; --purge-seeds opts into wiping it (a separate conscious act).
        "--purge-seeds": "bool",
        "--apply": "bool",
        "--dry-run": "bool",
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
  lines.push(`  seed path:  ${seedPath}   (auto-provisioned by 'arc upgrade cortex' — NOT generated here)`);
  lines.push("");
  lines.push(`  ${applied ? "wrote" : "would write"} under ${targetDir}:`);
  for (const f of files) lines.push(`    • ${f.relPath}`);
  lines.push("");
  if (applied) {
    lines.push("Next steps:");
    lines.push("  1. Fill the <REPLACE_ME> markers (Discord token/guild/channels, your Discord id).");
    lines.push(`  2. Provision the signing seed: arc upgrade cortex   (auto-provisions ${seedPath} on first install)`);
    lines.push(`  3. Mint this stack's bus account tree: cortex network provision ${slug} --apply   (mints the agents/system accounts)`);
    lines.push(`  4. Bring the bus live: cortex network make-live ${slug} --apply   (mints this daemon's bus creds at ~/.config/nats/${slug}-bot.creds + restarts nats-server)`);
    lines.push(`  5. Point your daemon at the pointer: cortex start --config ${join(targetDir, `${slug}.yaml`)}`);
    lines.push(`  6. Federate (optional): cortex network join <network>   (run from this stack's config)`);
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
// delete (C-1351 Slice 1 — local teardown)
// =============================================================================

/** One planned teardown action. `exists` drives dry-run rendering + the
 *  idempotent apply (missing pieces are skipped, never an error). */
interface TeardownAction {
  /** Short label for the plan/summary line. */
  label: string;
  /** Absolute target path. */
  path: string;
  /** Present on disk right now. */
  exists: boolean;
  /** How --apply handles it. */
  op: "unload+remove" | "remove-dir" | "remove-file" | "retire-seed" | "purge-seed";
  /** For retire-seed: the resolved `<seed>.retired-<stamp>` destination. */
  retireTo?: string;
}

/**
 * A per-artifact teardown failure recorded during --apply. #1384 review (MAJOR)
 * — kept structurally (not just as human `steps` prose) so `--json` can surface
 * it and the exit code can go non-zero on a partial teardown.
 */
interface TeardownFailure {
  label: string;
  path: string;
  error: string;
}

/**
 * Best-effort unload of a launchd plist before removing it (macOS). An
 * already-unloaded / never-loaded service makes `launchctl unload` exit
 * non-zero — non-fatal (we are tearing down), so we swallow it and continue.
 * On non-darwin platforms the daemon is a systemd user unit, not a plist:
 * Slice 1 targets the launchd path `cortex stack create` scaffolds; a systemd
 * teardown is a documented follow-up. Never throws.
 */
function serviceUnload(plistPath: string, steps: string[]): void {
  if (process.platform !== "darwin") return; // systemd teardown = Slice-1 follow-up
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    steps.push(`  unloaded launchd service: ${plistPath}`);
  } catch (_err) {
    // Non-fatal: the service may already be unloaded / never loaded. We still
    // remove the plist file below. Surfaced as a soft note, not a failure.
    steps.push(`  (launchctl unload skipped — service not loaded: ${plistPath})`);
  }
}

/** Filesystem-safe timestamp for the retired-seed suffix. */
function retireStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runDelete(
  slug: string,
  flags: FlagMap,
  json: boolean,
): ExitResult {
  // --- validate slug -------------------------------------------------------
  if (!SLUG_RE.test(slug)) {
    return usageError(
      "delete",
      `slug "${slug}" must be lowercase alphanumeric + hyphen/underscore, letter-prefixed (the {stack_id} segment grammar)`,
      json,
    );
  }

  const roots: TeardownRoots = {
    configDir: expandTildePath(optionalValueFlag(flags, "--config-dir") ?? DEFAULT_CONFIG_DIR),
    natsDir: expandTildePath(optionalValueFlag(flags, "--nats-dir") ?? DEFAULT_NATS_DIR),
    launchAgentsDir: expandTildePath(
      optionalValueFlag(flags, "--launch-agents-dir") ?? DEFAULT_LAUNCH_AGENTS_DIR,
    ),
  };

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("delete", applyRes.reason, json);
  const purgeSeeds = flags["--purge-seeds"] === true;

  const art = resolveStackArtifacts(roots, slug);

  // --- (a) joined-network gate (READ-ONLY, fail-closed, BOTH modes) --------
  // Never orphan a live roster membership. Refuse in dry-run too — previewing a
  // teardown that cannot run would be misleading; the actionable fix is the same.
  const joined = readJoinedNetworkIds(art.policyConfigFile);
  if (joined.length > 0) {
    const leaveCmds = joined.map((n) => `cortex network leave ${n} --apply`).join("; ");
    return opError(
      "delete",
      `refusing to delete "${slug}": still joined to ${joined.length.toString()} network(s) ` +
        `(${joined.join(", ")}). Leave each first (never orphan a live roster membership): ${leaveCmds}.`,
      json,
    );
  }

  // --- destructive-action confirmation (apply only) ------------------------
  if (applyRes.apply) {
    const confirm = optionalValueFlag(flags, "--confirm");
    if (confirm === undefined) {
      return usageError(
        "delete",
        `--apply requires --confirm <slug>: type the literal slug "${slug}" to confirm a destructive teardown (never a glob)`,
        json,
      );
    }
    if (confirm !== slug) {
      return usageError(
        "delete",
        `--confirm "${confirm}" does not match the slug "${slug}" — type the exact slug to confirm (never a glob)`,
        json,
      );
    }
  }

  // --- build the ordered teardown plan -------------------------------------
  // Order matters: stop services (b) before removing the config/nats files they
  // load (c), and retire the seed last (d).
  //
  // #1384 review (MAJOR) — we deliberately DO NOT remove the leaf-include files
  // (`leafnodes-<network>.conf`). Those are NETWORK-keyed and live in the SHARED
  // natsDir: two stacks on the same network reference the SAME file, and
  // `cortex network leave` already owns + removes it (network-lib.ts). Removing
  // it here is redundant in the happy path (a cleanly-left stack — which the
  // joined-network refusal gate above guarantees — holds no leaf refs) and
  // DESTRUCTIVE in a partial-leave state: it could delete a leaf conf a live
  // SIBLING stack still includes, breaking the sibling's federation. We remove
  // only THIS stack's OWN rendered nats config (`<natsDir>/<slug>.conf`).
  const stamp = retireStamp();
  const actions: TeardownAction[] = [
    { label: "cortex daemon plist", path: art.daemonPlist, exists: existsSync(art.daemonPlist), op: "unload+remove" },
    { label: "nats-server plist", path: art.natsPlist, exists: existsSync(art.natsPlist), op: "unload+remove" },
    { label: "config-split stack dir (incl. pointer)", path: art.configStackDir, exists: existsSync(art.configStackDir), op: "remove-dir" },
    { label: "rendered nats config", path: art.natsConf, exists: existsSync(art.natsConf), op: "remove-file" },
    purgeSeeds
      ? { label: "signing seed (PURGE)", path: art.seed, exists: existsSync(art.seed), op: "purge-seed" }
      : { label: "signing seed (retire)", path: art.seed, exists: existsSync(art.seed), op: "retire-seed", retireTo: retiredSeedPath(art.seed, stamp) },
  ];

  // --- dry-run (DEFAULT): print the plan, touch NOTHING --------------------
  if (!applyRes.apply) {
    return renderTeardownPlan(slug, roots, actions, purgeSeeds, false, [], [], json);
  }

  // --- apply: execute in order, continuing past missing pieces -------------
  // #1384 review (MAJOR) — collect per-artifact failures STRUCTURALLY (not just
  // as human `steps` prose) so the --json envelope can surface them and the exit
  // code can go non-zero. A scripted `--json --apply` consumer must be able to
  // detect a partial teardown, not see applied:true + exit 0 on an EACCES.
  const steps: string[] = [];
  const failures: TeardownFailure[] = [];
  for (const a of actions) {
    if (!a.exists) {
      steps.push(`  skip (absent): ${a.label} — ${a.path}`);
      continue;
    }
    try {
      switch (a.op) {
        case "unload+remove":
          serviceUnload(a.path, steps);
          rmSync(a.path, { force: true });
          steps.push(`  removed ${a.label}: ${a.path}`);
          break;
        case "remove-dir":
          rmSync(a.path, { recursive: true, force: true });
          steps.push(`  removed ${a.label}: ${a.path}`);
          break;
        case "remove-file":
          rmSync(a.path, { force: true });
          steps.push(`  removed ${a.label}: ${a.path}`);
          break;
        case "purge-seed":
          rmSync(a.path, { force: true });
          steps.push(`  PURGED ${a.label}: ${a.path} (key material destroyed)`);
          break;
        case "retire-seed": {
          // Retire, don't destroy: rename the seed aside so key destruction is a
          // separate conscious act (--purge-seeds). retireTo is always set when
          // the action is built (see the plan above); guard rather than assert
          // non-null (lint: no-non-null-assertion).
          const retireTo = a.retireTo;
          if (retireTo === undefined) throw new Error(`retire-seed action missing retireTo: ${a.path}`);
          renameSync(a.path, retireTo);
          steps.push(`  retired ${a.label}: ${a.path} → ${retireTo} (NOT deleted; --purge-seeds to wipe)`);
          break;
        }
      }
    } catch (err) {
      // Continue past a per-artifact failure (idempotent teardown) but record it
      // so the principal can finish by hand. Never a silent swallow — the failure
      // is captured both in human `steps` AND structurally in `failures` (below)
      // so the --json path can surface it and the exit code can go non-zero.
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ label: a.label, path: a.path, error: message });
      steps.push(
        `  ⚠ ${a.label} teardown failed (continuing): ${a.path} — ${message}`,
      );
    }
  }

  return renderTeardownPlan(slug, roots, actions, purgeSeeds, true, steps, failures, json);
}

function renderTeardownPlan(
  slug: string,
  roots: TeardownRoots,
  actions: TeardownAction[],
  purgeSeeds: boolean,
  applied: boolean,
  steps: string[],
  failures: TeardownFailure[],
  json: boolean,
): ExitResult {
  const present = actions.filter((a) => a.exists);
  // #1384 review (MAJOR) — a partial teardown (one or more artifact removals
  // failed under --apply) is NOT a success. Exit non-zero so a scripted consumer
  // can detect it, in BOTH --json and human modes.
  const failedByPath = new Map(failures.map((f) => [f.path, f.error]));
  const exitCode = failures.length > 0 ? 1 : 0;

  if (json) {
    const envelope = envelopeOk(
      actions.map((a) => {
        const failure = failedByPath.get(a.path);
        return {
          label: a.label,
          path: a.path,
          op: a.op,
          present: a.exists ? "true" : "false",
          ...(a.retireTo !== undefined && { retire_to: a.retireTo }),
          // Per-action outcome (only meaningful under --apply). A consumer can
          // gate on `failed` per artifact; `failed_count` (in data) is the
          // aggregate, and the process exit code mirrors it.
          ...(failure !== undefined && { failed: "true", failed_reason: failure }),
        };
      }),
      {
        slug,
        config_dir: roots.configDir,
        nats_dir: roots.natsDir,
        launch_agents_dir: roots.launchAgentsDir,
        purge_seeds: purgeSeeds ? "true" : "false",
        present_count: present.length.toString(),
        applied: applied ? "true" : "false",
        failed_count: failures.length.toString(),
      },
    );
    // status stays "ok" (the teardown ran + the plan is preserved in items), but
    // the exit code signals the partial failure — the machine-readable handshake.
    return { exitCode, stdout: renderJson(envelope), stderr: "" };
  }

  const lines: string[] = [];
  lines.push(`cortex stack delete ${slug}: ${applied ? "torn down" : "dry-run"}`);
  if (!applied) lines.push("  (dry-run — no disk mutation; pass --apply --confirm " + slug + " to execute)");
  lines.push("");
  if (present.length === 0) {
    lines.push(`  nothing to remove — no local artifacts found for "${slug}" (already torn down).`);
    lines.push("");
    return ok(lines.join("\n"));
  }
  lines.push(`  ${applied ? "teardown order (executed):" : "teardown plan (would execute in order):"}`);
  for (const a of actions) {
    const mark = a.exists ? (a.op === "retire-seed" ? "retire" : a.op === "purge-seed" ? "PURGE" : "remove") : "skip (absent)";
    const extra = a.op === "retire-seed" && a.retireTo !== undefined ? ` → ${a.retireTo}` : "";
    lines.push(`    • [${mark}] ${a.label}: ${a.path}${extra}`);
  }
  lines.push("");
  if (applied && steps.length > 0) {
    lines.push("  result:");
    for (const s of steps) lines.push(s);
    lines.push("");
  }
  // C-1351 Slice 2 — the registry-side deregistration verb the principal runs
  // AFTER local teardown to tombstone the stack in the principal's registry
  // record (root-signed, dry-run by default).
  const retireHint =
    `cortex provision-stack retire <principal> --stack-id <principal>/${slug} ` +
    `--principal-seed <root-seed> --registry-url <url> --registry-pubkey <pin> --apply`;
  if (!applied) {
    lines.push("Registry-side deregistration (Slice 2, #1351) is a SEPARATE step — this teardown is LOCAL only.");
    lines.push(`Re-run with --apply --confirm ${slug} to execute the local teardown, then deregister:`);
    lines.push(`  ${retireHint}`);
  } else if (failures.length > 0) {
    // #1384 review (MAJOR) — surface the partial failure loudly + exit non-zero.
    lines.push(
      `PARTIAL teardown: ${failures.length.toString()} artifact(s) could NOT be removed (see ⚠ above) — ` +
        `finish by hand or fix permissions and re-run. Registry-side deregistration (Slice 2, #1351) not performed.`,
    );
  } else {
    lines.push("Local teardown complete. Now deregister the stack from the registry (Slice 2, #1351):");
    lines.push(`  ${retireHint}`);
  }
  lines.push("");
  return { exitCode, stdout: lines.join("\n"), stderr: "" };
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
    case "delete":
      return Promise.resolve(runDelete(parsed.positionals.slug ?? "", parsed.flags, json));
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
  cortex stack delete <slug> [--apply --confirm <slug>] [--purge-seeds] [options]

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
          cortex-<slug>.nk and does NOT generate the seed — 'arc upgrade cortex'
          auto-provisions it on first install. NEVER overwrites an existing dir.
  list    Show discovered stacks (split-layout dirs + legacy cortex*.yaml
          monoliths) with their stack.id and an aligned/DRIFT flag.
  delete  Tear down a stack's LOCAL artifacts (C-1351 Slice 1): refuse if still
          joined to any network (leave first), stop+unload the daemon + nats
          plists, remove the config-split dir (incl. its pointer) + this stack's
          OWN rendered nats conf, and RETIRE (rename, not delete) the signing
          seed. Shared network-keyed leaf files (leafnodes-<net>.conf) are NOT
          touched — 'cortex network leave' owns those. Registry-side
          deregistration is Slice 2 (a separate follow-up).
          Slice-1 limitation: seed + nats-conf are resolved by SLUG CONVENTION
          (<nats-dir>/<slug>.conf, conventional seed path), NOT the stack's
          recorded stack.nkey_seed_path — a stack whose seed lives at a
          non-default path is only partially torn down (finish by hand).

Safety:
  create + delete default to DRY-RUN (print the plan, touch nothing). Pass
  --apply to execute. --apply and --dry-run are mutually exclusive. delete
  additionally requires --confirm <slug> (the literal slug typed) with --apply,
  and RETIRES the signing seed (rename to <seed>.retired-<timestamp>) rather
  than deleting it — pass --purge-seeds to wipe key material.

Flags (create):
  --principal <id>      The principal half of stack.id. Default: inferred from
                        the single existing principal under --config-dir; if
                        zero or 2+ principals are present, it is REQUIRED.
  --display-name <name> The agent's display name (default: capitalized agent id).
  --agent <id>          The agent id on the scaffolded stack (default: assistant).
  --config-dir <path>   Config dir to create the stack under (default:
                        ~/.config/cortex). The stack lands at <config-dir>/<slug>/.
  --apply               Write the files (default: dry-run).
  --json                Emit a { status, items, data, error } envelope.

Flags (list):
  --config-dir <path>   Config dir to scan (default: ~/.config/cortex).
  --json                Emit a { status, items, data, error } envelope.

Flags (delete):
  --apply               Execute the teardown (default: dry-run).
  --confirm <slug>      REQUIRED with --apply: the literal slug, typed, to
                        confirm the destructive teardown (never a glob).
  --purge-seeds         Wipe the signing seed instead of retiring it (rename).
  --config-dir <path>   Config dir (default: ~/.config/cortex).
  --nats-dir <path>     NATS material dir (default: ~/.config/nats) — the
                        rendered <slug>.conf, leaf includes, and signing seed.
  --launch-agents-dir <path>
                        launchd LaunchAgents dir (default: ~/Library/LaunchAgents).
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
