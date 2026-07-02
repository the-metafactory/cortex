/**
 * MC-B2 (cortex#1279) — the **write** sibling of the admission-rows READ
 * providers: sign a Tier-2 admit/reject decision with THIS stack's own
 * registered key and POST it to the registry's admin-gated decision route.
 *
 * ## Why this lives in the bus layer (not the surface)
 *
 * The signing key is the stack's `SU…` seed — the SAME material the member
 * roster read PoP-signs with ({@link ../stack-provisioning.StackIdentityMaterial}).
 * The surface layer (`src/surface/mc/`) never imports the bus and never touches
 * a seed; `cortex.ts` wires this signer into an injected `AdmissionDecider` seam,
 * exactly as it wires `createMemberRosterAdmissionProvider` for the read side.
 * The local daemon holds the seed in-process; the CF worker (no seed) never
 * calls this. The browser never signs.
 *
 * ## Reuse, mint nothing, reimplement nothing
 *
 * The claim shape `{ request_id, decision, admin_pubkey, issued_at, nonce }` and
 * the `{ claim, signature }` envelope mirror the CLI admit path
 * (`network.ts buildAdmissionDecisionBody`) and the registry validator
 * (`validateAdmissionDecisionClaim`). Signing reuses {@link signClaimWithSeed} +
 * {@link canonicalJSON} — the SAME plumbing the CLI and the read provider use —
 * and the nonce comes from {@link randomNonce}. No crypto is reimplemented here.
 *
 * ## Authorization is the registry's call, surfaced honestly
 *
 * The registry accepts the write iff the signing pubkey is a GLOBAL admin
 * (`REGISTRY_ADMIN_PUBKEYS`) OR the target network's per-network admin
 * (`admin_pubkeys`, ADR-0020). When this stack is neither, the registry returns
 * `403 admin_not_authorized`; we map it to a distinct `not_authorized` reason the
 * surface renders readably (never a silent failure, never a 5xx).
 *
 * Never throws — every failure is a typed `{ ok: false }`, mirroring the read
 * provider's fail-soft contract.
 */

import { canonicalJSON } from "../../common/registry/signing";
import {
  randomNonce,
  signClaimWithSeed,
  type StackIdentityMaterial,
} from "../stack-provisioning";

/** The two Tier-2 decisions, matching the registry's shared `handleDecision`. */
export type AdmissionDecisionVerb = "admit" | "reject";

/** The signed decision claim — byte-shape must match `validateAdmissionDecisionClaim`. */
export interface AdmissionDecisionClaim {
  request_id: string;
  decision: AdmissionDecisionVerb;
  admin_pubkey: string;
  issued_at: string;
  nonce: string;
}

/** A decision claim + detached signature, ready to POST. */
export interface SignedAdmissionDecision {
  claim: AdmissionDecisionClaim;
  /** Base64 ed25519 signature over `canonicalJSON(claim)`. */
  signature: string;
}

/**
 * Build + sign an admission decision body. Reuses the CLI/read-provider signing
 * primitives; the claim is signed over the SAME `canonicalJSON(claim)` the
 * registry reconstructs and verifies. `opts` overrides (issuedAt/nonce) exist
 * for deterministic tests only.
 */
