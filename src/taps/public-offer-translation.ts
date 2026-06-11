/**
 * CO-5 (epic cortex#939) — the **public PR-review marketplace** translation:
 * a validated GitHub **PR-opened** event on a public repo → a **public Offer**
 * for `code-review.<flavor>`.
 *
 * This module is the **Stage-1 admission tap** of ADR-0010's two-stage gate:
 * deterministic, metadata-only, pre-LLM, **at the tap**. It runs AFTER the
 * webhook's HMAC has been verified (the surface trust anchor) and decides — in
 * code, on surface-asserted trustworthy metadata ONLY (repo, sender login) —
 * whether to emit a public Offer envelope. **No Offer is published for a request
 * that fails Stage-1.** The PR's *content* (title/description/diff) is NEVER read
 * for the admission decision; it reaches the (CO-7-hardened, sandboxed,
 * least-privileged) reviewer only once the Offer is claimed.
 *
 * ## What this is, traced to design §3
 *
 *   External contributor opens a PR on a public the-metafactory/* repo
 *     → gh-webhook tap validates HMAC (done upstream)
 *     → THIS module: evaluate the metadata-only accept-predicate; if it admits,
 *       build the public Offer envelope:
 *         subject:  public.{principal}.{stack}.tasks.code-review.{flavor}
 *         type:     tasks.code-review.{flavor}
 *         originator: { identity: did:mf:github (surface), attribution: adapter-resolved }
 *         payload:  { repo, pr, reviewer, title?, … , github:{login, pr_url, diff_ref},
 *                     surface_verified:true, surface_predicate_passed:true }
 *     → a stack OFFERING code-review.{flavor} at public scope (Echo) claims it
 *       (CO-2 binds public.…tasks.code-review.>), runs the CO-7-hardened review,
 *       posts to GitHub, emits the verdict.
 *
 * ## The subject the tap publishes on (reconciliation with CONTEXT.md §Scope)
 *
 * CONTEXT.md §Scope says `public.*` carries no principal/stack segment for a
 * *requester*; design §3's `public.the-metafactory.<repo>.…` is illustrative.
 * The wire reality is the **consumer binding**: CO-2's `offeringSubjectPatterns`
 * binds the public Offer consumer on `public.{principal}.{stack}.tasks.code-review.>`
 * — the OFFERING stack's identity (the *provider*, the cryptographic signer per
 * CONTEXT.md §Stack signing identity), not the requester's (the requester is a
 * surface, carried in `originator` + the payload `github` block). So the tap MUST
 * publish on `public.{principal}.{stack}.tasks.code-review.{flavor}` to land on
 * the consumer it is feeding. This module computes exactly that subject from the
 * offering stack's `(principal, stack)`.
 *
 * ## SHIPS DARK — gated on #978 / #971 (the honest, correct outcome)
 *
 * CO-5 builds the **full mechanism end-to-end + tests**, but the LIVE public
 * switch stays correctly blocked until deferred infra lands. The chain of gates
 * (all already in `main` via CO-4 + CO-7):
 *
 *   - **M3 backend gate (#978)** — `checkPublicOfferingBackendGate`
 *     (`src/common/types/public-offering-backend-gate.ts`) REJECTS a `public`
 *     offering on a `local` execution backend at config-validation. The non-local
 *     F-5b sandbox (#978) is DEFERRED; until it lands, no production stack can
 *     even boot a public `code-review` offering. So this translation NEVER fires
 *     on a real deployment yet — there is no admitted public consumer to feed.
 *   - **M6 BudgetCheck (#977)** — `resolveComplianceOk` fail-closes a public
 *     offering with no declared cost authority to `compliance_block`.
 *   - **`compliance_block` stub (#971)** — must be hardened before go-live.
 *
 * This module is therefore **provingly inert on every live stack today**: with no
 * public `code-review` offering (default-deny ⇒ `local`), {@link
 * translatePrOpenedToOffer} resolves "not offered public" and returns
 * `{admit:false}` without building anything. It bites only once a stack offers
 * `code-review` publicly — which the M3 gate blocks until #978. Tests exercise the
 * full admitted path with a MOCK non-local backend to prove the mechanism, and
 * prove the M3 gate rejects the same config on `local` (see
 * `__tests__/public-offer-translation.test.ts` + the cortex.ts integration test).
 *
 * Pure + total: no I/O, no throw. The receiver (`gh-webhook-receiver/server.ts`)
 * is the only caller; it injects the offering + the publish callback.
 *
 * Anchors: docs/design-capability-offering.md §3 (the worked example) · §6 (M1–M6) ·
 *          docs/adr/0010-public-accept-gate-two-stage.md (DD-CO-8, two-stage gate) ·
 *          src/common/types/offering.ts (PublicPredicateSchema — the closed,
 *            metadata-only predicate union) · CONTEXT.md §Capability offering / §Scope.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import { buildBaseEnvelope } from "../bus/envelope-builder";
import type { SystemEventSource } from "../bus/system-events";
import { isUuid } from "../common/types/uuid";
import {
  resolveOffering,
  type Offering,
  type PublicAccept,
  type PublicPredicate,
} from "../common/types/offering";

/**
 * The surface DID stamped as the public Offer's `originator.identity`. The
 * public requester (a GitHub contributor) holds NO bus identity (ADR-0010
 * DD-CO-8) — the SURFACE is the trust anchor, so the originator names the
 * surface, not the contributor. The contributor's GitHub login + PR coordinates
 * are carried in the payload `github` block (surface-asserted metadata). DID
 * grammar `^did:mf:[a-z]…` is satisfied by `did:mf:github`.
 */
