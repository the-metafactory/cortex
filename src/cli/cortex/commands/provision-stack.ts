#!/usr/bin/env bun
/**
 * `cortex provision-stack <subcommand>` — TC-1b (#632) stack-identity
 * provisioning tooling.
 *
 * Makes SIGNED operation real: generate a stack signing identity (ed25519
 * NKey seed), write it chmod 600 to `stack.nkey_seed_path`, and register its
 * pubkey with the network-registry through the proof-of-possession
 * `POST /principals/{id}/register` contract. Without this, `signing: enforce`
 * has no identity to verify and the boot `verifier-self-check` cannot pass.
 *
 * Design: `docs/design-trust-confidentiality.md` §4 Phase 1.1b.
 *
 * Subcommands:
 *   generate <principal-id> --seed-path <path> [--stack-id <id>] [--force]
 *       Generate a fresh NKey signing identity, write the seed chmod 600
 *       (REFUSES to clobber an existing seed without --force — rotation is a
 *       security event), and print the NKey pubkey + base64 pubkey +
 *       fingerprint. Add `--register --registry-url <url>` to ALSO build and
 *       POST a signed registration claim (proof-of-possession with the same
 *       key). Without --register it only generates locally.
 *
 *   claim <principal-id> --seed-path <path> [--stack-id <id>]
 *       Build + print a signed registration body for an EXISTING seed, without
 *       posting it. For air-gapped / review-before-post workflows.
 *
 *   register <principal-id> --seed-path <path> --registry-url <url> [--stack-id <id>]
 *            [--principal-seed <path>]
 *       Build the signed claim from an existing seed and POST it to the
 *       registry. The ONLY subcommand that performs network I/O.
 *
 *       C-787 — to ADD a 2nd+ stack to an already-registered principal, pass
 *       `--principal-seed <root-seed>` (the FIRST stack's seed). The add-stack
 *       claim is then SIGNED BY THE ROOT (the authorization the registry
 *       requires) while `--seed-path` is the NEW stack's own signing key (its
 *       pubkey becomes the new stack's `stack_pubkey`). Without
 *       `--principal-seed`, `--seed-path` is itself the root (first register).
 *
 * Secrets discipline: the NKey SEED is written to disk + held in memory to
 * sign the claim; it is NEVER printed or logged. Output carries the pubkey +
 * a short fingerprint only.
 *
 * Exit codes:
 *   0  success
 *   1  operational failure (clobber refused, seed load error, registry reject)
 *   2  usage error (bad flag, missing positional / required flag)
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";

import { expandTilde } from "../../../common/config/loader";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import {
  generateStackIdentity,
  materialFromSeedString,
  buildRegistrationClaim,
  registerStackIdentity,
  fetchExistingStacks,
  type StackIdentityMaterial,
  type SignedRegistrationBody,
  type StackEntryShape,
} from "../../../bus/stack-provisioning";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type ProvisionSubcommand = "generate" | "claim" | "register";

const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;
const STACK_ID_RE = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

const SPEC: SubcommandSpec<ProvisionSubcommand> = {
  cliName: "provision-stack",
  subcommands: {
    generate: {
      positionals: ["principal-id"],
      flags: {
        "--seed-path": "value",
        "--stack-id": "value",
        "--force": "bool",
        "--register": "bool",
        "--registry-url": "value",
      },
    },
    claim: {
      positionals: ["principal-id"],
      flags: { "--seed-path": "value", "--stack-id": "value" },
    },
    register: {
      positionals: ["principal-id"],
      flags: {
        "--seed-path": "value",
        "--stack-id": "value",
        "--registry-url": "value",
        // C-787 — the principal ROOT seed (the first stack's seed). Present
        // ONLY when adding a SECOND+ stack to an already-registered principal:
        // the add-stack claim must be signed by the root, while `--seed-path`
        // is the NEW stack's own key. Omit for a first registration (then
        // `--seed-path` is itself the root, as pre-C-787).
        "--principal-seed": "value",
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

// =============================================================================
// Helpers
// =============================================================================

/** Resolve the stack id — explicit `--stack-id` or `{principal}/default`. */
function resolveStackId(
  principalId: string,
  stackIdFlag: string | true | undefined,
): { ok: true; stackId: string } | { ok: false; reason: string } {
  if (stackIdFlag === undefined) {
    return { ok: true, stackId: `${principalId}/default` };
  }
  if (stackIdFlag === true || typeof stackIdFlag !== "string") {
    return { ok: false, reason: "--stack-id requires a value" };
  }
  if (!STACK_ID_RE.test(stackIdFlag)) {
    return {
      ok: false,
      reason: `--stack-id "${stackIdFlag}" must be {principal_id}/{stack_id} (lowercase, letter-prefixed)`,
    };
  }
  const prefix = stackIdFlag.split("/")[0];
  if (prefix !== principalId) {
    return {
      ok: false,
      reason: `--stack-id prefix "${prefix ?? ""}" must match principal-id "${principalId}"`,
    };
  }
  return { ok: true, stackId: stackIdFlag };
}

