/**
 * G-1115 (governance upgrade Stage 5) — project `governance.verdict.*`
 * envelopes into MC.
 *
 * Pulse's governed-action stack (P-702) publishes one envelope per layer
 * verdict: `governance.verdict.{l0,tribunal,gate,resolved}`. This projection
 * stores them as pipeline-level audit rows in `governance_verdicts` — NOT
 * session-joined events (the Governance tab queries time windows + counts;
 * the working grid's session feed is the review-verdict projection's concern,
 * a different consumer).
 *
 * Layer payload shapes (pulse src/types/governed.ts + the demo publisher):
 *   l0       → { name, tool, decision: allow|ask|deny, reason, rule_index }
 *   tribunal → TribunalVerdict { name, verdict: allow|deny|defer, reason, votes, … }
 *   gate     → { name, verdict: pass|fail, notes, closed_at }
 *   resolved → GovernedResult { name, outcome: allow|deny, resolved_by, l0, … }
 *
 * Non-throwing: a malformed payload returns null (no-op) — the renderer's
 * catch is the outer belt. Idempotent on envelope id (UNIQUE on
 * `envelope_id`) so a JetStream redelivery never double-inserts.
 */

import type { Database } from "bun:sqlite";

import {
  insertGovernanceVerdict,
  type GovernanceLayer,
} from "../db/governance";

const LAYERS = new Set<GovernanceLayer>(["l0", "tribunal", "gate", "resolved"]);

/** Minimal projectable shape — the renderer hands any validated envelope here. */
export interface ProjectableGovernanceEnvelope {
  id?: string;
  type: string;
  source?: string;
  payload: Record<string, unknown>;
}

export interface GovernanceProjectionResult {
  layer: GovernanceLayer;
  decision: string;
  /** Row id, or null when this envelope was already projected (redelivery). */
  rowId: string | null;
}

/**
 * Project one `governance.verdict.*` envelope. Returns null for any
 * non-governance type (the authoritative filter — the renderer subscribes
 * broadly) or a payload missing the layer's decision field.
 */
export function projectGovernanceVerdict(
  db: Database,
  envelope: ProjectableGovernanceEnvelope,
  subject?: string,
): GovernanceProjectionResult | null {
  const layer = governanceLayer(envelope.type);
  if (layer === null) return null;

  const envelopeId = asString(envelope.id);
  if (envelopeId === null) return null; // no idempotency key — refuse to project

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  const decision = decisionFor(layer, payload);
  if (decision === null) {
    process.stderr.write(
      `[mission-control] governance-projection: ignoring ${envelope.type} — no decision field\n`,
    );
    return null;
  }

  const { principal, stack } = subjectIdentity(subject);

  const rowId = insertGovernanceVerdict(db, {
    envelopeId,
    layer,
    decision,
    name: asString(payload.name) ?? "(unnamed)",
    tool: asString(payload.tool),
    reason: reasonFor(payload),
    resolvedBy: asString(payload.resolved_by),
    source: asString(envelope.source),
    subject: subject ?? null,
    principal,
    stack,
    payload,
  });

  return { layer, decision, rowId };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function governanceLayer(type: string): GovernanceLayer | null {
  const prefix = "governance.verdict.";
  if (!type.startsWith(prefix)) return null;
  const layer = type.slice(prefix.length);
  return LAYERS.has(layer as GovernanceLayer) ? (layer as GovernanceLayer) : null;
}

/** Each layer names its ruling differently; absence means malformed. */
function decisionFor(layer: GovernanceLayer, payload: Record<string, unknown>): string | null {
  switch (layer) {
    case "l0":
      return asString(payload.decision);
    case "tribunal":
    case "gate":
      return asString(payload.verdict);
    case "resolved":
      return asString(payload.outcome);
  }
}

/** `reason` (l0/tribunal/resolved) or the gate's analyst `notes`. */
function reasonFor(payload: Record<string, unknown>): string | null {
  return asString(payload.reason) ?? asString(payload.notes);
}

/**
 * Parse `{principal}` + optional `{stack}` from the NATS subject:
 *   local.{principal}.governance.verdict.{layer}            (stack-less)
 *   local.{principal}.{stack}.governance.verdict.{layer}    (stack-ful)
 *   federated.{principal}.{stack}.governance.verdict.{layer}
 */
function subjectIdentity(subject: string | undefined): {
  principal: string | null;
  stack: string | null;
} {
  if (!subject) return { principal: null, stack: null };
  const segments = subject.split(".");
  const gov = segments.indexOf("governance");
  if (gov < 2) return { principal: null, stack: null };
  return {
    principal: segments[1] ?? null,
    stack: gov >= 3 ? (segments[2] ?? null) : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
