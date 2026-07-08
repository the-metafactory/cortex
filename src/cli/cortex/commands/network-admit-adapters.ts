/**
 * S5 (#1519, epic #1514) — LIVE adapters for `cortex network admit` /
 * `cortex network reject` / `cortex network admit --list-pending`.
 *
 * The real side effects the orchestration (`network-admit-lib.ts`) depends on:
 *   - REGISTRY — admin-signed reads (single request / status-filtered list)
 *     + the admit/reject decision POST. The signed read header is built via
 *     the lib's pure {@link buildAdmissionReadHeader}; the signed decision
 *     claim is built by the lib's `buildAdmissionDecisionBody` and handed to
 *     {@link AdmitRegistryPort.postDecision} already-signed (a build failure
 *     and a POST failure are distinct error classes, so building stays out
 *     of this port — see `network-admit-lib.ts`).
 *   - DISCORD  — best-effort O-5 community-fleet role ASSIGN ONLY, moved
 *     verbatim from network.ts's `runAdmit` inline block. The old
 *     `__setDiscordAdmitClientForTests` mutable-singleton override is gone —
 *     tests inject a fake {@link AdmitDiscordPort} via the ports factory
 *     instead. Reject's role REMOVAL stays on the pre-S5
 *     `removeDiscordFleetRole` helper in network.ts (shared with `secret
 *     revoke-member`, out of scope here) — see network-admit-ports.ts.
 *   - SEAL     — {@link sealAdmittedMember} moved VERBATIM (byte-for-byte,
 *     same steps, same order) from network.ts. It delegates to the EXISTING
 *     `secret add-member` orchestration via an injected `secretPortsFactory`
 *     — no payload-key/PSK crypto runs here directly. cortex#1481/ADR-0018:
 *     do not reorder or "clean up" this function — a changed byte in the
 *     hub-locality gate or the seal-vs-write sequencing breaks federated
 *     admission.
 *
 * Unlike the join/leave adapters (`network-adapters.ts`), there is NO
 * dry-run port constructor here: admit/reject's dry-run path (network.ts)
 * prints its plan and returns BEFORE building any port at all — it never
 * touches the registry (`fetchCalled` stays `false`, per the existing
 * tests). A dry-run ports variant would be permanently unreachable dead
 * code, so this module only builds the live bundle.
 */

import {
  assignRole as discordAssignRoleApi,
  resolveRoleId as discordResolveRoleIdApi,
  loadConfig as loadDiscordConfig,
  resolveServerContext,
} from "../lib/discord-roles";
import { existsSync, readFileSync } from "fs";
import { randomNonce, signAdminRequest, type StackIdentityMaterial } from "../../../bus/stack-provisioning";
import { expandTilde } from "../../../common/config/loader";
import { natsConfigMonitorUrl } from "../../../common/nats/leaf-remote-renderer";
import type { HubAccountProbePort } from "./network-admit-ports";
import { buildAdmissionReadHeader } from "./network-admit-lib";
import { runNetworkSecret, type SecretInputs, type SecretReport } from "./network-secret-lib";
import { buildLiveSecretPorts } from "./network-secret-adapters";
import type {
  AdmissionDecision,
  AdmissionListRow,
  AdmissionRow,
  AdmitDiscordPort,
  AdmitPorts,
  AdmitRegistryPort,
  AdmitSealOutcome,
  AdmitSealPort,
  DiscordRoleInputs,
  DiscordRoleOutcome,
  GetRequestResult,
  ListRequestsResult,
  PostDecisionResult,
  SealMemberArgs,
  SecretPortsFactory,
  SignedAdmissionDecision,
} from "./network-admit-ports";

