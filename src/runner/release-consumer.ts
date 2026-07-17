/**
 * cortex#835 F-4.1 — `release-consumer.ts`
 *
 * **The gated release-cut capability consumer.** The mirror of
 * `src/bus/review-consumer.ts` (the reference Offer consumer) for the
 * `release.cut` capability: a JetStream pull consumer that claims
 * `tasks.release.cut` Offer envelopes, runs the VERSIONING + RELEASE-CUT
 * SOPs (`compass/sops/versioning.md` 4-step + `release-checklist.md`
 * pre-deploy gates), and emits the cortex dispatch lifecycle envelopes back
 * onto the bus.
 *
 * Anchors:
 *   - `docs/design-agentic-dev-pipeline.md`
 *       §3.1   — release-agent row (`release.cut` capability, gated).
 *       §3.5   — the gate table: release/deploy is **ALWAYS-HUMAN** for prod.
 *       F-4    — "Encode versioning/deployment/release-checklist SOPs as a
 *                 gated consumer; announcements via the gateway."
 *   - `compass/sops/versioning.md` — the 4-step release workflow this consumer
 *       encodes: bump manifest → chore commit → push default branch →
 *       `gh release create --generate-notes`.
 *   - `compass/sops/release-checklist.md` — the pre-deploy gates the consumer
 *       verifies as preconditions (clean default branch, checks green).
 *
 * **Scope carve-out — this consumer encodes VERSIONING + RELEASE-CUT ONLY.**
 * It does NOT deploy. Deployment (`arc upgrade`, `wrangler deploy`) stays a
 * separate, human-run step per design §3.5 (release/deploy is always-human for
 * prod). The consumer's terminal success is "the GitHub release exists" — the
 * release URL — never "the release is live in production".
 *
 * **The ALWAYS-HUMAN principal-grant gate (the load-bearing contract).**
 * Cutting a release is a principal-held authority. The consumer REFUSES every
 * claim that does not carry an explicit principal-grant marker on the task
 * envelope (`payload.approved_by`, set by the dispatching H-gate per §3.5).
 * An ungranted claim fails CLOSED as `wont_do` (reason: "release gate is
 * principal-held") — a permanent `term` ack. There is no auto-grant, no env
 * override, no "dev-env exception" inside the consumer: the gate is the whole
 * point of the consumer existing as a capability rather than a cron job.
 *
 * **Trust model (v1 — presence-only, NOT cryptographic).** `approved_by` is a
 * PRESENCE marker, not a proof of authenticity. The envelope says whatever it
 * says: any principal who can publish to
 * `local.{principal}.{stack}.tasks.release.cut` can set `approved_by: "andreas"`
 * with no cryptographic proof. The grant's authenticity therefore rests ENTIRELY
 * on the NATS account credentials controlling who may publish to this gate's
 * subject — this is the documented v1 assumption. The path to a
 * cryptographically-proven grant is the cortex trust track (signing enforcement
 * TC-0/1/2); until that lands the consumer trusts the transport's account ACLs.
 *
 * **Failure-reason → ack/nak/term mapping (mirrors review-consumer's table):**
 *
 * | Outcome                                          | wire envelope          | JetStream control                  |
 * |--------------------------------------------------|------------------------|------------------------------------|
 * | release cut (manifest bumped + release created)  | `dispatch.task.completed` | `ack`                           |
 * | ungranted claim (no principal-grant marker)      | `dispatch.task.failed` | `term` (`wont_do`, permanent)      |
 * | bad subject / bad payload / no capability        | `dispatch.task.failed` | `term` (`cant_do`, permanent)      |
 * | precondition failed (dirty branch / red checks / no manifest) | `dispatch.task.failed` | `term` (`cant_do`, permanent — a named precondition) |
 * | maxConcurrent reached                            | `dispatch.task.failed` | `nak(retry_after_ms)` (`not_now`)  |
 * | executor throws unexpectedly (defensive)         | `dispatch.task.failed` | `nak(0)` (transient)               |
 * | Redelivery > 1 (BEFORE executor)                 | `dispatch.task.aborted`| continues; AckDecision per executor |
 *
 * **Seams — tests NEVER touch real git/gh.** Every side-effecting operation
 * (read default-branch status, read CI checks, locate + read + write the
 * version manifest, commit, push, create the release) flows through the
 * injected {@link ReleaseExecutor}. Production wires a real forge/command
 * executor; the F-4.1 slice ships the consumer + a `null`-safe default that
 * keeps the consumer dormant when no executor is configured. The CC pipeline
 * seam the review-consumer uses is deliberately ABSENT here: a release cut is
 * deterministic SOP execution, not an LLM task (the cortex#491
 * deterministic-surface-formatting rule applied to the release lane).
 *
 * **Anti-scope:**
 *   - NOT a deployer — see the scope carve-out above.
 *   - NOT a registry — the single-agent capability check matches review-consumer.
 *   - NOT a renderer — emitted lifecycle envelopes flow through the existing
 *     surface-router fan-out; the announce step is the gateway's job downstream.
 *   - NOT federated — release is a same-principal authority (local subject scope
 *     only); cross-principal release-cut is explicitly out of scope for F-4.1.
 */

