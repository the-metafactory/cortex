/**
 * ADR-0018 PR5b (#1240) — `cortex network secret` orchestrator (PURE over ports).
 *
 * The per-member leaf PSK lifecycle (ADR-0018 Q2/Q5/Q6):
 *
 *   add-member  mint a per-member PSK → write the member's hub `authorization`
 *               user + reload the hub (allow transport) → DELIVER: seal an
 *               envelope to the member's pubkey and POST it to their ADMITTED
 *               admission row (sealed, default), OR surface the PSK for an
 *               out-of-band handover (oob).
 *   rotate      re-mint + re-seal + replace; old PSK inert (hub user updated,
 *               sealed blob replaced).
 *   revoke-member  drop the member's hub `authorization` user + reload (CUT
 *               transport — not just a roster row) → mark the admission row
 *               REVOKED (registry).
 *
 * MUTATIONS gate on `apply`: dry-run resolves the plan (it may READ the registry
 * row + the hub config to make the plan concrete) but performs NO write/reload/
 * deliver/revoke. SECRETS NEVER appear in the returned report EXCEPT the oob
 * surfaced PSK (which the hub-admin MUST receive to hand it over) — that lives in
 * a dedicated `surfaced` field the caller renders explicitly, never in `steps`.
 *
 * The leaf PSK rides a {@link encodeLeafSecretEnvelope} JSON envelope so the M3
 * per-network payload key (#1246) can ride the SAME sealed blob later with no
 * schema change — that is the documented M3 seam.
 */

import { encodeLeafSecretEnvelope } from "../../../common/registry/sealed-leaf-secret";
import { pskFingerprint } from "../../../common/nats/leaf-psk";
import {
  upsertHubLeafUser,
  removeHubLeafUser,
  HubAuthConflictError,
} from "../../../common/nats/hub-leaf-authorization";
import type { NetworkSecretPorts } from "./network-secret-ports";

export type SecretAction = "add-member" | "revoke-member" | "rotate";
export type DeliveryMode = "sealed" | "oob";

export interface SecretInputs {
  action: SecretAction;
  networkId: string;
  /** The member's registered ed25519 pubkey (base64) — the seal target + row key. */
  memberPubkey: string;
  /** add-member only: sealed (default) or oob. */
  deliver: DeliveryMode;
  /** Override the hub leaf user (defaults to the member's principal id). */
  leafUserOverride?: string;
  /**
   * C-1349 Slice 1 — the per-network payload key `K` (base64, 32 bytes) read
   * from the HUB STACK's own resolved config (`policy.federated.networks[<net>]
   * .payload_key`) by the CLI. When present (add-member / rotate), it is sealed
   * into the envelope alongside the leaf PSK so `network join` installs it. When
   * ABSENT (encryption-off network, or no K configured hub-side), the envelope
   * is sealed exactly as before and an info line points at the SOP fallback.
   * The orchestrator NEVER mints K — delivery reads the existing hub-side key
   * verbatim (minting is Slice 2's `rotate-key`).
   */
  payloadKey?: string;
  /**
   * C-1349 Slice 1 — the key id (rotation epoch) paired with {@link payloadKey}
   * (`payload_key_id ?? <network>/k1`). Rides beside K in the envelope so the
   * joiner installs both. Only meaningful when {@link payloadKey} is set.
   */
  payloadKeyKid?: string;
  apply: boolean;
}

export interface SecretReport {
  ok: boolean;
  applied: boolean;
  action: SecretAction;
  networkId: string;
  /** Human-readable plan/result steps — NEVER carry a secret. */
  steps: string[];
  /** Structured data for --json — NEVER carries a secret. */
  data: Record<string, string>;
  /** Failure reason (operational). */
  reason?: string;
  /**
   * OOB delivery ONLY: the secret the hub-admin must hand over out-of-band. The
   * caller renders this explicitly + separately (it is the one place a secret
   * legitimately reaches stdout). Absent for sealed delivery.
   */
  surfaced?: { leafUser: string; psk: string };
}

/** Dispatch by action. */
export async function runNetworkSecret(
  inputs: SecretInputs,
  ports: NetworkSecretPorts,
): Promise<SecretReport> {
  switch (inputs.action) {
    case "add-member":
      return addOrRotate(inputs, ports, /* rotate */ false);
    case "rotate":
      return addOrRotate(inputs, ports, /* rotate */ true);
    case "revoke-member":
      return revokeMember(inputs, ports);
  }
}

