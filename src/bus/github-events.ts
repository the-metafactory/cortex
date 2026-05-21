/**
 * MIG-5.6 (C-106) — `github.*` envelope constructor for GitHub webhook events.
 *
 * Per plan §4 MIG-5.6 + cortex#37: HMAC-validated GitHub webhooks must surface
 * on the bus as `local.{principal}.github.{event}.{action}` envelopes so any sibling
 * agent / surface can subscribe (dashboard projection, pilot review router,
 * cortex worklog hints, future renderers).
 *
 * **Subject derivation** (mirrors `bus/system-events.ts` + `bus/dispatch-events.ts`):
 *   - `envelope.type` is the dotted `github.{event}.{action}` form.
 *   - `MyelinRuntime.publish` prepends `local.{principal}.` at publish time, so the
 *     final NATS subject is `local.{principal}.github.{event}.{action}` without
 *     callers having to assemble it.
 *   - When the GitHub event has no natural `action` (e.g. `push`, `ping`,
 *     `release` payloads that don't carry an `action` field), the helper
 *     emits `github.{event}.received` so the type always has the
 *     `domain.entity.action` triplet the schema requires (pattern allows
 *     2-5 segments, but 3 is the canonical shape and keeps wildcard subs
 *     stable: `local.{principal}.github.>` matches everything; `local.{principal}.github.{event}.>`
 *     matches all actions for an event).
 *
 * **Shape contract** (consistent with the rule-of-three established by
 * system-events / dispatch-events / cc-events):
 *   - `id` is a fresh `crypto.randomUUID()` per call.
 *   - `timestamp` is the helper-call time (ISO 8601). The webhook delivery
 *     timestamp (if available via `X-GitHub-Delivery` parsing or payload
 *     fields) lives in `payload` so envelope `timestamp` always reflects
 *     emit time — same convention as `system-events.ts`.
 *   - `source` is the dotted `{principal}.{agent}.{instance}` form.
 *   - `correlation_id` is set to the GitHub delivery ID **only when it is
 *     UUID-shaped**. GitHub delivery IDs *are* UUIDs (e.g.
 *     `12345678-1234-1234-1234-123456789012`), so this is the normal path —
 *     but the check is defensive in case GitHub ever changes the format,
 *     since the myelin envelope schema (G-1100.B) constrains
 *     `correlation_id` to UUID. Non-UUID delivery IDs fall through to
 *     `payload.delivery_id` only.
 *   - `sovereignty` defaults to `local-only / max_hop=0 / frontier_ok=false /
 *     model_class=local-only`. Same rationale as `system.*` and `dispatch.*`:
 *     a webhook payload includes repo names, commit messages, PR titles,
 *     issue bodies — operator-relevant content that has no business being
 *     federated outside the org or processed by frontier models without an
 *     explicit upgrade decision. `data_residency` is parameterised on the
 *     source struct so non-NZ operators get accurate residency stamps.
 *
 * **What this file is NOT:**
 *   - NOT a webhook receiver. The HTTP entry-point that calls this helper
 *     lives at `src/taps/gh-webhook-receiver/server.ts` (the local server
 *     cortex.ts stands up) and at `src/taps/gh-webhook/src/index.ts` (the
 *     CF Worker edge proxy). This file is a pure helper.
 *   - NOT a payload sanitiser / redactor. GitHub webhook payloads can
 *     contain user-authored content (issue bodies, PR descriptions, commit
 *     messages) that *might* warrant redaction before federation; that
 *     concern lives in a payload-filter at the publish site (per
 *     `bus/payload-filter.ts` pattern). Here we shape the envelope; the
 *     filter (when needed) trims the payload before the publish call.
 *   - NOT a HMAC verifier. That lives in the receiver (re-verified locally
 *     as defense-in-depth even after the Worker validated upstream).
 *   - NOT a Worker file. This module imports from `bus/envelope-builder.ts`
 *     which uses `crypto.randomUUID()` — safe in both Node/Bun and CF Workers
 *     but the file is only imported from the local cortex process today.
 */