export const PUBLIC_SURFACE_DID = "did:mf:github";

/**
 * The `code-review` capability id family. A public Offer targets a flavored
 * capability (`code-review.typescript` for a TS PR); the base `code-review`
 * offering covers all flavors (the consumer binds `tasks.code-review.>`).
 */
export const CODE_REVIEW_CAPABILITY = "code-review";

/**
 * The surface-asserted, HMAC-validated metadata the tap extracts from a GitHub
 * `pull_request` `opened` (or `reopened`) delivery. EVERY field here is
 * trustworthy (the surface asserts it; the HMAC proves the webhook is genuine —
 * ADR-0010). The PR's free-text CONTENT (description body, diff) is deliberately
 * NOT in this shape — admission must never depend on it.
 */
export interface PrOpenedMetadata {
  /** GitHub event name (`X-GitHub-Event`). Must be `pull_request` to translate. */
  readonly event: string;
  /** GitHub action (`payload.action`). Must be `opened`/`reopened` to translate. */
  readonly action: string | undefined;
  /** `owner/repo` (surface-asserted, HMAC-proven). */
  readonly repo: string | undefined;
  /** PR number (surface-asserted). */
  readonly pr: number | undefined;
  /** Sender login (`payload.sender.login` — surface-asserted). */
  readonly sender: string | undefined;
  /**
   * The PR title. SURFACE-asserted but REQUESTER-controlled — carried through
   * to the review payload where CO-7's M1 boundary quarantines it as untrusted
   * data. NEVER used in the admission decision (it is content the attacker
   * controls).
   */
  readonly title?: string;
  /** The diff ref (head SHA or `refs/pull/{n}/head`) for the reviewer to fetch. */
  readonly diffRef?: string;
}

/** The PR-opened actions the marketplace translates. `synchronize`/`edited`/… are
 *  ignored — a public review is offered on PR OPEN (and reopen), not on every
 *  push (which would re-offer on each commit). Narrow + deterministic. */
export const TRANSLATABLE_PR_ACTIONS: readonly string[] = ["opened", "reopened"];

