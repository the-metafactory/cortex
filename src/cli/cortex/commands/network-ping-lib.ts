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
  PROBE_ECHO_CAPABILITY,
  PROBE_REPLY_ECHO_TYPE,
  type ProbeEchoReplyPayload,
} from "../../../bus/probe-responder";
import type { LoadedConfig } from "../../../common/config/loader";
import type {
  LeafzCounters,
  NetworkPingPorts,
} from "./network-ping-ports";

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
  const matchingNetworks = scoped.filter((n) =>
    n.peers.some(
      (p) =>
        p.principal_id === opts.targetPrincipal && p.stack_id === targetStackId,
    ),
  );
  const isConfiguredPeer = matchingNetworks.length > 0;

  // cortex#1728 (guard 4) — the network's `leaf_node` scopes the leafz sampler.
  // Resolve it ONLY when exactly one network carries this peer with a distinct
  // leaf_node: if the peer sits on multiple networks with DIFFERENT leaves (no
  // `--network` selector), we can't tell which leaf the probe rides, so we leave
  // it undefined (the sampler omits the diagnostic rather than sample the wrong
  // leaf). Two networks that share ONE `leaf_node` (the pool-key case) collapse
  // to that single unambiguous leaf.
  const distinctLeafNodes = [
    ...new Set(matchingNetworks.map((n) => n.leaf_node)),
  ];
  const networkLeafNode =
    distinctLeafNodes.length === 1 ? distinctLeafNodes[0] : undefined;

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
      ...(networkLeafNode !== undefined && { networkLeafNode }),
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
  /**
   * cortex#1728 (guard 4) — the `leaf_node` name of the network the probe rides
   * (the network whose `peers[]` contains the target). The leafz sampler scopes
   * its `/leafz` read to THIS leaf so the counter delta reflects only this
   * network's traffic, never a sibling leaf's heartbeats. `undefined` when the
   * network's `leaf_node` can't be resolved (peer in multiple networks with no
   * `--network` selector, or none declares a leaf_node) — the sampler then omits
   * the diagnostic rather than misattribute.
   */
  networkLeafNode?: string;
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

/**
 * cortex#1728 (guard 4) — which half of the leaf path a `timeout` failure lives
 * on, folded from the local `/leafz` counter delta measured across the probe
 * volley.
 *
 *   - `remote`       — probes crossed the leaf (`out` +N) but no echo returned
 *                      (`in` +0): the peer responder / echo leg is broken, NOT
 *                      our egress.
 *   - `local-egress` — nothing left the leaf (`out` +0): OUR egress is broken
 *                      (leaf account / binding), not the peer.
 *   - `inconclusive` — counters moved in a shape that does not cleanly
 *                      disambiguate (e.g. `out` +0 AND `in` +N, or unchanged
 *                      because another sender shares the leaf): report the raw
 *                      delta without a directional claim.
 */
export type LeafzHalf = "remote" | "local-egress" | "inconclusive";

/**
 * cortex#1728 (guard 4) — the structured leafz diagnosis attached to a ping
 * result. Present only when a before/after `/leafz` sample was obtained AND the
 * verdict is `timeout` (the only verdict the half-disambiguation informs).
 */
export interface LeafzDiagnosis {
  /** Which half the failure is on. */
  half: LeafzHalf;
  /** `out_msgs` delta across the probe volley (probes that left the leaf). */
  outDelta: number;
  /** `in_msgs` delta across the probe volley (echoes that returned). */
  inDelta: number;
  /** The rendered, human-facing diagnostic line. */
  line: string;
}

