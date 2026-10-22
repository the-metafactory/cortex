// glossary-ignore: subscriber
import type { Database } from "bun:sqlite";
import { EXECUTION_RUN_FINISHED_TYPE, VIGIL_ATTENTION_RESOLVED_TYPE } from "@the-metafactory/myelin";
import { DeliverPolicy } from "nats";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { EnvelopeHandler, MyelinSubscriber } from "../bus/myelin/subscriber";
import { LEDGER_STREAM, isNotFoundError, provisionPullConsumer, type ProvisionLog } from "../bus/jetstream/provision";
import type { ProvisionJsm } from "../bus/jetstream/types";
import { clearVigilReplay, markVigilReplayStarted, rebuildVigilBudget, stageVigilTextReceipt } from "./db";
import { LEDGER_ACK_WAIT_NS, LEDGER_MAX_DELIVER, ingestLedgerEnvelope, ledgerEnvelopeError, stackOfEnvelope } from "./ingest";
import { emptyLedgerWarning, finishStackScopedReplay, ledgerRetention, reconnectReplayedEvents } from "./stack-scope";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { textSentReceiptSchema, VIGIL_TEXT_SENT_TYPE } from "./delivery-receipt";
import { replayVigilResolution } from "./resolution";

/** Rebuilds Vigil state from one non-`execution.run.finished` ledger envelope. Writes no Vigil event. */
export type LedgerReplayHandler = (db: Database, envelope: Envelope) => { kind: "skip"; reason: string } | undefined;

function replayTextSentReceipt(db: Database, envelope: Envelope): ReturnType<LedgerReplayHandler> {
  const receipt = textSentReceiptSchema.safeParse(envelope.payload);
  if (!receipt.success) return { kind: "skip", reason: "text-sent payload" };
  stageVigilTextReceipt(db, receipt.data);
  return undefined;
}

export const LEDGER_REPLAY_HANDLERS: ReadonlyMap<string, LedgerReplayHandler> = new Map([
  [VIGIL_TEXT_SENT_TYPE, replayTextSentReceipt],
  [VIGIL_ATTENTION_RESOLVED_TYPE, replayVigilResolution],
]);

export const REPLAY_POLL_MS = 100;
/** Replay gives up when the consumer's backlog has not shrunk for this long. */
export const REPLAY_STALL_MS = 60_000;

export function replayDurable(principal: string): string {
  return `cortex-vigil-replay-${principal}`;
}

/**
 * Rebuild `vigil_subjects` by reading the whole LEDGER stream through the live
 * ingest with delivery suppressed (soma#787 Q8). A temporary durable starts at
 * sequence 1 and is deleted afterwards; replay is done when it reports nothing
 * pending and nothing awaiting ack. `vigil_replay` holds a marker from start
 * to finish. Any failure logs one line and returns `null`, leaving whatever
 * was rebuilt so far and the marker, so the next startup replays again — the
 * order guard makes re-applied envelopes no-ops. Vigil meanwhile runs on the
 * live consumer alone. Returns the number of envelopes applied.
 */
