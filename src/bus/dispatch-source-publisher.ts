import { directTaskSubject } from "@the-metafactory/myelin/subjects";
import { DID_RE } from "@the-metafactory/myelin/identity";
import type { InboundMessage } from "../adapters/types";
import type { PolicyEngine } from "../common/policy/engine";
import type { ResponseRouting } from "./dispatch-events";
import { buildBaseEnvelope } from "./envelope-builder";
import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import type { SystemEventSource } from "./system-events";

/**
 * Dispatch-source publisher for M7 inbound task envelopes.
 *
 * Platform adapters, dashboards, taps, and assistant runtimes are all
 * dispatch sources when they turn an inbound action into a canonical
 * `tasks.@{assistant}.{capability}` envelope. This helper owns the shared
 * envelope/subject construction; source-specific code still owns prompt
 * building, access checks, response routing, and context gathering.
 */

export interface InboundChatDispatchPublishOpts {
  runtime: MyelinRuntime | undefined;
  source: SystemEventSource | undefined;
  stack?: string;
  agentName: string;
  agentDisplayName: string;
  taskId: string;
  msg: InboundMessage;
  prompt: string;
  resumeSessionId: string | undefined;
  allowedDirs: string[];
  disallowedTools: string[];
  /**
   * cortex#1167 — EXPLICIT tool ALLOWLIST emitted as `allowed_tools` on the
   * payload. Non-empty → the runner confines the CC session to exactly these
   * tools (allowlist semantics). Empty/undefined → omitted (the runner's
   * pre-existing allow-by-default + deny-list behaviour, unchanged for every
   * real dispatch). Set only by the open-onboarding anon path.
   */
  allowedTools?: string[];
  /**
   * cortex#710 — per-skill grant list. `undefined` → omit `allowed_skills`
   * from the payload (the runner harness applies default-deny: no Skill
   * tool). `[]` → explicit no-skills. `[...]` → grant exactly those skills
   * via the runner's Skill Guard PreToolUse hook. The dispatch-handler maps
   * `AccessDecision.allowedSkills` here; the gateway leaves it `undefined`
   * (it grants nothing — see bus-inbound-sink.ts).
   */
  allowedSkills: string[] | undefined;
  timeoutMs: number | undefined;
  cwd: string | undefined;
  additionalArgs: string[] | undefined;
  channel: string | undefined;
  network: string | undefined;
  project: string | undefined;
  entity: string | undefined;
  principal: string | undefined;
  /**
   * cortex#651 (F-1b) — **routing** principal for the publish SUBJECT, distinct
   * from {@link principal} (which is author/identity metadata stamped into the
   * payload body, e.g. the per-stack path passes `msg.authorName`).
   *
   * The surface gateway serves MULTIPLE principals on one shared bus. A
   * cross-principal binding's inbound request must land on the BOUND stack's
   * runner subscription at `local.{bindingPrincipal}.{stack}.tasks.*`
   * (dispatch-listener.ts), NOT on the gateway principal's subject. The
   * gateway sink sets this to the binding's parsed principal
   * (`match.principal`).
   *
   * When `undefined`, the subject falls back to `source.principal` — the
   * EXACT pre-F-1b behaviour. The per-stack `dispatch-handler` path never sets
   * this field, so its subject derivation is byte-for-byte unchanged. Gap-4
   * gateway bindings (no parsed principal) leave this `undefined` and thus
   * fall back to the gateway principal, which is the intended gap-4 default.
   *
   * F-1 (#629) wired the OUTBOUND (reply) leg per-principal; this field
   * completes the INBOUND (request) leg, closing #629's cross-principal goal.
   */
  subjectPrincipal?: string;
  /**
   * cortex#486 — PolicyEngine consulted at publish time to resolve the
   * inbound `(platform, authorId)` tuple to a registered principal id.
   * The adapter is the right layer for this lookup per
   * CONTEXT.md §Dispatch-source — `originator.identity` MUST carry the
   * **resolved** principal DID (`did:mf:<principal-id>`), never a
   * platform-prefixed snowflake. When the engine is absent OR cannot
   * resolve the tuple, the publish is refused with reason
   * `invalid-originator`; the caller surfaces a degraded dispatch.
   */
  policyEngine: PolicyEngine | undefined;
  /**
   * cortex#1167 — pre-resolved originator DID that BYPASSES the normal
   * `adapterOriginatorIdentity` platform-tuple resolution. Set ONLY by the
   * open-onboarding anon path (an unmapped sender, admitted by a flagged
   * concierge agent, has no registered principal so the normal resolver would
   * reject the envelope with `invalid-originator` and the concierge would
   * never reply).
   *
   * Security: applied ONLY when present, and the ONLY caller that sets it is
   * the anon gate (guarded by `access.anonPrincipal === true`). Every real /
   * mapped / peer / federated dispatch leaves it `undefined`, so originator
   * validation for those paths is BYTE-UNCHANGED — they still resolve through
   * `adapterOriginatorIdentity` and are still rejected when unresolvable. The
   * override DID resolves to no registered principal; it is a syntactically-
   * valid label for the one inbound chat envelope only and grants nothing.
   */
  originatorIdentityOverride?: string;
}

