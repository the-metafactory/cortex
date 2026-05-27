import { directTaskSubject } from "@the-metafactory/myelin/subjects";
import { DID_RE } from "@the-metafactory/myelin/identity";
import type { InboundMessage } from "../adapters/types";
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
  timeoutMs: number | undefined;
  cwd: string | undefined;
  additionalArgs: string[] | undefined;
  groveChannel: string | undefined;
  groveNetwork: string | undefined;
  project: string | undefined;
  entity: string | undefined;
  operator: string | undefined;
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
 * Map a platform-side author identifier onto a DID-grammar-compliant
 * `did:mf:<name>` string suitable for `originator.identity`.
 */
export function adapterOriginatorIdentity(
  platform: string,
  authorId: string,
): string | null {
  const prefix = platform.toLowerCase();
  const safeId = authorId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const candidate = `did:mf:${prefix}-${safeId}`;
  if (DID_RE.test(candidate)) return candidate;
  return null;
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
  let subject: string;
  try {
    subject = buildDirectTaskPublishSubject(
      opts.source.principal,
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

  const originatorIdentity = adapterOriginatorIdentity(
    opts.msg.platform,
    opts.msg.authorId,
  );
  if (originatorIdentity === null) {
    console.error(
      `dispatch-source: cannot derive DID-valid originator identity for platform=${opts.msg.platform} authorId=${opts.msg.authorId}`,
    );
    return { published: false, subject, reason: "invalid-originator" };
  }

  const payload: Record<string, unknown> = {
    task_id: opts.taskId,
    agent_id: opts.agentName,
    prompt: opts.prompt,
    ...(opts.groveChannel !== undefined && { grove_channel: opts.groveChannel }),
    ...(opts.groveNetwork !== undefined && { grove_network: opts.groveNetwork }),
    agent_name: opts.agentDisplayName,
    ...(opts.resumeSessionId !== undefined && {
      resume_session_id: opts.resumeSessionId,
    }),
    ...(opts.disallowedTools.length > 0 && {
      disallowed_tools: opts.disallowedTools,
    }),
    ...(opts.allowedDirs.length > 0 && { allowed_dirs: opts.allowedDirs }),
    ...(opts.timeoutMs !== undefined && { timeout_ms: opts.timeoutMs }),
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    ...(opts.additionalArgs !== undefined &&
      opts.additionalArgs.length > 0 && { additional_args: opts.additionalArgs }),
    ...(opts.project !== undefined && { project: opts.project }),
    ...(opts.entity !== undefined && { entity: opts.entity }),
    ...(opts.operator !== undefined && { operator: opts.operator }),
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
