/**
 * cortex#1498 (epic #1479 follow-up) — `cortex network authorize` orchestrator
 * (PURE over ports).
 *
 * The hub-owner side of the guided-join handoff's hub-authorize leg
 * (`network-handoff-lib.ts`): after the hub owner has applied the member's
 * leaf `authorization` entry on their OWN nats-server config (the #1481
 * hub-owner artifact — printed by `cortex network secret add-member
 * --seal-only` / an EXTERNAL-hub `add-member`), they run THIS command to
 * stamp the registry's `hub_authorized_at` (cortex#1498) — the real signal
 * that replaces the `--hub-authorized-confirmed` honor-system attestation.
 *
 * Mints nothing; writes nothing hub-local. It is a single admin-signed
 * registry write, gated on the SAME hub-admin authority as the sealed-secret
 * delivery (ADR-0018 Q5). MUTATION gates on `apply`: dry-run resolves the
 * admission-row lookup (read-only, safe) and prints the plan; `--apply` POSTs
 * the signed claim.
 */

import { toBase64Pubkey, looksLikeNkeyRole } from "../../../common/registry/pubkey-normalize";
import type { NetworkAuthorizePorts } from "./network-authorize-ports";

export interface AuthorizeInputs {
  networkId: string;
  /** The member's registered ed25519 pubkey (base64, or an nkey of either encoding) — the row key. */
  memberPubkey: string;
  apply: boolean;
}

export interface AuthorizeReport {
  ok: boolean;
  applied: boolean;
  networkId: string;
  /** Human-readable plan/result steps. */
  steps: string[];
  /** Structured data for --json. */
  data: Record<string, string>;
  /** Failure reason (operational). */
  reason?: string;
}

/**
 * Stamp `hub_authorized_at` onto the member's ADMITTED admission row for
 * `networkId`. Dry-run by default (resolves the row, prints the plan);
 * `apply` POSTs the signed claim.
 */
export async function runNetworkAuthorize(
  inputs: AuthorizeInputs,
  ports: NetworkAuthorizePorts,
): Promise<AuthorizeReport> {
  const steps: string[] = [];
  // cortex#1482-style normalize: accept either encoding (base64 or an nkey of
  // either role) for the lookup, falling back to the raw value so an
  // already-malformed input fails exactly as it did before this normalize.
  const memberPubkeyB64 = toBase64Pubkey(inputs.memberPubkey) ?? inputs.memberPubkey;
  const data: Record<string, string> = {
    action: "authorize",
    network: inputs.networkId,
    member_fingerprint: memberPubkeyB64.slice(0, 12),
  };

  const row = await ports.admission.findAdmittedRow(inputs.networkId, memberPubkeyB64);
  if (!row) {
    return fail(inputs, steps, data, noAdmittedRowMessage(inputs.networkId, inputs.memberPubkey));
  }
  data.request_id = row.request_id;
  steps.push(`member:     ${memberPubkeyB64.slice(0, 12)}… (request ${row.request_id})`);

  if (!inputs.apply) {
    steps.push(`would: stamp hub_authorized_at on the registry admission row (hub-admin authority)`);
    return plan(inputs, steps, data);
  }

  try {
    await ports.delivery.postAuthorize(row.request_id);
  } catch (err) {
    return fail(inputs, steps, data, `failed to stamp the registry: ${errText(err)}`);
  }
  steps.push(`registry:   admission row ${row.request_id} stamped hub_authorized_at`);

  const report = plan(inputs, steps, data);
  report.applied = true;
  return report;
}

function plan(inputs: AuthorizeInputs, steps: string[], data: Record<string, string>): AuthorizeReport {
  return { ok: true, applied: false, networkId: inputs.networkId, steps, data };
}

function fail(
  inputs: AuthorizeInputs,
  steps: string[],
  data: Record<string, string>,
  reason: string,
): AuthorizeReport {
  return { ok: false, applied: false, networkId: inputs.networkId, steps, data, reason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * cortex#1482-style — a plausible copy-paste mix-up: the member's OWN
 * registered/PoP pubkey and the hub's federation account are DIFFERENT keys
 * (seal-target ≠ leaf-account, ADR-0018). Explain it when the RAW value looks
 * like the other representation (an nkey-account, `A…`); otherwise the bare
 * "not admitted yet" message (a real, distinct failure).
 */
function noAdmittedRowMessage(networkId: string, rawMemberPubkey: string): string {
  const bare = `no ADMITTED admission row for that member on network "${networkId}" — admit them first (cortex network admit), or check the member pubkey`;
  if (!looksLikeNkeyRole(rawMemberPubkey, "account")) return bare;
  return (
    `${bare}. "${rawMemberPubkey.slice(0, 12)}…" looks like a FED account nkey (A…), but admission ` +
    `rows are keyed to the member's REGISTERED/PoP pubkey — a different key, not a hub's federation ` +
    `account. Pass the member's registered/PoP pubkey here instead (base64 or a U… nkey — either encoding works).`
  );
}
