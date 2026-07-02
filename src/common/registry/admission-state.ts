/**
 * C-1315 (#1315) — the member-side **admission-state read**: a PoP-signed
 * `GET /admission-requests/mine` that surfaces a stack's OWN admission rows
 * (request-id + status + whether a sealed leaf secret has been delivered) WITHOUT
 * dumping the sealed material.
 *
 * This is the shared primitive behind two onboarding handles the CLI was
 * missing:
 *   - `provision-stack register --network <net>` prints the `request_id` the admin
 *     needs (the register response itself does not carry it — the registry route
 *     returns only the signed principal assertion), and
 *   - `cortex network join` reports the REAL admission/sealed state (PENDING /
 *     admitted-but-unsealed / revoked) instead of falling through to the
 *     misleading legacy `.creds not found (#821)` preflight.
 *
 * ## PoP signing — reuse, mint nothing
 *
 * The read is authorized by a proof-of-possession signature over
 * `{ principal_id, peer_pubkey, issued_at }`, signed with the stack's OWN
 * registered seed (the `SU…` nkey whose base64 ed25519 pubkey is the registry
 * `peer_pubkey`). Signing reuses {@link signClaimWithSeed} + {@link canonicalJSON}
 * — the SAME plumbing `fetchSealedLeafSecret` uses. No key is minted.
 *
 * ## Never throws
 *
 * Every failure is a typed `{ ok: false, reason }` so callers (register output,
 * the join error path) branch without try/catch and degrade gracefully.
 */

import { canonicalJSON } from "./signing";
import {
  signClaimWithSeed,
  type StackIdentityMaterial,
} from "../../bus/stack-provisioning";

/**
 * One admission row as `GET /admission-requests/mine` returns it. Mirrors the
 * registry `AdmissionRequest` (a separate deploy target — same redeclare
 * rationale as the other consumer-side registry types).
 */
export interface AdmissionMineRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
  sealed_secret: string | null;
}

/** Injectable fetch (defaults to `globalThis.fetch`) so callers/tests stay hermetic. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface FetchOwnAdmissionRowsInput {
  /** Registry base URL. Trailing slashes trimmed. */
  registryUrl: string;
  /** The joining principal id (echoed into the signed claim). */
  principalId: string;
  /** The stack's identity material — pubkey (the registry `peer_pubkey`) + seed (signs the PoP claim). */
  material: StackIdentityMaterial;
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Injected clock (tests). Production omits → `Date`. */
  now?: () => Date;
}

export type FetchOwnAdmissionRowsResult =
  | { ok: true; rows: AdmissionMineRow[] }
  | { ok: false; reason: string };

/**
 * PoP-sign + `GET /admission-requests/mine`, returning this stack's raw admission
 * rows. The single `/mine` read implementation — `fetchSealedLeafSecret` layers
 * its select-admitted-row + unseal on top of this. Never throws (soft-closed).
 */
export async function fetchOwnAdmissionRows(
  input: FetchOwnAdmissionRowsInput,
): Promise<FetchOwnAdmissionRowsResult> {
  const fetchImpl: FetchLike = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? (() => new Date());

  // 1. Sign the PoP read claim with the stack's own key (signature IS the auth).
  const claim = {
    principal_id: input.principalId,
    peer_pubkey: input.material.pubkeyB64,
    issued_at: now().toISOString(),
  };
  let header: string;
  try {
    const sig = await signClaimWithSeed(
      input.material.seed,
      new TextEncoder().encode(canonicalJSON(claim)),
    );
    header = JSON.stringify({ claim, signature: sig });
  } catch (err) {
    return { ok: false, reason: `failed to sign PoP read claim: ${errText(err)}` };
  }

  // 2. GET /admission-requests/mine.
  let body: unknown;
  try {
    const url = `${input.registryUrl.replace(/\/+$/, "")}/admission-requests/mine`;
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-pop-signed": header },
    });
    if (!resp.ok) {
      return { ok: false, reason: `registry mine-read failed (HTTP ${resp.status.toString()})` };
    }
    body = await resp.json();
  } catch (err) {
    return { ok: false, reason: `registry mine-read errored: ${errText(err)}` };
  }

  if (!Array.isArray(body)) {
    return { ok: false, reason: "registry mine-read returned a non-array body" };
  }
  return { ok: true, rows: body as AdmissionMineRow[] };
}

/**
 * Classified admission state for ONE network, from a stack's own `/mine` rows.
 *   - `no-row`            — no admission request exists for this network.
 *   - `pending`           — registered, awaiting admin admit.
 *   - `admitted-unsealed` — admitted, but no sealed leaf secret delivered yet.
 *   - `admitted-sealed`   — admitted AND a sealed leaf secret is present.
 *   - `revoked` / `rejected` — admission withdrawn / refused.
 *   - `unknown`           — an unrecognised status string (forward-compat).
 */
export type AdmissionRowState =
  | "no-row"
  | "pending"
  | "admitted-unsealed"
  | "admitted-sealed"
  | "revoked"
  | "rejected"
  | "unknown";

export interface OwnAdmissionState {
  state: AdmissionRowState;
  networkId: string;
  /** The admission request-id (absent only for `no-row`). */
  requestId?: string;
  /** True when the row carries a non-empty sealed leaf secret. */
  hasSealedSecret: boolean;
  /** The registered stack pubkey (the admin needs it for `secret add-member`). */
  peerPubkey: string;
}

/** True when a row carries a non-empty sealed leaf-secret blob. */
export function rowHasSealedSecret(row: AdmissionMineRow): boolean {
  return typeof row.sealed_secret === "string" && row.sealed_secret.length > 0;
}

/**
 * Classify this stack's admission state for `networkId` from its own `/mine`
 * rows + its pubkey. Pure. Selects the row whose `network_id` matches; a
 * `no-row` result carries no `requestId`.
 */
export function classifyOwnAdmissionRows(
  rows: AdmissionMineRow[],
  networkId: string,
  peerPubkey: string,
): OwnAdmissionState {
  const row = rows.find((r) => r.network_id === networkId);
  if (row === undefined) {
    return { state: "no-row", networkId, hasSealedSecret: false, peerPubkey };
  }
  const hasSealedSecret = rowHasSealedSecret(row);
  const base = { networkId, requestId: row.request_id, hasSealedSecret, peerPubkey };
  switch (row.status) {
    case "PENDING":
      return { ...base, state: "pending" };
    case "ADMITTED":
      return { ...base, state: hasSealedSecret ? "admitted-sealed" : "admitted-unsealed" };
    case "REVOKED":
      return { ...base, state: "revoked" };
    case "REJECTED":
      return { ...base, state: "rejected" };
    default:
      return { ...base, state: "unknown" };
  }
}

export type ResolveOwnAdmissionStateResult =
  | { ok: true; state: OwnAdmissionState }
  | { ok: false; reason: string };

/**
 * Read + classify this stack's admission state for `networkId` in one call.
 * Never throws — a read failure is a typed `{ ok: false, reason }` so the caller
 * can degrade (e.g. keep the original error) rather than mislead.
 */
export async function resolveOwnAdmissionState(
  input: FetchOwnAdmissionRowsInput,
  networkId: string,
): Promise<ResolveOwnAdmissionStateResult> {
  const res = await fetchOwnAdmissionRows(input);
  if (!res.ok) return res;
  return {
    ok: true,
    state: classifyOwnAdmissionRows(res.rows, networkId, input.material.pubkeyB64),
  };
}

/** Error → message, never echoing secret-bearing inputs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