/** Pull a required value-flag; returns the string or an error result. */
function requireValueFlag(
  flags: Record<string, string | true>,
  name: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const v = flags[name];
  if (v === undefined) return { ok: false, reason: `${name} is required` };
  if (v === true) return { ok: false, reason: `${name} requires a value` };
  return { ok: true, value: v };
}

/** Load + re-derive material from an existing seed file (chmod-600 gated). */
async function materialFromSeedFile(
  seedPath: string,
): Promise<{ ok: true; material: StackIdentityMaterial } | { ok: false; reason: string }> {
  const expanded = expandTilde(seedPath);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `seed file not found at ${expanded}` };
  }
  try {
    // Same chmod-600 discipline as loadStackSigningKey — refuse to read a
    // group/world-readable secret.
    enforceChmod600(expanded);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  let seed: string;
  try {
    seed = await readFile(expanded, "utf-8");
  } catch (err) {
    return { ok: false, reason: `failed to read seed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { ok: true, material: materialFromSeedString(seed) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// =============================================================================
// Subcommand handlers
// =============================================================================

interface HandlerCtx {
  principalId: string;
  flags: Record<string, string | true>;
  json: boolean;
}

async function runGenerate(ctx: HandlerCtx): Promise<ExitResult> {
  const seedPathFlag = requireValueFlag(ctx.flags, "--seed-path");
  if (!seedPathFlag.ok) return usageError("generate", seedPathFlag.reason, ctx.json);
  const stackIdRes = resolveStackId(ctx.principalId, ctx.flags["--stack-id"]);
  if (!stackIdRes.ok) return usageError("generate", stackIdRes.reason, ctx.json);

  const seedPath = expandTilde(seedPathFlag.value);
  const force = ctx.flags["--force"] === true;

  let material: StackIdentityMaterial;
  try {
    material = generateStackIdentity({ seedPath, force });
  } catch (err) {
    return opError(err instanceof Error ? err.message : String(err), ctx.json, {
      seed_path: seedPath,
    });
  }

  // Optional registration (opt-in — never silent).
  let registerNote: string | undefined;
  if (ctx.flags["--register"] === true) {
    const urlRes = requireValueFlag(ctx.flags, "--registry-url");
    if (!urlRes.ok) {
      return usageError("generate", `--register also needs ${urlRes.reason}`, ctx.json);
    }
    const reg = await doRegister(ctx.principalId, material, stackIdRes.stackId, urlRes.value);
    if (!reg.ok) return opError(reg.reason, ctx.json, { fingerprint: material.fingerprint });
    registerNote = reg.note;
  }

  // SECRETS: only the pubkey + fingerprint are surfaced; the seed is on disk.
  const data: Record<string, string> = {
    principal_id: ctx.principalId,
    stack_id: stackIdRes.stackId,
    nkey_pub: material.nkeyPub,
    pubkey_b64: material.pubkeyB64,
    fingerprint: material.fingerprint,
    seed_path: seedPath,
    seed_mode: "600",
    ...(registerNote !== undefined && { registered: registerNote }),
  };
  if (ctx.json) {
    return ok(renderJson(envelopeOk([], data)));
  }
  const lines = [
    `cortex provision-stack: generated stack signing identity`,
    `  principal:    ${ctx.principalId}`,
    `  stack:        ${stackIdRes.stackId}`,
    `  nkey_pub:     ${material.nkeyPub}`,
    `  pubkey (b64): ${material.pubkeyB64}`,
    `  fingerprint:  ${material.fingerprint}`,
    `  seed written: ${seedPath} (chmod 600)`,
    ...(registerNote !== undefined ? [`  registered:   ${registerNote}`] : []),
    ``,
    `Next: set in cortex.yaml under stack: —`,
    `  stack:`,
    `    id: ${stackIdRes.stackId}`,
    `    nkey_seed_path: ${seedPath}`,
    `    nkey_pub: ${material.nkeyPub}`,
    ...(registerNote === undefined
      ? [
          ``,
          `The pubkey is NOT yet registered. To register (required before`,
          `signing: enforce), re-run with --register --registry-url <url>,`,
          `or use \`cortex provision-stack register\`.`,
        ]
      : []),
    ``,
  ];
  return ok(lines.join("\n"));
}

