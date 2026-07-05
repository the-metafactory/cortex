/**
 * S5 (#1519, epic #1514) — `cortex network admit` / `cortex network reject` /
 * `cortex network admit --list-pending` orchestration (PURE over ports).
 *
 * Extracted from `network.ts`'s ADR-0015 `runAdmit`/C-1348 `runReject`/C-1314
 * `runListPending` handlers, which stay in `network.ts` as thin commander
 * wiring (parse + validate flags, load the admin-seed material, build ports,
 * call the orchestrators below, format the returned report).
 *
 * The signing helpers ({@link buildAdmissionReadHeader},
 * {@link buildAdmissionDecisionBody}) are deterministic crypto over the
 * SAME `signAdminRequest` bridge every sibling admin-signed command uses
 * (`network-authorize-lib.ts`, `network-secret-adapters.ts`) — no I/O, no
 * `fetch`, no `Bun.spawn`. They are exported ONLY for `network-admit-adapters.ts`
 * to build the signed requests — never for test convenience: the
 * live-registry round-trip test (`network-admit.test.ts`, cortex#1517 S3)
 * deliberately drives them only through the real `dispatchNetwork` command
 * path, never by importing them directly.
 */

import { randomNonce, signAdminRequest, type StackIdentityMaterial } from "../../../bus/stack-provisioning";
import type {
  AdmissionDecision,
  AdmissionListRow,
  AdmitPorts,
  AdmitSealOutcome,
  DiscordRoleInputs,
  DiscordRoleStatus,
  GetRequestResult,
  ListRequestsResult,
  PostDecisionResult,
  SignedAdmissionDecision,
} from "./network-admit-ports";

// =============================================================================
// Deterministic crypto — admin-signed read header + decision claim.
// =============================================================================

/**
 * Build an admin-signed read claim for the `x-admin-signed` header.
 * No nonce (reads are idempotent). Uses the shared PKCS#8 signing bridge.
 *
 * Exported so `network-admit-adapters.ts` can build the signed GET requests
 * without re-deriving the claim shape — NOT exported for test convenience
 * (the live-registry round-trip test, cortex#1517 S3, deliberately drives
 * this only through the real `dispatchNetwork` command path).
 */
export async function buildAdmissionReadHeader(material: StackIdentityMaterial): Promise<string> {
  const claim = {
    admin_pubkey: material.pubkeyB64,
    issued_at: new Date().toISOString(),
  };
  return JSON.stringify(await signAdminRequest(material.seed, claim));
}

/**
 * Build the admin-signed admission decision body (ADR-0015: `decision` selects
 * admit vs reject; no leaf_package — decides the roster row only, mints nothing).
 * Exported for `network-admit-adapters.ts`'s `postDecision`; see the note above.
 */
