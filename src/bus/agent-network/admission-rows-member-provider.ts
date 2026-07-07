/**
 * MC-A2 (cortex#1276) — the **live** {@link AdmissionRowsProvider}: the
 * member-posture admission-rows read that replaces A1's `not_configured` stub.
 *
 * ## What it reads
 *
 * The registry's PoP-signed member roster endpoint, `GET
 * /networks/{network_id}/roster/member` (C-1282 / ADR-0018 Q4, DEPLOYED #1284).
 * That route releases the network's **ADMITTED** peer-roster to any caller who
 * proves possession of an ADMITTED member key for THAT network — the PoP
 * signature IS the authorization (no admin key, no allowlist). It is the
 * member-accessible sibling of the admin-gated full list, and the Q3-correct
 * source of truth for membership (ADMITTED admission rows, NOT capabilities).
 *
 * Because the endpoint serves the COMPLETE admitted roster (the same payload the
 * public `/roster` returns, ADR-0018 Q4), this provider returns
 * `scope: "complete"` — the membership verdict is authoritative. PENDING rows
 * are NOT in this payload (a member sees admitted peers, never the onboarding
 * queue); a network where THIS stack holds admin credentials and wants the
 * PENDING queue is the admin-posture path (the same `AdmissionRowsProvider`
 * seam, fed by the admin list) and is out of scope here — pending stays `[]`.
 *
 * ## PoP signing — reuse, mint nothing
 *
 * The claim `{ network_id, peer_pubkey, issued_at }` is signed with the stack's
 * OWN registered signing key (the `SU…` nkey from `stack.nkey_seed_path`, whose
 * base64 ed25519 pubkey is the registry `peer_pubkey`). Signing reuses
 * {@link signClaimWithSeed} + {@link canonicalJSON} — the SAME plumbing
 * `fetchSealedLeafSecret` uses for the `/admission-requests/mine` PoP read. No
 * key is minted; the running stack already holds this seed.
 *
 * ## DD-9 — verify the registry assertion
 *
 * The endpoint wraps the roster in a registry-`SignedAssertion`. We verify it
 * against the pinned registry pubkey ({@link verifySignedAssertion}) before
 * trusting a single principal id — a spoofed/compromised registry otherwise
 * injects arbitrary roster members. No pinned pubkey ⇒ we cannot verify ⇒
 * honest `not_configured` (never trust an unverifiable roster).
 *
 * ## Never 5xx, fail-soft (mirror A1's DD-10)
 *
 * Every failure is a typed `{ ok: false }` — the never-throw contract the A1
 * seam + the `/api/networks` handler rely on. Auth-class failures (401/403)
 * surface as `unauthorized` (a real, distinct state the pane shows honestly,
 * never masked); transport / not-found / unverifiable failures surface as
 * `unreachable`. The handler degrades either to a self-only membership rather
 * than erroring. We deliberately do NOT mask a failure with a stale cached
 * roster: on a TRUST pane, a silently-stale roster is more misleading than an
 * honest "registry unreachable" chip (the constraint's blessed alternative).
 */

import { canonicalJSON } from "../../common/registry/signing";
import { verifySignedAssertion } from "../../common/registry/verify-assertion";
import {
  signClaimWithSeed,
  type StackIdentityMaterial,
} from "../stack-provisioning";
import type {
  AdmissionRow,
  AdmissionRowsProvider,
  AdmissionRowsResult,
  AdmissionStatus,
} from "./admission-read";
import {
  verifyRosterAuthorship,
  type RosterAuthorship,
  type RosterAuthorshipMaterial,
} from "./roster-authorship";

/**
 * Injectable `fetch`, narrowed to what this provider needs. Production omits it
 * → `globalThis.fetch`; tests inject a hermetic stub. Mirrors `fetch-sealed-secret`.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Construction inputs for {@link createMemberRosterAdmissionProvider}. */
export interface MemberRosterAdmissionProviderOptions {
  /** Registry base URL (`policy.federated.registry.url`). Trailing slashes trimmed. */
  registryUrl: string;
  /**
   * Pinned registry pubkey (base64 Ed25519) for the DD-9 assertion verify
   * (`policy.federated.registry.pubkey`). When absent/empty the provider cannot
   * verify and returns `not_configured` — it NEVER trusts an unverifiable roster.
   */
  registryPubkey?: string;
  /**
   * FLG-4 / #1600 — the PINNED network-admin pubkey (base64 Ed25519) the sealed
   * row's hub-admin `{claim, signature}` is verified against. When absent, or
   * when the read carries no authorship material, per-member `authorship`
   * resolves to `"unchecked"` (honest — never a fabricated pass). No config field
   * pins this yet (residual risk in the FLG-4 PR), so this is normally undefined.
   */
  networkAdminPubkey?: string;
  /**
   * The stack's identity material — its registered `SU…` seed + base64 pubkey.
   * The pubkey is the registry `peer_pubkey`; the seed signs the PoP claim.
   * SECRET (the seed) — never logged.
   */
  material: StackIdentityMaterial;
  /** Per-request timeout (ms). Default 10s. */
  requestTimeoutMs?: number;
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Injected clock (tests). Production omits → `Date`. */
  now?: () => Date;
  /** Logger seam (CLAUDE.md "no silent catches"). Default → `process.stderr`. */
  logError?: (msg: string) => void;
}