import type { JsMsg } from "nats";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinSubscriber, AckDecision } from "../bus/myelin/subscriber";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskAbortedEvent,
  type DispatchEventSource,
  type DispatchTaskFailedReason,
} from "../bus/dispatch-events";
import type { GateFloorDecision } from "../bus/gate-floor";
import { anyAdvertisedSegmentPrefixMatches } from "../common/types/capability-window";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * CO-2/CO-4 (epic cortex#939) — the per-offer-scope ADMISSION GATE seam for the
 * release lane (the structural twin of `bus/review-consumer.ts`'s
 * `OfferAdmissionGate`). Given an inbound envelope + the subject it arrived on,
 * returns the gate-floor decision for the offer-scope that subject's prefix
 * denotes. Production wires `admitOfferedDispatch` (CO-4); omit to disable.
 *
 * BYTE-IDENTICAL: a `local.` subject (the only scope bound with no
 * `policy.offerings`) admits unconditionally, so the gate is inert today; it
 * bites only on the `federated.`/`public.` subjects CO-2 newly binds.
 */
export type ReleaseOfferAdmissionGate = (
  envelope: Envelope,
  subject: string,
) => GateFloorDecision;

/**
 * Minimal snapshot of the cortex.yaml `agents[]` data the consumer needs —
 * the release-lane mirror of `ReviewConsumerAgent`. Kept narrow so tests can
 * build a fixture without the full Zod-validated `Agent` shape.
 */
export interface ReleaseConsumerAgent {
  /** Logical agent id (e.g. `"forge"`). Stamped onto every emitted envelope. */
  id: string;
  /**
   * Capability ids this agent claims, e.g. `["release.cut", "release"]`.
   * The consumer claims a `tasks.release.cut` request when the agent declares
   * the exact `release.cut` capability OR the generic `release` capability.
   */
  capabilities: readonly string[];
  /**
   * Optional per-agent `maxConcurrent`. The default is **1** for the release
   * lane (the task spec's `maxConcurrent 1`): two concurrent release cuts on
   * one repo would race the manifest bump + push. When undefined, the consumer
   * still applies the release-lane default of 1 (unlike review-consumer, which
   * treats undefined as unbounded — a release cut is never safe to fan out).
   */
  maxConcurrent?: number;
}

/** Semantic-version bump kind, per `compass/sops/versioning.md`. */
export type VersionBumpKind = "patch" | "minor" | "major";

/**
 * Canonical, validated `tasks.release.cut` request payload. The wire payload
 * is normalised to this shape by {@link parseReleaseRequestPayload} before the
 * executor ever sees it.
 */
export interface ReleaseRequestPayload {
  /** Target repo, `owner/name` form (e.g. `the-metafactory/cortex`). */
  repo: string;
  /** Semantic-version bump kind. */
  bump: VersionBumpKind;
  /**
   * The principal-grant marker (§3.5 ALWAYS-HUMAN gate). Present ONLY when the
   * dispatching H-gate granted the cut; the consumer REFUSES (`wont_do`) when
   * it is absent. Carries the granting principal's id for the audit trail +
   * the commit/release attribution. Non-empty string when granted.
   */
  approvedBy?: string;
  /** Optional free-form refs (issue/PR numbers, design §) for the audit trail. */
  refs?: readonly string[];
}

/**
 * Default `maxConcurrent` for the release lane. A release cut mutates the
 * default branch (bump commit + push); two in flight on one repo race the
 * push. The lane is serialised — `maxConcurrent` defaults to this even when
 * the agent config omits it (the divergence from review-consumer's unbounded
 * default is deliberate and documented on {@link ReleaseConsumerAgent}).
 */
export const RELEASE_LANE_MAX_CONCURRENT = 1;

/**
 * The named preconditions the consumer verifies BEFORE mutating anything, per
 * `release-checklist.md` Phase 1. A failed precondition is a `cant_do` whose
 * `detail` names WHICH gate tripped, so a principal grepping stderr /
 * dead-letter sees `dirty_default_branch` / `checks_not_green` /
 * `manifest_not_found` without cross-referencing tables.
 */
export type ReleasePrecondition =
  | "dirty_default_branch"
  | "checks_not_green"
  | "manifest_not_found";

/** Status of the repo's default branch — the `release-checklist.md` "clean branch" gate. */
export interface DefaultBranchStatus {
  /** Branch name (`main` for cortex). Echoed into the commit/push step. */
  branch: string;
  /** True when the working tree + index are clean (nothing to stash, no drift). */
  clean: boolean;
}

/** Aggregate CI status — the `release-checklist.md` "all checks green" gate. */
export interface ChecksStatus {
  /** True when every required check on the default branch's head is green. */
  allGreen: boolean;
  /** Optional human-readable summary of failing checks (for the failure detail). */
  summary?: string;
}

/** A located version manifest — `arc-manifest.yaml` / `package.json` per repo convention. */
export interface VersionManifest {
  /** Absolute (or repo-relative) path to the manifest file. */
  path: string;
  /** Current `version` value read from the manifest. */
  currentVersion: string;
}

/** The outcome of a successful release cut — the terminal `completed` payload. */
export interface ReleaseCutResult {
  /** The version the manifest was bumped TO (e.g. `v5.5.1`). */
  version: string;
  /** The `gh release create` URL — the load-bearing success artifact. */
  releaseUrl: string;
}

/**
 * The single injected seam through which EVERY side effect flows. Production
 * wires a real forge/command executor (git + gh); tests inject a recording
 * double so no real git/gh runs. The methods are ordered as the SOP runs them:
 * verify preconditions, then mutate.
 *
 * Returned as an injectable object (rather than the consumer importing git/gh
 * helpers directly) for the same reason review-consumer injects its
 * `pipelineRunner`: the consumer stays decoupled from the execution mechanism
 * and unit-testable without a real repo.
 */
export interface ReleaseExecutor {
  /**
   * Read the default-branch cleanliness status — `release-checklist.md`
   * "confirmed you are on the correct branch" + clean-tree gate.
   */
  getDefaultBranchStatus(repo: string): Promise<DefaultBranchStatus>;
  /**
   * Read the aggregate CI status for the default-branch head —
   * `release-checklist.md` Phase 1.2 "all checks must pass".
   */
  getChecksStatus(repo: string): Promise<ChecksStatus>;
  /**
   * Locate + read the version manifest per the repo convention
   * (`arc-manifest.yaml` for arc-managed repos, else `package.json`).
   * Returns `null` when no manifest can be located → `manifest_not_found`.
   */
  locateVersionManifest(repo: string): Promise<VersionManifest | null>;
  /**
   * Compute the next version from the current + bump kind, write it to the
   * manifest, create the conventional `chore:` bump commit, push the default
   * branch, and run `gh release create --generate-notes`. Returns the cut
   * result (version + release URL). The grant marker is threaded through for
   * commit/release attribution.
   *
   * This is the single MUTATING call — kept as one method so the consumer
   * never holds a half-applied release (the executor owns the bump→commit→
   * push→release atomicity per `versioning.md`).
   */
  cutRelease(input: {
    repo: string;
    manifest: VersionManifest;
    bump: VersionBumpKind;
    branch: string;
    approvedBy: string;
    refs?: readonly string[];
  }): Promise<ReleaseCutResult>;
}

// W5.0 (cortex#924) — SIGNED-COMMIT CONTRACT for any production `ReleaseExecutor`.
//
// The `release.cut` bump commit MUST be signed; signing is NEVER disabled.
// The production executor (deferred — F-4.1 ships dormant, no executor) MUST,
// before pushing the default branch:
//   1. `assertSigningConfig(...)` over the release env/git-config — refuse if
//      `commit.gpgsign != true`, no `user.signingkey`, or (ssh signer) no
//      `SSH_AUTH_SOCK` (the `ssh-add --apple-load-keychain` step must have run).
//   2. create the bump commit WITHOUT `--no-gpg-sign` (never disable signing),
//      then `readCommitSignatures(...)` over the pushed range and refuse the
//      push on any commit whose `%G?` trust is not `G`.
// Both verbs live in `./commit-signing.ts` so the dev-loop forge and the
// release executor enforce signing from ONE source. See
// `docs/design-merge-policy-w5.0.md` (pilot) §4 for the cross-repo rationale.
//
// This is a contract note, not a runtime hook, because F-4.1 has no production
// executor to instrument yet; the dev.implement forge enforces the SAME policy
// today (`dev-consumer-boot.ts`). The follow-up that wires the real executor
// wires these two calls.

/**
 * Construction options. Every dependency is injected — no module-scope
 * singletons, no env-derived defaults (mirrors `ReviewConsumerOpts`).
 */
export interface ReleaseConsumerOpts {
  /** The agent this consumer serves. One consumer per agent. */
  agent: ReleaseConsumerAgent;
  /** Envelope source (`{principal}.{agent}.{instance}`) for lifecycle envelopes. */
  source: DispatchEventSource;
  /** The myelin runtime — used for `publish` (lifecycle envelopes). */
  runtime: MyelinRuntime;
  /**
   * The injected SOP executor (forge + command seams). When `undefined`, the
   * consumer treats every claim as `cant_do` (no executor configured) — the
   * release lane is dormant-but-present, exactly like a review consumer whose
   * runtime is disabled. Production wires a real executor.
   */
  executor?: ReleaseExecutor;
  /**
   * CO-2/CO-4 (epic cortex#939) — the per-offer-scope admission gate. Runs
   * after the redelivery/subject/payload checks, before the capability gate.
   * Omit to disable (the default — byte-identical to pre-CO-2). See
   * {@link ReleaseOfferAdmissionGate}.
   */
  offerAdmission?: ReleaseOfferAdmissionGate;
  /** Test seam — clock. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

/**
 * Options for {@link ReleaseConsumer.start} when binding to a real JetStream
 * pull consumer. The consumer MUST already exist on the server (binds, does
 * NOT provision) — same contract as `ReviewConsumerStartOpts`.
 */
export interface ReleaseConsumerStartOpts {
  /** Subject pattern, e.g. `local.{principal}.{stack}.tasks.release.cut`. */
  pattern: string;
  /** JetStream stream name carrying the bound consumer. */
  stream: string;
  /** Durable consumer name. */
  durable: string;
  maxMessages?: number;
  expiresMs?: number;
  thresholdMessages?: number;
}

/**
 * Boot/log info the consumer produces — the release-lane mirror of
 * `ReviewConsumerStartedInfo`. `subscribed` distinguishes a live subscription
 * from a dormant one (runtime disabled / `subscribePull` returned null) so the
 * boot path logs "ready" vs "DORMANT" honestly.
 */
export interface ReleaseConsumerStartedInfo {
  agentId: string;
  subscribed: boolean;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Per-agent capability-dispatch release-cut consumer.
 *
 * Lifecycle mirrors `ReviewConsumer`:
 *   1. `new ReleaseConsumer(opts)` — registers nothing; does NOT subscribe.
 *   2. `await consumer.start({...})` — opens the pull subscription (or stays
 *      dormant when the runtime declines).
 *   3. `await consumer.stop()` — drains in-flight cuts; idempotent.
 *
 * Tests drive `processEnvelope` directly (returns the full `AckDecision`)
 * without standing up JetStream.
 */
export class ReleaseConsumer {
  readonly agent: ReleaseConsumerAgent;
  /** Effective per-agent concurrency cap (release-lane default = 1). */
  readonly maxConcurrent: number;

  private readonly source: DispatchEventSource;
  private readonly runtime: MyelinRuntime;
  private readonly executor: ReleaseExecutor | undefined;
  /** CO-2/CO-4 — per-offer-scope admission gate. Undefined disables the gate. */
  private readonly offerAdmission: ReleaseOfferAdmissionGate | undefined;
  private readonly clock: () => Date;

  /** Promises for in-flight cuts so `stop()` can drain. */
  private readonly inFlight = new Set<Promise<void>>();

  private subscriber: MyelinSubscriber | null = null;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: ReleaseConsumerOpts) {
    this.agent = opts.agent;
    this.source = opts.source;
    this.runtime = opts.runtime;
    this.executor = opts.executor;
    this.offerAdmission = opts.offerAdmission;
    this.clock = opts.clock ?? (() => new Date());
    // Release lane is serialised by default — `maxConcurrent` falls back to 1
    // even when the agent config omits it (see ReleaseConsumerAgent doc).
    this.maxConcurrent = opts.agent.maxConcurrent ?? RELEASE_LANE_MAX_CONCURRENT;
  }

  /**
   * Bind to a JetStream pull consumer. Returns once the subscriber is `ready`,
   * or `{ subscribed: false }` when the runtime declines (disabled / no
   * `subscribePull` helper). Mirrors `ReviewConsumer.start`.
   */
  async start(opts: ReleaseConsumerStartOpts): Promise<ReleaseConsumerStartedInfo> {
    if (this.subscriber !== null) {
      throw new Error(
        `release-consumer: already started for agent="${this.agent.id}"`,
      );
    }
    const subscribePullOpts: {
      pattern: string;
      stream: string;
      durable: string;
      onEnvelope: (envelope: Envelope, subject: string) => Promise<AckDecision>;
      maxMessages?: number;
      expiresMs?: number;
      thresholdMessages?: number;
    } = {
      pattern: opts.pattern,
      stream: opts.stream,
      durable: opts.durable,
      onEnvelope: async (envelope, subject) =>
        this.processEnvelope(envelope, subject, null),
    };
    if (opts.maxMessages !== undefined) subscribePullOpts.maxMessages = opts.maxMessages;
    if (opts.expiresMs !== undefined) subscribePullOpts.expiresMs = opts.expiresMs;
    if (opts.thresholdMessages !== undefined) {
      subscribePullOpts.thresholdMessages = opts.thresholdMessages;
    }
    // `subscribePull` is OPTIONAL on MyelinRuntime (legacy stubs must satisfy
    // the interface byte-identically). Treat undefined like a null return: the
    // consumer stays dormant.
    const sub = this.runtime.subscribePull
      ? this.runtime.subscribePull(subscribePullOpts)
      : null;
    if (sub === null) {
      return { agentId: this.agent.id, subscribed: false };
    }
    this.subscriber = sub;
    await this.subscriber.ready;
    return { agentId: this.agent.id, subscribed: true };
  }

  /**
   * Drive one envelope through the consumer's pipeline. Public for tests.
   * Always returns an `AckDecision` (even on executor throw) so the subscriber
   * can drive ack/nak/term without exception handling.
   */
  async processEnvelope(
    envelope: Envelope,
    subject: string,
    msg: JsMsg | null,
  ): Promise<AckDecision> {
    // §2.3 (mirrored from review-consumer) — emit `dispatch.task.aborted` on
    // redelivery > 1 BEFORE re-running. Advisory; the executor's terminal
    // envelope remains the load-bearing reply.
    const deliveryCount = redeliveryCountFrom(msg);
    if (deliveryCount > 1) {
      await this.safePublish(
        createDispatchTaskAbortedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt: this.clock(),
          abortedAt: this.clock(),
          reason: `redelivery (attempt ${deliveryCount})`,
        }),
        "dispatch.task.aborted",
      );
    }

    // 1. Validate subject + that this is a release.cut request.
    if (!isReleaseCutEnvelope(envelope)) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `envelope type "${envelope.type}" is not a tasks.release.cut request`,
        },
        `unrecognised release subject: ${subject}`,
      );
      return { kind: "term", reason: "non-release subject" };
    }

    // 2. Validate payload shape.
    const payload = parseReleaseRequestPayload(envelope);
    if (payload === null) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: "payload validation failed (missing/invalid repo or bump)",
        },
        `bad payload for ${subject}`,
      );
      return { kind: "term", reason: "payload validation failed" };
    }

    // 2.7. CO-2/CO-4 — per-offer-scope ADMISSION GATE. A dispatch that arrived
    //      at a WIDER scope (`federated.`/`public.`) must clear that scope's
    //      gate floor before the always-human grant gate runs. BYTE-IDENTICAL:
    //      a `local.` subject admits unconditionally, so this is inert today;
    //      it bites only on the `federated.`/`public.` subjects CO-2 newly
    //      binds. Omitted (no-offerings boot / tests) ⇒ skipped. A refusal is
    //      published as `dispatch.task.failed` and term/nak'd per the lane's
    //      `releaseFailedReasonToAckDecision`.
    if (this.offerAdmission !== undefined) {
      const decision = this.offerAdmission(envelope, subject);
      if (!decision.admit) {
        process.stderr.write(
          `cortex/release-consumer: offer-scope admission DENIED for ` +
            `agent="${this.agent.id}" subject=${subject} envelope=${envelope.id} — ${decision.refusal.kind}\n`,
        );
        await this.publishFailed(
          envelope,
          decision.refusal,
          `offer-scope admission denied for ${subject}`,
        );
        return releaseFailedReasonToAckDecision(decision.refusal);
      }
    }

    // 3. Capability routing — does THIS agent claim release.cut?
    if (!this.claims()) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: `agent "${this.agent.id}" does not claim release.cut`,
        },
        "no capability match for release.cut",
      );
      return { kind: "term", reason: "no capability match" };
    }

    // 4. THE ALWAYS-HUMAN GATE (design §3.5). Refuse — fail CLOSED — unless the
    //    task envelope carries an explicit principal-grant marker
    //    (`payload.approved_by`, set by the dispatching H-gate). This is the
    //    whole reason release.cut is a gated consumer and not a cron job: an
    //    ungranted release cut is a `wont_do` (the agent COULD cut, but policy
    //    says only a principal-granted dispatch may) — permanent `term`, so a
    //    redelivery of the same ungranted envelope never sneaks through.
    //
    //    Belt-and-suspenders: the parser already drops whitespace-only grants,
    //    but the gate ALSO trims so a whitespace-only `approved_by` ("   ")
    //    can never pass here even if the value reaches the gate by another path.
    //    A bare `.length === 0` check would let "   " (length 3) through.
    //
    //    TRUST MODEL: approved_by is a presence marker, not a cryptographic proof.
    //    Authenticity of this grant relies on NATS account credentials controlling
    //    who can publish to this gate's subject. Cross-reference: signing enforcement
    //    (cortex trust track TC-0/1/2) is the path to a cryptographically-proven grant.
    if (!payload.approvedBy || payload.approvedBy.trim().length === 0) {
      await this.publishFailed(
        envelope,
        {
          kind: "wont_do",
          detail:
            "release gate is principal-held — refusing release.cut with no principal-grant marker (payload.approved_by)",
        },
        "release.cut refused: no principal grant",
      );
      return { kind: "term", reason: "wont_do: release gate is principal-held" };
    }

    // 5. Concurrency gate — release lane is serialised (default 1). Over the
    //    cap → nak `not_now`.
    if (this.inFlight.size >= this.maxConcurrent) {
      const retryAfterMs = 1000;
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: `release lane at maxConcurrent (${this.maxConcurrent}) — try again`,
          retry_after_ms: retryAfterMs,
        },
        "release consumer at maxConcurrent",
      );
      return { kind: "nak", delayMs: retryAfterMs };
    }

    // 6. No executor configured → cant_do (release lane dormant-but-present).
    if (this.executor === undefined) {
      await this.publishFailed(
        envelope,
        {
          kind: "cant_do",
          detail: "no release executor configured (release lane dormant)",
        },
        "release consumer has no executor",
      );
      return { kind: "term", reason: "no release executor" };
    }

    // 7. Emit dispatch.task.started — paired with the terminal via correlation_id.
    const startedAt = this.clock();
    await this.safePublish(
      createDispatchTaskStartedEvent({
        source: this.source,
        taskId: crypto.randomUUID(),
        agentId: this.agent.id,
        correlationId: envelope.id,
        startedAt,
      }),
      "dispatch.task.started",
    );

    // 8. Run the cut. Track the promise for `stop()` drain.
    const cutPromise = this.runCut(
      envelope,
      payload,
      payload.approvedBy,
      startedAt,
      this.executor,
    );
    const tracked: Promise<{ decision: AckDecision }> = cutPromise.then(
      (decision) => ({ decision }),
    );
    const drainSentinel = tracked.then(() => undefined);
    this.inFlight.add(drainSentinel);
    try {
      const { decision } = await tracked;
      return decision;
    } finally {
      this.inFlight.delete(drainSentinel);
    }
  }

  /**
   * Stop accepting new envelopes and drain in-flight cuts. Idempotent.
   * Mirrors `ReviewConsumer.stop`.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      const sub = this.subscriber;
      if (sub) {
        try {
          await sub.stop();
        } catch (err) {
          process.stderr.write(
            `release-consumer: subscriber stop failed for agent=${this.agent.id}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      }
    })();
    return this.stopPromise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Capability claim: exact `release.cut` or the generic `release`.
   *  cortex#2020 dual-accept window (RFC-0008 §4.2): the ratified segment-prefix
   *  matcher is ORed on top of today's exact/generic membership — additive, so an
   *  agent advertising a deeper `release.cut.<deeper>` also claims the
   *  `release.cut` request, and no match that lands today is removed. */
  private claims(): boolean {
    return (
      this.agent.capabilities.includes("release.cut") ||
      this.agent.capabilities.includes("release") ||
      anyAdvertisedSegmentPrefixMatches("release.cut", this.agent.capabilities)
    );
  }

  /**
   * Run the SOP: verify preconditions (clean branch, green checks, manifest
   * located), then cut (bump → commit → push → `gh release create`). Publishes
   * the terminal envelope (completed on success; failed on a named precondition
   * or a defensive executor throw) and returns the `AckDecision`.
   */
  private async runCut(
    envelope: Envelope,
    payload: ReleaseRequestPayload,
    approvedBy: string,
    startedAt: Date,
    executor: ReleaseExecutor,
  ): Promise<AckDecision> {
    if (this.stopped) {
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: "release consumer is shutting down",
          retry_after_ms: 0,
        },
        "consumer shutting down before cut start",
      );
      return { kind: "nak", delayMs: 0 };
    }

    try {
      // --- Preconditions (release-checklist.md Phase 1) — verify BEFORE any
      //     mutation. A failed precondition is a `cant_do` whose detail NAMES
      //     the gate that tripped.
      const branch = await executor.getDefaultBranchStatus(payload.repo);
      if (!branch.clean) {
        return await this.failPrecondition(
          envelope,
          "dirty_default_branch",
          `default branch "${branch.branch}" is not clean`,
        );
      }

      const checks = await executor.getChecksStatus(payload.repo);
      if (!checks.allGreen) {
        const detail = checks.summary ?? "one or more required checks are not green";
        return await this.failPrecondition(envelope, "checks_not_green", detail);
      }

      const manifest = await executor.locateVersionManifest(payload.repo);
      if (manifest === null) {
        return await this.failPrecondition(
          envelope,
          "manifest_not_found",
          `no version manifest located for "${payload.repo}" (arc-manifest.yaml / package.json)`,
        );
      }

      // --- The mutating step (versioning.md 4-step, executed atomically by the
      //     executor): bump → chore commit → push → gh release create.
      const result = await executor.cutRelease({
        repo: payload.repo,
        manifest,
        bump: payload.bump,
        branch: branch.branch,
        approvedBy,
        ...(payload.refs !== undefined && { refs: payload.refs }),
      });

      await this.safePublish(
        createDispatchTaskCompletedEvent({
          source: this.source,
          taskId: crypto.randomUUID(),
          agentId: this.agent.id,
          correlationId: envelope.id,
          startedAt,
          completedAt: this.clock(),
          resultSummary: `released ${payload.repo} ${result.version} — ${result.releaseUrl}`,
          chatResponse: result.releaseUrl,
        }),
        "dispatch.task.completed",
      );
      return { kind: "ack" };
    } catch (err) {
      // Defensive — map any executor throw to a §7.6 transient failure so a
      // dispatching reactor gets a retry-safe signal rather than a phantom.
      const detail = err instanceof Error ? err.message : String(err);
      await this.publishFailed(
        envelope,
        {
          kind: "not_now",
          detail: `release executor threw unexpectedly: ${detail}`,
          retry_after_ms: 0,
        },
        `release executor threw: ${detail}`,
      );
      return { kind: "nak", delayMs: 0 };
    }
  }

  /**
   * Publish a `cant_do` failure naming a specific {@link ReleasePrecondition}
   * and return the `term` AckDecision. A precondition failure is permanent for
   * THIS envelope — the dispatching gate must re-grant once the branch is
   * clean / checks are green / a manifest exists.
   */
  private async failPrecondition(
    envelope: Envelope,
    precondition: ReleasePrecondition,
    detail: string,
  ): Promise<AckDecision> {
    const failureDetail = `precondition ${precondition}: ${detail}`;
    await this.publishFailed(
      envelope,
      { kind: "cant_do", detail: failureDetail },
      `release precondition failed: ${precondition}`,
    );
    return { kind: "term", reason: failureDetail };
  }

  /**
   * Build + publish a `dispatch.task.failed` envelope, threading
   * `correlation_id = envelope.id`. The fresh `taskId` is for lifecycle
   * stitching only. Mirrors `ReviewConsumer.publishFailed`.
   */
  private async publishFailed(
    request: Envelope,
    reason: DispatchTaskFailedReason,
    errorSummary: string,
  ): Promise<void> {
    const now = this.clock();
    const failed = createDispatchTaskFailedEvent({
      source: this.source,
      taskId: crypto.randomUUID(),
      agentId: this.agent.id,
      correlationId: request.id,
      startedAt: now,
      failedAt: now,
      errorSummary,
      reason,
    });
    await this.safePublish(failed, "dispatch.task.failed");
  }

  /**
   * Single publish path — traps + logs publish errors per CLAUDE.md "no empty
   * catch blocks". A failed publish must not crash the consumer or prevent the
   * handler from returning an `AckDecision`. Mirrors `ReviewConsumer.safePublish`
   * minus the federated branch (release is local-scope only — F-4.1 anti-scope).
   */
  private async safePublish(envelope: Envelope, label: string): Promise<void> {
    try {
      await this.runtime.publish(envelope);
    } catch (err) {
      process.stderr.write(
        `release-consumer: publish failed for ${label} (agent=${this.agent.id}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Is this envelope a `tasks.release.cut` request? The envelope `type` (NOT the
 * wire subject) is canonical — same rationale as `extractFlavor` in
 * review-consumer (a malformed subject must not falsely match).
 */
export function isReleaseCutEnvelope(envelope: Envelope): boolean {
  return envelope.type === "tasks.release.cut";
}

const OWNER_REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const BUMP_KINDS: ReadonlySet<string> = new Set(["patch", "minor", "major"]);

/**
 * Parse + validate a `tasks.release.cut` envelope payload into the canonical
 * {@link ReleaseRequestPayload}, or `null` on any shape violation.
 *
 * Required: `repo` (`owner/name`), `bump` (`patch|minor|major`). Optional:
 * `approved_by` (the principal-grant marker — its PRESENCE is what the §3.5 gate
 * keys on), `refs` (string[]).
 *
 * NOTE: this parser does NOT reject a missing grant — that is the consumer's
 * §3.5 gate decision (it emits a `wont_do`, distinct from a `cant_do` payload
 * violation). The grant marker is OPTIONAL at the payload layer precisely so
 * the consumer can distinguish "malformed request" from "well-formed but
 * ungranted request".
 */
export function parseReleaseRequestPayload(
  envelope: Envelope,
): ReleaseRequestPayload | null {
  const p = envelope.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;

  if (typeof p.repo !== "string" || !OWNER_REPO_RE.test(p.repo)) return null;
  if (typeof p.bump !== "string" || !BUMP_KINDS.has(p.bump)) return null;

  const out: ReleaseRequestPayload = {
    repo: p.repo,
    bump: p.bump as VersionBumpKind,
  };

  // The grant marker — accept the wire snake_case `approved_by`. Empty string
  // AND whitespace-only strings are treated as ABSENT (the gate refuses them)
  // so a blank or `"   "` grant can't sneak past the §3.5 check. We TRIM before
  // the non-empty test: `"   ".length === 3 > 0` would otherwise parse as a
  // present grant, and the gate's empty-string check (`.length === 0`) would
  // not catch it — a whitespace-only grant must parse as ABSENT, not present.
  if (typeof p.approved_by === "string" && p.approved_by.trim().length > 0) {
    out.approvedBy = p.approved_by;
  }

  if (Array.isArray(p.refs)) {
    const refs = p.refs.filter((r): r is string => typeof r === "string");
    if (refs.length > 0) out.refs = refs;
  }

  return out;
}

/**
 * Map a `DispatchTaskFailedReason` to its JetStream `AckDecision`. Identical
 * contract to review-consumer's `failedReasonToAckDecision` (the release lane
 * uses the same four-way nak taxonomy). Re-implemented here (rather than
 * imported) to keep the release lane's ack table self-contained + independently
 * testable — the lanes share the wire vocabulary, not the module.
 */
export function releaseFailedReasonToAckDecision(
  reason: DispatchTaskFailedReason | undefined,
): AckDecision {
  if (!reason) return { kind: "ack" };
  switch (reason.kind) {
    case "cant_do":
      return { kind: "term", reason: `cant_do: ${reason.detail}` };
    case "wont_do":
      return { kind: "term", reason: `wont_do: ${reason.detail}` };
    case "policy_denied": {
      const denyKeys = Object.keys(reason.deny);
      const summary = denyKeys.length > 0 ? denyKeys.join(",") : "(no deny detail)";
      return { kind: "term", reason: `policy_denied: ${summary}` };
    }
    case "not_now": {
      const out: AckDecision = { kind: "nak" };
      if (reason.retry_after_ms !== undefined) out.delayMs = reason.retry_after_ms;
      return out;
    }
    case "compliance_block":
      return { kind: "term", reason: "v1 does not handle compliance_block" };
  }
}

/**
 * Read JetStream redelivery count from a `JsMsg`. Returns `1` when no msg is
 * supplied (tests). Mirrors review-consumer's `redeliveryCountFrom`.
 */
function redeliveryCountFrom(msg: JsMsg | null): number {
  if (!msg) return 1;
  const info = (msg.info as { redeliveryCount?: number } | undefined) ?? undefined;
  if (info && typeof info.redeliveryCount === "number") {
    return info.redeliveryCount;
  }
  return msg.redelivered ? 2 : 1;
}