export async function buildAdmissionDecisionBody(
  requestId: string,
  decision: AdmissionDecisionVerb,
  material: StackIdentityMaterial,
  opts: { issuedAt?: string; nonce?: string } = {},
): Promise<SignedAdmissionDecision> {
  const claim: AdmissionDecisionClaim = {
    request_id: requestId,
    decision,
    admin_pubkey: material.pubkeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signClaimWithSeed(material.seed, message);
  return { claim, signature };
}

/**
 * Injectable `fetch`, narrowed to what this poster needs. Production omits it →
 * `globalThis.fetch`; tests inject a hermetic stub. Mirrors the read provider.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Construction inputs for {@link postAdmissionDecision}. */
export interface PostAdmissionDecisionOptions {
  /** Registry base URL (`policy.federated.registry.url`). Trailing slashes trimmed. */
  registryUrl: string;
  /** The admission request to decide. */
  requestId: string;
  /** admit | reject — selects both the route and the claim's `decision`. */
  decision: AdmissionDecisionVerb;
  /**
   * The stack's identity material — its registered `SU…` seed + base64 pubkey.
   * The pubkey must be a global or per-network admin for the registry to accept.
   * SECRET (the seed) — never logged.
   */
  material: StackIdentityMaterial;
  /** Per-request timeout (ms). Default 10s. */
  requestTimeoutMs?: number;
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Deterministic issued_at (tests). */
  issuedAt?: string;
  /** Deterministic nonce (tests). */
  nonce?: string;
  /** Logger seam (CLAUDE.md "no silent catches"). Default → `process.stderr`. */
  logError?: (msg: string) => void;
}

/** Why a decision POST failed — a distinct, renderable state per registry verdict. */
export type PostAdmissionDecisionFailure =
  | "not_authorized" // 403 — this stack is not a global/per-network admin
  | "not_configured" // 503 — registry has no admin allowlist provisioned
  | "already_decided" // 409 — the request was already admitted/rejected
  | "replayed" // 409 — nonce replay (should not happen with a fresh nonce)
  | "rate_limited" // 429
  | "invalid" // 400/401 — claim/signature rejected
  | "not_found" // 404 — no such request
  | "unreachable"; // transport / non-JSON / unexpected status

/** The outcome of a decision POST — never thrown. */
export type PostAdmissionDecisionResult =
  | { ok: true; status: "ADMITTED" | "REJECTED"; requestId: string }
  | { ok: false; reason: PostAdmissionDecisionFailure; detail: string; httpStatus?: number };

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Sign + POST a Tier-2 admit/reject decision to
 * `POST {registry}/admission-requests/{id}/{admit|reject}`. Maps each registry
 * status to a distinct, renderable {@link PostAdmissionDecisionResult}. Never
 * throws (mirrors the read provider's fail-soft contract).
 */
export async function postAdmissionDecision(
  options: PostAdmissionDecisionOptions,
): Promise<PostAdmissionDecisionResult> {
  const url = options.registryUrl.replace(/\/+$/, "");
  const fetchImpl: FetchLike = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logError =
    options.logError ??
    ((msg: string) => {
      process.stderr.write(`admission-decision: ${msg}\n`);
    });

  // 1. Sign the decision claim with the stack's OWN registered seed.
  let signed: SignedAdmissionDecision;
  try {
    signed = await buildAdmissionDecisionBody(
      options.requestId,
      options.decision,
      options.material,
      {
        ...(options.issuedAt !== undefined && { issuedAt: options.issuedAt }),
        ...(options.nonce !== undefined && { nonce: options.nonce }),
      },
    );
  } catch (err) {
    logError(`failed to sign ${options.decision} claim: ${errText(err)}`);
    return {
      ok: false,
      reason: "unreachable",
      detail: `failed to sign the decision claim: ${errText(err)}`,
    };
  }

  // 2. POST to the admit/reject route (the signature is the authorization).
  const endpoint = `${url}/admission-requests/${encodeURIComponent(options.requestId)}/${options.decision}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, requestTimeoutMs);
  let resp: Awaited<ReturnType<FetchLike>>;
  try {
    resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
      signal: controller.signal,
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${requestTimeoutMs.toString()}ms`
        : errText(err);
    logError(`POST ${endpoint} failed: ${reason}`);
    return { ok: false, reason: "unreachable", detail: `decision POST errored: ${reason}` };
  } finally {
    clearTimeout(timeoutHandle);
  }

  // 3. Success — the registry returns the transitioned request row.
  if (resp.ok) {
    let row: unknown;
    try {
      row = await resp.json();
    } catch (err) {
      logError(`POST ${endpoint} 2xx but non-JSON: ${errText(err)}`);
      return { ok: false, reason: "unreachable", detail: "decision response was not JSON" };
    }
    const status = readRowStatus(row);
    if (status === undefined) {
      return { ok: false, reason: "unreachable", detail: "decision response missing a status field" };
    }
    return { ok: true, status, requestId: options.requestId };
  }

  // 4. Map the registry error to a distinct, renderable reason.
  const errorCode = await readErrorCode(resp);
  const httpStatus = resp.status;
  switch (httpStatus) {
    case 403:
      return {
        ok: false,
        reason: "not_authorized",
        httpStatus,
        detail:
          "the registry refused the decision — this stack's key is not a global admin " +
          "nor listed in the network's admin_pubkeys (ADR-0020). Only a network admin may admit/reject.",
      };
    case 503:
      return {
        ok: false,
        reason: "not_configured",
        httpStatus,
        detail: "the registry has no admin allowlist provisioned (admin_not_configured) — decisions are disabled.",
      };
    case 429:
      return { ok: false, reason: "rate_limited", httpStatus, detail: "the registry rate-limited the decision; retry shortly." };
    case 409:
      return errorCode === "nonce_replayed"
        ? { ok: false, reason: "replayed", httpStatus, detail: "the registry saw this nonce already (replay) — retry with a fresh decision." }
        : { ok: false, reason: "already_decided", httpStatus, detail: "this request was already decided (admitted or rejected)." };
    case 404:
      return { ok: false, reason: "not_found", httpStatus, detail: `no admission request "${options.requestId}" on the registry.` };
    case 400:
    case 401:
      return { ok: false, reason: "invalid", httpStatus, detail: `the registry rejected the decision claim (${errorCode ?? `HTTP ${httpStatus.toString()}`}).` };
    default:
      logError(`POST ${endpoint} returned unexpected HTTP ${httpStatus.toString()} (${errorCode ?? "no code"})`);
      return { ok: false, reason: "unreachable", httpStatus, detail: `the registry returned HTTP ${httpStatus.toString()}.` };
  }
}

/** Read `.status` off the transitioned-request row, narrowed to the two terminal states. */
function readRowStatus(row: unknown): "ADMITTED" | "REJECTED" | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const s = (row as Record<string, unknown>).status;
  return s === "ADMITTED" || s === "REJECTED" ? s : undefined;
}

/** Best-effort read of the registry's `{ error }` code; never throws. */
async function readErrorCode(resp: { json: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = await resp.json();
    if (body !== null && typeof body === "object") {
      const e = (body as Record<string, unknown>).error;
      if (typeof e === "string") return e;
    }
  } catch {
    // Body wasn't JSON / already consumed — fall through to undefined.
  }
  return undefined;
}

/** Error → message, never echoing secret-bearing inputs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