export interface LiveAdmitPortsConfig {
  registryUrl: string;
  material: StackIdentityMaterial;
  /** C-1316 — builds the ports the fold-in seal delegates to (`secret
   *  add-member`). Only meaningful for `admit` (`reject` never seals).
   *  Production omits it → the live secret-ports adapters. */
  secretPortsFactory?: SecretPortsFactory;
  /**
   * cortex#1652 — OPTIONAL network scope for the admin-signed READS
   * (`getRequest`/`listRequests`). REQUIRED for a per-network admin (#1321):
   * the registry's FND-5 read gate 403s an unscoped read claim from a
   * non-global admin. A global admin may omit it (unscoped) or supply it
   * (registry narrows the read). Wired from `--network`.
   */
  networkId?: string;
  /** Injectable fetch (tests). Production omits → globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/** Live ports — every effect mutates the deployment. */
export function buildLiveAdmitPorts(cfg: LiveAdmitPortsConfig): AdmitPorts {
  return {
    registry: buildLiveAdmitRegistryPort(cfg),
    discord: buildLiveAdmitDiscordPort(),
    seal: buildLiveAdmitSealPort(cfg),
    // cortex#1598 (C3) — operator-mode probe-then-stamp (accountz read + authorize POST).
    hubProbe: buildLiveHubAccountProbePort(cfg),
  };
}

// =============================================================================
// REGISTRY — admin-signed reads + the admit/reject decision POST.
// =============================================================================

function buildLiveAdmitRegistryPort(cfg: LiveAdmitPortsConfig): AdmitRegistryPort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const material = cfg.material;

  return {
    async getRequest(requestId): Promise<GetRequestResult> {
      const readHeader = await buildAdmissionReadHeader(material, cfg.networkId);
      const getUrl = `${base}/admission-requests/${encodeURIComponent(requestId)}`;
      const resp = await fetchImpl(getUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": readHeader },
      });
      if (resp.status === 404) return { outcome: "not_found" };
      if (!resp.ok) {
        const body = await resp.text();
        return { outcome: "error", status: resp.status, body };
      }
      const row = (await resp.json()) as AdmissionRow;
      return { outcome: "ok", row };
    },

    async listRequests(status): Promise<ListRequestsResult> {
      const readHeader = await buildAdmissionReadHeader(material, cfg.networkId);
      const getUrl = `${base}/admission-requests?status=${encodeURIComponent(status)}`;
      const resp = await fetchImpl(getUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-signed": readHeader },
      });
      if (resp.status === 403) {
        const body = await resp.text();
        return { outcome: "forbidden", body };
      }
      if (!resp.ok) {
        const body = await resp.text();
        return { outcome: "error", status: resp.status, body };
      }
      const rows = (await resp.json()) as AdmissionListRow[];
      return { outcome: "ok", rows };
    },

    async postDecision(
      requestId: string,
      decision: AdmissionDecision,
      signedBody: SignedAdmissionDecision,
    ): Promise<PostDecisionResult> {
      const postUrl = `${base}/admission-requests/${encodeURIComponent(requestId)}/${decision}`;
      const resp = await fetchImpl(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedBody),
      });
      if (!resp.ok) {
        const body = await resp.text();
        // reject's richer classification (admit's lib collapses all three of
        // these back into the SAME generic message it always used — see
        // `admitDecisionFailureMessage` in network-admit-lib.ts).
        if (resp.status === 409 && body.includes("already_decided")) return { outcome: "already_decided", body };
        if (resp.status === 404) return { outcome: "not_found", body };
        if (resp.status === 403) return { outcome: "forbidden", body };
        return { outcome: "error", status: resp.status, body };
      }
      // Best-effort principal_id extraction (admit doesn't need it — it
      // already has principal_id from the GET; reject's summary uses it).
      try {
        const row = (await resp.json()) as { principal_id?: string };
        return { outcome: "ok", principalId: row.principal_id ?? "" };
      } catch (_err) {
        return { outcome: "ok" };
      }
    },
  };
}