/** One parsed roster member — `principal_id` plus the OPTIONAL FLG-4 facets. */
interface VerifiedRosterMember {
  principal_id: string;
  /** FLG-4 — the row's lifecycle status when the registry emits it (else ADMITTED). */
  admission_state?: AdmissionStatus;
  /** FLG-4 — sealed-secret delivered (boolean signal; never the ciphertext). */
  sealed?: boolean;
  /** FLG-4 — ISO-8601 UTC hub-authorize timestamp, or null. */
  hub_authorized_at?: string | null;
  /** #1600 — hub-admin authorship material (verified against the pinned admin key). */
  authorship?: RosterAuthorshipMaterial;
}

/** The verified-roster shape the member endpoint returns (admission-sourced). */
interface VerifiedRosterPayload {
  network_id: string;
  members: VerifiedRosterMember[];
}

/** The registry's `AdmissionStatus` values (guard for the optional `admission_state`). */
const ADMISSION_STATES: readonly AdmissionStatus[] = [
  "PENDING",
  "ADMITTED",
  "REJECTED",
  "REVOKED",
  "DEPARTED",
];

/** Parse a member's OPTIONAL FLG-4 authorship material, or `undefined` when absent/malformed. */
function parseAuthorshipMaterial(m: Record<string, unknown>): RosterAuthorshipMaterial | undefined {
  const claim = m.seal_claim;
  const signature = m.seal_signature;
  const hubAdmin = m.sealed_by;
  if (claim === undefined || claim === null) return undefined;
  if (typeof signature !== "string" || signature.length === 0) return undefined;
  if (typeof hubAdmin !== "string" || hubAdmin.length === 0) return undefined;
  return { claim, signature, hub_admin_pubkey: hubAdmin };
}

/**
 * Parse a DD-9-verified payload as the member roster — `{ network_id,
 * members: [{ principal_id, ...FLG-4 facets }] }`. The FLG-4 facets
 * (`admission_state`, `sealed`, `hub_authorized_at`, and the authorship material)
 * are all OPTIONAL and ADDITIVE: a pre-FLG-4 registry omits them and the member
 * simply carries `{ principal_id }`, so this stays backward-compatible. A
 * verified-but-wrong-shape payload is a wire-contract violation, not a value to
 * trust → `undefined` (caller maps to `unreachable`). Mirrors `network-client`'s
 * `parseRoster` discipline.
 */
function parseVerifiedRoster(
  payload: unknown,
  networkId: string,
): VerifiedRosterPayload | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (p.network_id !== networkId) return undefined;
  if (!Array.isArray(p.members)) return undefined;
  const members: VerifiedRosterMember[] = [];
  for (const raw of p.members) {
    if (raw === null || typeof raw !== "object") return undefined;
    const m = raw as Record<string, unknown>;
    if (typeof m.principal_id !== "string" || m.principal_id.length === 0) {
      return undefined;
    }
    const member: VerifiedRosterMember = { principal_id: m.principal_id };
    if (
      typeof m.admission_state === "string" &&
      (ADMISSION_STATES as readonly string[]).includes(m.admission_state)
    ) {
      member.admission_state = m.admission_state as AdmissionStatus;
    }
    if (typeof m.sealed === "boolean") member.sealed = m.sealed;
    if (typeof m.hub_authorized_at === "string") {
      member.hub_authorized_at = m.hub_authorized_at;
    } else if (m.hub_authorized_at === null) {
      member.hub_authorized_at = null;
    }
    const authorship = parseAuthorshipMaterial(m);
    if (authorship !== undefined) member.authorship = authorship;
    members.push(member);
  }
  return { network_id: networkId, members };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Build the live member-posture {@link AdmissionRowsProvider}. The returned
 * provider PoP-signs + reads `GET /networks/{id}/roster/member`, verifies the
 * registry assertion (DD-9), and projects the admitted roster into
 * `AdmissionRow[]` (every member `status: "ADMITTED"`, `scope: "complete"`).
 * Never throws.
 */