export async function buildAdmissionDecisionBody(
  requestId: string,
  material: StackIdentityMaterial,
  decision: AdmissionDecision,
  opts: { issuedAt?: string; nonce?: string } = {},
): Promise<SignedAdmissionDecision> {
  const claim = {
    request_id: requestId,
    decision,
    admin_pubkey: material.pubkeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  return signAdminRequest(material.seed, claim);
}

// =============================================================================
// C-1314 — pending-table rendering (pure).
// =============================================================================

/** Render the discovery table (human path). Peer pubkey is truncated to a
 *  fingerprint for width; the full value rides the --json output. */
export function renderPendingTable(
  rows: AdmissionListRow[],
  status: string,
  networkFilter: string | undefined,
  registryUrl: string,
): string {
  const scope = networkFilter !== undefined ? ` on network "${networkFilter}"` : "";
  const header =
    `cortex network admit --list-pending — ${rows.length.toString()} ${status} request(s)${scope} ` +
    `(registry: ${registryUrl})`;
  if (rows.length === 0) {
    return `${header}\n  (none) — nothing to ${status === "PENDING" ? "admit" : "show"}.\n`;
  }
  const cells = rows.map((r) => ({
    id: r.request_id,
    principal: r.principal_id,
    network: r.network_id ?? "(none)",
    peer: `${r.peer_pubkey.slice(0, 12)}…`,
    status: r.status,
    created: r.created_at,
  }));
  const w = {
    id: Math.max("REQUEST-ID".length, ...cells.map((c) => c.id.length)),
    principal: Math.max("PRINCIPAL".length, ...cells.map((c) => c.principal.length)),
    network: Math.max("NETWORK".length, ...cells.map((c) => c.network.length)),
    peer: Math.max("PEER_PUBKEY".length, ...cells.map((c) => c.peer.length)),
    status: Math.max("STATUS".length, ...cells.map((c) => c.status.length)),
  };
  const row = (id: string, principal: string, network: string, peer: string, st: string, created: string): string =>
    `  ${id.padEnd(w.id)}  ${principal.padEnd(w.principal)}  ${network.padEnd(w.network)}  ${peer.padEnd(w.peer)}  ${st.padEnd(w.status)}  ${created}`;
  const lines = [header, "", row("REQUEST-ID", "PRINCIPAL", "NETWORK", "PEER_PUBKEY", "STATUS", "CREATED")];
  for (const c of cells) lines.push(row(c.id, c.principal, c.network, c.peer, c.status, c.created));
  lines.push("", `To admit: cortex network admit <request-id> --admin-seed <path> --apply`, "");
  return lines.join("\n");
}

/**
 * Pull the current status out of the registry's `already_decided` 409 body.
 * The route returns `{ error, details, current: <AdmissionRequest> }`; we read
 * `current.status` (falling back to undefined so the caller degrades to a
 * generic "already decided" line rather than crashing on an unexpected shape).
 */
function extractCurrentStatus(respBody: string): string | undefined {
  try {
    const parsed = JSON.parse(respBody) as { current?: { status?: string } };
    const status = parsed.current?.status;
    return typeof status === "string" ? status : undefined;
  } catch (_err) {
    return undefined;
  }
}

// =============================================================================
// `cortex network admit --list-pending` — C-1314 discovery orchestration.
// =============================================================================

export interface ListPendingInputs {
  status: string;
  networkFilter?: string;
  registryUrl: string;
  material: StackIdentityMaterial;
}

export interface ListPendingReport {
  ok: boolean;
  rows: AdmissionListRow[];
  status: string;
  networkFilter?: string;
  registryUrl: string;
  adminFingerprint: string;
  reason?: string;
}

/** ADR-0020 read-scoping limitation, reconstructed verbatim from the pre-S5 inline message. */
function forbiddenListMessage(networkFilter: string | undefined, body: string): string {
  return (
    `registry refused the list (HTTP 403 admin_not_authorized): admission reads are ` +
    `GLOBAL-admin-only today, so a per-network admin cannot list PENDING requests` +
    `${networkFilter !== undefined ? ` for "${networkFilter}"` : ""} from the CLI yet. ` +
    `Per-network read-scoping is the ADR-0020 fast-follow; until then use a global-admin ` +
    `seed or the MC admission queue (Pier). Registry said: ${body}`
  );
}

export async function runNetworkListPending(
  inputs: ListPendingInputs,
  ports: AdmitPorts,
): Promise<ListPendingReport> {
  const base: Omit<ListPendingReport, "ok" | "rows" | "reason"> = {
    status: inputs.status,
    ...(inputs.networkFilter !== undefined && { networkFilter: inputs.networkFilter }),
    registryUrl: inputs.registryUrl,
    adminFingerprint: inputs.material.fingerprint,
  };

  let res: ListRequestsResult;
  try {
    res = await ports.registry.listRequests(inputs.status);
  } catch (err) {
    return {
      ...base,
      ok: false,
      rows: [],
      reason: `failed to list admission requests from registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.outcome === "forbidden") {
    return { ...base, ok: false, rows: [], reason: forbiddenListMessage(inputs.networkFilter, res.body) };
  }
  if (res.outcome === "error") {
    return { ...base, ok: false, rows: [], reason: `registry list failed (HTTP ${res.status.toString()}): ${res.body}` };
  }

  const filtered =
    inputs.networkFilter !== undefined ? res.rows.filter((r) => r.network_id === inputs.networkFilter) : res.rows;
  return { ...base, ok: true, rows: filtered };
}

// =============================================================================
// ADR-0015 — `cortex network admit <request-id>` (apply-path decision + seal + Discord).
// =============================================================================

export interface AdmitInputs {
  requestId: string;
  registryUrl: string;
  material: StackIdentityMaterial;
  /** C-1316 — skip the fold-in seal, roster row only. */
  rosterOnly: boolean;
  /** cortex#1481 — force seal-only (never write the local hub). */
  sealOnly: boolean;
  /** cortex#1481 — the hub's own federation account nkey-U, when known. */
  hubAccount?: string;
  hubConfigPath: string;
  /** The --admin-seed path (rides the seal's fallback command text). */
  adminSeedPath: string;
  discord?: DiscordRoleInputs;
}

/** Discriminated on `ok` so a caller narrows to `sealOutcome`/`principalId`
 *  without a non-null assertion — both are ALWAYS set together on success. */
export type AdmitReport =
  | {
      ok: true;
      requestId: string;
      adminFingerprint: string;
      principalId: string;
      sealOutcome: AdmitSealOutcome;
      discordStatus: DiscordRoleStatus;
      discordWarning: string;
    }
  | {
      ok: false;
      requestId: string;
      adminFingerprint: string;
      reason: string;
    };

function admitFail(inputs: AdmitInputs, reason: string): AdmitReport {
  return {
    ok: false,
    requestId: inputs.requestId,
    adminFingerprint: inputs.material.fingerprint,
    reason,
  };
}

/** ADMIT's POST-failure message has always been fully generic — reconstruct the
 *  exact prior text (`registry rejected admission (HTTP <n>): <body>`)
 *  regardless of which discriminated outcome the registry response landed in. */
function admitDecisionFailureMessage(res: Exclude<PostDecisionResult, { outcome: "ok" }>): string {
  const status =
    res.outcome === "not_found" ? 404 : res.outcome === "forbidden" ? 403 : res.outcome === "already_decided" ? 409 : res.status;
  return `registry rejected admission (HTTP ${status.toString()}): ${res.body}`;
}

/**
 * ADR-0015 replacement for `cortex creds grant`. Fetches the PENDING request,
 * builds + POSTs the signed admit decision, folds in the C-1316 seal (unless
 * `--roster-only`), and best-effort assigns the O-5 Discord role. The
 * admission is committed the moment the POST succeeds — every step after that
 * (seal, Discord) degrades to a warning/fallback rather than failing the admit.
 */
export async function runNetworkAdmit(inputs: AdmitInputs, ports: AdmitPorts): Promise<AdmitReport> {
  // 1. Fetch the PENDING admission request (admin-signed GET).
  let getRes: GetRequestResult;
  try {
    getRes = await ports.registry.getRequest(inputs.requestId);
  } catch (err) {
    return admitFail(inputs, `failed to fetch request from registry: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (getRes.outcome === "not_found") {
    return admitFail(inputs, `request-id "${inputs.requestId}" not found in registry (HTTP 404)`);
  }
  if (getRes.outcome === "error") {
    return admitFail(inputs, `registry GET failed (HTTP ${getRes.status.toString()}): ${getRes.body}`);
  }
  const { principal_id: requestPrincipalId, status: requestStatus, peer_pubkey: requestPeerPubkey, network_id: requestNetworkId } =
    getRes.row;

  // Must be PENDING to admit.
  if (requestStatus !== "PENDING") {
    return admitFail(
      inputs,
      `request "${inputs.requestId}" is not PENDING (status: ${requestStatus}) — cannot admit an already-decided request`,
    );
  }

  // 2. Build + POST the signed admission decision. Building the claim (pure
  // crypto) and submitting it (I/O) are DISTINCT failure classes with their
  // own messages — mirrors the pre-S5 two-try-catch split exactly.
  let signedBody: SignedAdmissionDecision;
  try {
    signedBody = await buildAdmissionDecisionBody(inputs.requestId, inputs.material, "admit");
  } catch (err) {
    return admitFail(inputs, `failed to build admission decision claim: ${err instanceof Error ? err.message : String(err)}`);
  }
  let postRes: PostDecisionResult;
  try {
    postRes = await ports.registry.postDecision(inputs.requestId, "admit", signedBody);
  } catch (err) {
    return admitFail(inputs, `registry POST failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (postRes.outcome !== "ok") {
    return admitFail(inputs, admitDecisionFailureMessage(postRes));
  }

  // 2b. C-1316 — admit-and-seal. The roster row is now ADMITTED; an admitted-
  // but-unsealed peer is INERT. Reuse the EXISTING `secret add-member` flow
  // (the seal port) — the admission is ALREADY committed, so the seal NEVER
  // fails the admit.
  let sealOutcome: AdmitSealOutcome;
  if (inputs.rosterOnly) {
    const net = requestNetworkId ?? "<network>";
    sealOutcome = {
      status: "skipped",
      steps: [],
      reason: "--roster-only: committed the roster row only, no seal",
      fallbackCmd: `cortex network secret add-member ${net} ${requestPeerPubkey} --admin-seed ${inputs.adminSeedPath} --apply`,
    };
  } else {
    sealOutcome = await ports.seal.sealMember({
      networkId: requestNetworkId,
      memberPubkey: requestPeerPubkey,
      registryUrl: inputs.registryUrl,
      hubConfigPath: inputs.hubConfigPath,
      material: inputs.material,
      adminSeedPath: inputs.adminSeedPath,
      sealOnly: inputs.sealOnly,
      ...(inputs.hubAccount !== undefined && { hubAccount: inputs.hubAccount }),
    });
  }

  // 3. Assign Discord role (O-5) — when --discord-member is given.
  let discordStatus: DiscordRoleStatus = "skipped";
  let discordWarning = "";
  if (inputs.discord !== undefined) {
    const outcome = await ports.discord.assignRole(inputs.discord);
    discordStatus = outcome.status;
    discordWarning = outcome.warning;
  }

  return {
    ok: true,
    requestId: inputs.requestId,
    adminFingerprint: inputs.material.fingerprint,
    principalId: requestPrincipalId,
    sealOutcome,
    discordStatus,
    discordWarning,
  };
}

// =============================================================================
// C-1348 — `cortex network reject <request-id>` (admission DENIAL).
// =============================================================================

export interface RejectInputs {
  requestId: string;
  material: StackIdentityMaterial;
}

export interface RejectReport {
  ok: boolean;
  requestId: string;
  adminFingerprint: string;
  reason?: string;
  /** Best-effort — "" when the registry's 200 body wasn't the expected shape. */
  principalId?: string;
}

/** REJECT's richer failure mapping — 409 already_decided / 404 / 403 each get
 *  their own actionable message; reconstructed verbatim from the pre-S5 inline logic. */
function rejectDecisionFailureMessage(inputs: RejectInputs, res: Exclude<PostDecisionResult, { outcome: "ok" }>): string {
  if (res.outcome === "already_decided") {
    const current = extractCurrentStatus(res.body);
    const was = current !== undefined ? ` (already ${current})` : "";
    return `request "${inputs.requestId}" is already decided${was} — cannot reject an already-decided request`;
  }
  if (res.outcome === "not_found") {
    return `request-id "${inputs.requestId}" not found in registry (HTTP 404)`;
  }
  if (res.outcome === "forbidden") {
    return (
      `not authorised to reject request "${inputs.requestId}" — the admin key (${inputs.material.fingerprint}) ` +
      `is neither a global admin nor an admin of this request's network (HTTP 403)`
    );
  }
  return `registry rejected the decision (HTTP ${res.status.toString()}): ${res.body}`;
}

/** Mirrors `admitFail` — the shared `{ ok: false, ... }` shape every reject failure returns. */
function rejectFail(inputs: RejectInputs, reason: string): RejectReport {
  return {
    ok: false,
    requestId: inputs.requestId,
    adminFingerprint: inputs.material.fingerprint,
    reason,
  };
}

/**
 * ADR-0015's admission-denial verb — the exact mirror of {@link runNetworkAdmit},
 * except the signed decision claim carries `decision: "reject"`. Grants +
 * seals NOTHING (a rejected request has no roster row to make connectable),
 * so — unlike admit — there is no seal step and no pre-check GET (the registry
 * is the single authority; its POST response carries the decided row or the
 * error).
 *
 * The C-1350 S3 Discord-role REMOVAL that rides along on a successful reject
 * is NOT this orchestrator's job — it stays in `network.ts` on the shared
 * `removeDiscordFleetRole` helper (also used by `secret revoke-member`, out
 * of scope for this slice; see the note above that helper's definition).
 */
export async function runNetworkReject(inputs: RejectInputs, ports: AdmitPorts): Promise<RejectReport> {
  // Building the claim (pure crypto) and submitting it (I/O) are DISTINCT
  // failure classes with their own messages — mirrors admit's split.
  let signedBody: SignedAdmissionDecision;
  try {
    signedBody = await buildAdmissionDecisionBody(inputs.requestId, inputs.material, "reject");
  } catch (err) {
    return rejectFail(inputs, `failed to build admission decision claim: ${err instanceof Error ? err.message : String(err)}`);
  }
  let postRes: PostDecisionResult;
  try {
    postRes = await ports.registry.postDecision(inputs.requestId, "reject", signedBody);
  } catch (err) {
    return rejectFail(inputs, `registry POST failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (postRes.outcome !== "ok") {
    return rejectFail(inputs, rejectDecisionFailureMessage(inputs, postRes));
  }

  return {
    ok: true,
    requestId: inputs.requestId,
    adminFingerprint: inputs.material.fingerprint,
    principalId: postRes.principalId ?? "",
  };
}