export interface PingResult {
  /** The overall verdict — the worst/most-informative across all probes. */
  verdict: PingVerdict;
  exitCode: number;
  probes: PingProbeResult[];
  stats: PingStats;
  /** Human-facing reason when not reachable (surfaced in the CLI output). */
  detail?: string;
  /**
   * cortex#1728 (guard 4) — best-effort local-`/leafz` half-disambiguation for a
   * `timeout` verdict. Absent when no leafz sampler was wired, a sample failed,
   * or the verdict is not `timeout`. Additive diagnostic context; never gates.
   */
  leafz?: LeafzDiagnosis;
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
  return {
    id: crypto.randomUUID(),
    // `source` addresses the TARGET stack (ADR-0002 §1) — the sender assistant
    // is our own assistant id.
    source: `${inputs.targetPrincipal}.${inputs.targetStack}.${inputs.requesterAssistant}`,
    // cortex#1728 — the envelope `type` is the plain CAPABILITY (`probe.echo`),
    // schema-valid under the envelope `type` pattern. The `@{enc-did}` DID
    // segment is a SUBJECT-routing construct (encodeDidSegment → the subject's
    // `tasks.@{assistant}.{capability}` form, built in buildProbeRequestSubject)
    // — putting it in `type` made the type schema-INVALID (`@` fails the
    // pattern), so the peer's envelope validator dropped every probe. Direct
    // addressing rides in distribution_mode:"direct" + target_assistant, not the
    // type. isProbeEcho() recognises the bare `probe.echo` capability.
    type: PROBE_ECHO_CAPABILITY,
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
    // cortex#1728 — a Direct probe IS a direct-addressed dispatch, so the F-021
    // envelope rule (`target_assistant` required when distribution_mode ===
    // "direct" | "delegate", envelope-validator.ts) applies. The emitter already
    // has the target DID (it encodes it into the subject above) — omitting it
    // here made every probe schema-invalid, dropped at the peer's subscriber
    // BEFORE the probe-responder saw it (0 echoes, the whole ping gap). Stamp it.
    target_assistant: inputs.targetAssistantDid,
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
// cortex#1728 (guard 4) — leafz half-disambiguation
// ---------------------------------------------------------------------------

/**
 * cortex#1728 (guard 4) — diagnose WHICH half of the leaf path a `timeout`
 * failure lives on, from the local `/leafz` counter delta measured across the
 * probe volley.
 *
 * Live evidence (the first two-principal join): the monitor delta was decisive
 * both times.
 *
 *   - `out` incremented, `in` +0 ⇒ probes crossed the leaf but no echo returned
 *     ⇒ the failure is REMOTE (peer responder / echo leg), not local egress;
 *   - `out` +0 ⇒ nothing left the leaf ⇒ LOCAL egress is broken (leaf
 *     account/binding), not the peer.
 *
 * Any other shape (e.g. `out` +0 AND `in` +N, or a negative delta from a
 * counter reset / reconnect between samples) is `inconclusive` — report the raw
 * numbers without a directional claim rather than assert a wrong half.
 *
 * PURE — no I/O; the ports supply the two samples. Returns `undefined` when
 * either sample is missing (nothing to diff) so the caller omits the line.
 */
export function diagnoseLeafzDelta(
  before: LeafzCounters | undefined,
  after: LeafzCounters | undefined,
): LeafzDiagnosis | undefined {
  if (before === undefined || after === undefined) return undefined;
  const outDelta = after.outMsgs - before.outMsgs;
  const inDelta = after.inMsgs - before.inMsgs;

  // A negative delta means the counter went BACKWARDS between samples (leaf
  // reconnect / server restart reset the counters) — the diff is meaningless,
  // so we cannot claim a half.
  if (outDelta < 0 || inDelta < 0) {
    return {
      half: "inconclusive",
      outDelta,
      inDelta,
      line: `leafz counters moved unexpectedly (out ${fmtDelta(outDelta)}, in ${fmtDelta(inDelta)}) — leaf may have reconnected mid-probe; cannot localise the failure`,
    };
  }

  if (outDelta > 0 && inDelta === 0) {
    return {
      half: "remote",
      outDelta,
      inDelta,
      line: `${outDelta} probe(s) crossed the leaf (out ${fmtDelta(outDelta)}) but no echo returned (in +0) — the failure is REMOTE (peer responder / echo leg), not local egress`,
    };
  }

  if (outDelta === 0) {
    return {
      half: "local-egress",
      outDelta,
      inDelta,
      line: `0 probes left the leaf (out +0) — LOCAL egress is broken (leaf account/binding, not the peer)`,
    };
  }

  // out +N AND in +N, or any other non-directional shape: a reply DID come back
  // over the leaf yet the ping still timed out (nonce mismatch, slow echo,
  // shared-leaf noise). Report the raw delta without asserting a half.
  return {
    half: "inconclusive",
    outDelta,
    inDelta,
    line: `leaf counters advanced on both legs (out ${fmtDelta(outDelta)}, in ${fmtDelta(inDelta)}) but the probe timed out — traffic crossed both ways; the failure is not a clean egress/echo split`,
  };
}

/** Format a non-negative counter delta as `+N` (negatives kept as-is). */
function fmtDelta(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
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

  // cortex#1728 (guard 4) — sample THIS network's leaf `/leafz` counters BEFORE
  // the probe volley so a `timeout` verdict can be localised to a half from the
  // delta. Scoped to `inputs.networkLeafNode` (never summed across sibling
  // leaves — the #1731 review BLOCK). Best-effort: an unresolvable leaf_node or
  // a failed sample just omits the diagnostic line.
  const leafzBefore = await sampleLeafzBestEffort(ports, inputs.networkLeafNode);

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

  // cortex#1728 (guard 4) — sample AFTER the volley; diff against the before
  // sample to localise the failure. Only meaningful for `timeout` (the verdict
  // whose four-way cause list this delta disambiguates); computed here but
  // attached below only when the overall verdict is `timeout`.
  const leafzAfter = await sampleLeafzBestEffort(ports, inputs.networkLeafNode);
  const leafzDiagnosis = diagnoseLeafzDelta(leafzBefore, leafzAfter);

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
    // cortex#1728 (guard 4) — fold the leafz half-disambiguation into a
    // `timeout` verdict only (the verdict whose ambiguous cause list it
    // resolves). Omitted for reachable / not-configured, and whenever no
    // before/after sample was obtained.
    ...(overall === "timeout" && leafzDiagnosis !== undefined
      ? { leafz: leafzDiagnosis }
      : {}),
  };
}

/**
 * cortex#1728 (guard 4) — read THIS network's leaf `/leafz` counters if a
 * sampler is wired AND the network's `leaf_node` is known, swallowing ANY
 * failure to `undefined`. The whole guard is additive diagnostic context: a
 * leafz read must NEVER fail or perturb the ping. A missing `leafNode` (peer on
 * multiple networks with no `--network` selector) omits the sample rather than
 * risk sampling the wrong leaf.
 */
async function sampleLeafzBestEffort(
  ports: NetworkPingPorts,
  leafNode: string | undefined,
): Promise<LeafzCounters | undefined> {
  if (ports.leafz === undefined || leafNode === undefined) return undefined;
  try {
    return await ports.leafz.sample(leafNode);
  } catch (err) {
    // Best-effort: a failed leafz read degrades to "no diagnostic line", never
    // a failed ping. Log to stderr so the read failure is not silent.
    process.stderr.write(
      `network-ping: leafz sample failed (diagnostic line omitted): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
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