async function runClaim(ctx: HandlerCtx): Promise<ExitResult> {
  const seedPathFlag = requireValueFlag(ctx.flags, "--seed-path");
  if (!seedPathFlag.ok) return usageError("claim", seedPathFlag.reason, ctx.json);
  const stackIdRes = resolveStackId(ctx.principalId, ctx.flags["--stack-id"]);
  if (!stackIdRes.ok) return usageError("claim", stackIdRes.reason, ctx.json);

  const matRes = await materialFromSeedFile(seedPathFlag.value);
  if (!matRes.ok) return opError(matRes.reason, ctx.json);

  const body = await buildRegistrationClaim({
    principalId: ctx.principalId,
    material: matRes.material,
    stacks: [{ stack_id: stackIdRes.stackId }],
  });

  // The body is safe to print — it carries the PUBLIC key + a detached
  // signature, never the seed.
  if (ctx.json) {
    return ok(renderJson(envelopeOk([body as unknown as Record<string, unknown>], {
      fingerprint: matRes.material.fingerprint,
    })));
  }
  return ok(JSON.stringify(body, null, 2) + "\n");
}

async function runRegister(ctx: HandlerCtx): Promise<ExitResult> {
  const seedPathFlag = requireValueFlag(ctx.flags, "--seed-path");
  if (!seedPathFlag.ok) return usageError("register", seedPathFlag.reason, ctx.json);
  const urlRes = requireValueFlag(ctx.flags, "--registry-url");
  if (!urlRes.ok) return usageError("register", urlRes.reason, ctx.json);
  const stackIdRes = resolveStackId(ctx.principalId, ctx.flags["--stack-id"]);
  if (!stackIdRes.ok) return usageError("register", stackIdRes.reason, ctx.json);

  const matRes = await materialFromSeedFile(seedPathFlag.value);
  if (!matRes.ok) return opError(matRes.reason, ctx.json);

  // C-787 — optional principal ROOT seed for an add-stack. When present, the
  // root signs the claim and `--seed-path` (matRes) is the NEW stack's key.
  let rootMaterial: StackIdentityMaterial | undefined;
  const principalSeed = ctx.flags["--principal-seed"];
  if (principalSeed !== undefined) {
    if (principalSeed === true || typeof principalSeed !== "string") {
      return usageError("register", "--principal-seed requires a value", ctx.json);
    }
    const rootRes = await materialFromSeedFile(principalSeed);
    if (!rootRes.ok) return opError(`--principal-seed: ${rootRes.reason}`, ctx.json);
    rootMaterial = rootRes.material;
  }

  const reg = await doRegister(
    ctx.principalId,
    matRes.material,
    stackIdRes.stackId,
    urlRes.value,
    rootMaterial,
  );
  if (!reg.ok) return opError(reg.reason, ctx.json, { fingerprint: matRes.material.fingerprint });

  const data: Record<string, string> = {
    principal_id: ctx.principalId,
    stack_id: stackIdRes.stackId,
    fingerprint: matRes.material.fingerprint,
    registered: reg.note,
  };
  if (ctx.json) return ok(renderJson(envelopeOk([], data)));
  return ok(
    `cortex provision-stack: ${reg.note}\n  principal: ${ctx.principalId}\n  stack: ${stackIdRes.stackId}\n  fingerprint: ${matRes.material.fingerprint}\n`,
  );
}