// =============================================================================
// DISCORD — O-5 community-fleet role assign (admit only).
//
// NOTE: reject's role REMOVAL is NOT here — it's shared with `secret
// revoke-member` (out of scope for this slice) and stays on the pre-S5
// `removeDiscordFleetRole` helper in network.ts. See network-admit-ports.ts's
// module doc for the full explanation.
// =============================================================================

/**
 * Resolve the bot token + guild id an assign acts against. `resolveServerContext`
 * (discord-roles.ts) already folds `--guild` in at the HIGHEST precedence
 * (over `--server` profile, over top-level config) — that's the pre-S5
 * production behaviour verbatim, so `ctx.guildId` alone is the right value;
 * no second `inputs.guild ??` fallback is needed (or correct — it would be
 * redundant with, not additive to, what `resolveServerContext` already does).
 */
function resolveDiscordContext(inputs: DiscordRoleInputs): { botToken?: string; guildId?: string } {
  const discordConfig = loadDiscordConfig();
  const ctx = resolveServerContext(discordConfig, { server: inputs.server, guild: inputs.guild });
  return { botToken: ctx.botToken, guildId: ctx.guildId };
}

function buildLiveAdmitDiscordPort(): AdmitDiscordPort {
  return {
    async assignRole(inputs: DiscordRoleInputs): Promise<DiscordRoleOutcome> {
      try {
        const { botToken, guildId } = resolveDiscordContext(inputs);
        if (!botToken) {
          return {
            status: "skipped_no_token",
            warning: "Discord role not assigned: no bot token configured (run: discord config set botToken <token>)",
          };
        }
        if (!guildId) {
          return {
            status: "skipped_no_guild",
            warning:
              "Discord role not assigned: no guild id configured — pass --discord-guild <id> or run: discord config set guildId <id>",
          };
        }
        let roleId: string;
        try {
          roleId = await discordResolveRoleIdApi(botToken, guildId, inputs.role);
        } catch (err) {
          return {
            status: "failed",
            warning: `Discord role not assigned: ${err instanceof Error ? err.message : String(err)} — assign manually`,
          };
        }
        const roleResult = await discordAssignRoleApi(botToken, guildId, inputs.member, roleId);
        if (roleResult.success) return { status: "assigned", warning: "" };
        return {
          status: "failed",
          warning: `Discord role assignment failed: ${roleResult.error ?? "unknown error"} — admission committed, assign role manually`,
        };
      } catch (err) {
        return {
          status: "failed",
          warning: `Discord role assignment error: ${err instanceof Error ? err.message : String(err)} — admission committed, assign role manually`,
        };
      }
    },
  };
}

// =============================================================================
// SEAL — C-1316 admit-and-seal (fold the leaf-secret delivery into admit).
//
// cortex#1481/ADR-0018 — WIRE-SENSITIVE. Moved VERBATIM from network.ts: same
// steps, same order, same hub-locality gate. Do not reorder or "clean up".
// =============================================================================

/**
 * Seal + deliver the per-member leaf PSK for a just-admitted member by reusing
 * the EXISTING `secret add-member` orchestration (`runNetworkSecret`) — nothing
 * about sealing is reimplemented here.
 *
 * The caller has ALREADY committed the admission, so this NEVER throws and NEVER
 * fails the admit: every failure mode returns a `fallback` outcome that surfaces
 * the explicit `secret add-member` command instead. Failure modes it degrades on:
 *   - the admission row is network-less (legacy `network_id = null`) — nothing to
 *     bind a leaf PSK to;
 *   - the hub config isn't local / readable (a fully-separable deployment where
 *     the hub isn't on this host) — `readConf` rejects before any mutation;
 *   - the admit signer isn't the hub-admin (registry-admin ≠ hub-admin) — the
 *     registry refuses the sealed-secret delivery.
 */
