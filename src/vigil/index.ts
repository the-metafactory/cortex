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
import { vigilSystemPattern } from "./delivery-receipt";
import { sweepStale } from "./staleness";
import { startVigilTick, type VigilTickOptions } from "./tick";
import type { PlatformAdapter } from "../adapters/types";
import { notifyWithResult } from "../adapters/notify-result";
import { createVigilEmailFallback } from "./fallback-email";
import { flushTexts, type FlushTextsOptions } from "./flush";
import { somaGoalWording } from "./result-render";
import { hasLegacyVigilSubjects } from "./stack-scope";
import { expireRefAttention } from "./ref-attention";
import { maybeSendDigest } from "./digest";
import { flushVigilResolutions } from "./resolution";

import { publishReconcileDelta } from "../surface/mc/attention-notify";

export { LEDGER_ACK_WAIT_NS, LEDGER_MAX_DELIVER };

export interface VigilHandle {
  waitForTick(): Promise<void>;
  stop(): Promise<void>;
}

type VigilDeliveryPorts = Pick<FlushTextsOptions, "send" | "fallback" | "resolveGoalWording">;

export function createVigilDeliveryPorts(opts: {
  config: AgentConfig["vigil"];
  adapters: readonly PlatformAdapter[];
  resolveGoalWording?: FlushTextsOptions["resolveGoalWording"];
  email?: Parameters<typeof createVigilEmailFallback>[1];
}): VigilDeliveryPorts {
  const discord = opts.adapters.find((adapter) => adapter.platform === "discord");
  return {
    send: discord ? (text) => notifyWithResult(discord, text) : null,
    fallback: createVigilEmailFallback(opts.config, opts.email),
    resolveGoalWording: opts.resolveGoalWording ?? somaGoalWording(opts.config.soma_homes),
  };
}

/** Boot gates live here so callers and tests exercise the same interface. */
export async function startVigil(opts: {
  config: Pick<AgentConfig, "vigil" | "mc">;
  db: Database | null;
  runtime: Pick<MyelinRuntime, "jetstreamManager" | "subscribePull"> & Partial<Pick<MyelinRuntime, "publish" | "publishOnSubject">>;
  principal: string;
  stack: string;
  log?: ProvisionLog;
  onError?: EnvelopeErrorHandler;
  now?: () => number;
  schedule?: VigilTickOptions["schedule"];
} & Partial<VigilDeliveryPorts>): Promise<VigilHandle | null> {
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
  await provisionLedgerStream({
    jsm, principal: opts.principal, log,
    subjects: [vigilSystemPattern(opts.principal, opts.stack)],
  });
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
  if (!hasVigilSubjects(db) || isVigilReplayPending(db) || hasLegacyVigilSubjects(db)) {
    await replayLedger({ jsm, runtime: opts.runtime, db, principal: opts.principal, log, now });
  }
  if (hasLegacyVigilSubjects(db)) {
    log.warn("vigil: stack-scoped replay incomplete — not started");
    return null;
  }
  const publish = opts.runtime.publish?.bind(opts.runtime);
  const publishResolution = opts.runtime.publishOnSubject?.bind(opts.runtime);
  const flushResolutions = () => publishResolution
    ? flushVigilResolutions(db, { principal: opts.principal, stack: opts.stack, publish: publishResolution })
    : Promise.resolve();
  let notifications = Promise.resolve();
  const publishDelta = (delta: Parameters<typeof publishReconcileDelta>[0]) => {
    if (!publish || (delta.opened.length === 0 && delta.resolved.length === 0)) return notifications;
    notifications = notifications.then(async () => {
      try {
        await publishReconcileDelta(delta, {
          source: { principal: opts.principal, agent: "cortex", instance: "local" },
        }, publish);
      } catch (err) {
        log.warn(`vigil: attention notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return notifications;
  };
  const onEnvelope: EnvelopeHandler = (envelope, subject) => {
    const invalid = ledgerEnvelopeError(envelope, subject);
    if (invalid !== null) {
      log.warn(`vigil: envelope ${envelope.id} invalid: ${invalid}`);
      return { kind: "ack" };
    }
    // A throw here reaches onError, and the delivery is NAK'ed for redelivery.
    void publishDelta(ingestLedgerEnvelope(db, envelope, subject, now(), { localStackId: opts.stack, log }));
    void flushResolutions();
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
    run: async () => {
      const tickNow = now();
      expireRefAttention(db, tickNow);
      await publishDelta(sweepStale(db, tickNow, opts.config.vigil.cadence, opts.stack));
      await flushResolutions();
      if (publish) await flushTexts({
        db, principal: opts.principal, stack: opts.stack, now: tickNow, publish,
        send: opts.send ?? null, fallback: opts.fallback ?? null, resolveGoalWording: opts.resolveGoalWording,
      });
      await maybeSendDigest({
        resultBaseUrl: opts.config.vigil.result_base_url,
        db, stack: opts.stack, now: tickNow, send: opts.send ?? null, fallback: opts.fallback ?? null,
        resolveGoalWording: opts.resolveGoalWording,
      });
    },
    schedule: opts.schedule,
    onError: (err) => { log.warn(`vigil: tick failed: ${err instanceof Error ? err.message : String(err)}`); },
  });
  let stopping: Promise<void> | undefined;
  return {
    waitForTick: () => tick.waitForTick(),
    stop: () => stopping ??= (async () => {
      await tick.stop();
      await pull.stop();
      await notifications;
      await flushResolutions();
    })(),
  };
}
