import type { Database } from "bun:sqlite";
import { executionRunFinishedPattern, validateExecutionRunFinished } from "@the-metafactory/myelin";
import { DeliverPolicy } from "nats";
import type { AgentConfig } from "../common/types/config";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { EnvelopeErrorHandler, EnvelopeHandler } from "../bus/myelin/subscriber";
import { provisionLedgerStream, provisionReviewConsumer, type ProvisionLog } from "../bus/jetstream/provision";
import { ingestLedgerEnvelope } from "./ingest";

export interface VigilHandle {
  stop(): Promise<void>;
}

/** Boot gates live here so callers and tests exercise the same interface. */
export async function startVigil(opts: {
  config: Pick<AgentConfig, "vigil" | "mc">;
  db: Database | null;
  runtime: Pick<MyelinRuntime, "jetstreamManager" | "subscribePull">;
  principal: string;
  stack: string;
  log?: ProvisionLog;
  onError?: EnvelopeErrorHandler;
  now?: () => number;
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
  await provisionReviewConsumer({
    jsm, stream: "LEDGER", durable, filterSubject: pattern,
    deliverPolicy: DeliverPolicy.New, log,
  });
  const db = opts.db;
  const now = opts.now ?? Date.now;
  const onEnvelope: EnvelopeHandler = (envelope) => {
    // The wire subscriber already checked the envelope. A5b checks ledger
    // fields; its newer chain-only signature type differs from our vendored type.
    const { id, source, type, timestamp, sovereignty, payload, economics, correlation_id } = envelope;
    const validation = validateExecutionRunFinished({ id, source, type, timestamp, sovereignty, payload, economics, correlation_id });
    if (!validation.valid) {
      const first = validation.errors[0];
      log.warn(`vigil: envelope ${envelope.id} invalid: ${first?.field}: ${first?.message}`);
      return { kind: "ack" };
    }
    // Throws deliberately reach the subscriber's onError + NAK path.
    ingestLedgerEnvelope(db, envelope, now());
    return { kind: "ack" };
  };
  const subscriber = opts.runtime.subscribePull({
    stream: "LEDGER", durable, pattern, onEnvelope,
    onError: opts.onError ?? ((err) => { log.warn(`vigil: ingest error: ${err.message}`); }),
  });
  if (!subscriber) {
    log.warn("vigil: runtime dormant — not started");
    return null;
  }
  try {
    await subscriber.ready;
  } catch (err) {
    await subscriber.stop();
    throw err;
  }
  return { stop: () => subscriber.stop() };
}