export function createMemberRosterAdmissionProvider(
  options: MemberRosterAdmissionProviderOptions,
): AdmissionRowsProvider {
  const url = options.registryUrl.replace(/\/+$/, "");
  const pinnedPubkey = options.registryPubkey;
  const material = options.material;
  const fetchImpl: FetchLike = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logError =
    options.logError ??
    ((msg: string) => {
      process.stderr.write(`admission-rows-member-provider: ${msg}\n`);
    });

  async function readAdmissionRows(
    networkId: string,
  ): Promise<AdmissionRowsResult> {
    // DD-9: no pinned pubkey ⇒ cannot verify ⇒ never trust the roster.
    if (pinnedPubkey === undefined || pinnedPubkey === "") {
      return {
        ok: false,
        reason: "not_configured",
        detail:
          "no pinned registry pubkey (policy.federated.registry.pubkey) — cannot verify the member roster assertion (DD-9)",
      };
    }

    // 1. Sign the PoP read claim with the stack's OWN registered seed.
    const claim = {
      network_id: networkId,
      peer_pubkey: material.pubkeyB64,
      issued_at: now().toISOString(),
    };
    let header: string;
    try {
      const sig = await signClaimWithSeed(
        material.seed,
        new TextEncoder().encode(canonicalJSON(claim)),
      );
      header = JSON.stringify({ claim, signature: sig });
    } catch (err) {
      logError(
        `failed to sign PoP read claim for "${networkId}": ${errText(err)}`,
      );
      return {
        ok: false,
        reason: "unreachable",
        detail: `failed to sign PoP read claim: ${errText(err)}`,
      };
    }

    // 2. GET the member roster endpoint (PoP header is the authorization).
    const endpoint = `${url}/networks/${encodeURIComponent(networkId)}/roster/member`;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await fetchImpl(endpoint, {
        method: "GET",
        headers: { "Content-Type": "application/json", "x-pop-signed": header },
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `timed out after ${requestTimeoutMs.toString()}ms`
          : errText(err);
      logError(`GET ${endpoint} failed: ${reason}`);
      return { ok: false, reason: "unreachable", detail: `member roster read errored: ${reason}` };
    } finally {
      clearTimeout(timeoutHandle);
    }

    // 3. Map the HTTP status. 401/403 are a REAL authorization state (not this
    //    stack's key, or not an admitted member) — surfaced as `unauthorized`,
    //    distinct from transport `unreachable`. Everything else degrades to
    //    `unreachable` so the network still renders self-only.
    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        detail: `registry refused the member roster read (HTTP ${resp.status.toString()}) — this stack is not an admitted member of "${networkId}"`,
      };
    }
    if (!resp.ok) {
      logError(`GET ${endpoint} returned HTTP ${resp.status.toString()}`);
      return {
        ok: false,
        reason: "unreachable",
        detail: `member roster read failed (HTTP ${resp.status.toString()})`,
      };
    }

    // 4. Parse + DD-9 verify the registry assertion before trusting any member.
    let rawBody: unknown;
    try {
      rawBody = await resp.json();
    } catch (err) {
      logError(`GET ${endpoint} JSON parse failed: ${errText(err)}`);
      return { ok: false, reason: "unreachable", detail: "member roster response was not JSON" };
    }
    const verified = await verifySignedAssertion(rawBody, pinnedPubkey);
    if (verified.kind !== "ok") {
      logError(
        `member roster assertion did not verify for "${networkId}" (${verified.kind}); rejecting (DD-9)`,
      );
      return {
        ok: false,
        reason: "unreachable",
        detail: `member roster assertion failed DD-9 verification (${verified.kind})`,
      };
    }

    // 5. Shape-validate + project ADMITTED members → AdmissionRow[].
    const roster = parseVerifiedRoster(verified.payload, networkId);
    if (roster === undefined) {
      logError(`member roster payload shape invalid for "${networkId}"; rejecting`);
      return {
        ok: false,
        reason: "unreachable",
        detail: "member roster payload was not a valid roster shape",
      };
    }
    // FLG-4 — project each member into an AdmissionRow, carrying the OPTIONAL
    // state facets. The member-read serves the ADMITTED roster, so `status`
    // defaults to ADMITTED unless the registry emits an explicit `admission_state`.
    // #1600 — resolve authorship per member: verify the hub-admin {claim,
    // signature} (when present) against the pinned network-admin pubkey. Absent
    // material or no pinned key ⇒ "unchecked" (honest — never a fabricated pass).
    const rows: AdmissionRow[] = await Promise.all(
      roster.members.map(async (m): Promise<AdmissionRow> => {
        const authorship: RosterAuthorship = await verifyRosterAuthorship(
          m.authorship,
          options.networkAdminPubkey,
        );
        return {
          principal_id: m.principal_id,
          network_id: networkId,
          status: m.admission_state ?? "ADMITTED",
          ...(m.sealed !== undefined && { sealed: m.sealed }),
          ...(m.hub_authorized_at !== undefined && {
            hub_authorized_at: m.hub_authorized_at,
          }),
          authorship,
        };
      }),
    );
    return { ok: true, rows, scope: "complete" };
  }

  return { readAdmissionRows };
}

/** Error → message, never echoing secret-bearing inputs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
