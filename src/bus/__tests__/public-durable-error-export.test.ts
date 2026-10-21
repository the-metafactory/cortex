import { describe, expect, test } from "bun:test";
import {
  MyelinDurablePublishError,
  MyelinRuntimeConfigError,
  startMyelinRuntime,
  type Envelope,
  type MyelinDurablePubAck,
  type MyelinDurablePublishErrorKind,
  type MyelinPublishDurableOptions,
  type MyelinRuntimeOptions,
} from "@the-metafactory/cortex/bus";

const CONFIG = {
  agent: { name: "synthetic", displayName: "Synthetic" },
  nats: { url: "nats://synthetic.invalid:4222", name: "synthetic", subjects: [] },
} as unknown as Parameters<typeof startMyelinRuntime>[0];

const ENVELOPE: Envelope = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "synthetic.stack.service",
  type: "tasks.synthetic",
  timestamp: "2026-10-21T00:00:00.000Z",
  sovereignty: {
    classification: "local",
    data_residency: "NZ",
    max_hop: 0,
    frontier_ok: true,
    model_class: "any",
  },
  payload: {},
};

describe("public bus barrel: durable publication errors", () => {
  test("a stopped runtime rejects with the public error class and kind", async () => {
    const runtime = await startMyelinRuntime(CONFIG, {
      connectImpl: () =>
        Promise.resolve({
          status: () => [],
          drain: () => Promise.resolve(),
        } as unknown as Awaited<ReturnType<NonNullable<MyelinRuntimeOptions["connectImpl"]>>>),
    });
    try {
      expect(runtime.enabled).toBe(true);
      await runtime.stop();
      if (runtime.publishDurable === undefined) throw new Error("publishDurable missing");

      const options: MyelinPublishDurableOptions = {
        expectedStream: "SYNTHETIC_STREAM",
        timeoutMs: 100,
      };
      const publication: Promise<MyelinDurablePubAck> = runtime.publishDurable(ENVELOPE, options);
      await publication.then(
        () => {
          throw new Error("expected stopped runtime to reject");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(MyelinDurablePublishError);
          if (!(error instanceof MyelinDurablePublishError)) throw error;
          const kind: MyelinDurablePublishErrorKind = error.kind;
          expect(kind).toBe("stopped");
          expect(error.envelopeId).toBe(ENVELOPE.id);
        },
      );
    } finally {
      await runtime.stop();
    }
  });

  test("an invalid runtime option rejects with the public config error class", async () => {
    await startMyelinRuntime(CONFIG, { jetstreamDomain: "" }).then(
      () => {
        throw new Error("expected invalid runtime option to reject");
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(MyelinRuntimeConfigError);
        if (!(error instanceof MyelinRuntimeConfigError)) throw error;
        expect(error.option).toBe("jetstreamDomain");
      },
    );
  });
});
