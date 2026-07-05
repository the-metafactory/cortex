/**
 * S7 (epic #1514, plan §2, cortex#1521) — boot wiring for the per-agent
 * review-consumer construction, extracted from the ~475-line
 * `startReviewConsumersForAgent` closure that used to live inline in
 * `src/cortex.ts` (B-0, cortex#1021). Shaped after `dev-consumer-boot.ts`:
 * a narrow structural `*BootAgent` projection + a `WireXConsumersOpts`
 * interface that lists every boot-scoped value the wiring needs, so the
 * construction is unit-testable without standing up `startCortex`.
 *
 * **Different shape than `wireDevConsumers` — and why.** `wireDevConsumers`
 * builds every dev-capable agent's consumer ONCE and returns the finished
 * list; `cortex.ts` starts them. The review lane can't follow that shape
 * byte-for-byte: `cortex.ts` calls this construction TWICE — once in the
 * boot loop over `reviewCapableAgents`, and again from the `agents.d/`
 * hot-reload path for each added/changed agent (§B-0 design §7/§11) — and
 * the construction itself does the provisioning + `consumer.start()` +
 * boot-log inline (the review lane never separates "build" from "start"
 * the way the dev lane does). So `wireReviewConsumers` returns a callable,
 * `startForAgent`, that `cortex.ts` invokes per agent at both sites,
 * exactly where `startReviewConsumersForAgent(agent)` used to be called.
 *
 * **No dormancy filter here.** Unlike `wireDevConsumers` (which filters
 * `agents` itself), the capability filter (`code-review`/`code-review.*`)
 * stays in `cortex.ts` — both call sites only ever invoke `startForAgent`
 * for an agent already known to be review-capable
 * (`reviewCapableAgents`/`isReviewCapable`). This module has nothing to
 * decide about eligibility; it only builds + subscribes.
 *
 * **`opts.reviewConsumers` is a shared, NOT owned, array.** `cortex.ts`
 * still declares `const reviewConsumers: ReviewConsumer[] = []` and reads
 * it for the hot-reload diff (`drainConsumersForAgent`) and the shutdown
 * drain — both well outside this slice's scope. `startForAgent` pushes
 * onto the SAME array reference (passed once as an opts field), so those
 * call sites keep seeing every consumer this module wires, unchanged.
 *
 * **Free-variable capture — no mutable-capture threading needed.** Every
 * value `WireReviewConsumersOpts` carries is a plain snapshot, not a
 * getter/setter pair, because none of the captured `cortex.ts` `let`s are
 * reassigned after `wireReviewConsumers` is constructed (boot-time, right
 * where the old closure used to be defined) and before either call site
 * runs: `signer` (cortex.ts, assigned once near boot-time signer setup)
 * and `stackNKeyPubForVerifier` (assigned once alongside it) both settle
 * before the first `startForAgent` call; `runtime` (also a `let`) is
 * assigned once from either `options.injectRuntime` or
 * `startMyelinRuntime(...)`, likewise before either call site. The old
 * closure only ever READ these — it never reassigned any of them — so a
 * plain value capture at construction time is behaviourally identical to
 * the inline closure's live-binding read.
 */

import { CCSession, type CCSessionOpts } from "./cc-session";
import { withCo7EgressGuard } from "./co7-egress-pipeline";
import {
  reviewPromptForScope,
  reviewSessionOptsForScope,
} from "./co7-review-hardening";
import { resolveReviewEngine, type ReviewEngineInput } from "./review-engine";
import { runReviewPipeline } from "./review-pipeline";
import { makeSageReviewRunner } from "./sage-runner";
import {
  ReviewConsumer,
  type ReviewConsumerAgent,
  type SignatureVerifier,
} from "../bus/review-consumer";
import { provisionReviewConsumer, type ProvisionJsm } from "../bus/jetstream/provision";
import { verifySignedByChain } from "../bus/verify-signed-by-chain";
import type { SystemEventSource } from "../bus/system-events";
import type { BusEnvelopeSigner, MyelinRuntime } from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { GateFloorDecision } from "../bus/gate-floor";
import type { OfferScope } from "../common/types/offering";
import type { TrustResolver } from "../common/agents/trust-resolver";
import type { ResolvedSigningKnobs } from "../common/security-posture";
import type { PolicyFederatedNetwork } from "../common/types/cortex-config";
import type { AgentModelClass } from "../bus/sovereignty-gate";