async function sealAdmittedMember(args: {
  networkId: string | null;
  memberPubkey: string;
  registryUrl: string;
  hubConfigPath: string;
  material: StackIdentityMaterial;
  secretPortsFactory: SecretPortsFactory;
  adminSeedPath: string;
  /** cortex#1481 — force seal-only (never write the local hub) even when the
   *  auto-detected locality would otherwise call the hub local. */
  sealOnly?: boolean;
  /** cortex#1481 — the hub's own federation account nkey-U, when known. */
  hubAccount?: string;
  /** cortex#1598 — operator-mode attestation (off the verified descriptor). */
  hubMode?: "operator" | "simple";
  resolverMode?: "nats" | "memory";
  hubFedAccount?: string;
}): Promise<AdmitSealOutcome> {
  const {
    networkId,
    memberPubkey,
    registryUrl,
    hubConfigPath,
    material,
    secretPortsFactory,
    adminSeedPath,
    sealOnly,
    hubAccount,
    hubMode,
    resolverMode,
    hubFedAccount,
  } = args;

  // A network-less admission row (legacy null network_id) can't be sealed — the
  // leaf PSK is network-scoped, and `secret add-member` needs a real network id.
  if (networkId === null || networkId === "") {
    return {
      status: "fallback",
      steps: [],
      reason:
        "the admission row has no network_id (legacy / network-less request) — a leaf secret is network-scoped, so it can't be sealed automatically",
      fallbackCmd: `cortex network secret add-member <network> ${memberPubkey} --admin-seed ${adminSeedPath} --apply`,
    };
  }

  const fallbackCmd = `cortex network secret add-member ${networkId} ${memberPubkey} --admin-seed ${adminSeedPath} --apply`;

  const inputs: SecretInputs = {
    action: "add-member",
    networkId,
    memberPubkey,
    deliver: "sealed",
    apply: true,
    ...(sealOnly !== undefined && { sealOnly }),
    ...(hubAccount !== undefined && { hubAccount }),
    ...(hubMode !== undefined && { hubMode }),
    ...(resolverMode !== undefined && { resolverMode }),
    ...(hubFedAccount !== undefined && { hubFedAccount }),
  };

  let report: SecretReport;
  try {
    // #1316 nit (PR #1412): construct the ports factory INSIDE the try so the
    // "seal NEVER throws / NEVER fails the admit" invariant is structural — a
    // throwing factory (bad hub config, unreadable seed) degrades to `fallback`
    // like every other seal failure instead of escaping past the committed admit.
    const ports = secretPortsFactory({ hubConfigPath, registryUrl, material });
    report = await runNetworkSecret(inputs, ports);
  } catch (err) {
    return {
      status: "fallback",
      steps: [],
      reason: `seal could not run: ${err instanceof Error ? err.message : String(err)}`,
      fallbackCmd,
    };
  }

  if (!report.ok) {
    return {
      status: "fallback",
      steps: report.steps,
      reason: report.reason ?? "seal failed",
      fallbackCmd,
    };
  }

  // cortex#1598 (C3) — surface the operator-mode fingerprints so the admit fold
  // can probe the hub resolver + stamp hub_authorized_at. Present only on the
  // operator seal path (`envelope_version === "2"` + account/signing pubkeys in
  // the report data); absent on the simple/PSK path.
  const operator =
    report.data.envelope_version === "2" &&
    typeof report.data.account_pubkey === "string" &&
    typeof report.data.signing_key === "string"
      ? { fedAccountPubKey: report.data.account_pubkey, signingKeyPubKey: report.data.signing_key }
      : undefined;

  return {
    status: "sealed",
    steps: report.steps,
    ...(report.hubOwnerArtifact !== undefined && { hubOwnerArtifact: report.hubOwnerArtifact }),
    ...(operator !== undefined && { operator }),
  };
}

function buildLiveAdmitSealPort(cfg: LiveAdmitPortsConfig): AdmitSealPort {
  const secretPortsFactory = cfg.secretPortsFactory ?? ((c) => buildLiveSecretPorts(c));
  return {
    sealMember: (args: SealMemberArgs) => sealAdmittedMember({ ...args, secretPortsFactory }),
  };
}

