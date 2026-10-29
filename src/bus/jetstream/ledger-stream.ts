import { AckPolicy, DeliverPolicy, type JetStreamClient, type JetStreamManager } from "nats";
import { LEDGER_STREAM } from "./provision";
import type { LedgerStream } from "./ledger-archive";

export function createLedgerStream(js: JetStreamClient, jsm: JetStreamManager): LedgerStream {
  return {
    async sequences() {
      const { state } = await jsm.streams.info(LEDGER_STREAM, { deleted_details: true });
      const sequences: number[] = [];
      const deleted = new Set(state.deleted);
      for (let sequence = state.first_seq; sequence <= state.last_seq && state.messages > 0; sequence++) {
        if (!deleted.has(sequence)) sequences.push(sequence);
      }
      if (sequences.length !== state.messages) throw new Error("LEDGER stream did not report a complete sequence snapshot");
      return sequences;
    },
    async consume(startSequence) {
      const consumer = await jsm.consumers.add(LEDGER_STREAM, {
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.StartSequence,
        opt_start_seq: startSequence,
        max_ack_pending: 1,
        max_deliver: -1,
        inactive_threshold: 300_000_000_000,
      });
      let messages;
      try {
        const binding = await js.consumers.get(LEDGER_STREAM, consumer.name);
        messages = await binding.consume({ max_messages: 1 });
      } catch (error) {
        await jsm.consumers.delete(LEDGER_STREAM, consumer.name);
        throw error;
      }
      let stopping: Promise<void> | undefined;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of messages) {
            yield {
              sequence: message.info.streamSequence,
              subject: message.subject,
              timestamp: new Date(message.info.timestampNanos / 1_000_000).toISOString(),
              data: message.data,
              ack: () => { message.ack(); },
            };
          }
        },
        stop: () => stopping ??= (async () => {
          await messages.close();
          await jsm.consumers.delete(LEDGER_STREAM, consumer.name);
        })(),
      };
    },
  };
}
