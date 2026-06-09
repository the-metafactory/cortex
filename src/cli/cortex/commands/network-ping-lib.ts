/**
 * `cortex network ping` — PURE orchestration (signal#113 P-11 /
 * `docs/design-network-ping.md` §3, issue #56).
 *
 * Fires the Direct probe at a configured peer, awaits the echo on our own
 * `probe.reply.echo`, measures RTT, and returns the verdict per the §3.3
 * taxonomy + exit codes. Pure over {@link NetworkPingPorts}: no bus, no
 * config, no clock here — the live adapter (`network.ts`) wires those; tests
 * inject a fake bus.
 *
 * ## Wire grammar (ADR-0001 / ADR-0002 — the request half)
 *
 *   REQUEST (us → peer), Direct mode:
 *     subject     federated.{target}.{target-stack}.tasks.@{enc-target-did}.probe.echo
 *     source      {target}.{target-stack}.{our-assistant}   — addresses the TARGET
 *     originator  did:mf:{us}-{our-stack}                    — the REQUESTER (us)
 *     type        tasks.@{enc-target-did}.probe.echo
 *     classification federated · distribution_mode direct · max_hop 1 · NO network_id
 *     correlation_id <uuid> · payload { nonce, sent_at, seq }
 *
 *   REPLY (peer → us): subscribed on `federated.{us}.{our-stack}.probe.reply.>`,
 *   matched by `correlation_id`.
 *
 * The network is NEVER on the wire — `selectLink` resolves the target leaf from
 * the target principal's `peers[]` membership (FG-1). A target not in OUR
 * `peers[]` ⇒ `not-configured` (exit 2, nothing emitted).
 */

import { encodeDidSegment } from "@the-metafactory/myelin/subjects";

import type { Envelope } from "../../../bus/myelin/envelope-validator";
import {
  PROBE_REPLY_ECHO_TYPE,
  type ProbeEchoReplyPayload,
} from "../../../bus/probe-responder";
import type { LoadedConfig } from "../../../common/config/loader";
import type { NetworkPingPorts } from "./network-ping-ports";

// ---------------------------------------------------------------------------
// Config derivation (the #753 config-derivation seam, ping subset)
// ---------------------------------------------------------------------------

/** Resolve the requester stack slug from `stack.id` (`{principal}/{slug}`). */
function requesterStackSlug(principal: string, cfg: LoadedConfig): string {
  const id = cfg.stack?.id;
  if (id === undefined) return "default";
  const parts = id.split("/");
  // `{principal}/{slug}` — take the slug; fall back to the whole id if it's
  // not in slash form (defensive — schema enforces the slash form).
  const slug = parts[1];
  if (parts.length === 2 && parts[0] === principal && slug !== undefined) {
    return slug;
  }
  return slug ?? id;
}

/** The result of resolving ping inputs from config + CLI flags. */
export interface PingDeriveResult {
  ok: boolean;
  inputs?: PingInputs;
  /** Actionable, field-naming error when a required value can't be resolved. */
  reason?: string;
}

/**
 * Derive the {@link PingInputs} from the loaded config + CLI selections, and
 * resolve whether the target is a configured peer in OUR
 * `policy.federated.networks[].peers[]`.
 *
 *   - requester principal/stack/assistant come from config (the #753 seam);
 *   - the target principal/stack come from the `<peer>` positional;
 *   - `--assistant` overrides the target assistant DID (Direct routing); when
 *     omitted it defaults to the target stack's reserved DID
 *     `did:mf:{target}-{target-stack}` (spec §8 default-assistant follow-up);
 *   - `isConfiguredPeer` is `true` iff the target `{principal}/{stack}` appears
 *     in some configured network's `peers[]` (spec §3.3 `not-configured` gate).
 *
 * When `--network <id>` is supplied, peer resolution is scoped to that
 * network's `peers[]` (the topology selector, NEVER a wire segment — ADR-0002 §4).
 */