/**
 * The outcome of a Stage-1 admission + translation attempt.
 *   - `{admit:false, reason}` — NOT translated (not a PR-opened event, the
 *     capability isn't offered public, the metadata-only predicate refused, or
 *     required routing metadata was absent). NO Offer is published. `reason` is
 *     a machine-stable token for logging/audit (never request content).
 *   - `{admit:true, envelope, subject, flavor}` — translated. The caller
 *     publishes `envelope` on `subject` via `runtime.publishOnSubject`.
 */
export type TranslateResult =
  | { readonly admit: false; readonly reason: string }
  | {
      readonly admit: true;
      readonly envelope: Envelope;
      readonly subject: string;
      readonly flavor: string;
    };

/**
 * Inputs to {@link translatePrOpenedToOffer}. The offering stack's identity, its
 * offerings list (to resolve the `code-review` public offering), the envelope
 * source, and the surface-asserted PR metadata.
 */
export interface TranslateInput {
  /** The OFFERING stack's principal id (the provider / cryptographic signer). */
  readonly principal: string;
  /** The OFFERING stack's stack segment. */
  readonly stack: string;
  /** The stack's offerings list (`config.policy.offerings`). */
  readonly offerings: readonly Offering[] | undefined;
  /** Envelope source `{principal}.{agent}.{instance}` — same as system events. */
  readonly source: SystemEventSource;
  /** The surface-asserted PR-opened metadata (post-HMAC). */
  readonly metadata: PrOpenedMetadata;
  /** GitHub delivery id (for correlation + dedup). */
  readonly deliveryId: string;
}

/**
 * Match a `owner/repo` against a single glob pattern. The ONLY metacharacter is
 * `*`, which matches any run of characters INCLUDING `/` (it is NOT confined to
 * one path component) — so a trailing `*` (`the-metafactory/*`) matches any repo
 * under the owner, and `the-metafactory/c*` matches `the-metafactory/cortex`. We
 * implement the minimal, deterministic glob the `repo-membership` predicate
 * needs (no `**`, no `?`, no brace expansion) so there is no dependency on a
 * glob library and the match is auditable. The pattern is anchored at both ends
 * (`^…$`), so `the-metafactory/*` does NOT match `the-metafactory-evil/x` (the
 * literal `/` after the owner must be present) — no owner-boundary escape.
 *
 * Exact strings (no `*`) match literally. Case-sensitive (GitHub repo full
 * names are case-preserving; the surface asserts the canonical case).
 */
export function matchRepoGlob(repo: string, pattern: string): boolean {
  if (!pattern.includes("*")) return repo === pattern;
  // Escape every regex metachar EXCEPT `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(repo);
}

/**
 * Evaluate a public accept-predicate against surface-asserted metadata —
 * DETERMINISTIC, METADATA-ONLY (ADR-0010 DD-CO-8). The predicate union is the
 * CLOSED `PublicPredicateSchema` (`src/common/types/offering.ts`); each kind
 * keys ONLY on trustworthy surface metadata (repo, sender), NEVER on PR content.
 *
 *   - `repo-membership` — the surface repo matches one of the globs.
 *   - `sender-allow`    — the surface sender is on the allowlist.
 *   - `sender-block`    — the surface sender is NOT on the blocklist (admit the
 *                          rest in-scope).
 *   - `rate`            — STRUCTURALLY passes here (admission is identity-free);
 *                          the actual rate ceiling is the gate-floor's `rateOk`
 *                          knob (`PublicLimits`), enforced downstream — a
 *                          counting limiter is deferred (#977). Returning `true`
 *                          here keeps the predicate evaluable at the tap without
 *                          a content read; it does NOT bypass rate limiting (that
 *                          is a separate, downstream gate).
 *
 * A missing surface field the predicate needs (e.g. `sender-allow` with no
 * sender) FAILS CLOSED (returns `false`) — no admissible identity ⇒ refuse.
 *
 * Pure + total.
 */