/** Shared register flow — build claim + POST. Returns a log-safe note. */
async function doRegister(
  principalId: string,
  material: StackIdentityMaterial,
  stackId: string,
  registryUrl: string,
  rootMaterial?: StackIdentityMaterial,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  // C-787 — build the COMPLETE intended `stacks[]`. The register route does a
  // FULL-OVERWRITE upsert of the `stacks` column with no read-merge, so a claim
  // that carries only the new stack DROPS every stack already on record — the
  // exact federation #787 exists to preserve (PR #790 data-loss blocker). On
  // the add-stack path we therefore FETCH the principal's existing stacks and
  // merge the new one in, so the root re-attests the full set and the route's
  // overwrite becomes correct.
  const stacksRes = await resolveMergedStacks(
    principalId,
    stackId,
    material.pubkeyB64,
    registryUrl,
    rootMaterial !== undefined,
  );
  if (!stacksRes.ok) return { ok: false, reason: stacksRes.reason };

  let body: SignedRegistrationBody;
  try {
    body = await buildRegistrationClaim({
      principalId,
      material,
      // C-787 — on the add-stack path the root signs; the new stack carries
      // its own pubkey. On the first-register path rootMaterial is undefined
      // and `material` both declares + signs (pre-C-787 behaviour).
      ...(rootMaterial !== undefined && { rootMaterial }),
      stacks: stacksRes.stacks,
    });
  } catch (err) {
    return { ok: false, reason: `failed to build registration claim: ${err instanceof Error ? err.message : String(err)}` };
  }

  let result: Awaited<ReturnType<typeof registerStackIdentity>>;
  try {
    result = await registerStackIdentity({ registryUrl, principalId, body });
  } catch (err) {
    return { ok: false, reason: `registry POST failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!result.ok) {
    const detail =
      typeof result.response === "object" && result.response !== null
        ? JSON.stringify(result.response)
        : String(result.response);
    return {
      ok: false,
      reason: `registry rejected registration (HTTP ${result.status.toString()}): ${detail}`,
    };
  }
  return { ok: true, note: `registered pubkey ${material.fingerprint}… at ${registryUrl} (HTTP ${result.status.toString()})` };
}

/** A stack entry as carried in the registration claim. */
interface ClaimStack {
  stack_id: string;
  stack_pubkey?: string;
  display_name?: string;
  metadata?: Record<string, string>;
}

/**
 * C-787 — compute the COMPLETE `stacks[]` for the registration claim.
 *
 * First registration (`isAddStack === false`): just the new stack — pre-C-787
 * behaviour; the route establishes the principal from scratch, nothing to drop.
 *
 * Add-stack (`isAddStack === true`): FETCH the principal's existing stacks and
 * merge the new one in (replace-by-stack_id if it already exists, else append),
 * each existing entry keeping its own `stack_pubkey`. This is the data-loss
 * fix: the full-overwrite route then writes the complete intended set instead
 * of clobbering the existing stacks with only the new one.
 *
 * Failure handling:
 *   - registry returns 404 (`absent`) on the add-stack path → the principal
 *     isn't registered yet, so there is nothing to merge; proceed with just the
 *     new stack (equivalent to a first registration).
 *   - registry unreachable / malformed (`error`) → ABORT with a clear error. We
 *     do NOT fall back to sending only the new stack: that is precisely the
 *     silent stack-drop the blocker is about.
 */
async function resolveMergedStacks(
  principalId: string,
  stackId: string,
  stackPubkey: string,
  registryUrl: string,
  isAddStack: boolean,
): Promise<{ ok: true; stacks: ClaimStack[] } | { ok: false; reason: string }> {
  const newStack: ClaimStack = { stack_id: stackId, stack_pubkey: stackPubkey };
  if (!isAddStack) {
    return { ok: true, stacks: [newStack] };
  }

  let existing: Awaited<ReturnType<typeof fetchExistingStacks>>;
  try {
    existing = await fetchExistingStacks({ registryUrl, principalId });
  } catch (err) {
    return {
      ok: false,
      reason: `failed to fetch existing stacks for merge: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (existing.kind === "error") {
    return {
      ok: false,
      reason:
        `cannot add a stack without dropping existing ones: ${existing.reason}. ` +
        `Refusing to register a partial stack set (would overwrite the principal's stacks). ` +
        `Verify --registry-url and retry.`,
    };
  }
  if (existing.kind === "absent") {
    // No record yet — nothing to preserve. Proceed with just the new stack.
    return { ok: true, stacks: [newStack] };
  }

  // present — merge: replace-by-stack_id if present, else append.
  const merged: ClaimStack[] = existing.stacks.map((s: StackEntryShape) => ({
    stack_id: s.stack_id,
    ...(s.stack_pubkey !== undefined && { stack_pubkey: s.stack_pubkey }),
    ...(s.display_name !== undefined && { display_name: s.display_name }),
    ...(s.metadata !== undefined && { metadata: s.metadata }),
  }));
  const idx = merged.findIndex((s) => s.stack_id === stackId);
  if (idx >= 0) {
    // Re-keying an existing stack: keep position, swap in the new pubkey.
    merged[idx] = { ...merged[idx], stack_id: stackId, stack_pubkey: stackPubkey };
  } else {
    merged.push(newStack);
  }
  return { ok: true, stacks: merged };
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
    : `cortex provision-stack ${sub}: ${reason}\n${topLevelHelp()}`;
  return { exitCode: 2, stdout: "", stderr };
}

function opError(reason: string, json: boolean, context?: Record<string, string>): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, context))
    : `cortex provision-stack: ${reason}\n`;
  return { exitCode: 1, stdout: "", stderr };
}

