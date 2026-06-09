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

/** The ports bundle (room to grow — clock, etc., stay injectable). */
export interface NetworkPingPorts {
  bus: ProbeBusPort;
  /** Monotonic-ish nonce + correlation id source (testable). */
  newNonce(): string;
  newCorrelationId(): string;
}