import type { Classification, Envelope } from "./myelin/envelope-validator";
import { buildBaseEnvelope } from "./envelope-builder";
import type { SystemEventSource } from "./system-events";
import { isUuid } from "../common/types/uuid";

/**
 * Re-export `SystemEventSource` under a domain-neutral alias so callers in
 * `taps/gh-webhook-receiver/` import from one place. Same ergonomic
 * shortcut as `DispatchEventSource` in `bus/dispatch-events.ts`.
 */
export type GithubEventSource = SystemEventSource;

function buildSource(src: SystemEventSource): string {
  return `${src.org}.${src.agent}.${src.instance}`;
}

/**
 * Default sovereignty for `github.*` events. Operator-only by default / local
 * residency / no frontier — webhook payloads may carry PII (committer email,
 * issue bodies) and federating them outside the org is an explicit decision,
 * not a default.
 *
 * `data_residency` is sourced from `source.dataResidency` (defaulting to
 * `"NZ"`) so a non-NZ operator gets envelopes stamped with their actual
 * residency without per-call overrides.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Callers may opt into
 * `"federated"` or `"public"` when a GitHub event has been explicitly
 * deemed shareable beyond the org boundary (e.g. a public-repo PR-merged
 * event that powers a cross-org community dashboard). Default preserves
 * the prior operator-private posture.
 */
function defaultGithubSovereignty(
  source: SystemEventSource,
  classification: Classification = "local",
): Envelope["sovereignty"] {
  return {
    classification,
    data_residency: source.dataResidency ?? "NZ",
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

// cortex#196 — strict UUID check (`isUuid`) is shared in
// `src/common/types/uuid.ts`. Same v1-v5 grammar previously
// inlined here.

/**
 * Sanitize a free-form segment for use inside `envelope.type`. The schema
 * pattern requires `[a-z][a-z0-9-]*` per segment — GitHub event names already
 * conform (`pull_request` has an underscore which DOES NOT match the
 * `[a-z0-9-]` charset, so we map `_` → `-`). Mixed case is lowercased.
 *
 * Exported for testability; callers should use `createGithubEventEnvelope`
 * directly rather than wiring this themselves.
 */
export function sanitizeTypeSegment(value: string): string {
  // Lowercase + replace any char outside [a-z0-9-] with `-`. Collapse
  // runs of `-`. Strip leading/trailing `-`. The leading-char rule in the
  // schema pattern (`^[a-z]`) is satisfied by the GitHub event/action
  // vocabulary — `pull_request`, `issue_comment`, `opened`, etc. — which
  // all start with a letter. The trailing-strip is belt-and-braces for
  // future GitHub event names.
  const lower = value.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9-]+/g, "-");
  return replaced.replace(/^-+|-+$/g, "");
}

