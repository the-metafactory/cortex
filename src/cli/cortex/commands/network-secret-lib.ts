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
import { looksLikeNkeyRole, toBase64Pubkey } from "../../../common/registry/pubkey-normalize";
import { pskFingerprint } from "../../../common/nats/leaf-psk";
import {
  upsertHubLeafUser,
  removeHubLeafUser,
  listHubLeafUsers,
  HubAuthConflictError,
} from "../../../common/nats/hub-leaf-authorization";
import { defaultKeyId } from "../../../common/crypto/network-encryption-policy";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type {
  NetworkSecretPorts,
  NetworkKeyRotationPorts,
} from "./network-secret-ports";

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
   * cortex#1481 — force the SEAL-ONLY path (registry seal + hub-owner artifact,
   * NEVER a local hub write) even when {@link decideHubLocality} would otherwise
   * call the hub local. The explicit opt-in for "I know this hub isn't mine, or
   * I don't trust the auto-detection" — add-member/rotate only (revoke-member
   * still cuts the local hub unconditionally; #1481 scopes the fix to the mint+
   * write seam that storms).
   */
  sealOnly?: boolean;
  /**
   * cortex#1481 — the hub's OWN federation account nkey-U (`A…`), when the
   * caller happens to know it (`--hub-account`). Only meaningful when the hub
   * turns out to be EXTERNAL (or `sealOnly` is set): it rides the hub-owner
   * artifact's `account:` field so the printed snippet is account-bound
   * (operator-mode). Absent ⇒ the artifact omits `account:` and tells the hub
   * owner to add it themselves (only they have visibility into their own
   * account tree).
   */
  hubAccount?: string;
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
  /**
   * cortex#1481 — present iff the hub turned out to be EXTERNAL (or `sealOnly`
   * forced it): the EXACT `leafnodes { authorization { users: [...] } }`
   * snippet + hand-off note the hub owner must add to THEIR OWN nats-server
   * config, since the orchestrator refused to write it here. The other
   * legitimate place the raw PSK reaches the caller (alongside `surfaced`) —
   * the render caller shows it explicitly, never folds it into `steps`.
   */
  hubOwnerArtifact?: string[];
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

// ===========================================================================
// cortex#1481 (epic #1479, join-2) — hub locality: NEVER write a foreign hub.
//
// The #1 storm cause: `--hub-config` defaults to the LOCAL nats, so when a
// network's hub is ANOTHER principal's server, `add-member`/`admit --and-seal`
// wrote the leaf authorization onto the admin's own laptop — never the real
// hub — and the joiner's leaf then Authorization-Violation-storms against the
// real hub (which never saw the PSK). {@link decideHubLocality} is the PURE,
// fail-safe decision (data in, verdict out — no I/O); {@link
// renderHubOwnerArtifact} is the PURE artifact the orchestrator emits INSTEAD
// of the local write when the hub is external. Both are exported for direct
// unit testing; `addOrRotate` is the only caller in the orchestrator itself.
// ===========================================================================

/** Loopback aliases considered an UNAMBIGUOUS match for "this host", as
 *  returned by `new URL(...).hostname` (bracketed IPv6). Compared
 *  case-insensitively against the parsed hub_url host. */
const LOCAL_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Parse the host out of a `hub_url` (a full `tls://host:port` URL — DD-12 —
 * or a bare host; mirrors `resolveLeafUrl` in `leaf-remote-renderer.ts`).
 * Returns `undefined` on an empty/unparseable value — the caller treats that
 * as "cannot determine" (fails safe to EXTERNAL). Exported so the LIVE adapter
 * ({@link HubLocalityPort.hubHostIsLocalInterface}) resolves the SAME host this
 * decider matches on — one grammar, no drift.
 */