export async function replayLedger(opts: {
  jsm: ProvisionJsm;
  runtime: Pick<MyelinRuntime, "subscribePull">;
  db: Database;
  principal: string;
  log?: ProvisionLog;
  now?: () => number;
  handlers?: ReadonlyMap<string, LedgerReplayHandler>;
  pollMs?: number;
  stallMs?: number;
}): Promise<number | null> {
  const { jsm, db } = opts;
  const log = opts.log ?? console;
  const now = opts.now ?? Date.now;
  const handlers = opts.handlers ?? LEDGER_REPLAY_HANDLERS;
  const durable = replayDurable(opts.principal);
  let applied = 0;
  const onEnvelope: EnvelopeHandler = (envelope) => {
    if (envelope.type !== EXECUTION_RUN_FINISHED_TYPE) {
      const handler = handlers.get(envelope.type);
      if (handler) {
        const result = handler(db, envelope);
        if (result?.kind === "skip") {
          log.warn(`vigil: replay skipped envelope ${envelope.id} invalid: ${result.reason}`);
        } else {
          applied += 1;
        }
      }
      return { kind: "ack" };
    }
    const invalid = ledgerEnvelopeError(envelope);
    if (invalid !== null) {
      log.warn(`vigil: replay skipped envelope ${envelope.id} invalid: ${invalid}`);
      return { kind: "ack" };
    }
    // A throw reaches onError and the delivery is NAK'ed for redelivery.
    db.transaction(() => {
      ingestLedgerEnvelope(db, envelope, now(), { replay: true });
      reconnectReplayedEvents(db, envelope.payload as unknown as ExecutionRunFinishedPayload, stackOfEnvelope(envelope));
    })();
    applied += 1;
    return { kind: "ack" };
  };

  let pull: MyelinSubscriber | null = null;
  try {
    markVigilReplayStarted(db, now());
    // A durable left by an interrupted replay sits mid-stream; start over.
    await deleteConsumerIfExists(jsm, durable);
    const retention = ledgerRetention(await jsm.streams.info(LEDGER_STREAM));
    await provisionPullConsumer({
      jsm, stream: LEDGER_STREAM, durable, deliverPolicy: DeliverPolicy.All,
      ackWaitNs: LEDGER_ACK_WAIT_NS, maxDeliver: LEDGER_MAX_DELIVER, log,
    });
    if (await backlog(jsm, durable) > 0) {
      pull = opts.runtime.subscribePull?.({
        stream: LEDGER_STREAM, durable,
        // Recorded only: the replay durable has no filter and reads the whole stream.
        pattern: `local.${opts.principal}.>`,
        onEnvelope,
        onError: (err) => { log.warn(`vigil: replay ingest error: ${err.message}`); },
      }) ?? null;
      if (!pull) throw new Error("runtime dormant");
      await pull.ready;
      await waitDrained(jsm, durable, opts.pollMs ?? REPLAY_POLL_MS, opts.stallMs ?? REPLAY_STALL_MS);
    }
    const carriedOver = db.transaction(() => {
      rebuildVigilBudget(db);
      const keys = finishStackScopedReplay(db, retention.retainedSince);
      clearVigilReplay(db);
      return keys;
    })();
    if (retention.empty && carriedOver.length > 0) log.warn(emptyLedgerWarning(carriedOver.length));
    for (const key of carriedOver) {
      log.warn(`vigil: ${key} kept from its legacy row; its LEDGER history has aged out`);
    }
    log.info(`vigil: rebuilt subject state from ${applied} ledger envelope(s)`);
    return applied;
  } catch (err) {
    log.warn(`vigil: ledger replay failed, continuing with the live consumer: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    await pull?.stop();
    try {
      await deleteConsumerIfExists(jsm, durable);
    } catch (err) {
      log.warn(`vigil: could not delete replay consumer ${durable}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function backlog(jsm: ProvisionJsm, durable: string): Promise<number> {
  const info = await jsm.consumers.info(LEDGER_STREAM, durable);
  return info.num_pending + info.num_ack_pending;
}

async function waitDrained(jsm: ProvisionJsm, durable: string, pollMs: number, stallMs: number): Promise<void> {
  let least = Number.POSITIVE_INFINITY;
  let progressAt = Date.now();
  for (;;) {
    const left = await backlog(jsm, durable);
    if (left === 0) return;
    if (left < least) {
      least = left;
      progressAt = Date.now();
    } else if (Date.now() - progressAt >= stallMs) {
      throw new Error(`replay stalled with ${left} envelope(s) outstanding`);
    }
    await Bun.sleep(pollMs);
  }
}

async function deleteConsumerIfExists(jsm: ProvisionJsm, durable: string): Promise<void> {
  try {
    await jsm.consumers.delete(LEDGER_STREAM, durable);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}
