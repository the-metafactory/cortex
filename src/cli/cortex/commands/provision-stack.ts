#!/usr/bin/env bun

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
import { NETWORK_ID_RE } from "../../../common/network-id";

export { type ExitResult } from "./_shared/exit-result";

type ProvisionSubcommand = "generate" | "claim" | "register" | "retire";

const EXIT_CODE = { ok: 0, operationalFailure: 1, usageError: 2 } as const;

const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;
// Looser than myelin/wire STACK_ID_RE (accepts `_`); swapping before the flag-day tightens the wire: https://github.com/the-metafactory/cortex/issues/2034
const STACK_ID_RE = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/;

type FlagValue = FlagMap[string] | undefined;
type StackIdResult = { ok: true; stackId: string } | { ok: false; reason: string };

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
        "--stack-id": "value",
        "--registry-url": "value",
        "--principal-seed": "value",
        "--registry-pubkey": "value",
        "--apply": "bool",
      },
    },
    register: {
      positionals: ["principal-id"],
      flags: {
        "--seed-path": "value",
        "--stack-id": "value",
        "--registry-url": "value",
        "--principal-seed": "value",
        "--registry-pubkey": "value",
        "--network": "value",
        "--config": "value",
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

function resolveStackId(
  principalId: string,
  stackIdFlag: FlagValue,
): StackIdResult {
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

function resolveNetworkId(
  networkFlag: FlagValue,
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

function requireValueFlag(
  flags: FlagMap,
  name: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const v = flags[name];
  if (v === undefined) return { ok: false, reason: `${name} is required` };
  if (v === true || Array.isArray(v)) return { ok: false, reason: `${name} requires a value` };
  return { ok: true, value: v };
}

async function materialFromSeedFile(
  seedPath: string,
): Promise<{ ok: true; material: StackIdentityMaterial } | { ok: false; reason: string }> {
  const expanded = expandTilde(seedPath);
  if (!existsSync(expanded)) {
    return { ok: false, reason: `seed file not found at ${expanded}` };
  }
  try {
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

interface HandlerCtx {
  principalId: string;
  flags: FlagMap;
  json: boolean;
}

type RegistryPinConfigReader = (path: string) => {
  policy?: { federated?: { registry?: { pubkey?: string } } };
};

export function resolveRegistryPubkey(
  ctx: HandlerCtx,
  loadConfig: RegistryPinConfigReader = loadConfigWithAgents,
): { ok: true; pubkey: string | undefined } | { ok: false; reason: string } {
  const pubkeyFlag = ctx.flags["--registry-pubkey"];
  if (pubkeyFlag !== undefined) {
    if (pubkeyFlag === true || typeof pubkeyFlag !== "string") {
      return { ok: false, reason: "--registry-pubkey requires a value" };
    }
    return { ok: true, pubkey: pubkeyFlag };
  }
  const cfgFlag = ctx.flags["--config"];
  const cfgRaw = typeof cfgFlag === "string" ? cfgFlag : resolveConfigFilePath("cortex.yaml");
  let cfgPath = cfgRaw;
  try {
    cfgPath = expandTilde(cfgRaw);
    const cfg = loadConfig(cfgPath);
    const pin = cfg.policy?.federated?.registry?.pubkey;
    return { ok: true, pubkey: typeof pin === "string" && pin.length > 0 ? pin : undefined };
  } catch (err) {
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

  let registerNote: string | undefined;
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

  const data: Record<string, string> = {
    principal_id: ctx.principalId,
    stack_id: stackIdRes.stackId,
    nkey_pub: material.nkeyPub,
    pubkey_b64: material.pubkeyB64,
    fingerprint: material.fingerprint,
    seed_path: seedPath,
    seed_mode: "600",
    ...(registerNote !== undefined && { registered: registerNote }),
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

  const pubkeyRes = resolveRegistryPubkey(ctx);
  if (!pubkeyRes.ok) return usageError("register", pubkeyRes.reason, ctx.json);
  const registryPubkey = pubkeyRes.pubkey;

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
    admission_request: reg.admission,
  };

  const humanLines: string[] = [];
  if (networkRes.networkId !== undefined) {
    data.network_id = networkRes.networkId;
    const echoedPending = pendingStateFromRegisterEcho(reg, networkRes.networkId, matRes.material.pubkeyB64);
    const probe =
      echoedPending !== undefined
        ? { ok: true as const, state: echoedPending }
        : await resolveOwnAdmissionState(
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

  if (ctx.json) return ok(renderJson(envelopeOk([], data)));
  const base = `cortex provision-stack: ${reg.note}\n  principal: ${ctx.principalId}\n  stack: ${stackIdRes.stackId}\n  fingerprint: ${matRes.material.fingerprint}\n`;
  return ok(humanLines.length > 0 ? `${base}${humanLines.join("\n")}\n` : base);
}

function pendingStateFromRegisterEcho(
  reg: Extract<DoRegisterResult, { ok: true }>,
  networkId: string,
  justRegisteredPubkey: string,
): OwnAdmissionState | undefined {
  if (reg.requestId === undefined || reg.admissionStatus !== "PENDING") return undefined;
  return {
    networkId,
    state: "pending",
    requestId: reg.requestId,
    hasSealedSecret: false,
    peerPubkey: justRegisteredPubkey,
  };
}

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

type DoRegisterResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      note: string;
      admission: "ok" | "failed";
      warning?: string;
      requestId?: string;
      admissionStatus?: string;
    };

function readAdmissionState(response: unknown): { failed: boolean; warning?: string } {
  if (typeof response === "object" && response !== null && "admission_request" in response) {
    const r = response as Record<string, unknown>;
    if (r.admission_request === "failed") {
      return { failed: true, ...(typeof r.warning === "string" && { warning: r.warning }) };
    }
  }
  return { failed: false };
}

function readEchoedRequestId(response: unknown): { requestId?: string; admissionStatus?: string } {
  if (typeof response !== "object" || response === null) return {};
  const r = response as Record<string, unknown>;
  return {
    ...(typeof r.request_id === "string" && { requestId: r.request_id }),
    ...(typeof r.admission_status === "string" && { admissionStatus: r.admission_status }),
  };
}

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

  async function attemptRegister(): Promise<
    { ok: false; reason: string } | { ok: true; status: number; response: unknown }
  > {
    const stacksRes = await resolveMergedStacks({
      principalId,
      stackId,
      stackPubkey: material.pubkeyB64,
      registryUrl,
      ...(registryPubkey !== undefined && { registryPubkey }),
      isAddStack,
    });
    if (!stacksRes.ok) return { ok: false, reason: stacksRes.reason };

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
        ...(rootMaterial !== undefined && { rootMaterial }),
        stacks: stacksRes.stacks,
        capabilities: capsRes.capabilities,
        ...(stacksRes.existingUpdatedAt !== undefined && { expectedUpdatedAt: stacksRes.existingUpdatedAt }),
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

  let admission = readAdmissionState(attempt.response);
  let retried = false;
  if (admission.failed) {
    retried = true;
    const retry = await attemptRegister();
    if (!retry.ok) {
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

  const noteBase = `registration recorded; awaiting admin grant — your credential will be issued on approval (HTTP ${attempt.status.toString()}, registry: ${registryUrl})`;
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

function requireExplicitStackId(
  principalId: string,
  stackIdFlag: FlagValue,
): StackIdResult {
  if (stackIdFlag === undefined) {
    return { ok: false, reason: "--stack-id is required for retire (name the stack explicitly; no default)" };
  }
  return resolveStackId(principalId, stackIdFlag);
}

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

function ok(stdout: string): ExitResult {
  return { exitCode: EXIT_CODE.ok, stdout, stderr: "" };
}

function usageError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex provision-stack ${sub}: ${reason}\n${topLevelHelp()}`;
  return { exitCode: EXIT_CODE.usageError, stdout: "", stderr };
}

function opError(reason: string, json: boolean, context?: Record<string, string>): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, context))
    : `cortex provision-stack: ${reason}\n`;
  return { exitCode: EXIT_CODE.operationalFailure, stdout: "", stderr };
}

export async function dispatchProvisionStack(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: EXIT_CODE.usageError, stdout: "", stderr: `cortex provision-stack: ${err.message}\n${topLevelHelp()}` };
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return { exitCode: EXIT_CODE.ok, stdout: topLevelHelp(), stderr: "" };
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return { exitCode: EXIT_CODE.usageError, stdout: "", stderr: `cortex provision-stack: ${msg}\n${topLevelHelp()}` };
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

if (import.meta.main) {
  const result = await dispatchProvisionStack(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