// ---------------------------------------------------------------------------
// The narrow agent shape the boot wiring consumes
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a cortex.yaml `Agent` the review boot wiring needs
 * — structural (not the full Zod `Agent`) so `cortex.ts` passes
 * `mergedAgents`/hot-reload agents without a cast, mirroring
 * `DevBootAgent`. `runtime` intersects {@link ReviewEngineInput} because
 * `resolveReviewEngine(agent.runtime)` is called directly (unlike the dev
 * lane, which never reads engine/model/substrate).
 */
export interface ReviewBootAgent {
  id: string;
  displayName: string;
  /** Peer agent ids this agent trusts — drives the per-agent signature verifier. */
  trust: readonly string[];
  runtime?: ReviewEngineInput & {
    capabilities?: readonly string[];
    maxConcurrent?: number;
    /** Governance Stage 1b — feeds the consumer-side sovereignty gate. */
    modelClass?: AgentModelClass;
  };
}

/** Inputs `cortex.ts` threads into the review-consumer boot wiring. */
export interface WireReviewConsumersOpts {
  /** `{principal}` subject segment — durable names + the verifier's own-stack check. */
  reviewPrincipalId: string;
  /** B.1a structural-trust resolver backing the per-agent signature verifier. */
  trustResolver: TrustResolver;
  /** `security.signing` posture knobs — `cryptoVerify` + `rejectEmpty` are read. */
  signingKnobs: ResolvedSigningKnobs;
  /** This stack's own envelope signer, when attached — feeds the verifier's own-stack short-circuit. */
  signer?: BusEnvelopeSigner;
  /** This stack's NKey pubkey, for the same own-stack short-circuit. */
  stackNKeyPubForVerifier?: string;
  /** Bus-side event source every consumer publishes lifecycle/verdict envelopes through. */
  systemEventSource: SystemEventSource;
  /** The (possibly dormant) MyelinRuntime the consumer subscribes against. */
  runtime: MyelinRuntime;
  /**
   * §3 review-session opts, pre-curried with `config` + `process.cwd()` by
   * the caller (`buildReviewSessionOpts` stays exported from `cortex.ts`
   * — this module doesn't import it, avoiding a `cortex.ts` ⇄
   * `review-consumer-boot.ts` cycle).
   */
  buildSessionOpts: (agent: ReviewBootAgent) => Partial<Omit<CCSessionOpts, "prompt">>;
  /** CO-2/CO-4 per-offer-scope admission gate factory, keyed by capability id. */
  makeOfferAdmission: (
    capability: string,
  ) => (envelope: Envelope, subject: string) => GateFloorDecision;
  /** cortex#686 federation roster (`policy.federated.networks`) for the federated consumer's `peers[]` gate. */
  federatedNetworks: readonly PolicyFederatedNetwork[];
  /**
   * Shared consumer array — the SAME array `cortex.ts` owns for its
   * hot-reload diff (`drainConsumersForAgent`) and shutdown drain. This
   * module pushes onto it; it does not own the array's lifecycle.
   */
  reviewConsumers: ReviewConsumer[];
  /** CO-2 offer-scope Offer patterns (`[reviewSubjectPattern]` for the local-only default). */
  reviewOfferingPatterns: readonly string[];
  /** The primary local subject pattern — the `reviewOfferingPatterns[0]` fallback. */
  reviewSubjectPattern: string;
  /** Resolved JetStream manager, or `null` when the runtime is dormant. */
  reviewJsm: ProvisionJsm | null;
  /** CODE_REVIEW stream name. */
  reviewStream: string;
  /** Durable max-deliver, shared with the release/brain lanes. */
  reviewConsumerMaxDeliver: number;
  /** Whether a `policy.federated` block is declared — gates the ADR-0001 federated consumers. */
  federationConfigured: boolean;
  /** cortex#686 (ADR 0001) federated Offer pattern. */
  reviewFederatedSubjectPattern: string;
  /** cortex#725 (ADR 0001/0002 §2) federated Direct pattern. */
  reviewFederatedDirectSubjectPattern: string;
}