export function derivePingInputs(opts: {
  cfg: LoadedConfig;
  targetPrincipal: string;
  targetStack: string;
  assistant?: string;
  network?: string;
  count: number;
  timeoutMs: number;
  /** Flag overrides for principal / stack (parity with join). */
  principalOverride?: string;
  stackSlugOverride?: string;
}): PingDeriveResult {
  const { cfg } = opts;
  const requesterPrincipal = opts.principalOverride ?? cfg.principal?.id;
  if (requesterPrincipal === undefined || requesterPrincipal === "") {
    return {
      ok: false,
      reason:
        "cannot resolve principal — pass --principal or set `principal.id` in cortex.yaml",
    };
  }
  const requesterStack =
    opts.stackSlugOverride ?? requesterStackSlug(requesterPrincipal, cfg);

  // Our assistant id — the first declared agent, else the stack slug as a
  // best-effort label (only used as the `source` sender segment + reply
  // `source.agent`; the routing identity is the originator DID).
  const requesterAssistant = cfg.inlineAgents[0]?.id ?? requesterStack;

  // Target assistant DID — `--assistant` overrides; default to the target
  // stack's reserved DID.
  const targetAssistantDid =
    opts.assistant !== undefined
      ? `did:mf:${opts.assistant}`
      : `did:mf:${opts.targetPrincipal}-${opts.targetStack}`;

  // peers[] membership — fail-closed `not-configured` when the target is in no
  // configured network's peers[]. Scope to `--network` when supplied.
  const networks = cfg.policy?.federated?.networks ?? [];
  const targetStackId = `${opts.targetPrincipal}/${opts.targetStack}`;
  const scoped =
    opts.network !== undefined
      ? networks.filter((n) => n.id === opts.network)
      : networks;
  const isConfiguredPeer = scoped.some((n) =>
    n.peers.some(
      (p) =>
        p.principal_id === opts.targetPrincipal && p.stack_id === targetStackId,
    ),
  );

  return {
    ok: true,
    inputs: {
      requesterPrincipal,
      requesterStack,
      requesterAssistant,
      targetPrincipal: opts.targetPrincipal,
      targetStack: opts.targetStack,
      targetAssistantDid,
      count: opts.count,
      timeoutMs: opts.timeoutMs,
      isConfiguredPeer,
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict taxonomy (spec §3.3)
// ---------------------------------------------------------------------------

/**
 * The §3.3 verdict taxonomy + exit codes:
 *   reachable (0) · not-configured (2) · no-responder (3) · timeout (4) · refused (5)
 *
 * v1 is **timeout-only**: in the pure-echo design the requester cannot directly
 * distinguish "routed but no responder" from "no route at all", so everything-
 * not-reachable that produced no reply is `timeout`. `no-responder` /
 * `refused` are reserved in the taxonomy + carried as types for Ping-B's P-13
 * roster-correlation refinement; v1 emits `reachable`, `not-configured`, and
 * `timeout`. A `publish-failed` (no resolvable leaf route) is `not-configured`.
 */
export type PingVerdict =
  | "reachable"
  | "not-configured"
  | "no-responder"
  | "timeout"
  | "refused";

export const VERDICT_EXIT_CODE: Record<PingVerdict, number> = {
  reachable: 0,
  "not-configured": 2,
  "no-responder": 3,
  timeout: 4,
  refused: 5,
};

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface PingInputs {
  /** Our principal id (the requester). */
  requesterPrincipal: string;
  /** Our stack slug (the requester stack). */
  requesterStack: string;
  /** Our assistant id (the `source` sender segment + reply `source.agent`). */
  requesterAssistant: string;
  /** Target peer principal. */
  targetPrincipal: string;
  /** Target peer stack slug (defaults to `default` at the CLI boundary). */
  targetStack: string;
  /**
   * The target assistant DID for the Direct probe's `@{enc-did}` segment.
   * Defaults at the CLI boundary to the target stack's reserved DID
   * (`did:mf:{target}-{target-stack}`) when `--assistant` is omitted.
   */
  targetAssistantDid: string;
  /** Number of probes to send (`ping -c`). */
  count: number;
  /** Per-probe timeout (ms). */
  timeoutMs: number;
  /**
   * Whether the target is a configured peer in OUR `peers[]`. Resolved by the
   * caller from config; `false` ⇒ `not-configured` (nothing emitted).
   */
  isConfiguredPeer: boolean;
}

/** One probe's result row (for per-seq reporting). */
export interface PingProbeResult {
  seq: number;
  verdict: PingVerdict;
  rttMs?: number;
}

export interface PingStats {
  sent: number;
  received: number;
  /** Loss as a fraction 0..1. */
  loss: number;
  rttMinMs?: number;
  rttAvgMs?: number;
  rttMaxMs?: number;
}

export interface PingResult {
  /** The overall verdict — the worst/most-informative across all probes. */
  verdict: PingVerdict;
  exitCode: number;
  probes: PingProbeResult[];
  stats: PingStats;
  /** Human-facing reason when not reachable (surfaced in the CLI output). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Subject + envelope construction
// ---------------------------------------------------------------------------

/**
 * Compose the Direct federated probe request subject. The `@{enc-did}` segment
 * addresses the target assistant; the `{target}.{target-stack}` segments
 * address the target stack (FG-2). The network is NOT a segment (FG-1).
 */
export function buildProbeRequestSubject(
  targetPrincipal: string,
  targetStack: string,
  targetAssistantDid: string,
): string {
  const enc = encodeDidSegment(targetAssistantDid);
  return `federated.${targetPrincipal}.${targetStack}.tasks.${enc}.probe.echo`;
}

/** The requester's reply subscription pattern (our own scope). */
export function buildReplySubjectPattern(
  requesterPrincipal: string,
  requesterStack: string,
): string {
  return `federated.${requesterPrincipal}.${requesterStack}.probe.reply.>`;
}

/**
 * Build one Direct probe request envelope. `source` addresses the TARGET (so
 * `deriveNatsSubject`/`selectLink` route there); `originator.identity` carries
 * the REQUESTER DID (the reply-to); `type` mirrors the Direct capability.
 */
export function buildProbeRequestEnvelope(opts: {
  inputs: PingInputs;
  nonce: string;
  correlationId: string;
  seq: number;
}): Envelope {
  const { inputs, nonce, correlationId, seq } = opts;
  const enc = encodeDidSegment(inputs.targetAssistantDid);
  return {
    id: crypto.randomUUID(),
    // `source` addresses the TARGET stack (ADR-0002 §1) — the sender assistant
    // is our own assistant id.
    source: `${inputs.targetPrincipal}.${inputs.targetStack}.${inputs.requesterAssistant}`,
    type: `tasks.${enc}.probe.echo`,
    distribution_mode: "direct",
    timestamp: new Date().toISOString(),
    correlation_id: correlationId,
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 1,
      frontier_ok: false,
      model_class: "local-only",
    },
    // `originator` carries the REQUESTER (us) — the DID the responder decodes
    // to key the reply back. `did:mf:{principal}-{stack}` per ADR-0002 §1.
    originator: {
      identity: `did:mf:${inputs.requesterPrincipal}-${inputs.requesterStack}`,
      attribution: "federated",
    },
    payload: {
      nonce,
      sent_at: new Date().toISOString(),
      seq,
    },
  };
}

// ---------------------------------------------------------------------------
// Verdict classification
// ---------------------------------------------------------------------------

/**
 * Classify ONE probe round-trip into a verdict (v1 timeout-only).
 *
 *   - a matched reply with a well-formed echo payload ⇒ `reachable`;
 *   - a matched reply with a MALFORMED payload ⇒ `no-responder` (something
 *     answered but not a conformant echo — e.g. an old responder);
 *   - a timeout ⇒ `timeout`;
 *   - a publish-failure (no leaf route) ⇒ `not-configured`.
 *
 * The echoed nonce MUST match the request nonce — a mismatched nonce is treated
 * as `no-responder` (a non-conformant / confused responder), never `reachable`.
 */
export function classifyRoundTrip(
  result:
    | { kind: "reply"; rttMs: number; reply: Envelope }
    | { kind: "timeout" }
    | { kind: "publish-failed"; reason: string },
  expectedNonce: string,
): { verdict: PingVerdict; rttMs?: number; detail?: string } {
  if (result.kind === "publish-failed") {
    return { verdict: "not-configured", detail: result.reason };
  }
  if (result.kind === "timeout") {
    return { verdict: "timeout" };
  }
  const payload = result.reply.payload as
    | Partial<ProbeEchoReplyPayload>
    | undefined;
  if (
    result.reply.type !== PROBE_REPLY_ECHO_TYPE ||
    payload === undefined ||
    typeof payload.nonce !== "string" ||
    payload.nonce !== expectedNonce
  ) {
    return {
      verdict: "no-responder",
      detail: "reply received but echo payload did not match (old/non-conformant responder)",
    };
  }
  return { verdict: "reachable", rttMs: result.rttMs };
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * Fire `count` Direct probes at the target peer, await each echo, aggregate
 * RTT + loss, and return the verdict + exit code. Pure over the ports.
 */
export async function pingPeer(
  inputs: PingInputs,
  ports: NetworkPingPorts,
): Promise<PingResult> {
  // Fail-closed at OUR publish boundary: a target not in our peers[] never
  // emits (FG-4 / spec §3.3 `not-configured`, exit 2).
  if (!inputs.isConfiguredPeer) {
    return {
      verdict: "not-configured",
      exitCode: VERDICT_EXIT_CODE["not-configured"],
      probes: [],
      stats: { sent: 0, received: 0, loss: 1 },
      detail: `peer "${inputs.targetPrincipal}/${inputs.targetStack}" is not in this stack's policy.federated.networks[].peers[]`,
    };
  }

  const probes: PingProbeResult[] = [];
  const rtts: number[] = [];
  const replySubjectPattern = buildReplySubjectPattern(
    inputs.requesterPrincipal,
    inputs.requesterStack,
  );

  for (let seq = 1; seq <= inputs.count; seq++) {
    const nonce = ports.newNonce();
    const correlationId = ports.newCorrelationId();
    const request = buildProbeRequestEnvelope({
      inputs,
      nonce,
      correlationId,
      seq,
    });
    const requestSubject = buildProbeRequestSubject(
      inputs.targetPrincipal,
      inputs.targetStack,
      inputs.targetAssistantDid,
    );

    const rt = await ports.bus.fireProbe({
      request,
      requestSubject,
      replySubjectPattern,
      correlationId,
      timeoutMs: inputs.timeoutMs,
    });

    const classified = classifyRoundTrip(rt, nonce);
    const probe: PingProbeResult = {
      seq,
      verdict: classified.verdict,
      ...(classified.rttMs !== undefined && { rttMs: classified.rttMs }),
    };
    probes.push(probe);
    if (classified.verdict === "reachable" && classified.rttMs !== undefined) {
      rtts.push(classified.rttMs);
    }
  }

  // Overall verdict: reachable iff at least one probe got a conformant echo.
  // Otherwise pick the most-informative failure across the probes
  // (no-responder > refused > timeout > not-configured precedence — a
  // responder-present signal is more useful than a bare timeout).
  const overall = aggregateVerdict(probes);

  const received = rtts.length;
  const sent = probes.length;
  const stats: PingStats = {
    sent,
    received,
    loss: sent === 0 ? 1 : (sent - received) / sent,
    ...(rtts.length > 0 && {
      rttMinMs: Math.min(...rtts),
      rttMaxMs: Math.max(...rtts),
      rttAvgMs: rtts.reduce((a, b) => a + b, 0) / rtts.length,
    }),
  };

  const detail = probes.find((p) => p.verdict === overall && overall !== "reachable");
  return {
    verdict: overall,
    exitCode: VERDICT_EXIT_CODE[overall],
    probes,
    stats,
    ...(detail !== undefined && overall !== "reachable"
      ? { detail: failureDetail(overall, inputs) }
      : {}),
  };
}

/** Pick the overall verdict from the per-probe verdicts. */
function aggregateVerdict(probes: PingProbeResult[]): PingVerdict {
  if (probes.some((p) => p.verdict === "reachable")) return "reachable";
  // Failure precedence — surface the most diagnostic.
  //
  // PR #822 NIT-5 — `refused` is RESERVED for Ping-B (P-13 roster correlation
  // / enforce-posture gate signal) and is NOT produced by any v1 transport
  // outcome (`classifyRoundTrip` only emits reachable / no-responder / timeout
  // / not-configured). It stays in the precedence list so the taxonomy is
  // complete and Ping-B is a drop-in; in v1 the `refused` branch is
  // unreachable. `no-responder` IS reachable in v1 (a reply with a mismatched
  // nonce / non-conformant payload).
  const order: PingVerdict[] = [
    "no-responder",
    "refused", // reserved for Ping-B (P-13 correlation); unreachable in v1
    "timeout",
    "not-configured",
  ];
  for (const v of order) {
    if (probes.some((p) => p.verdict === v)) return v;
  }
  return "timeout";
}

function failureDetail(verdict: PingVerdict, inputs: PingInputs): string {
  const peer = `${inputs.targetPrincipal}/${inputs.targetStack}`;
  switch (verdict) {
    case "no-responder":
      return `peer ${peer} routed the probe but did not echo a conformant reply (responder absent or too old)`;
    case "timeout":
      return `no echo from ${peer} within ${inputs.timeoutMs}ms (peer offline, leaf down, hub partition, or not gated in)`;
    case "refused":
      // PR #822 NIT-5 — reserved for Ping-B; v1 never emits `refused` from a
      // transport outcome, so this detail string is currently unreachable.
      return `peer ${peer} refused the probe (we are not in its peers[], or signing posture rejected us)`;
    case "not-configured":
      return `peer ${peer} is not reachable on any configured network`;
    case "reachable":
      return "";
  }
}
