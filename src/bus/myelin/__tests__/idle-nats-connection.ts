import { mock } from "bun:test";
import type { NatsConnection, Status } from "nats";

export function makeIdleConnectionParts(): Pick<
  NatsConnection,
  "status" | "subscribe" | "drain" | "close"
> {
  let endStatus: () => void = () => {};
  return {
    status: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Status>>((resolve) => {
            endStatus = () => {
              resolve({ done: true, value: undefined });
            };
          }),
      }),
    }),
    subscribe: mock(() => {
      throw new Error("no push subscription expected");
    }),
    drain: mock(async () => {
      endStatus();
    }),
    close: mock(async () => {}),
  };
}