// ---------------------------------------------------------------------------
// cortex#1598 (C3) — operator-mode probe-then-stamp: read the hub monitor's
// /accountz to confirm the FED account is on the resolver, then stamp
// hub_authorized_at. Mint-admit only ever runs on the hub owner's machine
// (where the nsc store + hub conf live), so the monitor is a LOOPBACK read.
// ---------------------------------------------------------------------------

/** Bound the accountz probe — the hub monitor is loopback + local, so a short
 *  budget is right; a slow/absent monitor must not stall the admit fold. */
const ACCOUNTZ_PROBE_TIMEOUT_MS = 2000;

function buildLiveHubAccountProbePort(cfg: LiveAdmitPortsConfig): HubAccountProbePort {
  const base = cfg.registryUrl.replace(/\/+$/, "");
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  return {
    async probeAccountOnHub({ hubConfigPath, fedAccountPubKey, signingKeyPubKey }) {
      // Derive the monitor URL from the LOCAL hub conf (loopback:port). No conf /
      // no monitor directive → we cannot verify, so report NOT present (fail-safe:
      // the fold leaves hub_authorized_at unstamped, never a blind stamp).
      const confPath = expandTilde(hubConfigPath);
      if (!existsSync(confPath)) {
        return { present: false, reason: `hub config not found at ${confPath} — cannot probe the resolver` };
      }
      let monitorUrl: string | undefined;
      try {
        monitorUrl = natsConfigMonitorUrl(readFileSync(confPath, "utf-8"));
      } catch (err) {
        return { present: false, reason: `could not read the hub config: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (monitorUrl === undefined) {
        return { present: false, reason: `hub config ${confPath} declares no HTTP monitor port — cannot probe /accountz (add http_port to the hub conf)` };
      }
      try {
        const res = await fetchImpl(`${monitorUrl}/accountz?acc=${encodeURIComponent(fedAccountPubKey)}`, {
          signal: AbortSignal.timeout(ACCOUNTZ_PROBE_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { present: false, reason: `hub monitor ${monitorUrl}/accountz returned HTTP ${res.status.toString()}` };
        }
        const body = await res.text();
        // Present iff the account pubkey appears in the resolver's account detail.
        // The scoped signing key appearing too confirms the UPDATED account JWT
        // propagated (not just an older revision) — report it, but the account's
        // presence is the gating signal.
        if (!body.includes(fedAccountPubKey)) {
          return { present: false, reason: `FED account ${fedAccountPubKey.slice(0, 12)}… not present in the hub resolver's /accountz` };
        }
        if (!body.includes(signingKeyPubKey)) {
          return {
            present: false,
            reason: `FED account present but the scoped signing key ${signingKeyPubKey.slice(0, 12)}… is not yet in the resolver's account JWT (an older account revision) — the updated JWT has not propagated`,
          };
        }
        return { present: true };
      } catch (err) {
        const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
        return {
          present: false,
          reason: isTimeout
            ? `hub monitor ${monitorUrl}/accountz timed out after ${ACCOUNTZ_PROBE_TIMEOUT_MS.toString()}ms`
            : `hub monitor ${monitorUrl} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    async postAuthorize(requestId) {
      // The SAME hub-admin-signed POST `cortex network authorize` uses.
      const claim = {
        request_id: requestId,
        hub_admin_pubkey: cfg.material.pubkeyB64,
        issued_at: new Date().toISOString(),
        nonce: randomNonce(),
      };
      const signed = await signAdminRequest(cfg.material.seed, claim);
      const resp = await fetchImpl(`${base}/admission-requests/${encodeURIComponent(requestId)}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      if (!resp.ok) {
        throw new Error(`registry rejected authorize (HTTP ${resp.status.toString()}): ${await resp.text()}`);
      }
    },
  };
}