export function extractHubHost(hubUrl: string): string | undefined {
  const raw = hubUrl.trim();
  if (raw.length === 0) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `tls://${raw}`;
  try {
    const parsed = new URL(withScheme);
    // Strip the IPv6 brackets URL keeps on `hostname` (`[::1]` → `::1`) so the
    // adapter's DNS/interface comparison sees the bare address form.
    const host = parsed.hostname;
    if (host.length === 0) return undefined;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch (_err) {
    // A malformed hub_url is not this function's concern to report — the
    // caller (decideHubLocality) turns an undefined host into "cannot
    // determine" and fails safe to EXTERNAL, which is the correct behavior
    // for a value we can't parse.
    return undefined;
  }
}

/** The cortex#1481 hub-locality verdict. `hubUrl` rides the EXTERNAL branch
 *  (when known) so the hub-owner artifact can name the hub. */
export type HubLocality =
  | { kind: "local" }
  | { kind: "external"; hubUrl?: string; reason: string };

/**
 * The signals {@link decideHubLocality} weighs. `hubHostIsLocalInterface` is
 * the load-bearing one for a REAL deployment (Sage review, Important 2): the
 * hub owner's own machine caches its hub as an FQDN while `os.hostname()`
 * returns a short name, so neither the loopback-alias nor the exact-hostname
 * signal fires — the DNS→local-interface resolution (done in the adapter) is
 * what confirms "this FQDN is one of MY interfaces".
 */
export interface HubLocalityDeciderInputs {
  /** This machine's own hostname (`os.hostname()`). */
  localHostname: string;
  /**
   * True iff the hub_url's host resolves (via DNS) to one of THIS machine's
   * own network interfaces — computed by the adapter
   * ({@link HubLocalityPort.hubHostIsLocalInterface}), fail-safe `false` on any
   * resolution error. The signal that keeps the auto-write path alive for a
   * hub owner whose hub is cached as an FQDN.
   */
  hubHostIsLocalInterface: boolean;
}

/**
 * cortex#1481 — PURE, fail-safe locality decision. A network's hub counts as
 * LOCAL only on a CONFIDENT signal:
 *   - the hub_url host is a loopback alias (`localhost`/`127.0.0.1`/`::1`), OR
 *   - it EXACTLY case-insensitively matches this machine's hostname, OR
 *   - it resolves (DNS) to one of this machine's OWN network interfaces
 *     (`hubHostIsLocalInterface` — the real-FQDN-deployment signal, Sage
 *     review Important 2).
 * Every other case — no cached descriptor, an unparseable hub_url, or a host
 * that is none of the above — is EXTERNAL. The asymmetry is deliberate: a
 * false "local" IS the #1481 storm bug (writes a foreign hub); a false
 * "external" only costs an extra hand-off step (the hub-owner artifact instead
 * of an automatic write) — so every ambiguous case resolves to EXTERNAL.
 */
export function decideHubLocality(
  hubUrl: string | undefined,
  inputs: HubLocalityDeciderInputs,
): HubLocality {
  if (hubUrl === undefined || hubUrl.trim() === "") {
    return {
      kind: "external",
      reason:
        "no cached network descriptor for this network on this host (never joined/synced here) — cannot confirm the hub is local; treating as EXTERNAL (fail-safe)",
    };
  }
  const host = extractHubHost(hubUrl);
  if (host === undefined) {
    return {
      kind: "external",
      hubUrl,
      reason: `could not parse a host from the network's hub_url ${JSON.stringify(hubUrl)} — treating as EXTERNAL (fail-safe)`,
    };
  }
  const lowerHost = host.toLowerCase();
  const lowerLocal = inputs.localHostname.trim().toLowerCase();
  if (
    LOCAL_HOST_ALIASES.has(lowerHost) ||
    (lowerLocal.length > 0 && lowerHost === lowerLocal) ||
    inputs.hubHostIsLocalInterface
  ) {
    return { kind: "local" };
  }
  return {
    kind: "external",
    hubUrl,
    reason:
      `network hub_url host "${host}" is neither a loopback alias, this machine's ` +
      `hostname (${inputs.localHostname.trim().length > 0 ? inputs.localHostname : "unknown hostname"}), ` +
      `nor a local network interface — refusing to write the local nats config`,
  };
}

/** Inputs {@link renderHubOwnerArtifact} needs to print the EXACT snippet the
 *  hub owner adds to THEIR OWN nats-server config. */
export interface HubOwnerArtifactInputs {
  networkId: string;
  /** The hub `authorization` user (the userinfo USER the leaf dials with). */
  leafUser: string;
  /** The freshly-minted PSK — the ONE legitimate reason this rides the artifact. */
  psk: string;
  /** The network's hub_url, when known (absent ⇒ locality couldn't be confirmed at all). */
  hubUrl?: string;
  /**
   * The hub's OWN federation account nkey-U, when the caller happens to know
   * it (`--hub-account`). Present ⇒ the snippet is account-bound
   * (operator-mode). Absent ⇒ the snippet omits `account:` and the artifact
   * tells the hub owner to add it themselves — only THEY have visibility into
   * their own account tree.
   */
  account?: string;
}

/**
 * cortex#1481 — render the EXACT `leafnodes { authorization { users: [...] }
 * }` snippet the hub owner must add to THEIR OWN nats-server config, plus a
 * hand-off note. This is what the orchestrator emits INSTEAD OF writing the
 * local hub when the hub is external (or `--seal-only` forced it). PURE (data
 * in, text out) — the second legitimate place (alongside
 * `SecretReport.surfaced`) the raw PSK reaches the caller; the render layer
 * shows it explicitly, never folds it into `steps`/`data`.
 */
export function renderHubOwnerArtifact(inputs: HubOwnerArtifactInputs): string[] {
  const lines: string[] = [];
  lines.push("── HUB-OWNER ACTION REQUIRED (this network's hub is NOT this machine) ──");
  lines.push(
    inputs.hubUrl !== undefined
      ? `network:     ${inputs.networkId}  (hub: ${inputs.hubUrl})`
      : `network:     ${inputs.networkId}  (hub location could not be confirmed from this host)`,
  );
  lines.push("Add this to the leafnodes {} block of the HUB's OWN nats-server config:");
  lines.push("");
  lines.push("leafnodes {");
  lines.push("  authorization {");
  lines.push("    users: [");
  const accountField = inputs.account !== undefined ? `, account: ${JSON.stringify(inputs.account)}` : "";
  lines.push(`      { user: ${JSON.stringify(inputs.leafUser)}, password: ${JSON.stringify(inputs.psk)}${accountField} }`);
  lines.push("    ]");
  lines.push("  }");
  lines.push("}");
  if (inputs.account === undefined) {
    lines.push("");
    lines.push(
      "If that hub's bus is operator-mode, ALSO add an `account: \"<the hub's own federation " +
        "account nkey-U>\"` field to this user entry — only the hub owner has visibility into " +
        "their own account tree (pass --hub-account <A…> to this command if you already know it).",
    );
  }
  lines.push("");
  lines.push(
    `Hand this snippet to whoever runs network "${inputs.networkId}"'s hub. After they add it, they ` +
      "must validate (`nats-server -c <hub.conf> -t`) and RESTART their hub nats-server for the new " +
      "leaf-authorization user to take effect. A SIGHUP reload is NOT enough: nats-server rejects " +
      "leafnode-authorization changes on reload and keeps the old auth (server/reload.go), so a " +
      "reloaded hub will refuse the new member until it is restarted.",
  );
  return lines;
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
  // cortex#1482 (Pair 1) — normalize whatever encoding the caller passed
  // (base64, or an nkey of EITHER role) to base64 for the lookup/seal below;
  // fall back to the raw value when it isn't recognizable so an already-
  // malformed input fails exactly as it did before this change. The RAW
  // `inputs.memberPubkey` is kept separately (never overwritten) so
  // `noAdmittedRowMessage` can still inspect what the caller actually typed.
  const memberPubkeyB64 = toBase64Pubkey(inputs.memberPubkey) ?? inputs.memberPubkey;
  const data: Record<string, string> = {
    action,
    network: inputs.networkId,
    member_fingerprint: memberPubkeyB64.slice(0, 12),
    deliver: inputs.deliver,
  };

  // 1. Resolve the ADMITTED admission row (read-only — safe in dry-run too).
  const row = await ports.admission.findAdmittedRow(inputs.networkId, memberPubkeyB64);
  if (!row) {
    return fail(action, inputs, steps, data, noAdmittedRowMessage(inputs.networkId, inputs.memberPubkey, "admit them first (cortex network admit)"));
  }
  const leafUser = inputs.leafUserOverride ?? row.principal_id;
  data.request_id = row.request_id;
  data.leaf_user = leafUser;

  steps.push(`member:     ${memberPubkeyB64.slice(0, 12)}… (request ${row.request_id})`);
  steps.push(`leaf user:  ${leafUser}`);
  steps.push(`deliver:    ${inputs.deliver}`);

  // cortex#1481 — resolve hub locality BEFORE any mutation, so both the
  // dry-run plan and the apply path branch identically. `sealOnly` forces the
  // EXTERNAL path even when the descriptor would otherwise read as local (the
  // explicit "never write this hub" override) — but we still resolve the
  // cached hub_url (a pure local-disk read) so the hub-owner artifact can name
  // it when known. The DNS→local-interface probe (Sage review Important 2) only
  // runs when there is a cached hub_url to probe — the load-bearing signal for
  // a hub owner whose own hub is cached as an FQDN.
  const cachedHubUrl = await ports.hubLocality.resolveHubUrl(inputs.networkId);
  const hubHostIsLocalInterface =
    cachedHubUrl !== undefined ? await ports.hubLocality.hubHostIsLocalInterface(cachedHubUrl) : false;
  const localityDecision = decideHubLocality(cachedHubUrl, {
    localHostname: ports.hubLocality.localHostname(),
    hubHostIsLocalInterface,
  });
  const locality: HubLocality =
    inputs.sealOnly === true
      ? {
          kind: "external",
          reason: "--seal-only forced: registry seal + hub-owner artifact only — the local hub is never written",
          ...(cachedHubUrl !== undefined && { hubUrl: cachedHubUrl }),
        }
      : localityDecision;
  steps.push(
    locality.kind === "local"
      ? `hub:        LOCAL (this host) — ${ports.hub.confPath}`
      : `hub:        EXTERNAL — ${locality.reason}`,
  );
  data.hub_locality = locality.kind;

  if (!inputs.apply) {
    if (locality.kind === "local") {
      steps.push(rotate
        ? `would: re-mint PSK → REPLACE hub authorization user "${leafUser}" + reload → re-seal + replace sealed blob`
        : `would: mint PSK → add hub authorization user "${leafUser}" + reload → ${inputs.deliver === "sealed" ? "seal + deliver to the admission row" : "surface PSK for out-of-band handover"}`);
    } else {
      steps.push(rotate
        ? `would: re-mint PSK → SEAL-ONLY (no local hub write — external hub) → re-seal + replace sealed blob → emit hub-owner artifact`
        : `would: mint PSK → SEAL-ONLY (no local hub write — external hub) → ${inputs.deliver === "sealed" ? "seal + deliver to the admission row" : "surface PSK for out-of-band handover"} → emit hub-owner artifact`);
    }
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

  // 2. Mint the PSK, then EITHER write the hub authorization user + reload
  //    (LOCAL hub) OR skip that write entirely (EXTERNAL hub / --seal-only —
  //    cortex#1481: NEVER write a foreign hub's nats config).
  const psk = ports.crypto.mintPsk();
  const fp = await pskFingerprint(psk);
  data.psk_fingerprint = fp;

  if (locality.kind === "local") {
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
    steps.push(
      `hub:        ${rotate ? "replaced" : "added"} authorization user "${leafUser}" in config (psk ${fp}) — ` +
        `RESTART the hub nats-server for it to take effect (leaf-authorization is not applied by SIGHUP reload, server/reload.go)`,
    );
  } else {
    // cortex#1481 — the #1 storm cause: DO NOT touch ports.hub at all. The
    // registry seal below still runs (machine-independent); the hub-owner
    // artifact attached below carries the exact snippet for whoever runs the
    // real hub.
    steps.push(`hub:        SKIPPED — no local nats config written (external hub); see the hub-owner artifact below`);
  }

  // 3. Deliver.
  if (inputs.deliver === "oob") {
    steps.push(`deliver:    OOB — surface PSK for the privileged bot to hand over (registry untouched)`);
    const report = plan(action, inputs, steps, data);
    report.applied = true;
    report.surfaced = { leafUser, psk };
    attachArtifactIfExternal(report, locality, inputs, leafUser, psk);
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
    sealed = await ports.crypto.seal(envelope, memberPubkeyB64);
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
  attachArtifactIfExternal(report, locality, inputs, leafUser, psk);
  return report;
}

/**
 * cortex#1481 (Sage review, nit) — attach the hub-owner artifact to `report`
 * IFF the hub is external. Shared by the oob and sealed delivery tails of
 * {@link addOrRotate} (the block was verbatim in both). The raw PSK riding the
 * artifact is one of the two legitimate secret-to-caller channels (the other is
 * `report.surfaced`); the render layer prints it explicitly, never in steps.
 */
function attachArtifactIfExternal(
  report: SecretReport,
  locality: HubLocality,
  inputs: SecretInputs,
  leafUser: string,
  psk: string,
): void {
  if (locality.kind !== "external") return;
  report.hubOwnerArtifact = renderHubOwnerArtifact({
    networkId: inputs.networkId,
    leafUser,
    psk,
    ...(locality.hubUrl !== undefined && { hubUrl: locality.hubUrl }),
    ...(inputs.hubAccount !== undefined && { account: inputs.hubAccount }),
  });
}

async function revokeMember(
  inputs: SecretInputs,
  ports: NetworkSecretPorts,
): Promise<SecretReport> {
  const action: SecretAction = "revoke-member";
  const steps: string[] = [];
  // cortex#1482 (Pair 1) — SAME normalize-then-fall-back-to-raw as addOrRotate.
  const memberPubkeyB64 = toBase64Pubkey(inputs.memberPubkey) ?? inputs.memberPubkey;
  const data: Record<string, string> = {
    action,
    network: inputs.networkId,
    member_fingerprint: memberPubkeyB64.slice(0, 12),
  };

  const row = await ports.admission.findAdmittedRow(inputs.networkId, memberPubkeyB64);
  if (!row) {
    return fail(action, inputs, steps, data, noAdmittedRowMessage(inputs.networkId, inputs.memberPubkey, "nothing to revoke"));
  }
  const leafUser = inputs.leafUserOverride ?? row.principal_id;
  data.request_id = row.request_id;
  data.leaf_user = leafUser;
  steps.push(`member:     ${memberPubkeyB64.slice(0, 12)}… (request ${row.request_id})`);
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
  steps.push(
    `hub:        dropped authorization user "${leafUser}" from config — ` +
      `RESTART the hub nats-server to actually cut transport. A SIGHUP reload does NOT drop an ` +
      `active leaf session (nats-server rejects leafnode-authorization reloads, server/reload.go): ` +
      `until the hub restarts, the revoked member stays connected.`,
  );

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

// ===========================================================================
// cortex#1482 (epic #1479, join-3) — Pair 1 reconciliation: registered/PoP
// pubkey ⟷ FED account. These CAN legitimately differ (seal-target ≠
// leaf-account, ADR-0018): a member's admission row is keyed to their
// REGISTERED/PoP pubkey (a user-role identity key), while their leaf binds a
// SEPARATE FED account (an account-role key). Passing the account key where
// the admission lookup expects the registered pubkey used to fail with a
// bare "no ADMITTED row" — {@link noAdmittedRowMessage} builds the loud,
// plain explanation instead, but ONLY when the RAW value the caller typed is
// shaped like the other representation (an nkey-account, `A…`). A value
// that's already base64 or an nkey-user (the CORRECT shape) that simply
// isn't admitted gets the bare message unchanged — base64 carries no role
// annotation, so we cannot honestly claim a representation mismatch for it,
// and "not admitted yet" is a real, distinct failure the explanation must
// not paper over.
// ===========================================================================

function noAdmittedRowMessage(networkId: string, rawMemberPubkey: string, tail: string): string {
  const bare = `no ADMITTED admission row for that member on network "${networkId}" — ${tail}`;
  if (!looksLikeNkeyRole(rawMemberPubkey, "account")) return bare;
  return (
    `${bare}. "${rawMemberPubkey.slice(0, 12)}…" looks like a FED account nkey (A…), but admission ` +
    `rows are keyed to the member's REGISTERED/PoP pubkey — a different key, not the hub's federation ` +
    `account. These can legitimately differ (seal-target ≠ leaf-account, ADR-0018): pass the member's ` +
    `registered/PoP pubkey here instead (base64 or a U… nkey — either encoding works). If you meant to ` +
    `bind the HUB's own federation account, that's --hub-account, not the member pubkey.`
  );
}

// ===========================================================================
// C-1349 Slice 2 — network-wide payload-key (K) rotation (`rotate-key`).
// ===========================================================================

/**
 * Deterministic kid epoch bump (design decision #4). Parse the current kid's
 * trailing counter `<network>/k<n>` → `<network>/k<n+1>`; when the current kid
 * does NOT match that shape (a manually-set kid, a prior date fallback, a
 * different network prefix), fall back to `<network>/k-<ISO-date>`. The ISO date
 * is INJECTED (`isoDate`) so the fallback is deterministic in tests and the
 * orchestrator never reaches for a clock itself.
 */
export function computeNextKid(
  networkId: string,
  currentKid: string | undefined,
  isoDate: string,
): string {
  const prefix = `${networkId}/k`;
  if (currentKid?.startsWith(prefix) === true) {
    const tail = currentKid.slice(prefix.length);
    if (/^\d+$/.test(tail)) {
      return `${prefix}${(Number.parseInt(tail, 10) + 1).toString()}`;
    }
  }
  return `${networkId}/k-${isoDate}`;
}

/** Inputs for a network-wide K rotation. NO member pubkey — `rotate-key` is
 *  network-scoped. `nowIso` feeds the kid date-fallback deterministically. */
export interface KeyRotationInputs {
  networkId: string;
  apply: boolean;
  /** ISO timestamp for the kid date-fallback (the CLI passes `new Date()...`). */
  nowIso: string;
}

/** Per-member re-seal outcome for the summary table. NEVER carries K. */
export interface KeyRotationMemberOutcome {
  /** Member pubkey fingerprint (first 12 chars) — the summary-table key. */
  memberFingerprint: string;
  requestId: string;
  resealed: boolean;
  /** Why a member was NOT resealed: `inert` (no hub user) or an error. NEVER K. */
  note?: string;
}

export interface KeyRotationReport {
  ok: boolean;
  applied: boolean;
  networkId: string;
  /** Plan/result steps — NEVER carry K (kid + fingerprint only). */
  steps: string[];
  /** Structured data for --json — NEVER carries K. */
  data: Record<string, string>;
  /** Per-member re-seal outcomes (the summary table). */
  members: KeyRotationMemberOutcome[];
  /** The new kid (printable identifier). */
  newKid?: string;
  /** SHA-256(K′) first-8-hex — the ONLY printable K identifier. */
  keyFingerprint?: string;
  /** How many ADMITTED members the rotation targeted. */
  memberCount: number;
  reason?: string;
}

/**
 * `rotate-key` — mint K′ (32 random bytes) → re-seal EVERY ADMITTED member's
 * envelope (leaf_psk UNCHANGED + payload_key=K′ + bumped kid) → advance the hub
 * K store. ORDERING (security-critical, design constraint): re-seal ALL members
 * FIRST, then commit K′ to the hub config LAST, so a mid-flight re-seal failure
 * leaves the OLD K authoritative and the whole op re-runnable (a re-run mints a
 * fresh K″ and overwrites every member's blob — no half-rotated state).
 *
 * ADMITTED-only: REVOKED/DEPARTED/PENDING/REJECTED rows are never enumerated (the
 * whole point post-eviction). An ADMITTED-but-INERT member (row exists but no hub
 * `authorization` user, so no leaf PSK to preserve) is SKIPPED — marked
 * `resealed: no (inert)` — and does NOT block the commit (it has no transport and
 * no K to protect; it picks up the current K whenever it is actually sealed via
 * add-member). Only a GENUINE seal/deliver FAILURE blocks the commit.
 *
 * K NEVER appears in steps/data/members/errors — only the new kid and a
 * SHA-256(K′) fingerprint are printable. Dry-run mints NOTHING and writes NOTHING.
 */
export async function runNetworkKeyRotation(
  inputs: KeyRotationInputs,
  ports: NetworkKeyRotationPorts,
): Promise<KeyRotationReport> {
  const steps: string[] = [];
  const data: Record<string, string> = { action: "rotate-key", network: inputs.networkId };
  const base = (): KeyRotationReport => ({
    ok: true,
    applied: false,
    networkId: inputs.networkId,
    steps,
    data,
    members: [],
    memberCount: 0,
  });

  // 1. Read the hub K store — rotate-key ROTATES an existing key; it never mints
  //    the FIRST K (standing up encryption is out of scope, design decision #2).
  let networks: PolicyFederatedNetwork[];
  try {
    networks = await ports.keyStore.readNetworks();
  } catch (err) {
    return { ...base(), ok: false, reason: `failed to read the hub stack config (${ports.keyStore.configPath}): ${errText(err)}` };
  }
  const netIdx = networks.findIndex((n) => n.id === inputs.networkId);
  const net = netIdx >= 0 ? networks[netIdx] : undefined;
  if (net?.payload_key === undefined) {
    return {
      ...base(),
      ok: false,
      reason:
        `network "${inputs.networkId}" has no payload key configured hub-side ` +
        `(${ports.keyStore.configPath}) — rotate-key ROTATES an existing key. ` +
        `Stand up encryption first (sop-onboard-peer-principal.md Step 8), then rotate.`,
    };
  }
  const currentKid = net.payload_key_id ?? defaultKeyId(inputs.networkId);
  const newKid = computeNextKid(inputs.networkId, currentKid, inputs.nowIso);
  data.current_kid = currentKid;
  data.new_kid = newKid;

  // 2. Enumerate EVERY ADMITTED member (admin read). ADMITTED-only.
  let admitted;
  try {
    admitted = await ports.admission.listAdmittedRows(inputs.networkId);
  } catch (err) {
    return { ...base(), ok: false, newKid, reason: `failed to list ADMITTED members for "${inputs.networkId}": ${errText(err)}` };
  }
  data.member_count = admitted.length.toString();

  steps.push(`network:    ${inputs.networkId}`);
  steps.push(`kid:        ${currentKid} → ${newKid}`);
  steps.push(`members:    ${admitted.length.toString()} ADMITTED`);

  // 3. Dry-run (default): print the plan. Mint NOTHING, write NOTHING, no K.
  if (!inputs.apply) {
    steps.push(`would: mint K′ → re-seal ${admitted.length.toString()} ADMITTED member(s) with the new kid → advance the hub K store`);
    steps.push(`would: ${admitted.length.toString()} member(s) must then re-run \`cortex network join\` to pick up the new key`);
    const report = base();
    report.newKid = newKid;
    report.memberCount = admitted.length;
    report.members = admitted.map((m) => ({
      memberFingerprint: m.peer_pubkey.slice(0, 12),
      requestId: m.request_id,
      resealed: false,
      note: "dry-run",
    }));
    return report;
  }

  // 4. --apply. Mint K′ + compute its log-safe fingerprint (NEVER K itself).
  const kBytes = ports.crypto.mintPayloadKey();
  const kB64 = Buffer.from(kBytes).toString("base64");
  const kFp = await pskFingerprint(kB64);
  data.payload_key_fingerprint = kFp;
  steps.push(`minted:     K′ (kid ${newKid}, fp ${kFp})`);

  // Recover each member's EXISTING leaf PSK from the hub config so the re-seal
  // keeps leaf_psk UNCHANGED (rotate-key rotates K, not the per-member PSK).
  let hubConf: string;
  try {
    hubConf = await ports.readHubConf();
  } catch (err) {
    return { ...base(), ok: false, newKid, keyFingerprint: kFp, reason: `failed to read hub config to recover member leaf PSKs: ${errText(err)}` };
  }
  const pskByUser = new Map(listHubLeafUsers(hubConf).map((u) => [u.user, u.secret]));

  // 5. Re-seal ALL members first (collect outcomes). A GENUINE seal/deliver error
  //    blocks the commit; an INERT member (no hub user) is skipped, not a failure.
  const members: KeyRotationMemberOutcome[] = [];
  let hadFailure = false;
  for (const m of admitted) {
    const fp = m.peer_pubkey.slice(0, 12);
    const leafUser = m.principal_id; // network-wide rotate uses the DEFAULT user.
    const psk = pskByUser.get(leafUser);
    if (psk === undefined) {
      // ADMITTED but no hub authorization user → INERT (never sealed, or a custom
      // --leaf-user we can't recover). No transport, no K to protect → skip, do
      // NOT block. It picks up the current K when it is actually sealed.
      members.push({ memberFingerprint: fp, requestId: m.request_id, resealed: false, note: "inert — no hub authorization user" });
      continue;
    }
    try {
      const envelope = encodeLeafSecretEnvelope({
        leaf_psk: psk,
        leaf_user: leafUser,
        payload_key: kB64,
        payload_key_kid: newKid,
      });
      const sealed = await ports.crypto.seal(envelope, m.peer_pubkey);
      await ports.delivery.postSealedSecret(m.request_id, sealed);
      members.push({ memberFingerprint: fp, requestId: m.request_id, resealed: true });
    } catch (err) {
      hadFailure = true;
      members.push({ memberFingerprint: fp, requestId: m.request_id, resealed: false, note: `error: ${errText(err)}` });
    }
  }
  const resealedCount = members.filter((x) => x.resealed).length;

  // 6. Commit the hub K store LAST — ONLY if no genuine failure. A mid-flight
  //    failure leaves the OLD K authoritative (config untouched) and re-runnable.
  if (hadFailure) {
    steps.push(`re-sealed:  ${resealedCount.toString()}/${admitted.length.toString()} — at least one member FAILED`);
    steps.push(`hub K:      NOT advanced — OLD K "${currentKid}" remains authoritative; fix the failure and re-run (a re-run mints a fresh K and re-seals every member)`);
    return {
      ok: false,
      applied: true,
      networkId: inputs.networkId,
      steps,
      data,
      members,
      newKid,
      keyFingerprint: kFp,
      memberCount: admitted.length,
      reason: `re-seal failed for at least one ADMITTED member — hub K NOT advanced (OLD K retained). Re-run \`cortex network secret rotate-key ${inputs.networkId} --admin-seed <p> --apply\` once the cause is fixed.`,
    };
  }

  // All members re-sealed (or inert-skipped) → advance the hub K store.
  const nextNetworks = networks.map((n, i) =>
    i === netIdx ? { ...n, encryption: n.encryption ?? "enabled", payload_key: kB64, payload_key_id: newKid } : n,
  );
  try {
    await ports.keyStore.writeNetworks(nextNetworks);
  } catch (err) {
    return {
      ok: false,
      applied: true,
      networkId: inputs.networkId,
      steps,
      data,
      members,
      newKid,
      keyFingerprint: kFp,
      memberCount: admitted.length,
      reason:
        `all ${resealedCount.toString()} member(s) re-sealed, but advancing the hub K store failed: ${errText(err)}. ` +
        `The OLD K "${currentKid}" is still authoritative (config restored) — re-run to retry.`,
    };
  }
  steps.push(`re-sealed:  ${resealedCount.toString()}/${admitted.length.toString()} ADMITTED member(s) with kid ${newKid}`);
  steps.push(`hub K:      advanced to ${newKid} in ${ports.keyStore.configPath} (fp ${kFp})`);
  steps.push(`pickup:     ${admitted.length.toString()} member(s) must re-run \`cortex network join\` to pick up the new key`);

  return {
    ok: true,
    applied: true,
    networkId: inputs.networkId,
    steps,
    data,
    members,
    newKid,
    keyFingerprint: kFp,
    memberCount: admitted.length,
  };
}
