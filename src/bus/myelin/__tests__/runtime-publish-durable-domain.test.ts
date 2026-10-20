import { describe, expect, test } from "bun:test";
import {
  SYNTHETIC_DOMAIN,
  SYNTHETIC_STREAM,
  ack,
  durable,
  makeEnvelope,
  rejectionOf,
  start,
} from "./runtime-publish-durable-fixture";

describe("MyelinRuntime.publishDurable PubAck domain", () => {
  test("resolves with the PubAck when its domain matches the configured domain", async () => {
    const pubAck = ack({ domain: SYNTHETIC_DOMAIN, duplicate: true });
    const { runtime } = await start(async () => pubAck, {
      jetstreamDomain: SYNTHETIC_DOMAIN,
    });
    try {
      const result = await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

      expect(result).toEqual(pubAck);
    } finally {
      await runtime.stop();
    }
  });

  test.each(["other-domain", undefined, "", "SYNTHETIC-DOMAIN"])(
    "rejects a PubAck domain of %s with a typed domain mismatch",
    async (domain) => {
      const { runtime, fake } = await start(async () => ack(domain === undefined ? {} : { domain }), {
        jetstreamDomain: SYNTHETIC_DOMAIN,
      });
      const envelope = makeEnvelope();
      try {
        const err = await rejectionOf(
          durable(runtime)(envelope, { expectedStream: SYNTHETIC_STREAM }),
        );

        expect(err.kind).toBe("domain-mismatch");
        expect(err.envelopeId).toBe(envelope.id);
        expect(err.message).toContain(SYNTHETIC_DOMAIN);
        expect(err.message).toContain(domain ?? "<absent>");
        expect(fake.publishCalls).toHaveLength(1);
        expect(fake.coreCalls).toEqual([]);
      } finally {
        await runtime.stop();
      }
    },
  );

  test.each([SYNTHETIC_DOMAIN, "other-domain", undefined])(
    "accepts a PubAck domain of %s when no domain is configured",
    async (domain) => {
      const pubAck = ack(domain === undefined ? {} : { domain });
      const { runtime } = await start(async () => pubAck);
      try {
        const result = await durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM });

        expect(result).toEqual(pubAck);
      } finally {
        await runtime.stop();
      }
    },
  );

  test.each([SYNTHETIC_DOMAIN, "other-domain", undefined])(
    "preserves stream mismatch rejection with PubAck domain %s",
    async (domain) => {
      const { runtime } = await start(async () => ack({ stream: "OTHER_STREAM", domain }), {
        jetstreamDomain: SYNTHETIC_DOMAIN,
      });
      try {
        const err = await rejectionOf(
          durable(runtime)(makeEnvelope(), { expectedStream: SYNTHETIC_STREAM }),
        );

        expect(err.kind).toBe("stream-mismatch");
        expect(err.message).toContain("OTHER_STREAM");
      } finally {
        await runtime.stop();
      }
    },
  );
});
