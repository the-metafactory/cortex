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

import { expandTilde, loadConfigWithAgents } from "../../../common/config/loader";
import { resolveConfigFilePath } from "../../../common/config/config-path";
import { enforceChmod600 } from "../../../common/config/file-permissions";
import {
  resolveOwnAdmissionState,
  type OwnAdmissionState,
} from "../../../common/registry/admission-state";
import {
  generateStackIdentity,
  materialFromSeedString,
  buildRegistrationClaim,
  registerStackIdentity,
  resolveMergedStacks,
  resolveMergedCapabilities,
  buildStackRetireClaim,
  retireStackIdentity,
  fetchExistingStacks,
  type StackIdentityMaterial,
  type SignedRegistrationBody,
  type StackEntryShape,
} from "../../../bus/stack-provisioning";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type ProvisionSubcommand = "generate" | "claim" | "register" | "retire";

const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;
// TODO(#2034/flag-day): replace with @the-metafactory/myelin/wire STACK_ID_RE
// once RFC-0001 lands (blocked-on #1996/#2016/#2020). ./wire is kebab-strict;
// this local copy is looser (accepts `_`), so swapping now tightens the wire.
const STACK_ID_RE = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;
/** ADR-0018 Gap-A — network id grammar (mirrors the registry's NETWORK_ID_RE). */
const NETWORK_ID_RE = /^[a-z][a-z0-9-]*$/;

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
        // ADR-0018 Gap-A — name the target network when registering, so the
        // PENDING admission request is pinned to it.
        "--network": "value",
      },
    },
    claim: {
      positionals: ["principal-id"],
      flags: { "--seed-path": "value", "--stack-id": "value" },
    },
    retire: {
      positionals: ["principal-id"],
      flags: {
        // The stack to retire ({principal}/{slug}). REQUIRED (no default — a
        // destructive op must never glob or fall back to `/default`).
        "--stack-id": "value",
        "--registry-url": "value",
        // #791 — the principal ROOT seed signs the retire claim (root-only
        // authority, same as add-stack). NO --seed-path: the retiring stack's
        // key signs nothing.
        "--principal-seed": "value",
        // #791 — pinned registry pubkey. REQUIRED: the CAS-token read of the
        // current record is signature-verified against it (fail closed).
        "--registry-pubkey": "value",
        // Dry-run is the DEFAULT; --apply mutates the live registry.
        "--apply": "bool",
      },
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
        // C-791 (security) — the PINNED registry pubkey. REQUIRED on the
        // add-stack path (--principal-seed): the merge-read of the principal's
        // existing stacks is signature-verified against this pin before it
        // drives the destructive full-overwrite re-attestation, so a
        // compromised registry can't omit a stack and cause a silent drop.
        "--registry-pubkey": "value",
        // ADR-0018 Gap-A — the target network this registration requests
        // admission into. Signed into the claim; the register hook stamps it
        // onto the PENDING admission row (per-network idempotency).
        "--network": "value",
        // C-1742 — override the config file resolveRegistryPubkey reads the
        // pinned pubkey from when --registry-pubkey is omitted. Defaults to
        // ~/.config/cortex/cortex.yaml; scoped per-stack deployments point it
        // at their stack's config.
        "--config": "value",
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
  stackIdFlag: string | true | string[] | undefined,
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

/**
 * ADR-0018 Gap-A — resolve the optional `--network <id>` flag. Returns the
 * validated network id, `undefined` when the flag is absent (a plain register
 * that names no network), or an error result on a malformed value.
 */
function resolveNetworkId(
  networkFlag: string | true | string[] | undefined,
): { ok: true; networkId: string | undefined } | { ok: false; reason: string } {
  if (networkFlag === undefined) return { ok: true, networkId: undefined };
  if (networkFlag === true || typeof networkFlag !== "string") {
    return { ok: false, reason: "--network requires a value" };
  }
  if (!NETWORK_ID_RE.test(networkFlag)) {
    return {
      ok: false,
      reason: `--network "${networkFlag}" must be a valid network id (lowercase, letter-prefixed)`,
    };
  }
  return { ok: true, networkId: networkFlag };
}

/** Pull a required value-flag; returns the string or an error result. */
function requireValueFlag(
  flags: FlagMap,
  name: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const v = flags[name];
  if (v === undefined) return { ok: false, reason: `${name} is required` };
  if (v === true || Array.isArray(v)) return { ok: false, reason: `${name} requires a value` };
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
  flags: FlagMap;
  json: boolean;
}


/**
 * cortex#1742 — resolve the pinned registry pubkey with precedence
 * `--registry-pubkey` flag > `policy.federated.registry.pubkey` from the cortex
 * config (the SAME pin `cortex network join` reads), so an add-stack register
 * need not re-supply on the command line.
 *
 * Best-effort on the config read: a missing/unreadable config or an absent pin
 * returns `undefined`, leaving the add-stack merge-read to FAIL CLOSED downstream
 * (C-791 — abort rather than overwrite; the June cap-wipe guard is untouched).
 * Never throws. Returns `{ ok:false }` only for a malformed FLAG value (a
 * usage error the caller surfaces), never for a config-read failure.
 */
/** Minimal config shape this resolver needs — an injection seam for tests. */
type RegistryPinConfigReader = (path: string) => {
  policy?: { federated?: { registry?: { pubkey?: string } } };
};

export function resolveRegistryPubkey(
  ctx: HandlerCtx,
  // Injectable for tests; production uses the real loader (reads ~/.config/cortex).
  loadConfig: RegistryPinConfigReader = loadConfigWithAgents,
): { ok: true; pubkey: string | undefined } | { ok: false; reason: string } {
  const pubkeyFlag = ctx.flags["--registry-pubkey"];
  if (pubkeyFlag !== undefined) {
    if (pubkeyFlag === true || typeof pubkeyFlag !== "string") {
      return { ok: false, reason: "--registry-pubkey requires a value" };
    }
    return { ok: true, pubkey: pubkeyFlag };
  }
  // Flag absent — fall back to the config pin (best-effort).
  const cfgFlag = ctx.flags["--config"];
  const cfgRaw = typeof cfgFlag === "string" ? cfgFlag : resolveConfigFilePath("cortex.yaml");
  // expandTilde inside the try: it throws when $HOME is unset (loader.ts), and
  // the best-effort contract must hold there too — degrade to undefined, never throw.
  let cfgPath = cfgRaw;
  try {
    cfgPath = expandTilde(cfgRaw);
    const cfg = loadConfig(cfgPath);
    const pin = cfg.policy?.federated?.registry?.pubkey;
    return { ok: true, pubkey: typeof pin === "string" && pin.length > 0 ? pin : undefined };
  } catch (err) {
    // Config unreadable/absent → no fallback pin. The add-stack path fail-closes
    // downstream with its own actionable message; log per the no-empty-catch rule.
    process.stderr.write(
      `provision-stack register: could not read policy.federated.registry.pubkey from ${cfgPath} ` +
        `(${err instanceof Error ? err.message : String(err)}) — pass --registry-pubkey explicitly ` +
        `if this add-stack register needs the pinned merge-read.\n`,
    );
    return { ok: true, pubkey: undefined };
  }
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
  // C-1269 (#1377 review) — mirror runRegister: surface the admission state on
  // the `generate --register` path too, so `--json` consumers can gate on it
  // regardless of which entry point registered.
  let registerAdmission: string | undefined;
  if (ctx.flags["--register"] === true) {
    const urlRes = requireValueFlag(ctx.flags, "--registry-url");
    if (!urlRes.ok) {
      return usageError("generate", `--register also needs ${urlRes.reason}`, ctx.json);
    }
    const networkRes = resolveNetworkId(ctx.flags["--network"]);
    if (!networkRes.ok) return usageError("generate", networkRes.reason, ctx.json);
    const reg = await doRegister(
      ctx.principalId,
      material,
      stackIdRes.stackId,
      urlRes.value,
      undefined,
      undefined,
      networkRes.networkId,
    );
    if (!reg.ok) return opError(reg.reason, ctx.json, { fingerprint: material.fingerprint });
    // C-1269 — same loud-fail contract as the standalone register path.
    if (reg.admission === "failed") {
      return admissionFailedResult(ctx, {
        reg,
        networkId: networkRes.networkId,
        seedPath,
        registryUrl: urlRes.value,
        stackId: stackIdRes.stackId,
      });
    }
    registerNote = reg.note;
    registerAdmission = reg.admission;
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
    // C-1269 (#1377 review) — parity with runRegister's --json envelope.
    ...(registerAdmission !== undefined && { admission_request: registerAdmission }),
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

  // C-791 (security) — the pinned registry pubkey verifies the add-stack
  // merge-read (fail closed when absent on the add-stack path).
  // cortex#1742 — precedence: --registry-pubkey flag > policy.federated.registry.pubkey
  // from config, so the principal need not re-supply a pin their config already has.
  // Absent from BOTH on the add-stack path stays fail-closed downstream.
  const pubkeyRes = resolveRegistryPubkey(ctx);
  if (!pubkeyRes.ok) return usageError("register", pubkeyRes.reason, ctx.json);
  const registryPubkey = pubkeyRes.pubkey;

  // ADR-0018 Gap-A — optional target network for the admission request.
  const networkRes = resolveNetworkId(ctx.flags["--network"]);
  if (!networkRes.ok) return usageError("register", networkRes.reason, ctx.json);

  const reg = await doRegister(
    ctx.principalId,
    matRes.material,
    stackIdRes.stackId,
    urlRes.value,
    rootMaterial,
    registryPubkey,
    networkRes.networkId,
  );
  if (!reg.ok) return opError(reg.reason, ctx.json, { fingerprint: matRes.material.fingerprint });

  // C-1269 — a 2xx registration whose admission request never landed (even
  // after the retry) is NOT a success: fail loud + actionable, never silent.
  if (reg.admission === "failed") {
    return admissionFailedResult(ctx, {
      reg,
      networkId: networkRes.networkId,
      seedPath: seedPathFlag.value,
      registryUrl: urlRes.value,
      stackId: stackIdRes.stackId,
    });
  }

  const data: Record<string, string> = {
    principal_id: ctx.principalId,
    stack_id: stackIdRes.stackId,
    fingerprint: matRes.material.fingerprint,
    registered: reg.note,
    // C-1269 — surface the admission state so scripting consumers can gate on it.
    admission_request: reg.admission,
  };

  // C-1315 / C-1398 — surface the admission request-id + sealed-delivery state
  // the admin needs. C-1398 (#1398): the register RESPONSE now ECHOES the
  // request_id (+ status), so when it is present we read it DIRECTLY off the
  // register result — no second PoP-signed `/admission-requests/mine`
  // round-trip. On a fresh register the row is always PENDING with no sealed
  // secret yet, so the echo carries everything the admin needs (the id to
  // admit); richer sealed-delivery state is surfaced later by
  // `cortex network join` / `cortex network status`. The `/mine` probe stays
  // as the FALLBACK for an older registry that predates the echo.
  const humanLines: string[] = [];
  if (networkRes.networkId !== undefined) {
    data.network_id = networkRes.networkId;
    if (reg.requestId !== undefined && reg.admissionStatus === "PENDING") {
      // C-1398 — fast-path: the register response ECHOED the request_id and a
      // PENDING status, so we surface it WITHOUT the `/mine` round-trip. #1398
      // is "avoid the round-trip", NOT "change the output contract": we
      // SYNTHESISE the SAME `OwnAdmissionState` the `/mine` path would have
      // produced for a just-created PENDING row and reuse the SAME helpers, so
      // the output is byte-identical — the ONLY behavioural change is no
      // network call. A fresh PENDING register carries no sealed secret
      // (`hasSealedSecret: false`), and the peer pubkey is the just-registered
      // stack's own key — EXACTLY what the `/mine` path derived
      // (`classifyOwnAdmissionRows(..., material.pubkeyB64)`). Any non-PENDING
      // echoed status falls through to the `/mine` probe below, which reads the
      // REAL sealed-delivery state (the echo does not convey it).
      const s: OwnAdmissionState = {
        networkId: networkRes.networkId,
        state: "pending",
        requestId: reg.requestId,
        hasSealedSecret: false,
        peerPubkey: matRes.material.pubkeyB64,
      };
      data.admission_status = admissionStatusLabel(s.state);
      data.sealed_secret = s.hasSealedSecret ? "present" : "missing";
      data.request_id = reg.requestId;
      data.next_for_admin = nextForAdmin(networkRes.networkId, s);
      humanLines.push(...registerStateLines(networkRes.networkId, s));
    } else {
      // Fallback: an older registry that does not echo the request_id, OR an
      // already-decided echoed status whose sealed-delivery state must be read
      // from `/mine`. PoP-signed `/admission-requests/mine` read to discover
      // it. Best-effort: a read failure NEVER fails a successful registration —
      // we note the lookup was unavailable and point at the discovery command.
      const probe = await resolveOwnAdmissionState(
        { registryUrl: urlRes.value, principalId: ctx.principalId, material: matRes.material },
        networkRes.networkId,
      );
      if (probe.ok) {
        const s = probe.state;
        data.admission_status = admissionStatusLabel(s.state);
        data.sealed_secret = s.hasSealedSecret ? "present" : "missing";
        if (s.requestId !== undefined) {
          data.request_id = s.requestId;
          data.next_for_admin = nextForAdmin(networkRes.networkId, s);
        }
        humanLines.push(...registerStateLines(networkRes.networkId, s));
      } else {
        data.admission_lookup = `unavailable: ${probe.reason}`;
        humanLines.push(
          `  admission: could not read the request-id from the registry (${probe.reason}).`,
          `  Discover it later with (admin): cortex network admit --list-pending --admin-seed <path>.`,
        );
      }
    }
  }

  if (ctx.json) return ok(renderJson(envelopeOk([], data)));
  const base = `cortex provision-stack: ${reg.note}\n  principal: ${ctx.principalId}\n  stack: ${stackIdRes.stackId}\n  fingerprint: ${matRes.material.fingerprint}\n`;
  return ok(humanLines.length > 0 ? `${base}${humanLines.join("\n")}\n` : base);
}

/** Human label for a C-1315 admission state. */
function admissionStatusLabel(state: OwnAdmissionState["state"]): string {
  switch (state) {
    case "no-row":
      return "NONE";
    case "pending":
      return "PENDING";
    case "admitted-unsealed":
      return "ADMITTED (sealed secret not yet delivered)";
    case "admitted-sealed":
      return "ADMITTED (sealed secret delivered)";
    case "revoked":
      return "REVOKED";
    case "rejected":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

/** The admin's next command(s) to move this request forward (C-1315). */
function nextForAdmin(networkId: string, s: OwnAdmissionState): string {
  const admit = s.requestId !== undefined ? `cortex network admit ${s.requestId} --apply` : "";
  const seal = `cortex network secret add-member ${networkId} ${s.peerPubkey} --apply`;
  switch (s.state) {
    case "pending":
      return admit !== "" ? `${admit} && ${seal}` : seal;
    case "admitted-unsealed":
      return seal;
    default:
      return admit !== "" ? admit : seal;
  }
}

/** Human-readable register-time admission lines (C-1315). */
function registerStateLines(networkId: string, s: OwnAdmissionState): string[] {
  const lines: string[] = [`  network: ${networkId}`];
  if (s.requestId !== undefined) {
    lines.push(`  request-id: ${s.requestId}   (give this to a network admin)`);
  }
  lines.push(`  admission: ${admissionStatusLabel(s.state)}`);
  if (s.state === "pending" || s.state === "admitted-unsealed") {
    lines.push(`  next (admin): ${nextForAdmin(networkId, s)}`);
  }
  return lines;
}

/**
 * Outcome of a register POST, from the CLIENT's point of view. C-1269 —
 * `admission` is the load-bearing addition: a registration can succeed at the
 * HTTP layer (2xx, `ok: true`) yet carry `admission_request: "failed"` in its
 * body, meaning the principal record committed but the PENDING admission row
 * did NOT (registry `principals.ts` §O-4a.1). The caller MUST NOT report a bare
 * success in that case — there is nothing for the network admin to admit. This
 * is the first external-walker regression #1262 (chuvala had a `principals` row
 * but no PENDING `admission_requests` row, so there was nothing to admit).
 */
type DoRegisterResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      note: string;
      admission: "ok" | "failed";
      warning?: string;
      // C-1398 (#1398) — the admission `request_id` + status ECHOED by the
      // register response, so the caller can print the id WITHOUT the
      // second PoP-signed `GET /admission-requests/mine` round-trip. Absent
      // when talking to an older registry that predates the echo (the caller
      // falls back to the `/mine` probe, which stays as the compatibility path).
      requestId?: string;
      admissionStatus?: string;
    };

/**
 * C-1269 — read the registry register-response for the non-fatal
 * `admission_request: "failed"` flag the registry adds (server-side
 * `principals.ts` lines 268-284) when the PENDING admission upsert fails but
 * the principal record commits. Additive + back-compat: a response without the
 * field (the normal success shape, or an older registry) reads as landed.
 */
function readAdmissionState(response: unknown): { failed: boolean; warning?: string } {
  if (typeof response === "object" && response !== null && "admission_request" in response) {
    const r = response as Record<string, unknown>;
    if (r.admission_request === "failed") {
      return { failed: true, ...(typeof r.warning === "string" && { warning: r.warning }) };
    }
  }
  return { failed: false };
}

/**
 * C-1398 (#1398) — read the admission `request_id` (+ status) the register
 * response now ECHOES, so the caller can surface the id WITHOUT the second
 * PoP-signed `GET /admission-requests/mine` round-trip. Additive + back-compat:
 * an older registry that predates the echo omits these fields, so both come
 * back `undefined` and the caller falls back to the `/mine` probe. Mirrors the
 * `readAdmissionState` shape (defensive `typeof` guards — the body is `unknown`).
 */
function readEchoedRequestId(response: unknown): { requestId?: string; admissionStatus?: string } {
  if (typeof response !== "object" || response === null) return {};
  const r = response as Record<string, unknown>;
  return {
    ...(typeof r.request_id === "string" && { requestId: r.request_id }),
    ...(typeof r.admission_status === "string" && { admissionStatus: r.admission_status }),
  };
}

/**
 * Shared register flow — build claim + POST, detect a failed admission-request
 * raise, and retry ONCE. Returns a log-safe note plus the admission state.
 *
 * C-1269 idempotency (VERIFIED against the registry route + store, not assumed):
 *   - `upsertPending` is `INSERT ... ON CONFLICT(principal_id, peer_pubkey,
 *     COALESCE(network_id,'')) DO NOTHING` (store.ts D1IssuanceRequestStore) —
 *     idempotent per the ADR-0018 Gap-A triple; a re-register never duplicates
 *     the PENDING row.
 *   - `putPrincipal` on a FIRST register carries no `expected_updated_at`, so it
 *     is an UNCONDITIONAL upsert — a bare re-register is fully idempotent (this
 *     is the #1262 external-walker path). On the ADD-STACK path the claim DOES
 *     carry a CAS token (`expected_updated_at`), so a re-POST of the SAME body
 *     would 409 `stale_record` (the first attempt already bumped `updated_at`).
 *   Therefore the retry REBUILDS the claim (`attemptRegister` re-runs
 *   `resolveMergedStacks`, which re-reads the current `updated_at`), making the
 *   retry correct on BOTH paths rather than a blind re-POST of a stale body.
 */
async function doRegister(
  principalId: string,
  material: StackIdentityMaterial,
  stackId: string,
  registryUrl: string,
  rootMaterial?: StackIdentityMaterial,
  registryPubkey?: string,
  networkId?: string,
): Promise<DoRegisterResult> {
  const isAddStack = rootMaterial !== undefined;

  // One full build-claim + POST cycle. C-1269 — factored into a closure so the
  // retry REBUILDS the claim (re-reading the CAS token via resolveMergedStacks)
  // rather than blind-reposting a now-stale body. Returns the registry result
  // triple on a 2xx, or a client-side error reason.
  async function attemptRegister(): Promise<
    { ok: false; reason: string } | { ok: true; status: number; response: unknown }
  > {
    // C-787 — build the COMPLETE intended `stacks[]`. The register route does a
    // FULL-OVERWRITE upsert of the `stacks` column with no read-merge, so a claim
    // that carries only the new stack DROPS every stack already on record — the
    // exact federation #787 exists to preserve (PR #790 data-loss blocker). On
    // the add-stack path we therefore FETCH the principal's existing stacks and
    // merge the new one in, so the root re-attests the full set and the route's
    // overwrite becomes correct. C-791 — the merge-read is signature-verified
    // against `registryPubkey` (fail closed on the add-stack path when absent).
    const stacksRes = await resolveMergedStacks({
      principalId,
      stackId,
      stackPubkey: material.pubkeyB64,
      registryUrl,
      ...(registryPubkey !== undefined && { registryPubkey }),
      isAddStack,
    });
    if (!stacksRes.ok) return { ok: false, reason: stacksRes.reason };

    // C-819 — merge-preserve CAPABILITIES, mirroring the stacks merge above. The
    // register route does the SAME full-overwrite upsert on the `capabilities`
    // column (store.ts: `capabilities = excluded.capabilities`), so a claim that
    // carries no caps zeroes the principal's existing set — silently evicting
    // them from every network roster (membership is implicit via
    // `capability.networks[]`). `provision-stack register` announces NO new caps
    // (it provisions a stack IDENTITY, not a network membership — that is what
    // `cortex network join` is for), so its `announce` is empty: on the add-stack
    // path the fetch+verify+union therefore PRESERVES the principal's existing
    // caps unchanged (empty ∪ existing = existing), and on a first register there
    // is nothing on record to preserve. `mergeExisting: isAddStack` keeps this
    // consistent with the stacks merge (and shares the C-791 fail-closed verified
    // read): merge only when adding to an already-registered principal (C-820
    // renamed the field from `isAddStack`; here the merge IS gated on add-stack —
    // provision-stack only preserves caps, it never re-announces network tags, so
    // unlike the federated join it has no reason to fetch+merge on a first
    // register). A register that genuinely intends to SHRINK caps is out of scope
    // for this command — it never announces caps at all.
    const capsRes = await resolveMergedCapabilities({
      principalId,
      registryUrl,
      ...(registryPubkey !== undefined && { registryPubkey }),
      announce: [],
      mergeExisting: isAddStack,
    });
    if (!capsRes.ok) return { ok: false, reason: capsRes.reason };

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
        // C-819 — re-attest the merged (preserved) capability set so the route's
        // full-overwrite writes the complete set instead of clobbering to empty.
        capabilities: capsRes.capabilities,
        // #825 — CAS token: the updated_at the merge read. The route rejects
        // (409 stale_record) if a concurrent host changed the row since.
        ...(stacksRes.existingUpdatedAt !== undefined && { expectedUpdatedAt: stacksRes.existingUpdatedAt }),
        // ADR-0018 Gap-A — pin the PENDING admission request to the target network.
        ...(networkId !== undefined && { networkId }),
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
    return { ok: true, status: result.status, response: result.response };
  }

  let attempt = await attemptRegister();
  if (!attempt.ok) return { ok: false, reason: attempt.reason };

  // C-1269 — the registration is 2xx, but the response may still carry
  // `admission_request: "failed"` (principal committed, PENDING row did not).
  // Retry the raise ONCE — a rebuilt re-register is idempotent (see doRegister
  // header: upsertPending ON CONFLICT DO NOTHING; putPrincipal unconditional on
  // first register, CAS-refreshed on the rebuilt add-stack retry).
  let admission = readAdmissionState(attempt.response);
  let retried = false;
  if (admission.failed) {
    retried = true;
    const retry = await attemptRegister();
    if (!retry.ok) {
      // C-1269 (#1377 review) — attempt 1 was a 2xx (the principal record
      // landed) but its PENDING admission row did NOT, and the automatic retry
      // could not even reach a 2xx. This is still a registered-but-unadmittable
      // stack, so keep `admission = failed` (fold the retry's transport error
      // into the warning) and fall through to the SAME loud, actionable
      // `admissionFailedResult` the retry-still-failed path uses — including the
      // manual re-register fallback command — rather than returning a bare
      // `ok:false` reason that omits it.
      admission = {
        failed: true,
        warning:
          `${admission.warning ?? "the PENDING admission request did not land"}; ` +
          `the automatic retry also failed: ${retry.reason}`,
      };
    } else {
      attempt = retry;
      admission = readAdmissionState(retry.response);
    }
  }

  // O-4a.2 — a successful registration (2xx) triggers an issuance request that
  // starts PENDING. The leaf credential package is issued only after an admin
  // grants the request. Always surface this so the principal knows to expect
  // the admin-grant step before the stack can join the federation.
  const noteBase = `registration recorded; awaiting admin grant — your credential will be issued on approval (HTTP ${attempt.status.toString()}, registry: ${registryUrl})`;
  // C-1398 — pull the echoed admission id off the (final) register response so
  // the caller can print it without a `/mine` round-trip.
  const echoed = readEchoedRequestId(attempt.response);
  return {
    ok: true,
    note:
      retried && !admission.failed
        ? `${noteBase} [admission request landed on automatic retry]`
        : noteBase,
    admission: admission.failed ? "failed" : "ok",
    ...(admission.warning !== undefined && { warning: admission.warning }),
    ...(echoed.requestId !== undefined && { requestId: echoed.requestId }),
    ...(echoed.admissionStatus !== undefined && { admissionStatus: echoed.admissionStatus }),
  };
}

/**
 * C-1269 — build the loud, actionable exit-1 result for a registration that
 * succeeded at the HTTP layer but whose PENDING admission request did NOT land
 * even after the automatic retry. NEVER a silent success: the stack is
 * registered but there is nothing for the network admin to admit, so the
 * principal must re-register (the upsert is idempotent). Names the network, the
 * registry warning, and the exact manual re-register command.
 */
function admissionFailedResult(
  ctx: HandlerCtx,
  args: {
    reg: Extract<DoRegisterResult, { ok: true }>;
    networkId: string | undefined;
    seedPath: string;
    registryUrl: string;
    stackId: string;
  },
): ExitResult {
  const netLabel = args.networkId !== undefined ? `network "${args.networkId}"` : "the (network-less) registration";
  const fallbackCmd =
    `cortex provision-stack register ${ctx.principalId} ` +
    `--seed-path ${args.seedPath} --registry-url ${args.registryUrl}` +
    (args.stackId !== `${ctx.principalId}/default` ? ` --stack-id ${args.stackId}` : "") +
    (args.networkId !== undefined ? ` --network ${args.networkId}` : "");
  const reason =
    `registration for ${ctx.principalId} landed, but the PENDING admission request for ${netLabel} did NOT ` +
    `(the automatic retry also failed). Your stack IS registered, but there is nothing for the network admin ` +
    `to admit yet` +
    (args.reg.warning !== undefined ? ` — registry warning: ${args.reg.warning}` : "") +
    `. Re-register to retry (the admission upsert is idempotent): ${fallbackCmd}`;
  const context: Record<string, string> = {
    admission_request: "failed",
    ...(args.networkId !== undefined && { network: args.networkId }),
    ...(args.reg.warning !== undefined && { warning: args.reg.warning }),
    manual_fallback: fallbackCmd,
  };
  return opError(reason, ctx.json, context);
}

// =============================================================================
// C-1351 Slice 2 (#1351) — retire (registry deregistration) handler
// =============================================================================

/** The retiring stack must be named explicitly — no `/default` fallback. */
function requireExplicitStackId(
  principalId: string,
  stackIdFlag: string | true | string[] | undefined,
): { ok: true; stackId: string } | { ok: false; reason: string } {
  if (stackIdFlag === undefined) {
    return { ok: false, reason: "--stack-id is required for retire (name the stack explicitly; no default)" };
  }
  return resolveStackId(principalId, stackIdFlag);
}

/**
 * `cortex provision-stack retire <principal> --stack-id <p>/<slug>
 *  --principal-seed <root> --registry-url <u> --registry-pubkey <pin> [--apply]`
 *
 * Root-signed DIRECTORY deregistration (tombstone). Same fail-closed machinery
 * as add-stack (#791): a pinned, signature-VERIFIED fetch supplies the CAS token
 * + confirms the stack, the ROOT seed signs the claim, and NO --seed-path is
 * taken (the retiring stack's key signs nothing). Dry-run is the DEFAULT;
 * --apply mutates the live registry.
 */
async function runRetire(ctx: HandlerCtx): Promise<ExitResult> {
  const stackIdRes = requireExplicitStackId(ctx.principalId, ctx.flags["--stack-id"]);
  if (!stackIdRes.ok) return usageError("retire", stackIdRes.reason, ctx.json);
  const urlRes = requireValueFlag(ctx.flags, "--registry-url");
  if (!urlRes.ok) return usageError("retire", urlRes.reason, ctx.json);
  const pubkeyRes = requireValueFlag(ctx.flags, "--registry-pubkey");
  if (!pubkeyRes.ok) {
    return usageError(
      "retire",
      `${pubkeyRes.reason} (the CAS-token read is signature-verified against it — fail closed)`,
      ctx.json,
    );
  }
  const seedRes = requireValueFlag(ctx.flags, "--principal-seed");
  if (!seedRes.ok) {
    return usageError("retire", `${seedRes.reason} (the principal ROOT seed signs the retire — root-only authority)`, ctx.json);
  }
  const rootRes = await materialFromSeedFile(seedRes.value);
  if (!rootRes.ok) return opError(`--principal-seed: ${rootRes.reason}`, ctx.json);

  const apply = ctx.flags["--apply"] === true;
  const stackId = stackIdRes.stackId;

  // Pinned, signature-verified read of the current record — supplies the CAS
  // token (updated_at) AND confirms the stack. Fail closed on any non-present
  // outcome (never sign a retire off an unverifiable / absent read).
  const existing = await fetchExistingStacks({
    registryUrl: urlRes.value,
    principalId: ctx.principalId,
    registryPubkey: pubkeyRes.value,
  });
  if (existing.kind === "error") {
    return opError(`could not read the principal record (verified fetch failed): ${existing.reason}`, ctx.json);
  }
  if (existing.kind === "absent") {
    return opError(`principal ${ctx.principalId} is not registered — nothing to retire`, ctx.json);
  }
  if (existing.updated_at === undefined) {
    return opError("registry record carried no updated_at — cannot compute the CAS token; aborting", ctx.json);
  }
  const target = existing.stacks.find((s: StackEntryShape) => s.stack_id === stackId);
  if (target === undefined) {
    return opError(
      `principal ${ctx.principalId} has no stack "${stackId}" (registered: ${existing.stacks.map((s) => s.stack_id).join(", ") || "none"})`,
      ctx.json,
    );
  }
  const alreadyRetired = target.retired_at !== undefined;
  // The active set AFTER this retire (exclude the target + any already-retired).
  const survivingActive = existing.stacks
    .filter((s) => s.stack_id !== stackId && s.retired_at === undefined)
    .map((s) => s.stack_id);

  if (!apply) {
    const data: Record<string, string> = {
      mode: "dry-run",
      principal_id: ctx.principalId,
      stack_id: stackId,
      already_retired: String(alreadyRetired),
      expected_updated_at: existing.updated_at,
      surviving_active: survivingActive.join(",") || "(none — dormant principal)",
    };
    if (ctx.json) return ok(renderJson(envelopeOk([], data)));
    const lines = [
      `cortex provision-stack retire — DRY RUN (no changes; pass --apply to mutate)`,
      `  principal:         ${ctx.principalId}`,
      `  stack to retire:   ${stackId}${alreadyRetired ? "   (ALREADY retired — apply would be an idempotent no-op)" : ""}`,
      `  registry:          ${urlRes.value}`,
      `  CAS (updated_at):  ${existing.updated_at}`,
      `  surviving active:  ${survivingActive.join(", ") || "(none — dormant principal, allowed)"}`,
      ``,
      `The stack stays on record as a tombstone (history preserved); it is excluded`,
      `from active resolution and its key stops verifying. Re-run with --apply to execute.`,
      ``,
    ];
    return ok(lines.join("\n"));
  }

  // --apply — build the root-signed claim and POST it.
  let body;
  try {
    body = await buildStackRetireClaim({
      principalId: ctx.principalId,
      stackId,
      rootMaterial: rootRes.material,
      expectedUpdatedAt: existing.updated_at,
    });
  } catch (err) {
    return opError(`failed to build retire claim: ${err instanceof Error ? err.message : String(err)}`, ctx.json);
  }

  let result: Awaited<ReturnType<typeof retireStackIdentity>>;
  try {
    result = await retireStackIdentity({ registryUrl: urlRes.value, principalId: ctx.principalId, body });
  } catch (err) {
    return opError(`retire POST failed: ${err instanceof Error ? err.message : String(err)}`, ctx.json);
  }
  if (!result.ok) {
    const detail =
      typeof result.response === "object" && result.response !== null
        ? JSON.stringify(result.response)
        : String(result.response);
    return opError(`registry rejected retire (HTTP ${result.status.toString()}): ${detail}`, ctx.json);
  }

  // Success — read the retired_at the registry stamped + the surviving active set
  // off the returned SignedAssertion<PrincipalRecord>.
  const retiredAt = readRetiredAt(result.response, stackId);
  const data: Record<string, string> = {
    mode: "applied",
    principal_id: ctx.principalId,
    stack_id: stackId,
    ...(retiredAt !== undefined && { retired_at: retiredAt }),
    surviving_active: survivingActive.join(",") || "(none — dormant principal)",
  };
  if (ctx.json) return ok(renderJson(envelopeOk([], data)));
  const lines = [
    `cortex provision-stack retire — APPLIED (HTTP ${result.status.toString()})`,
    `  principal:        ${ctx.principalId}`,
    `  retired stack:    ${stackId}`,
    ...(retiredAt !== undefined ? [`  retired_at:       ${retiredAt}`] : []),
    `  surviving active: ${survivingActive.join(", ") || "(none — dormant principal)"}`,
    ``,
    `The stack is now a tombstone: excluded from active resolution, history preserved.`,
    ``,
  ];
  return ok(lines.join("\n"));
}

/** Pull the retired_at the registry stamped for `stackId` out of the response. */
function readRetiredAt(response: unknown, stackId: string): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const payload = (response as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const stacks = (payload as { stacks?: unknown }).stacks;
  if (!Array.isArray(stacks)) return undefined;
  for (const s of stacks) {
    if (
      typeof s === "object" &&
      s !== null &&
      (s as { stack_id?: unknown }).stack_id === stackId &&
      typeof (s as { retired_at?: unknown }).retired_at === "string"
    ) {
      return (s as { retired_at: string }).retired_at;
    }
  }
  return undefined;
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
    case "retire":
      return runRetire(ctx);
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex provision-stack — stack-identity provisioning (TC-1b, #632)

Usage:
  cortex provision-stack generate <principal-id> --seed-path <path> [--stack-id <id>] [--force] [--register --registry-url <url> [--network <id>]] [--json]
  cortex provision-stack claim    <principal-id> --seed-path <path> [--stack-id <id>] [--json]
  cortex provision-stack register <principal-id> --seed-path <path> --registry-url <url> [--network <id>] [--stack-id <id>] [--principal-seed <root-path> --registry-pubkey <b64>] [--json]
  cortex provision-stack retire   <principal-id> --stack-id <p>/<slug> --principal-seed <root-path> --registry-url <url> --registry-pubkey <b64> [--apply] [--json]

Subcommands:
  generate   Generate a fresh NKey signing identity; write seed chmod 600
             (refuses to clobber without --force — rotation is a security
             event); print the pubkey. Add --register --registry-url to also
             register the pubkey via proof-of-possession.
  claim      Print a signed registration body for an existing seed WITHOUT
             posting (air-gapped / review-before-post).
  register   Build the claim from an existing seed and POST it to the registry.
  retire     Deregister (tombstone) a stack from the principal's registry record
             — root-signed, CAS-guarded, refused while the stack has a live
             ADMITTED membership. Dry-run by DEFAULT; --apply mutates. The stack
             stays on record as a tombstone (history preserved) but is excluded
             from active resolution and its key stops verifying.

Flags:
  --seed-path <path>     Path to the stack signing seed (matches stack.nkey_seed_path).
  --stack-id <id>        {principal}/{slug}; defaults to <principal-id>/default.
  --force                Allow overwriting an existing seed (DELIBERATE rotation).
  --register             (generate only) also register the pubkey after generating.
  --registry-url <url>   Network-registry base URL for registration.
  --network <id>         (register, ADR-0018) Target network to request admission
                         into. Pins the PENDING admission request to this network
                         so a stack can request admission to two networks.
  --principal-seed <p>   (register, #787) The principal ROOT seed (the FIRST
                         stack's seed) for adding a SECOND+ stack. The add-stack
                         claim is then root-signed; --seed-path is the new
                         stack's own key.
  --registry-pubkey <b64> (register/retire, #791) Pinned registry pubkey.
                         REQUIRED with --principal-seed (register) and always for
                         retire: the verified read is signature-checked against it
                         before it drives a destructive write (fails closed if
                         absent — guards against a compromised registry).
  --apply                (retire only) Execute the deregistration. WITHOUT it,
                         retire is a DRY RUN that prints the plan and touches
                         nothing.
  --json                 Emit a { status, items, data, error } envelope.

Retire authority: the retire claim is signed by the principal ROOT seed
(--principal-seed), NOT the retiring stack's key (there is no --seed-path). The
registry verifies it against the STORED record's principal_pubkey — root-only,
exactly like adding a stack (#791). A stack with a live ADMITTED membership is
refused (revoke or depart it first).

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