/** The callable `cortex.ts` invokes per agent, at both the boot loop and the `agents.d/` hot-reload sites. */
export interface WiredReviewConsumers {
  startForAgent: (agent: ReviewBootAgent) => Promise<void>;
}

/**
 * Build the per-agent review-consumer construction. Returns `startForAgent`
 * — the same construction the boot loop (over `reviewCapableAgents`) and
 * the `agents.d/` hot-reload path (for an added/changed agent) both call,
 * so a hot-added agent's consumers start identically to a boot agent's.
 * Never throws: a single agent's consumer-init failure is caught and
 * logged so siblings still wire (mirrors the pre-extraction closure).
 */
export function wireReviewConsumers(
  opts: WireReviewConsumersOpts,
): WiredReviewConsumers {
  const startForAgent = async (agent: ReviewBootAgent): Promise<void> => {
    try {
      const caps = agent.runtime?.capabilities ?? [];
      const consumerAgent: ReviewConsumerAgent = {
        id: agent.id,
        capabilities: caps,
        ...(agent.runtime?.maxConcurrent !== undefined && {
          maxConcurrent: agent.runtime.maxConcurrent,
        }),
        // Governance Stage 1b — the agent's declared model class feeds the
        // consumer-side sovereignty gate. Absent → the gate fails closed for
        // local-only tasks.
        ...(agent.runtime?.modelClass !== undefined && {
          modelClass: agent.runtime.modelClass,
        }),
      };
      // cortex#327 follow-up (D1) — build the per-agent signature verifier
      // closure when this agent declares a non-empty `trust:[]` list.
      //
      // **Default-ON, fail-open posture.** Agents with `trust: []` (the
      // shape that says "I accept anything from anyone the runtime
      // delivered") get NO verifier — the gate in `ReviewConsumer.processEnvelope`
      // is a no-op, matching the pre-#329 behaviour. Agents with at least
      // one trusted peer get the verifier wired and the gate enforces.
      // This is the one-way ratchet: as principals add `trust:` entries
      // to their cortex.yaml, signature enforcement strengthens
      // automatically without any flag toggling.
      //
      // The closure captures `trustResolver`, `agent.id`, and the
      // configured principalId — same triple the bus-peer harness
      // (`src/substrates/bus-peer/harness.ts`) supplies to
      // verifySignedByChain on its inbound path. `cryptoVerify: true`
      // engages B.1c canonical-bytes verification on top of B.1a
      // structural-trust resolution.
      //
      // Reason mapping: discriminated `ChainRejectionReason` → short
      // grep-friendly string ("empty_chain", "signer_not_trusted",
      // "crypto_verify_failed", etc.) so the structured stderr line
      // landed in #329 carries the rejection class verbatim. The full
      // myelin-side detail is logged separately by the trust resolver.
      const agentTrustList = agent.trust;
      const verifyPrincipalId = opts.reviewPrincipalId;
      const signatureVerifier: SignatureVerifier | undefined =
        agentTrustList.length === 0
          ? undefined
          : async (envelope) => {
              const r = await verifySignedByChain(envelope, {
                resolver: opts.trustResolver,
                receivingAgentId: agent.id,
                cryptoVerify: opts.signingKnobs.cryptoVerify,
                // TC-0 (#628) — posture-gated empty-chain rejection. `off`/
                // `permissive` → `false` (verify but never reject empty
                // adapter-originated chains); `enforce` → `true`. Pre-TC-0
                // this relied on the `verifySignedByChain` default
                // (`rejectEmpty: true`); the posture now sets it explicitly
                // so seed-less / off stacks stay non-rejecting.
                rejectEmpty: opts.signingKnobs.rejectEmpty,
                principalId: verifyPrincipalId,
                // cortex#535 (TC-1a) — implicit own-stack trust, mirroring
                // the bus-dispatch-listener wiring below. Pilot review-
                // requests are signed with the STACK identity
                // (`did:mf:<principal>-<stack>`), NOT an agent identity, so
                // without `stackIdentity` the stack DID misses the cortex#480
                // own-stack short-circuit and gets rejected as
                // `principal_has_no_nkey_pub`. Thread the SAME conditional-
                // spread options the dispatch-listener passes so self-signed
                // review-requests verify cleanly instead of being dropped.
                ...(opts.signer !== undefined && { stackIdentity: opts.signer.principal }),
                ...(opts.stackNKeyPubForVerifier !== undefined && {
                  stackNKeyPub: opts.stackNKeyPubForVerifier,
                }),
              });
              if (r.valid) return { valid: true } as const;
              return { valid: false, reason: r.reason.kind } as const;
            };

      // cortex#331 Phase 1 — substrate-aware pipelineRunner selection.
      //
      // **Why this lives in cortex (not sage).** Sage went in-process at
      // sage#41 — its standalone launchd daemon and standalone NATS
      // subscribe path are retired. Cortex's review-consumer is now the
      // sole receiver for sage-owned review flavors.
      //
      // cortex#917 — the engine/model split. `resolveReviewEngine` reads
      // `runtime.engine` (`sage` | `assistant`); the sage lens LLM is the
      // orthogonal `runtime.model` (claude|codex|pi), NOT `substrate` (which is
      // the M6 harness). `engine: sage` wires the sage lens-CLI runner,
      // forwarding `model` to `sage review --substrate <model>`; `assistant`
      // (and the legacy default) leaves `pipelineRunner` undefined so the
      // ReviewConsumer falls through to `runReviewPipeline` → the Claude-Code
      // SKILL.md path (`ccSessionFactory` stays wired for it). The resolver's
      // legacy shim keeps pre-split `substrate: pi-dev` configs routing to sage
      // (no forced model — SAGE_SUBSTRATE env still honoured).
      //
      // The sage runner resolves its binary lazily at first use (see
      // `sage-runner.ts`'s lifetime note), so a missing sage on boot does not
      // crash this loop — review requests surface the failure as
      // `dispatch.task.failed` envelopes instead.
      const { engine, model } = resolveReviewEngine(agent.runtime);
      const pipelineRunner =
        engine === "sage"
          ? makeSageReviewRunner(model !== undefined ? { model } : {})
          : undefined;

      const reviewSessionOpts = opts.buildSessionOpts(agent);

      // cortex#686 — shared construction options for the local + federated
      // consumers. Both serve the SAME reviewer agent (same capabilities,
      // verifier, substrate, prompt); they differ only in the `federated` flag
      // (which flips verdict routing to the requester) and the subscription
      // pattern/durable. Factored into a closure so the two consumers can't
      // drift on the heavy CC-session / verifier / prompt wiring.
      //
      // CO-7 (epic cortex#939) — the closure is now SCOPE-AWARE. The `scope`
      // argument (`local`/`federated`/`public`, derived from the bound subject
      // prefix) selects the hardened M1 prompt + M2 least-privilege session +
      // M4 egress-guarded pipeline for wider scopes. On `local` every helper
      // short-circuits to the pre-CO-7 path (plain prompt, baseline opts, no
      // egress wrap), so the local consumer is byte-identical to today.
      const makeConsumer = (scope: OfferScope): ReviewConsumer => {
        const federated = scope === "federated" || scope === "public";
        // M1 — untrusted-content boundary prompt for wider scope; plain for local.
        const scopedPromptBuilder = reviewPromptForScope(scope);
        // M2 — least-privilege session lockdown for wider scope; baseline for local.
        // `scratchDir` is left undefined here: the lockdown then fails CLOSED to
        // "no dirs granted" (empty allowedDirs) for a wider-scope review rather
        // than ever granting the principal's cwd to untrusted work. A per-review
        // scratch dir is the F-5b follow-up's concern (the non-local backend
        // owns the sandbox filesystem). For local, baseline opts (with their cwd)
        // pass through unchanged.
        const scopedSessionOpts = reviewSessionOptsForScope({
          baseline: reviewSessionOpts,
          scope,
          agentId: agent.id,
        });
        // M4 — wrap the pipeline runner so a wider-scope review's free-text
        // egress is leakage-scanned and a leak becomes `compliance_block`
        // (the review is never posted). `local` returns the inner runner
        // unchanged. The inner runner is the sage runner (if selected) or the
        // default `runReviewPipeline` (passed `undefined` ⇒ the consumer's own
        // default); we only override `pipelineRunner` when there is something to
        // wrap (a non-local scope OR an explicit sage runner).
        const baseRunner = pipelineRunner ?? runReviewPipeline;
        const scopedPipelineRunner =
          scope === "local"
            ? pipelineRunner // undefined ⇒ consumer default; or the sage runner
            : withCo7EgressGuard(scope, baseRunner);
        return new ReviewConsumer({
          agent: consumerAgent,
          source: opts.systemEventSource,
          runtime: opts.runtime,
          // CC session factory — spawns a real `claude` process. Mirrors the
          // default factory inside `ClaudeCodeHarness` (the harness keeps its
          // own copy private; we don't re-export to avoid the symbol leaking
          // into the public bus surface). Tests don't reach the factory
          // unless `processEnvelope` is invoked; the boot test in
          // `src/__tests__/cortex.review-consumer-boot.test.ts` only
          // exercises instantiation + subscribe. Stays wired even when a
          // non-CC pipelineRunner is selected — the consumer's type still
          // requires the factory, and the CC path remains the default
          // fallthrough for non-pi-dev substrates.
          ccSessionFactory: (o) => new CCSession(o),
          // PR-6 has no policy hook — that's a future PR (sovereignty /
          // compliance gate). Until then the pipeline goes straight to CC.
          // cortex#911 — the prompt now carries the verdict-block contract +
          // post intent explicitly (`buildReviewPrompt`), not just bare intent.
          // A thin persona used to review in prose and ask "Shall I post?",
          // leaving the pipeline with no parseable block and nothing on the
          // forge. Stating the contract in the prompt raises the floor on
          // persona quality. Failure is asymmetric: a missing/malformed block
          // drops only the verdict envelope (retryable), but a forge review,
          // once posted, persists — see `buildReviewPrompt`'s docstring.
          // Capability routing still happened on the subject
          // (`tasks.code-review.*`).
          // CO-7 M1 — scope-aware prompt builder (untrusted-content boundary for
          // federated/public; plain trusted prompt for local — byte-identical).
          promptBuilder: ({ payload }) => scopedPromptBuilder(payload),
          // CO-7 M2 — scope-aware session opts (least-privilege lockdown for
          // wider scope; baseline for local — byte-identical).
          sessionOpts: scopedSessionOpts,
          // CO-7 M4 — scope-aware pipeline runner (egress-guarded for wider
          // scope; the sage runner or consumer default for local).
          ...(scopedPipelineRunner !== undefined && {
            pipelineRunner: scopedPipelineRunner,
          }),
          ...(signatureVerifier !== undefined && { signatureVerifier }),
          // CO-2/CO-4 — the per-offer-scope admission gate. Inert on `local.`
          // (byte-identical); gates the `federated.`/`public.` subjects this
          // PR newly binds at their scope's floor before reviewer work.
          offerAdmission: opts.makeOfferAdmission("code-review"),
          // cortex#686 — federated consumers route the verdict back to the
          // requester's identity on the conformant `federated.{requester}.…`
          // grammar (the cortex receiver that closes the cross-principal loop).
          // The peer topology is passed so the consumer-path `peers[]` gate
          // (ADR 0002 §5) can deny a non-peer requester BEFORE spawning the
          // reviewer — defense-in-depth that, under `signing: off`, is the
          // application-layer trust boundary on the consumer path.
          ...(federated && {
            federated: true,
            federatedNetworks: opts.federatedNetworks,
          }),
        });
      };

      const consumer = makeConsumer("local");
      opts.reviewConsumers.push(consumer);
      // Subscribe via the runtime's subscribePull helper. When the
      // runtime is disabled the helper returns null inside start() and
      // the consumer stays dormant — `started.subscribed` distinguishes
      // the two cases so the boot log can be honest (cortex#334)
      // instead of unconditionally claiming "ready".
      const durable = `cortex-review-consumer-${opts.reviewPrincipalId}-${agent.id}`;

      // The durable's filter MUST match the subscription pattern this consumer
      // binds (`consumer.start({ pattern })` below), or the durable claims every
      // message on the stream — the cortex#1186 multi-durable fan-out that
      // double-posts a review when an agent has >1 scope consumer (local +
      // federated + …). `reviewOfferingPatterns[0]` is the local scope's
      // pattern (CO-1 default = `reviewSubjectPattern`); hoisted here so it
      // feeds BOTH the provision filter and the start pattern below.
      const primaryReviewPattern = opts.reviewOfferingPatterns[0] ?? opts.reviewSubjectPattern;

      // cortex#338 — provision the per-agent durable consumer up-front
      // so `consumer.start()` below binds successfully against a virgin
      // broker. Reuses `reviewJsm` resolved once before this loop.
      // Idempotent — safe across restarts. Skipped when JSM isn't
      // available (runtime dormant); the subsequent `consumer.start()`
      // will then stay dormant too.
      if (opts.reviewJsm !== null) {
        try {
          const outcome = await provisionReviewConsumer({
            jsm: opts.reviewJsm,
            stream: opts.reviewStream,
            durable,
            filterSubject: primaryReviewPattern,
            maxDeliver: opts.reviewConsumerMaxDeliver,
          });
          if (outcome === "created") {
            console.log(
              `cortex: provisioned JetStream durable "${durable}" on stream "${opts.reviewStream}"`,
            );
          } else if (outcome === "updated") {
            console.log(
              `cortex: reconciled JetStream durable "${durable}" ack_wait (cortex#422) on stream "${opts.reviewStream}"`,
            );
          }
        } catch (provisionErr) {
          // Don't abort — let consumer.start surface the bind failure
          // through its own error path so the principal sees the same
          // stderr shape they'd see if the consumer existed but bind
          // failed for another reason.
          process.stderr.write(
            `cortex: provisionReviewConsumer failed for "${durable}": ` +
              `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
          );
        }
      }

      // CO-2 (cortex#941) — bind the Offer consumer on the scope prefixes the
      // `code-review` offering admits. `reviewOfferingPatterns[0]` is the
      // first admitted scope in canonical order (local → federated → public);
      // for a `local`-only resolution (the CO-1 default) it is byte-identical
      // to `reviewSubjectPattern`, so the primary `start()` below is unchanged.
      // Any FURTHER patterns (federated/public, once CO-3 offers them wider)
      // bind on a per-scope durable so each scope's traffic acks independently,
      // mirroring the cortex#686/#725 federated-consumer idiom. With no
      // offerings, `reviewOfferingPatterns` is exactly `[reviewSubjectPattern]`
      // and this slice-loop is empty — zero added boot behaviour.
      // (`primaryReviewPattern` is hoisted above so it also feeds the durable's
      // `filterSubject` — cortex#1186.)
      const started = await consumer.start({
        pattern: primaryReviewPattern,
        stream: opts.reviewStream,
        durable,
      });
      const flavorSummary =
        consumer.flavors.length > 0 ? consumer.flavors.join(",") : "(none)";
      // D1 visibility: surface whether signature verification is enforced
      // on this consumer so principals can grep `signed=on/off` to confirm
      // their trust:[] config landed where they expected.
      const signedTag = signatureVerifier !== undefined ? "on" : "off";
      // cortex#331 Phase 1 — surface the dispatching substrate so
      // principals can grep `substrate=pi-dev` / `substrate=claude-code`
      // to confirm sage agents (or any future substrate) actually
      // received the substrate-aware factory. Unset substrate defaults
      // to `claude-code` in the log (matches the runtime fallthrough).
      //
      // cortex#334 — distinguish "ready" (subscription open) from
      // "DORMANT" (subscribePull returned null; G-1111 pending or
      // nats.subjects empty). The previous unconditional "ready" line
      // misled principals into chasing phantom misconfigs.
      if (started.subscribed) {
        console.log(
          `cortex: review consumer ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"}`,
        );
      } else {
        console.log(
          `cortex: review consumer DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (G-1111 pending; tasks.code-review.* envelopes will not be claimed by this consumer)`,
        );
      }

      // CO-2 (cortex#941) — bind the FURTHER offering scopes (federated/public)
      // beyond the primary local one. Empty for the CO-1 default (`local`-only
      // ⇒ `reviewOfferingPatterns` has length 1, so `.slice(1)` is empty ⇒ this
      // loop never runs ⇒ byte-identical boot). Each extra scope binds on its
      // OWN durable (scope token in the durable name) so the scopes ack
      // independently, the same idiom as the cortex#686/#725 federated durables.
      for (const extraPattern of opts.reviewOfferingPatterns.slice(1)) {
        const scopeToken = extraPattern.split(".", 1)[0] ?? "scope";
        // MAJOR-1 fix (cortex#715 re-introduction): a `federated.`/`public.`
        // offer-scope consumer MUST be constructed with `federated: true` so
        // `ReviewConsumer.processEnvelope` decodes the REQUESTER from
        // `originator.identity` and routes the verdict back cross-principal —
        // `makeConsumer(false)` left `this.federated` unset, routing every
        // verdict to SELF (the exact cortex#715 BLOCKER). `makeConsumer(true)`
        // also wires `federatedNetworks` so the defense-in-depth `peers[]` gate
        // runs. (`public` shares the federated verdict-routing path: a public
        // requester reaches us through a surface but the verdict still routes to
        // the relaying identity in `originator`, not self.)
        // CO-7 — pass the actual offer-scope (not just a federated bool) so the
        // consumer wires the scope-appropriate M1/M2/M4 hardening. A non-scope
        // token (defensive) falls back to `public` — the STRICTEST hardening —
        // never silently to local.
        const offerScope: OfferScope =
          scopeToken === "federated"
            ? "federated"
            : scopeToken === "public"
              ? "public"
              : "public";
        const offerConsumer = makeConsumer(offerScope);
        opts.reviewConsumers.push(offerConsumer);
        const offerDurable = `cortex-review-consumer-offer-${scopeToken}-${opts.reviewPrincipalId}-${agent.id}`;
        if (opts.reviewJsm !== null) {
          try {
            const outcome = await provisionReviewConsumer({
              jsm: opts.reviewJsm,
              stream: opts.reviewStream,
              durable: offerDurable,
              // Filter to THIS offer scope's pattern so it doesn't claim the
              // local/other-scope durables' traffic (cortex#1186 fan-out).
              filterSubject: extraPattern,
              maxDeliver: opts.reviewConsumerMaxDeliver,
            });
            if (outcome === "created") {
              console.log(
                `cortex: provisioned JetStream durable "${offerDurable}" on stream "${opts.reviewStream}"`,
              );
            } else if (outcome === "updated") {
              console.log(
                `cortex: reconciled JetStream durable "${offerDurable}" ack_wait (cortex#422) on stream "${opts.reviewStream}"`,
              );
            }
          } catch (provisionErr) {
            process.stderr.write(
              `cortex: provisionReviewConsumer failed for "${offerDurable}": ` +
                `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
            );
          }
        }
        const offerStarted = await offerConsumer.start({
          pattern: extraPattern,
          stream: opts.reviewStream,
          durable: offerDurable,
        });
        if (offerStarted.subscribed) {
          console.log(
            `cortex: review consumer (offer:${scopeToken}) ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} pattern=${extraPattern}`,
          );
        } else {
          console.log(
            `cortex: review consumer (offer:${scopeToken}) DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (${extraPattern} envelopes will not be claimed by this consumer)`,
          );
        }
      }

      // cortex#686 (ADR 0001) — the FEDERATED review consumer. Subscribes this
      // stack's OWN federated identity (`federated.{my-principal}.{my-stack}.
      // tasks.code-review.>`) on the SAME CODE_REVIEW stream (its subject
      // filter was extended above when federation is configured), via a
      // SEPARATE durable so local + federated traffic ack independently. Routes
      // the verdict back to the REQUESTER's identity (the `federated: true`
      // flag). Only wired when a `federated:` policy block is declared — a
      // non-federating deployment skips this entirely (back-compat).
      if (opts.federationConfigured) {
        // cortex#686 + cortex#725 — wire BOTH federated consumers (Offer +
        // Direct) for this agent. They share the `makeConsumer(true)`
        // construction (same reviewer, verifier, peers gate, verdict-back) and
        // the SAME CODE_REVIEW stream; they differ ONLY in the subscription
        // pattern + the durable (so Offer and Direct traffic ack independently).
        // Factored into a closure so the two can't drift on provisioning /
        // start / log wiring.
        const startFederatedConsumer = async (
          mode: "offer" | "direct",
          pattern: string,
          durableName: string,
        ): Promise<void> => {
          // CO-7 — the cortex#686/#725 federated-policy consumers bind on
          // `federated.` subjects, so they wire the `federated`-scope M1/M2/M4
          // hardening (untrusted-content boundary + least-privilege + egress
          // guard) for cross-principal review requests.
          const federatedConsumer = makeConsumer("federated");
          opts.reviewConsumers.push(federatedConsumer);
          if (opts.reviewJsm !== null) {
            try {
              const outcome = await provisionReviewConsumer({
                jsm: opts.reviewJsm,
                stream: opts.reviewStream,
                durable: durableName,
                // Filter to THIS federated consumer's `federated.…` pattern so
                // it claims only cross-principal traffic, never the local
                // durable's `local.…` requests (cortex#1186 fan-out).
                filterSubject: pattern,
                maxDeliver: opts.reviewConsumerMaxDeliver,
              });
              if (outcome === "created") {
                console.log(
                  `cortex: provisioned JetStream durable "${durableName}" on stream "${opts.reviewStream}"`,
                );
              } else if (outcome === "updated") {
                console.log(
                  `cortex: reconciled JetStream durable "${durableName}" ack_wait (cortex#422) on stream "${opts.reviewStream}"`,
                );
              }
            } catch (provisionErr) {
              process.stderr.write(
                `cortex: provisionReviewConsumer failed for "${durableName}": ` +
                  `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
              );
            }
          }
          const federatedStarted = await federatedConsumer.start({
            pattern,
            stream: opts.reviewStream,
            durable: durableName,
          });
          if (federatedStarted.subscribed) {
            console.log(
              `cortex: federated review consumer (${mode}) ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} pattern=${pattern}`,
            );
          } else {
            console.log(
              `cortex: federated review consumer (${mode}) DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (federated.* code-review envelopes will not be claimed by this consumer)`,
            );
          }
        };

        // cortex#686 (ADR 0001) — Offer: `federated.{me}.{stack}.tasks.code-review.>`.
        await startFederatedConsumer(
          "offer",
          opts.reviewFederatedSubjectPattern,
          `cortex-review-consumer-federated-${opts.reviewPrincipalId}-${agent.id}`,
        );
        // cortex#725 (ADR 0001/0002 §2) — Direct: this stack's OWN
        // `federated.{me}.{stack}.tasks.@{did}.code-review.>` (the `@{did}` is
        // the named reviewer/target-assistant). Routes the verdict back to the
        // REQUESTER (from `originator.identity`) identically to the Offer path.
        await startFederatedConsumer(
          "direct",
          opts.reviewFederatedDirectSubjectPattern,
          `cortex-review-consumer-federated-direct-${opts.reviewPrincipalId}-${agent.id}`,
        );
      }
    } catch (err) {
      // Per CLAUDE.md: log every error. A single agent's consumer crash
      // does NOT abort boot — siblings still get wired. Boot keeps the
      // consumer in `reviewConsumers[]` so shutdown drain still calls
      // `.stop()` (idempotent — handles the "never subscribed" case).
      process.stderr.write(
        `cortex: review consumer init failed for agent=${agent.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  return { startForAgent };
}