export interface DispatchSourcePublishResult {
  published: boolean;
  subject?: string;
  reason?:
    | "missing-runtime"
    | "missing-publish-on-subject"
    | "subject-build-failed"
    | "invalid-originator"
    | "envelope-build-failed"
    | "publish-failed";
}

/**
 * Resolve a platform-side author identifier to a registered principal DID
 * (`did:mf:<principal-id>`), suitable for `originator.identity` on an
 * inbound dispatch envelope.
 *
 * cortex#486 — resolution belongs at the dispatch source (this layer),
 * not at the consume-side resolver. Per CONTEXT.md §Dispatch-source the
 * adapter populates `originator.identity` with the **resolved** human/
 * agent DID. Pre-#486 this function emitted a platform-prefixed DID
 * (`did:mf:<platform>-<authorId>`) which forced the runner's
 * `resolvePrincipalId` to do a reverse-lookup. That snowflake DID shape
 * is no longer produced anywhere in the codebase.
 *
 * Returns:
 *   - `did:mf:<principal-id>` when the engine maps `(platform, authorId)`
 *     to a registered principal AND the result passes myelin's `DID_RE`.
 *   - `null` when the engine is absent (boot-without-policy), the tuple
 *     isn't registered (unknown platform identity), OR the resolved id
 *     can't be encoded as a DID-grammar-compliant tail. The caller
 *     refuses the publish with a clear `invalid-originator` reason — no
 *     anonymous-principal fallback, no platform-prefixed leakage.
 */
export function adapterOriginatorIdentity(
  engine: PolicyEngine | undefined,
  platform: string,
  authorId: string,
): string | null {
  if (engine === undefined) return null;
  const principalId = engine.lookupPrincipalIdByPlatformId(
    platform.toLowerCase(),
    authorId,
  );
  if (principalId === undefined) return null;
  const candidate = `did:mf:${principalId}`;
  if (DID_RE.test(candidate)) return candidate;
  return null;
}

/**
 * cortex#491 — derive **response routing** from the inbound platform
 * message (CONTEXT.md §Response-routing). The originating surface address
 * `{ adapter_instance, channel_id, thread_id? }` is stamped onto the
 * inbound payload so the runner can echo it onto the lifecycle envelopes
 * and the originating **dispatch sink** can deliver the reply to the right
 * channel/thread without keeping inbound state.
 *
 * `thread_id` is omitted (not present on the wire) when the message did
 * not arrive in a thread/DM — the sink falls back to channel-scope
 * delivery, matching `ResponseTarget`'s `threadId ?? channelId` convention.
 */
function responseRoutingFromMessage(msg: InboundMessage): ResponseRouting {
  return {
    adapter_instance: msg.instanceId,
    channel_id: msg.channelId,
    ...(msg.threadId !== undefined && { thread_id: msg.threadId }),
  };
}

function buildDirectTaskPublishSubject(
  principal: string,
  targetDid: string,
  stack: string | undefined,
  capability: string,
): string {
  const wildcard = directTaskSubject(principal, targetDid, stack);
  if (!wildcard.endsWith(".>")) {
    throw new Error(`directTaskSubject returned unexpected shape: ${wildcard}`);
  }
  return `${wildcard.slice(0, -2)}.${capability}`;
}