export interface CreateGithubEventEnvelopeOpts {
  /**
   * Envelope source — `{principal}.{agent}.{instance}` per schema. Callers (the
   * webhook receiver wired in cortex.ts) pass the same `systemEventSource`
   * the rest of the bus uses, so all envelopes from one cortex process
   * carry identical `source` strings.
   */
  source: GithubEventSource;
  /**
   * GitHub event name from the `X-GitHub-Event` header — `push`, `issues`,
   * `pull_request`, `issue_comment`, `release`, `ping`, etc. The helper
   * sanitises the value for use in `envelope.type`.
   */
  event: string;
  /**
   * GitHub action (e.g. `opened`, `closed`, `synchronize` for `pull_request`;
   * `created`, `edited`, `deleted` for `issue_comment`). Many GitHub events
   * carry the action inside the payload body (`payload.action`), not the
   * headers. The helper accepts it explicitly so the caller doesn't have to
   * type-narrow the payload here.
   *
   * Optional: events without a natural action (e.g. `push`, `ping`) get
   * `"received"` as a synthetic action so the envelope type always carries
   * a 3-segment shape (`github.{event}.received`). This keeps the subject
   * stable for subscribers — wildcard pattern `local.{principal}.github.{event}.>`
   * matches both action-bearing and action-less events.
   */
  action?: string;
  /**
   * The parsed JSON payload from the GitHub webhook body. Goes straight
   * into `envelope.payload.body` so subscribers can read the original
   * fields (`repository.full_name`, `sender.login`, etc.) without re-parsing.
   *
   * **Caller responsibility:** the body is included verbatim. If a future
   * iteration adds payload redaction (committer emails, etc.), it goes
   * through `bus/payload-filter.ts` before reaching this helper — same
   * pattern as `cc-events.ts`.
   */
  payload: Record<string, unknown>;
  /**
   * GitHub delivery ID from `X-GitHub-Delivery` (UUID format per GitHub's
   * API contract). Promoted to `envelope.correlation_id` when UUID-shaped;
   * always present in `envelope.payload.delivery_id` so subscribers can
   * deduplicate even if it isn't UUID-shaped.
   */
  deliveryId: string;
  /**
   * Optional repo full name (`owner/repo`) for surfaces that filter on it.
   * The receiver typically extracts this from `payload.repository.full_name`
   * before calling this helper; passing it explicitly avoids re-parsing
   * the payload in subscribers.
   */
  repo?: string;
  /**
   * Optional sender login from `payload.sender.login`. Same rationale as
   * `repo` — exposed at the top of the payload for filters.
   */
  sender?: string;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"`. GitHub webhook payloads can carry user-authored content
   * (PR titles, issue bodies, committer emails); operator-private is the
   * sensible default. Set `"federated"` only when an explicit operator
   * decision has scoped the event for cross-org consumption (e.g. an
   * open-source repo's release event powering a federated changelog
   * dashboard). Mismatch with the publish-time subject is a protocol
   * violation (see {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
}

/**
 * Construct a `github.{event}.{action}` envelope from a validated GitHub
 * webhook delivery. See file header for the shape contract.
 *
 * **Validation:** does NOT call `validateEnvelope` here — same convention as
 * the other envelope builders. If a future hardening pass requires
 * pre-publish validation, it lives at the runtime layer (one place, one
 * decision), not per-helper. Tests in `__tests__/github-events.test.ts`
 * assert that constructed envelopes pass the schema.
 *
 * **Action defaulting:** when `opts.action` is omitted or empty after
 * sanitisation, the envelope type uses `"received"` so the type always has
 * 3 segments. This is a normalisation step, not a guess — pass the action
 * verbatim when one exists (`opts.action = payload.action`); pass
 * `undefined` for events without an action concept.
 */
export function createGithubEventEnvelope(
  opts: CreateGithubEventEnvelopeOpts,
): Envelope {
  const eventSegment = sanitizeTypeSegment(opts.event);
  const rawAction = opts.action ? sanitizeTypeSegment(opts.action) : "";
  const actionSegment = rawAction.length > 0 ? rawAction : "received";
  const type = `github.${eventSegment}.${actionSegment}`;

  return buildBaseEnvelope({
    type,
    source: buildSource(opts.source),
    sovereignty: defaultGithubSovereignty(opts.source, opts.classification),
    // GitHub delivery IDs are UUIDs by contract; only promote when shape
    // matches, matching the cc-events helper's defensive pattern.
    ...(isUuid(opts.deliveryId) && { correlationId: opts.deliveryId }),
    payload: {
      delivery_id: opts.deliveryId,
      event: opts.event,
      ...(opts.action !== undefined && { action: opts.action }),
      ...(opts.repo !== undefined && { repo: opts.repo }),
      ...(opts.sender !== undefined && { sender: opts.sender }),
      // The original webhook JSON, untouched. Spread last so the wrapper
      // metadata above (`delivery_id`, `event`, `action`, etc.) takes
      // precedence on any name collision — keeps the envelope-level
      // contract stable regardless of what GitHub puts in the body.
      body: opts.payload,
    },
  });
}