// =============================================================================
// Dispatcher
// =============================================================================

export async function dispatchProvisionStack(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: 2, stdout: "", stderr: `cortex provision-stack: ${err.message}\n${topLevelHelp()}` };
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return { exitCode: 2, stdout: "", stderr: `cortex provision-stack: ${msg}\n${topLevelHelp()}` };
  }

  const principalId = parsed.positionals["principal-id"] ?? "";
  if (!PRINCIPAL_ID_RE.test(principalId)) {
    return usageError(
      parsed.subcommand,
      `principal-id "${principalId}" must be lowercase alphanumeric + hyphen, letter-prefixed`,
      json,
    );
  }

  const ctx: HandlerCtx = { principalId, flags: parsed.flags, json };
  switch (parsed.subcommand) {
    case "generate":
      return runGenerate(ctx);
    case "claim":
      return runClaim(ctx);
    case "register":
      return runRegister(ctx);
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex provision-stack — stack-identity provisioning (TC-1b, #632)

Usage:
  cortex provision-stack generate <principal-id> --seed-path <path> [--stack-id <id>] [--force] [--register --registry-url <url>] [--json]
  cortex provision-stack claim    <principal-id> --seed-path <path> [--stack-id <id>] [--json]
  cortex provision-stack register <principal-id> --seed-path <path> --registry-url <url> [--stack-id <id>] [--json]

Subcommands:
  generate   Generate a fresh NKey signing identity; write seed chmod 600
             (refuses to clobber without --force — rotation is a security
             event); print the pubkey. Add --register --registry-url to also
             register the pubkey via proof-of-possession.
  claim      Print a signed registration body for an existing seed WITHOUT
             posting (air-gapped / review-before-post).
  register   Build the claim from an existing seed and POST it to the registry.

Flags:
  --seed-path <path>     Path to the stack signing seed (matches stack.nkey_seed_path).
  --stack-id <id>        {principal}/{slug}; defaults to <principal-id>/default.
  --force                Allow overwriting an existing seed (DELIBERATE rotation).
  --register             (generate only) also register the pubkey after generating.
  --registry-url <url>   Network-registry base URL for registration.
  --json                 Emit a { status, items, data, error } envelope.

Secrets: the NKey SEED is written to disk + held in memory to sign the claim;
it is NEVER printed or logged. Output carries the pubkey + fingerprint only.
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchProvisionStack(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