export function evaluatePublicPredicate(
  predicate: PublicPredicate,
  metadata: Pick<PrOpenedMetadata, "repo" | "sender">,
): boolean {
  switch (predicate.kind) {
    case "repo-membership": {
      const repo = metadata.repo;
      if (repo === undefined || repo.length === 0) return false; // fail-closed.
      return predicate.repos.some((glob) => matchRepoGlob(repo, glob));
    }
    case "sender-allow": {
      const sender = metadata.sender;
      if (sender === undefined || sender.length === 0) return false; // fail-closed.
      return predicate.senders.includes(sender);
    }
    case "sender-block": {
      const sender = metadata.sender;
      if (sender === undefined || sender.length === 0) return false; // fail-closed:
      // no asserted sender ⇒ cannot prove the request is NOT a blocked sender.
      return !predicate.senders.includes(sender);
    }
    case "rate":
      // Identity-free structural pass — see the doc above. Downstream rate gate
      // (gate-floor `rateOk`) owns the actual ceiling.
      return true;
  }
}

/**
 * Derive the review flavor for a public `code-review` Offer. The marketplace
 * dogfood is TypeScript (`code-review.typescript`, design §3). A future
 * language-detection step could vary this; today it is a fixed, deterministic
 * `typescript` so the Offer subject + type are stable and the consumer's
 * `tasks.code-review.>` binding matches.
 */
function deriveFlavor(): string {
  return "typescript";
}

/**
 * The Stage-1 admission + public Offer translation (the CO-5 core).
 *
 * Returns `{admit:false}` (no Offer published) when ANY of:
 *   1. the event is not a translatable PR-opened (`pull_request` + `opened`/`reopened`);
 *   2. `code-review` is not offered at `public` scope on this stack (default-deny
 *      ⇒ the common case on every live stack — provingly inert);
 *   3. required surface routing metadata (repo, pr) is absent;
 *   4. the metadata-only accept-predicate refused (ADR-0010 — the request fell
 *      outside what the offering admits, e.g. a PR on a non-offered repo).
 *
 * Returns `{admit:true, envelope, subject, flavor}` only when all four pass.
 * The envelope is a `tasks.code-review.{flavor}` request (the same shape pilot
 * publishes for an internal review) with:
 *   - `originator` = the SURFACE (`did:mf:github`, `adapter-resolved`);
 *   - a payload that carries the review routing keys PLUS a `github` block
 *     (login, pr_url, diff_ref — surface-asserted) AND the Stage-1 proof
 *     booleans (`surface_verified`, `surface_predicate_passed`) the bus
 *     consumer's CO-4 admission reads (the ADR-0010 line: the Offer's existence
 *     IS the evidence Stage-1 passed, stamped explicitly so the consumer needn't
 *     re-derive it).
 *   - `sovereignty.classification = "public"` (the wire scope).
 *
 * The subject is `public.{principal}.{stack}.tasks.code-review.{flavor}` — the
 * provider stack's own public binding (see the file header reconciliation).
 *
 * Pure + total.
 */
