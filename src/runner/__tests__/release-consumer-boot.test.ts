/**
 * S8 (epic #1514, cortex#1522) — release-consumer boot-wiring tests.
 *
 * Unit-level coverage of `wireReleaseConsumers` IN ISOLATION — no
 * `startCortex`, no filesystem, no NATS. Assertions the pre-extraction
 * inline per-agent loop body never had at this grain: that `startForAgent`
 * can be exercised directly against a fixture opts object, that it binds the
 * expected subject pattern + durable via the runtime's `subscribePull`, and
 * that it pushes onto the shared `releaseConsumers[]` array passed in (this
 * module doesn't own that array's lifecycle — see the file header in
 * `release-consumer-boot.ts`).
 *
 * The full `startCortex` integration coverage (the byte-identical-when-absent
 * hard contract, dormancy, partial-failure isolation) lives in
 * `src/__tests__/cortex.release-consumer-boot.test.ts` and continues to pass
 * unchanged against this extraction — that file is the
 * byte-identical-behaviour regression guard; this one is the new module's
 * own unit contract.
 */

import { describe, expect, test } from "bun:test";
import {
  wireReleaseConsumers,
  type ReleaseBootAgent,
  type WireReleaseConsumersOpts,
} from "../release-consumer-boot";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { ReleaseConsumer } from "../release-consumer";

interface RecordingRuntime extends MyelinRuntime {
  subscribePullCalls: MyelinSubscribePullOpts[];
}

/** Mirrors `review-consumer-boot.test.ts`'s recorder — see that file for the rationale. */
function fakeRuntime(): RecordingRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const subscribePullCalls: MyelinSubscribePullOpts[] = [];
  return {
    enabled: false,
    subscribePullCalls,
    onEnvelope(h) {
      handlers.add(h);
      return { unregister: () => handlers.delete(h) };
    },
    publish: async (_e: Envelope) => {},
    stop: async () => {},
    subscribePull: (opts: MyelinSubscribePullOpts): MyelinSubscriber => {
      subscribePullCalls.push(opts);
      return {
        pattern: opts.pattern,
        ready: Promise.resolve(),
        stop: async () => {},
      } as unknown as MyelinSubscriber;
    },
  };
}

function baseOpts(overrides: Partial<WireReleaseConsumersOpts> = {}): WireReleaseConsumersOpts {
  return {
    principalId: "andreas",
    systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
    runtime: fakeRuntime(),
    makeOfferAdmission: () => () => ({ admit: true }),
    releaseConsumers: [],
    releaseJsm: null,
    releaseStream: "RELEASE",
    releaseConsumerMaxDeliver: 5,
    releaseOfferingPatterns: ["local.andreas.work.tasks.release.cut"],
    releaseSubjectPattern: "local.andreas.work.tasks.release.cut",
    ...overrides,
  };
}

function agent(id: string, capabilities: readonly string[]): ReleaseBootAgent {
  return {
    id,
    runtime: { capabilities },
  };
}

describe("wireReleaseConsumers — local binding", () => {
  test("startForAgent binds the local pattern/durable and pushes onto the shared releaseConsumers[]", async () => {
    const runtime = fakeRuntime();
    const releaseConsumers: ReleaseConsumer[] = [];
    const { startForAgent } = wireReleaseConsumers(
      baseOpts({ runtime, releaseConsumers }),
    );

    await startForAgent(agent("forge", ["release.cut"]));

    expect(releaseConsumers).toHaveLength(1);
    expect(releaseConsumers[0]!.agent.id).toBe("forge");

    expect(runtime.subscribePullCalls).toHaveLength(1);
    expect(runtime.subscribePullCalls[0]!.pattern).toBe(
      "local.andreas.work.tasks.release.cut",
    );
    expect(runtime.subscribePullCalls[0]!.durable).toBe(
      "cortex-release-consumer-andreas-forge",
    );
    expect(runtime.subscribePullCalls[0]!.stream).toBe("RELEASE");
  });

  test("the generic 'release' capability also claims the lane", async () => {
    const runtime = fakeRuntime();
    const releaseConsumers: ReleaseConsumer[] = [];
    const { startForAgent } = wireReleaseConsumers(
      baseOpts({ runtime, releaseConsumers }),
    );

    await startForAgent(agent("forge", ["release"]));

    expect(releaseConsumers).toHaveLength(1);
  });

  test("dormant runtime (no subscribePull) → consumer still constructed, no throw", async () => {
    const dormantRuntime: MyelinRuntime = {
      enabled: false,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      stop: async () => {},
      // subscribePull omitted — ReleaseConsumer.start() treats that as dormant.
    };
    const releaseConsumers: ReleaseConsumer[] = [];
    const { startForAgent } = wireReleaseConsumers(
      baseOpts({ runtime: dormantRuntime, releaseConsumers }),
    );

    await startForAgent(agent("forge", ["release.cut"]));

    expect(releaseConsumers).toHaveLength(1);
  });
});

describe("wireReleaseConsumers — CO-2 offer scope", () => {
  test("a second offered scope binds an extra offer consumer on its own durable", async () => {
    const runtime = fakeRuntime();
    const releaseConsumers: ReleaseConsumer[] = [];
    const { startForAgent } = wireReleaseConsumers(
      baseOpts({
        runtime,
        releaseConsumers,
        releaseOfferingPatterns: [
          "local.andreas.work.tasks.release.cut",
          "federated.andreas.work.tasks.release.cut",
        ],
      }),
    );

    await startForAgent(agent("forge", ["release.cut"]));

    // Local + one offer-scope consumer.
    expect(releaseConsumers).toHaveLength(2);
    const patterns = runtime.subscribePullCalls.map((c) => c.pattern);
    expect(patterns).toContain("local.andreas.work.tasks.release.cut");
    expect(patterns).toContain("federated.andreas.work.tasks.release.cut");
    const durables = runtime.subscribePullCalls.map((c) => c.durable);
    expect(durables.some((d) => d.includes("offer-federated"))).toBe(true);
  });
});

describe("wireReleaseConsumers — per-agent failure isolation", () => {
  test("a synchronous failure inside startForAgent is caught and logged, not thrown", async () => {
    const releaseConsumers: ReleaseConsumer[] = [];
    const { startForAgent } = wireReleaseConsumers(
      baseOpts({
        releaseConsumers,
        makeOfferAdmission: () => {
          throw new Error("synthetic makeOfferAdmission failure");
        },
      }),
    );

    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = (chunk: unknown): boolean => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    };
    try {
      // Per CLAUDE.md "no empty catch blocks" — the wiring never rejects; it
      // logs and moves on so sibling agents still wire (cortex.ts's
      // `for (const agent of releaseCapableAgents)` boot loop depends on this).
      await expect(startForAgent(agent("forge", ["release.cut"]))).resolves.toBeUndefined();
    } finally {
      process.stderr.write = original;
    }

    expect(stderr).toContain("release consumer init failed");
    expect(stderr).toContain("agent=forge");
    expect(stderr).toContain("synthetic makeOfferAdmission failure");
    // The failure happened before `new ReleaseConsumer`/`.push()` ran.
    expect(releaseConsumers).toHaveLength(0);
  });
});