/**
 * add-member + rotate share the mint→hub-write→deliver shape. rotate REPLACES
 * (the hub upsert + the sealed POST both overwrite in place; the old PSK is
 * inert once the hub user is overwritten).
 */
async function addOrRotate(
  inputs: SecretInputs,
  ports: NetworkSecretPorts,
  rotate: boolean,
): Promise<SecretReport> {
  const action: SecretAction = rotate ? "rotate" : "add-member";
  const steps: string[] = [];
  const data: Record<string, string> = {
    action,
    network: inputs.networkId,
    member_fingerprint: inputs.memberPubkey.slice(0, 12),
    deliver: inputs.deliver,
  };

  // 1. Resolve the ADMITTED admission row (read-only — safe in dry-run too).
  const row = await ports.admission.findAdmittedRow(inputs.networkId, inputs.memberPubkey);
  if (!row) {
    return fail(action, inputs, steps, data, `no ADMITTED admission row for that member on network "${inputs.networkId}" — admit them first (cortex network admit)`);
  }
  const leafUser = inputs.leafUserOverride ?? row.principal_id;
  data.request_id = row.request_id;
  data.leaf_user = leafUser;

  steps.push(`member:     ${inputs.memberPubkey.slice(0, 12)}… (request ${row.request_id})`);
  steps.push(`leaf user:  ${leafUser}`);
  steps.push(`deliver:    ${inputs.deliver}`);

  if (!inputs.apply) {
    steps.push(rotate
      ? `would: re-mint PSK → REPLACE hub authorization user "${leafUser}" + reload → re-seal + replace sealed blob`
      : `would: mint PSK → add hub authorization user "${leafUser}" + reload → ${inputs.deliver === "sealed" ? "seal + deliver to the admission row" : "surface PSK for out-of-band handover"}`);
    // C-1349 Slice 1 — surface whether the sealed blob will carry the payload key
    // K (kid only, NEVER K). oob never carries K (manual bootstrap path).
    if (inputs.deliver === "sealed") {
      const payloadKey =
        typeof inputs.payloadKey === "string" && inputs.payloadKey.length > 0
          ? inputs.payloadKey
          : undefined;
      steps.push(
        payloadKey !== undefined
          ? `would: seal payload key K (kid ${inputs.payloadKeyKid ?? `${inputs.networkId}/k1`}) — join would install encryption`
          : `would: no payload key configured hub-side for "${inputs.networkId}" — sealing PSK only (SOP Step 8 for manual encryption)`,
      );
    }
    return plan(action, inputs, steps, data);
  }

  // 2. Mint the PSK + write the hub authorization user + reload.
  const psk = ports.crypto.mintPsk();
  const fp = await pskFingerprint(psk);
  data.psk_fingerprint = fp;

  let conf: string;
  try {
    conf = await ports.hub.readConf();
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to read hub config: ${errText(err)}`);
  }
  let nextConf: string;
  try {
    nextConf = upsertHubLeafUser(conf, leafUser, psk);
  } catch (err) {
    if (err instanceof HubAuthConflictError) {
      return fail(action, inputs, steps, data, err.message);
    }
    return fail(action, inputs, steps, data, `failed to render hub authorization: ${errText(err)}`);
  }
  try {
    await ports.hub.writeConf(nextConf);
    await ports.hub.reload();
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to write/reload hub config: ${errText(err)}`);
  }
  steps.push(`hub:        ${rotate ? "replaced" : "added"} authorization user "${leafUser}" + reloaded (psk ${fp})`);

  // 3. Deliver.
  if (inputs.deliver === "oob") {
    steps.push(`deliver:    OOB — surface PSK for the privileged bot to hand over (registry untouched)`);
    const report = plan(action, inputs, steps, data);
    report.applied = true;
    report.surfaced = { leafUser, psk };
    return report;
  }

  // sealed (default): seal the envelope to the member + POST onto the row.
  // C-1349 Slice 1 — when the hub stack config carries a payload key K for this
  // network, seal it (+ its kid) alongside the leaf PSK so `network join`
  // installs it with zero manual key handling. K NEVER reaches steps/data — only
  // its kid + a SHA-256 fingerprint are printable. Absent K ⇒ seal as before +
  // an info line pointing at the SOP manual-handoff fallback.
  const payloadKey =
    typeof inputs.payloadKey === "string" && inputs.payloadKey.length > 0
      ? inputs.payloadKey
      : undefined;
  let payloadKeyKid: string | undefined;
  if (payloadKey !== undefined) {
    payloadKeyKid = inputs.payloadKeyKid ?? `${inputs.networkId}/k1`;
    // Log-safe correlation of K: kid + first 8 hex of SHA-256(K). NEVER K.
    const kFp = await pskFingerprint(payloadKey);
    data.payload_key_kid = payloadKeyKid;
    data.payload_key_fingerprint = kFp;
    steps.push(`payload key: sealed K (kid ${payloadKeyKid}, fp ${kFp}) — join installs encryption`);
  } else {
    steps.push(
      `payload key: no payload key configured hub-side for "${inputs.networkId}" — sealing PSK only; the member enables encryption via the manual handoff in sop-onboard-peer-principal.md Step 8`,
    );
  }

  let sealed: string;
  try {
    const envelope = encodeLeafSecretEnvelope({
      leaf_psk: psk,
      leaf_user: leafUser,
      ...(payloadKey !== undefined && {
        payload_key: payloadKey,
        payload_key_kid: payloadKeyKid,
      }),
    });
    sealed = await ports.crypto.seal(envelope, inputs.memberPubkey);
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to seal the secret to the member pubkey: ${errText(err)}`);
  }
  try {
    await ports.delivery.postSealedSecret(row.request_id, sealed);
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to deliver the sealed secret to the registry: ${errText(err)}`);
  }
  steps.push(`deliver:    sealed to member pubkey → posted to admission row ${row.request_id}`);

  const report = plan(action, inputs, steps, data);
  report.applied = true;
  return report;
}

