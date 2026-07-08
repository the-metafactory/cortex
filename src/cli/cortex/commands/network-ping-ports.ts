/**
 * `cortex network ping` — injected-dependency seams (signal#113 P-11 /
 * `docs/design-network-ping.md`, issue #56).
 *
 * Mirrors the `network-ports.ts` pattern: the orchestrator (`network-ping-lib.ts`)
 * is PURE over these ports; the live adapter (in `network.ts`) wires the real
 * `MyelinRuntime`; tests inject a fake bus that never touches NATS or
 * `~/.config`.
 *
 * The probe is a SINGLE port — a "fire one probe, await its echo" round-trip —
 * so the orchestration (count loop, RTT aggregation, verdict classification,
 * exit codes) stays testable without a live bus.
 */

import type { Envelope } from "../../../bus/myelin/envelope-validator";

/**
 * One probe round-trip outcome from the bus port. The port fires the request
 * envelope on the federated subject, subscribes the requester's own
 * `probe.reply.echo`, matches by `correlation_id`, and resolves with either the
 * matched reply (+ measured RTT) or a timeout.
 *
 * The port does NOT classify the verdict — that is the orchestrator's job (it
 * maps `timeout` / reply-shape to the §3.3 taxonomy). The port only reports the
 * raw transport outcome.
 */
export type ProbeRoundTripResult =
  | {
      kind: "reply";
      /** Round-trip time in ms, measured single-clock on the requester. */
      rttMs: number;
      /** The matched reply envelope (for the orchestrator to inspect). */
      reply: Envelope;
    }
  | {
      kind: "timeout";
    }
  | {
      /**
       * The publish itself failed (e.g. no `selectLink` route resolvable for
       * the target principal — the peer is not reachable on any shared
       * network's leaf). Distinct from `timeout`: nothing went on the wire.
       */
      kind: "publish-failed";
      reason: string;
    };

/** Inputs the bus port needs to fire one probe + await its echo. */
export interface ProbeFireInputs {
  /** The request envelope (`source` addresses target, `originator` = us). */
  request: Envelope;
  /** The explicit federated request subject (publishOnSubject). */
  requestSubject: string;
  /**
   * The requester's own reply subject pattern to subscribe
   * (`federated.{us}.{our-stack}.probe.reply.>`).
   */
  replySubjectPattern: string;
  /** Join key — match an inbound reply on this `correlation_id`. */
  correlationId: string;
  /** Per-probe wait budget for the echo reply (ms). */
  timeoutMs: number;
}

/**
 * The bus seam. ONE method: fire a probe + await its echo. The live adapter
 * owns the runtime subscription lifecycle; the fake records the request +
 * returns a scripted outcome.
 */
export interface ProbeBusPort {
  fireProbe(inputs: ProbeFireInputs): Promise<ProbeRoundTripResult>;
}

/**
 * cortex#1728 (guard 4) — a single `/leafz` counter reading for the local leaf
 * carrying THIS network's federated traffic.
 *
 * `out_msgs` / `in_msgs` from the nats-server monitor `/leafz` surface, keyed to
 * the network's own leaf. The orchestrator samples this BEFORE and AFTER the
 * probe volley and diffs the two, so a `timeout` verdict can say WHICH half is
 * broken instead of listing four undifferentiated candidate causes:
 *
 *   - `out` incremented, `in` did not ⇒ probes crossed the leaf but no echo
 *     returned ⇒ the failure is REMOTE (peer responder / echo leg);
 *   - `out` did not move ⇒ nothing left the leaf ⇒ LOCAL egress is broken
 *     (leaf account/binding), not the peer.
 */
export interface LeafzCounters {
  /** Messages SENT over the network's leaf since connect (`out_msgs`). */
  outMsgs: number;
  /** Messages RECEIVED over the network's leaf since connect (`in_msgs`). */
  inMsgs: number;
}

/**
 * cortex#1728 (guard 4) — best-effort sampler for the local leaf's `/leafz`
 * counters, SCOPED to a single network's leaf. The live adapter reads the
 * nats-server monitor; tests inject a fake returning controlled deltas.
 *
 * OPTIONAL on {@link NetworkPingPorts} and BEST-EFFORT: a `sample()` returning
 * `undefined` (monitor unreachable, no UNIQUELY-identifiable leaf for this
 * network, malformed body) MUST NOT fail the ping — the orchestrator simply
 * omits the extra diagnostic line. Additive diagnostic context, never a gate.
 *
 * SCOPING (the #1731 review BLOCK): a host runs several leaves that share the
 * same hub ip:port, so summing counters across ALL of them picks up other
 * networks' heartbeat traffic and MISATTRIBUTES the diagnosis. `sample()` takes
 * the pinged network's `leafNode` name and reads ONLY that leaf's counters;
 * when the target leaf cannot be uniquely identified it returns `undefined`
 * (omit the line — never misattribute).
 */
export interface LeafzSamplerPort {
  /**
   * Read the current `out_msgs` / `in_msgs` for THE `leafNode` network's leaf
   * only, or `undefined` when that leaf cannot be uniquely identified / read.
   * `leafNode` is the network's configured `leaf_node` (the rendered leaf-remote
   * name cortex writes into `leafnodes-<network>.conf`). NEVER throws — a failed
   * read resolves `undefined` so the ping proceeds unaffected.
   */
  sample(leafNode: string): Promise<LeafzCounters | undefined>;
}

/** The ports bundle (room to grow — clock, etc., stay injectable). */
export interface NetworkPingPorts {
  bus: ProbeBusPort;
  /** Monotonic-ish nonce + correlation id source (testable). */
  newNonce(): string;
  newCorrelationId(): string;
  /**
   * cortex#1728 (guard 4) — OPTIONAL local-`/leafz` sampler. When present, the
   * orchestrator samples before/after the probes and folds the counter delta
   * into a `timeout` verdict ("probes crossed the leaf — failure is remote" vs
   * "nothing left the leaf — local egress broken"). Absent ⇒ no extra line.
   */
  leafz?: LeafzSamplerPort;
}
