// glossary-ignore: subscriber, run
import type { Database } from "bun:sqlite";
import { executionRunFinishedPattern } from "@the-metafactory/myelin";
import { DeliverPolicy } from "nats";
import type { AgentConfig } from "../common/types/config";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { EnvelopeErrorHandler, EnvelopeHandler } from "../bus/myelin/subscriber";
import { LEDGER_STREAM, provisionLedgerStream, provisionPullConsumer, type ProvisionLog } from "../bus/jetstream/provision";
import { LEDGER_ACK_WAIT_NS, LEDGER_MAX_DELIVER, ingestLedgerEnvelope, ledgerEnvelopeError } from "./ingest";
import { hasVigilSubjects, isVigilReplayPending } from "./db";
import { replayLedger } from "./replay";
import { sweepStale } from "./staleness";
import { startVigilTick, type VigilTickOptions } from "./tick";

import { publishReconcileDelta } from "../surface/mc/attention-notify";

export { LEDGER_ACK_WAIT_NS, LEDGER_MAX_DELIVER };

export interface VigilHandle {
  stop(): Promise<void>;
}

/** Boot gates live here so callers and tests exercise the same interface. */
export async function startVigil(opts: {
  config: Pick<AgentConfig, "vigil" | "mc">;
  db: Database | null;
  runtime: Pick<MyelinRuntime, "jetstreamManager" | "subscribePull"> & Partial<Pick<MyelinRuntime, "publish">>;
  principal: string;
  stack: string;
  log?: ProvisionLog;
  onError?: EnvelopeErrorHandler;
  now?: () => number;
  schedule?: VigilTickOptions["schedule"];
}): Promise<VigilHandle | null> {
  if (!opts.config.vigil.enabled) return null;
  const log = opts.log ?? console;
  if (!opts.config.mc.enabled || opts.db === null) {
    log.warn("vigil: Vigil needs Mission Control — not started");
    return null;
  }
  if (opts.stack !== "default") {
    log.warn("vigil: Vigil runs on the default stack only — not started");
    return null;
  }
  const jsm = await opts.runtime.jetstreamManager?.();
  if (!jsm || !opts.runtime.subscribePull) {
    log.warn("vigil: runtime dormant — not started");
    return null;
  }
  await provisionLedgerStream({ jsm, principal: opts.principal, log });
  const durable = `cortex-vigil-${opts.principal}`;
  const pattern = executionRunFinishedPattern(opts.principal);
  await provisionPullConsumer({
    jsm, stream: LEDGER_STREAM, durable, filterSubject: pattern,
    deliverPolicy: DeliverPolicy.New, ackWaitNs: LEDGER_ACK_WAIT_NS, maxDeliver: LEDGER_MAX_DELIVER, log,
  });
  const db = opts.db;
  const now = opts.now ?? Date.now;
  // An empty table is the rebuild trigger (soma#787 Q8); a replay that did not
  // finish is retried even once some rows exist. Replay never blocks boot.
  // The live durable is provisioned first, so its `New` start is fixed
  // before replay reads the stream and nothing published meanwhile is lost.
  // Such an envelope reaches both consumers; replay applies it without an
  // event and the order guard makes the live copy a no-op.
  if (!hasVigilSubjects(db) || isVigilReplayPending(db)) {
    await replayLedger({ jsm, runtime: opts.runtime, db, principal: opts.principal, log, now });
  }
  const publish = opts.runtime.publish?.bind(opts.runtime);
  const publishDelta = async (delta: Parameters<typeof publishReconcileDelta>[0]) => {
    if (!publish) return;
    try {
      await publishReconcileDelta(delta, {
        source: { principal: opts.principal, agent: "cortex", instance: "local" },
      }, publish);
    } catch (err) {
      log.warn(`vigil: attention notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const onEnvelope: EnvelopeHandler = async (envelope) => {
    const invalid = ledgerEnvelopeError(envelope);
    if (invalid !== null) {
      log.warn(`vigil: envelope ${envelope.id} invalid: ${invalid}`);
      return { kind: "ack" };
    }
    // A throw here reaches onError, and the delivery is NAK'ed for redelivery.
    await publishDelta(ingestLedgerEnvelope(db, envelope, now(), { stackId: opts.stack }));
    return { kind: "ack" };
  };
  const pull = opts.runtime.subscribePull({
    stream: LEDGER_STREAM, durable, pattern, onEnvelope,
    onError: opts.onError ?? ((err) => { log.warn(`vigil: ingest error: ${err.message}`); }),
  });
  if (!pull) {
    log.warn("vigil: runtime dormant — not started");
    return null;
  }
  try {
    await pull.ready;
  } catch (err) {
    await pull.stop();
    throw err;
  }
  const tick = startVigilTick({
    run: async () => { await publishDelta(sweepStale(db, now(), opts.config.vigil.cadence, opts.stack)); },  // glossary-ignore: run
    schedule: opts.schedule,
    onError: (err) => { log.warn(`vigil: tick failed: ${err instanceof Error ? err.message : String(err)}`); },
  });
  let stopping: Promise<void> | undefined;
  return {
    stop: () => stopping ??= (async () => {
      await tick.stop();
      await pull.stop();
    })(),
  };
}
