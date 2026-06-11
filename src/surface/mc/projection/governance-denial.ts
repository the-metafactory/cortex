/**
 * P-14 U3.1 (#936) — project U0.2's (#932) `system.access.{denied,filtered}`
 * envelopes into the governance pane's DENIALS dimension.
 *
 * U0.2 emits two access-decision envelope shapes (src/bus/system-events.ts):
 *
 *   system.access.denied   → {
 *                              principal_id, capability,
 *                              reason: { kind: <discriminator>, ...variant },
 *                              envelope_subject, envelope_id, signed_by[]
 *                            }
 *      reason.kind values (U0.2 §reason-kinds): the consumer-side fail-closed
 *      drops emit `sovereignty_model_class` / `chain_verify_failed` /
 *      `chain_verify_fault` / `originator_denied`; the C.4 / D.2 gate flavours
 *      emit `unknown_principal` / `insufficient_role` / `sovereignty_mismatch`
 *      / `peer_not_in_accept_list` / `peer_deny_list`.
 *
 *   system.access.filtered → { renderer_id, envelope_subject, reason: <enum> }
 *      reason is a flat string enum (NOT a nested record):
 *      `residency_blocked` | `model_class_blocked` | `classification_exceeds_max`.
 *
 * Stored as pipeline-level audit rows in `governance_denials` — sibling to the
 * `governance.verdict.*` projection (governance-verdict.ts). The sovereignty
 * subset of `reason_kind` is the pane's REFUSALS (db/governance.ts owns the
 * classification set so projection + summary can't drift).
 *
 * Non-throwing: a malformed payload returns null (no-op) — the renderer's
 * try/catch is the outer belt. Idempotent on envelope id (UNIQUE on
 * `envelope_id`) so a JetStream redelivery never double-inserts.
 */

import type { Database } from "bun:sqlite";

import {
  insertGovernanceDenial,
  type GovernanceDenialKind,
} from "../db/governance";

/** Minimal projectable shape — the renderer hands any validated envelope here. */
export interface ProjectableDenialEnvelope {
  id?: string;
  type: string;
  source?: string;
  payload: Record<string, unknown>;
}

export interface GovernanceDenialProjectionResult {
  kind: GovernanceDenialKind;
  reasonKind: string;
  /** Row id, or null when this envelope was already projected (redelivery). */
  rowId: string | null;
}

/**
 * Project one `system.access.{denied,filtered}` envelope. Returns null for any
 * other type (the authoritative filter — the renderer subscribes broadly), an
 * envelope missing an idempotency key, or a payload from which no `reason_kind`
 * can be extracted (malformed).
 */
export function projectGovernanceDenial(
  db: Database,
  envelope: ProjectableDenialEnvelope,
  subject?: string,
): GovernanceDenialProjectionResult | null {
  const kind = denialKind(envelope.type);
  if (kind === null) return null;

  const envelopeId = asString(envelope.id);
  if (envelopeId === null) return null; // no idempotency key — refuse to project

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  const reasonKind = reasonKindFor(kind, payload);
  if (reasonKind === null) {
    process.stderr.write(
      `[mission-control] governance-denial: ignoring ${envelope.type} — no reason kind\n`,
    );
    return null;
  }

  const { principal, stack } = subjectIdentity(subject);

  const rowId = insertGovernanceDenial(db, {
    envelopeId,
    kind,
    reasonKind,
    principalId: asString(payload.principal_id),
    capability: asString(payload.capability),
    envelopeSubject: asString(payload.envelope_subject),
    detail: detailFor(kind, payload),
    source: asString(envelope.source),
    subject: subject ?? null,
    principal,
    stack,
    payload,
  });

  return { kind, reasonKind, rowId };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function denialKind(type: string): GovernanceDenialKind | null {
  if (type === "system.access.denied") return "denied";
  if (type === "system.access.filtered") return "filtered";
  return null;
}

/**
 * `denied` carries a nested `reason: { kind }` record; `filtered` carries a
 * flat `reason` string enum. Either absence is malformed (→ null, dropped).
 */
function reasonKindFor(
  kind: GovernanceDenialKind,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "filtered") return asString(payload.reason);
  // denied — reason is the structured PolicyDenyReason record.
  const reason = payload.reason;
  if (typeof reason === "object" && reason !== null) {
    return asString((reason as Record<string, unknown>).kind);
  }
  return null;
}

/**
 * Best-effort free-form detail for the row, by variant. `denied` reasons carry
 * variant fields off `reason` (reason text, verify_reason, fault, detail);
 * `filtered` carries the dropping renderer id.
 */
function detailFor(
  kind: GovernanceDenialKind,
  payload: Record<string, unknown>,
): string | null {
  if (kind === "filtered") return asString(payload.renderer_id);
  const reason = payload.reason;
  if (typeof reason === "object" && reason !== null) {
    const r = reason as Record<string, unknown>;
    return (
      asString(r.reason) ??
      asString(r.verify_reason) ??
      asString(r.fault) ??
      asString(r.detail) ??
      asString(r.missing_capability)
    );
  }
  return null;
}

/**
 * Parse `{principal}` + optional `{stack}` from the NATS subject. Mirrors
 * governance-verdict.ts: the access domain is `system.access.{denied,filtered}`,
 * so the anchor segment is `system`:
 *   local.{principal}.system.access.{kind}            (stack-less)
 *   local.{principal}.{stack}.system.access.{kind}    (stack-ful)
 *   federated.{principal}.{stack}.system.access.{kind}
 */
function subjectIdentity(subject: string | undefined): {
  principal: string | null;
  stack: string | null;
} {
  if (!subject) return { principal: null, stack: null };
  const segments = subject.split(".");
  const sys = segments.indexOf("system");
  if (sys < 2) return { principal: null, stack: null };
  return {
    principal: segments[1] ?? null,
    stack: sys >= 3 ? (segments[2] ?? null) : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