export async function publishInboundChatDispatchEnvelope(
  opts: InboundChatDispatchPublishOpts,
): Promise<DispatchSourcePublishResult> {
  if (!opts.runtime || !opts.source) {
    return { published: false, reason: "missing-runtime" };
  }
  if (typeof opts.runtime.publishOnSubject !== "function") {
    return { published: false, reason: "missing-publish-on-subject" };
  }

  const targetDid = `did:mf:${opts.agentName}`;
  // cortex#651 (F-1b) — derive the SUBJECT principal. Cross-principal gateway
  // bindings set `subjectPrincipal` to the binding's parsed principal so the
  // request lands on the BOUND stack's subscription. Absent (per-stack path,
  // gap-4 gateway bindings, same-principal) → fall back to `source.principal`,
  // the exact pre-F-1b behaviour. Note: this is distinct from the payload
  // `principal` field, which carries author/identity metadata.
  const subjectPrincipal = opts.subjectPrincipal ?? opts.source.principal;
  let subject: string;
  try {
    subject = buildDirectTaskPublishSubject(
      subjectPrincipal,
      targetDid,
      opts.stack,
      "chat",
    );
  } catch (err) {
    console.error(
      "dispatch-source: failed to compose canonical tasks subject:",
      err instanceof Error ? err.message : String(err),
    );
    return { published: false, reason: "subject-build-failed" };
  }

  // cortex#1167 — open-onboarding anon path supplies a pre-resolved DID so the
  // unmapped (zero-authority) sender is a valid originator OF ITS OWN inbound
  // chat. The override is applied ONLY when explicitly set; otherwise the
  // normal resolver runs and still rejects unresolvable tuples — real/mapped/
  // peer/federated dispatches are unaffected.
  let originatorIdentity: string | null;
  if (opts.originatorIdentityOverride !== undefined) {
    originatorIdentity = opts.originatorIdentityOverride;
  } else {
    originatorIdentity = adapterOriginatorIdentity(
      opts.policyEngine,
      opts.msg.platform,
      opts.msg.authorId,
    );
  }
  if (originatorIdentity === null) {
    console.error(
      `dispatch-source: cannot resolve platform identity to a registered principal — platform=${opts.msg.platform} authorId=${opts.msg.authorId}` +
        (opts.policyEngine === undefined
          ? " (no policy engine wired — boot without policy:)"
          : " (engine: unknown platform tuple)"),
    );
    return { published: false, subject, reason: "invalid-originator" };
  }

  const payload: Record<string, unknown> = {
    task_id: opts.taskId,
    agent_id: opts.agentName,
    prompt: opts.prompt,
    // cortex#491 — originating surface address; the runner echoes this onto
    // every lifecycle envelope so the dispatch sink can post the reply back.
    response_routing: responseRoutingFromMessage(opts.msg),
    // GV-2 (cortex#1077): DUAL-WRITE the channel/network labels onto the
    // dispatch payload — canonical `cortex_*` AND legacy `grove_*` aliases.
    // The listener reads cortex-first; the grove aliases retire at v3.0.0
    // (cortex#774 lockstep).
    ...(opts.channel !== undefined && { cortex_channel: opts.channel, grove_channel: opts.channel }),
    ...(opts.network !== undefined && { cortex_network: opts.network, grove_network: opts.network }),
    agent_name: opts.agentDisplayName,
    ...(opts.resumeSessionId !== undefined && {
      resume_session_id: opts.resumeSessionId,
    }),
    ...(opts.disallowedTools.length > 0 && {
      disallowed_tools: opts.disallowedTools,
    }),
    // cortex#1167 — explicit tool ALLOWLIST (anon open-onboarding path only).
    // Non-empty → the runner confines the session to exactly these tools.
    ...(opts.allowedTools !== undefined && opts.allowedTools.length > 0 && {
      allowed_tools: opts.allowedTools,
    }),
    // cortex#710 — carry the per-skill grant list when the source decided
    // one. Emitted even for `[]` (explicit no-skills) so the runner can
    // distinguish "no decision" (field absent) from "decided: no skills".
    ...(opts.allowedSkills !== undefined && {
      allowed_skills: opts.allowedSkills,
    }),
    ...(opts.allowedDirs.length > 0 && { allowed_dirs: opts.allowedDirs }),
    ...(opts.timeoutMs !== undefined && { timeout_ms: opts.timeoutMs }),
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    ...(opts.additionalArgs !== undefined &&
      opts.additionalArgs.length > 0 && { additional_args: opts.additionalArgs }),
    ...(opts.project !== undefined && { project: opts.project }),
    ...(opts.entity !== undefined && { entity: opts.entity }),
    ...(opts.principal !== undefined && { principal: opts.principal }),
  };

  let envelope: Envelope;
  try {
    const base = buildBaseEnvelope({
      type: "tasks.chat",
      source: `${opts.source.principal}.${opts.source.agent}.${opts.source.instance}`,
      correlationId: opts.taskId,
      sovereignty: {
        classification: "local",
        data_residency: opts.source.dataResidency ?? "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload,
    });
    envelope = {
      ...base,
      distribution_mode: "direct",
      target_assistant: targetDid,
      originator: {
        identity: originatorIdentity,
        attribution: "adapter-resolved",
      },
    };
  } catch (err) {
    console.error(
      "dispatch-source: failed to build inbound dispatch envelope:",
      err instanceof Error ? err.message : String(err),
    );
    return { published: false, subject, reason: "envelope-build-failed" };
  }

  try {
    await opts.runtime.publishOnSubject(envelope, subject);
  } catch (err) {
    console.error(
      `dispatch-source: publishOnSubject(${subject}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return { published: false, subject, reason: "publish-failed" };
  }

  return { published: true, subject };
}