async function revokeMember(
  inputs: SecretInputs,
  ports: NetworkSecretPorts,
): Promise<SecretReport> {
  const action: SecretAction = "revoke-member";
  const steps: string[] = [];
  const data: Record<string, string> = {
    action,
    network: inputs.networkId,
    member_fingerprint: inputs.memberPubkey.slice(0, 12),
  };

  const row = await ports.admission.findAdmittedRow(inputs.networkId, inputs.memberPubkey);
  if (!row) {
    return fail(action, inputs, steps, data, `no ADMITTED admission row for that member on network "${inputs.networkId}" — nothing to revoke`);
  }
  const leafUser = inputs.leafUserOverride ?? row.principal_id;
  data.request_id = row.request_id;
  data.leaf_user = leafUser;
  steps.push(`member:     ${inputs.memberPubkey.slice(0, 12)}… (request ${row.request_id})`);
  steps.push(`leaf user:  ${leafUser}`);

  if (!inputs.apply) {
    steps.push(`would: DROP hub authorization user "${leafUser}" + reload (CUT transport) → mark admission row REVOKED`);
    return plan(action, inputs, steps, data);
  }

  // 1. Drop the hub authorization user + reload — MUST cut transport, not just
  //    the roster row.
  let conf: string;
  try {
    conf = await ports.hub.readConf();
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to read hub config: ${errText(err)}`);
  }
  try {
    const nextConf = removeHubLeafUser(conf, leafUser);
    await ports.hub.writeConf(nextConf);
    await ports.hub.reload();
  } catch (err) {
    return fail(action, inputs, steps, data, `failed to drop hub authorization user / reload: ${errText(err)}`);
  }
  steps.push(`hub:        dropped authorization user "${leafUser}" + reloaded (transport CUT)`);

  // 2. Mark the admission row REVOKED (clears the sealed blob).
  try {
    await ports.delivery.revoke(row.request_id);
  } catch (err) {
    return fail(action, inputs, steps, data, `hub transport cut, but failed to mark the admission row REVOKED: ${errText(err)}`);
  }
  steps.push(`registry:   admission row ${row.request_id} marked REVOKED (sealed blob cleared)`);

  const report = plan(action, inputs, steps, data);
  report.applied = true;
  return report;
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function plan(action: SecretAction, inputs: SecretInputs, steps: string[], data: Record<string, string>): SecretReport {
  return { ok: true, applied: false, action, networkId: inputs.networkId, steps, data };
}

function fail(action: SecretAction, inputs: SecretInputs, steps: string[], data: Record<string, string>, reason: string): SecretReport {
  return { ok: false, applied: false, action, networkId: inputs.networkId, steps, data, reason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