export function translatePrOpenedToOffer(input: TranslateInput): TranslateResult {
  const { metadata } = input;

  // Gate 1 — must be a translatable PR-opened event. (Content-free: header +
  // action only.)
  if (metadata.event !== "pull_request") {
    return { admit: false, reason: "not_pull_request_event" };
  }
  if (metadata.action === undefined || !TRANSLATABLE_PR_ACTIONS.includes(metadata.action)) {
    return { admit: false, reason: "not_pr_opened_action" };
  }

  // Gate 2 — `code-review` must be offered at `public` scope on this stack.
  // Default-deny: with no `policy.offerings`, `resolveOffering` ⇒ `local`-only,
  // so this returns `{admit:false}` WITHOUT building anything (the provingly-
  // inert path every live stack takes today).
  const resolved = resolveOffering(CODE_REVIEW_CAPABILITY, input.offerings);
  if (!resolved.scopes.includes("public")) {
    return { admit: false, reason: "code_review_not_offered_public" };
  }
  // The public accept must be a `{kind:'surface'}` policy (the schema guarantees
  // this for a public-scoped offering, but resolve defensively rather than
  // assert — a malformed offering must refuse, never throw).
  const accept = resolved.accept;
  if (accept?.kind !== "surface") {
    return { admit: false, reason: "public_offering_missing_surface_accept" };
  }
  const publicAccept: PublicAccept = accept;

  // Gate 3 — required SURFACE routing metadata. repo + pr are the load-bearing
  // routing keys; without them there is nothing to route a review to.
  if (metadata.repo === undefined || metadata.repo.length === 0) {
    return { admit: false, reason: "missing_repo" };
  }
  if (metadata.pr === undefined || !Number.isInteger(metadata.pr) || metadata.pr <= 0) {
    return { admit: false, reason: "missing_or_invalid_pr" };
  }

  // Gate 4 — the metadata-only accept-predicate (ADR-0010 DD-CO-8). Evaluated in
  // code, on surface-asserted metadata ONLY (repo, sender) — never on PR content.
  const predicatePassed = evaluatePublicPredicate(publicAccept.predicate, {
    repo: metadata.repo,
    sender: metadata.sender,
  });
  if (!predicatePassed) {
    return { admit: false, reason: "accept_predicate_refused" };
  }

  // All four gates passed — Stage-1 ADMITS. Build the public Offer envelope.
  const flavor = deriveFlavor();
  const type = `tasks.code-review.${flavor}`;
  const subject = `public.${input.principal}.${input.stack}.${type}`;

  const envelope = buildBaseEnvelope({
    type,
    source: `${input.source.principal}.${input.source.agent}.${input.source.instance}`,
    sovereignty: {
      // The wire scope is public — the Offer is unrestricted by design.
      classification: "public",
      data_residency: input.source.dataResidency ?? "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    // GitHub delivery ids are UUIDs by contract; promote when shaped so the
    // verdict + lifecycle envelopes correlate to the originating delivery.
    ...(isUuid(input.deliveryId) && { correlationId: input.deliveryId }),
    payload: {
      // The review routing keys (the shape pilot's ReviewRequestPayload uses, so
      // the existing review consumer + CO-7 pipeline read it unchanged).
      repo: metadata.repo,
      pr: metadata.pr,
      // No named reviewer — this is an Offer (competing-consumer); any public
      // `code-review` offerer may claim it. Carried for surface rendering.
      reviewer: "public",
      ...(metadata.title !== undefined && metadata.title.length > 0 && { title: metadata.title }),
      // The surface-asserted GitHub coordinates — the requester's identity lives
      // here (ADR-0010: surface-asserted, not a bus pubkey), NOT in the subject.
      github: {
        login: metadata.sender ?? null,
        pr_url: `https://github.com/${metadata.repo}/pull/${metadata.pr}`,
        ...(metadata.diffRef !== undefined && { diff_ref: metadata.diffRef }),
      },
      // ADR-0010 line: the Offer's existence IS the proof Stage-1 passed (HMAC
      // verified + metadata predicate admitted). Stamp it EXPLICITLY so the bus
      // consumer's CO-4 gate-floor reads `surfaceVerified`/`surfacePredicatePassed`
      // off the envelope rather than re-deriving (the consumer can't re-run HMAC).
      // These are PROVIDER-asserted (the offering stack signs the envelope), not
      // attacker-controllable: a public requester cannot publish onto the bus.
      surface: publicAccept.surface,
      surface_verified: true,
      surface_predicate_passed: true,
    },
  });
  // The originator names the SURFACE (the public trust anchor), attribution
  // `adapter-resolved` (the tap mapped a non-bus surface id to the surface DID).
  envelope.originator = {
    identity: PUBLIC_SURFACE_DID,
    attribution: "adapter-resolved",
  };

  return { admit: true, envelope, subject, flavor };
}
