/**
 * S7 (epic #1514, cortex#1521) — review-consumer boot-wiring tests.
 *
 * Unit-level coverage of `wireReviewConsumers` IN ISOLATION — no
 * `startCortex`, no filesystem, no NATS, no `agents.d/` boot machinery.
 * Assertions the pre-extraction inline closure never had at this grain:
 * that `startForAgent` can be exercised directly against a fixture opts
 * object, that it binds the expected subject pattern + durable via the
 * runtime's `subscribePull`, and that it pushes onto the shared
 * `reviewConsumers[]` array passed in (this module doesn't own that
 * array's lifecycle — see the file header in `review-consumer-boot.ts`).
 *
 * The full `startCortex` integration coverage (multi-agent boot, CO-2
 * offering scopes, ADR-0001 federation, dormancy, partial-failure
 * isolation) lives in `src/__tests__/cortex.review-consumer-boot.test.ts`
 * and continues to pass unchanged against this extraction — that file is
 * the byte-identical-behaviour regression guard; this one is the new
 * module's own unit contract.
 */

import { describe, expect, test } from "bun:test";
import {
  wireReviewConsumers,
  type ReviewBootAgent,
  type WireReviewConsumersOpts,
} from "../review-consumer-boot";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import { resolveSigningKnobs } from "../../common/security-posture";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { ReviewConsumer } from "../../bus/review-consumer";

interface RecordingRuntime extends MyelinRuntime {
  subscribePullCalls: MyelinSubscribePullOpts[];
}

/** Mirrors `cortex.review-consumer-boot.test.ts`'s recorder: records every
 *  `subscribePull` invocation and hands back a synthetic subscriber whose
 *  `ready` resolves immediately, so `consumer.start()` reports `subscribed: true`
 *  without a real JetStream round-trip. */
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
      // Cast through unknown — real MyelinSubscriber has private fields we
      // deliberately don't synthesise; the test surface is the public
      // lifecycle pair (pattern/ready/stop), same idiom as the cortex.ts
      // boot test's recorder.
      return {
        pattern: opts.pattern,
        ready: Promise.resolve(),
        stop: async () => {},
      } as unknown as MyelinSubscriber;
    },
  };
}

function baseOpts(overrides: Partial<WireReviewConsumersOpts> = {}): WireReviewConsumersOpts {
  return {
    reviewPrincipalId: "andreas",
    trustResolver: new TrustResolver(AgentRegistry.fromAgents([])),
    signingKnobs: resolveSigningKnobs("off"),
    systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
    runtime: fakeRuntime(),
    buildSessionOpts: () => ({}),
    makeOfferAdmission: () => () => ({ admit: true }),
    federatedNetworks: [],
    reviewConsumers: [],
    reviewOfferingPatterns: ["local.andreas.work.tasks.code-review.*"],
    reviewSubjectPattern: "local.andreas.work.tasks.code-review.*",
    reviewJsm: null,
    reviewStream: "CODE_REVIEW",
    reviewConsumerMaxDeliver: 5,
    federationConfigured: false,
    reviewFederatedSubjectPattern: "federated.andreas.work.tasks.code-review.>",
    reviewFederatedDirectSubjectPattern: "federated.andreas.work.tasks.*.code-review.>",
    ...overrides,
  };
}

function agent(id: string, capabilities: readonly string[]): ReviewBootAgent {
  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    trust: [],
    runtime: { substrate: "claude-code", capabilities },
  };
}

describe("wireReviewConsumers — local binding", () => {
  test("startForAgent binds the local pattern/durable and pushes onto the shared reviewConsumers[]", async () => {
    const runtime = fakeRuntime();
    const reviewConsumers: ReviewConsumer[] = [];
    const { startForAgent } = wireReviewConsumers(
      baseOpts({ runtime, reviewConsumers }),
    );

    await startForAgent(agent("echo", ["code-review.typescript"]));

    expect(reviewConsumers).toHaveLength(1);
    expect(reviewConsumers[0]!.agent.id).toBe("echo");
    expect(reviewConsumers[0]!.flavors).toEqual(["typescript"]);

    expect(runtime.subscribePullCalls).toHaveLength(1);
    expect(runtime.subscribePullCalls[0]!.pattern).toBe(
      "local.andreas.work.tasks.code-review.*",
    );
    expect(runtime.subscribePullCalls[0]!.durable).toBe(
      "cortex-review-consumer-andreas-echo",
    );
    expect(runtime.subscribePullCalls[0]!.stream).toBe("CODE_REVIEW");
  });

  test("dormant runtime (no subscribePull) → consumer still constructed, no throw", async () => {
    const dormantRuntime: MyelinRuntime = {
      enabled: false,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      stop: async () => {},
      // subscribePull omitted — ReviewConsumer.start() treats that the same
      // as a `null` return (dormant), per the interface's additivity contract.
    };
    const reviewConsumers: ReviewConsumer[] = [];
    const { startForAgent } = wireReviewConsumers(
      baseOpts({ runtime: dormantRuntime, reviewConsumers }),
    );

    await startForAgent(agent("luna", ["code-review.security"]));

    expect(reviewConsumers).toHaveLength(1);
  });
});

describe("wireReviewConsumers — CO-2 offer-scope + ADR-0001 federation", () => {
  test("a second offered scope binds an extra offer consumer on its own durable", async () => {
    const runtime = fakeRuntime();
    const reviewConsumers: ReviewConsumer[] = [];
    const { startForAgent } = wireReviewConsumers(
      baseOpts({
        runtime,
        reviewConsumers,
        reviewOfferingPatterns: [
          "local.andreas.work.tasks.code-review.*",
          "federated.andreas.work.tasks.code-review.*",
        ],
      }),
    );

    await startForAgent(agent("echo", ["code-review.typescript"]));

    // Local + one offer-scope consumer.
    expect(reviewConsumers).toHaveLength(2);
    const patterns = runtime.subscribePullCalls.map((c) => c.pattern);
    expect(patterns).toContain("local.andreas.work.tasks.code-review.*");
    expect(patterns).toContain("federated.andreas.work.tasks.code-review.*");
    const durables = runtime.subscribePullCalls.map((c) => c.durable);
    expect(durables.some((d) => d.includes("offer-federated"))).toBe(true);
  });

  test("federationConfigured → federated Offer + Direct consumers also bound", async () => {
    const runtime = fakeRuntime();
    const reviewConsumers: ReviewConsumer[] = [];
    const { startForAgent } = wireReviewConsumers(
      baseOpts({ runtime, reviewConsumers, federationConfigured: true }),
    );

    await startForAgent(agent("echo", ["code-review.typescript"]));

    // Local + federated Offer + federated Direct = 3 consumers.
    expect(reviewConsumers).toHaveLength(3);
    const patterns = runtime.subscribePullCalls.map((c) => c.pattern);
    expect(patterns).toContain("federated.andreas.work.tasks.code-review.>");
    expect(patterns).toContain("federated.andreas.work.tasks.*.code-review.>");
    const durables = runtime.subscribePullCalls.map((c) => c.durable);
    expect(
      durables.some((d) => d === "cortex-review-consumer-federated-andreas-echo"),
    ).toBe(true);
    expect(
      durables.some(
        (d) => d === "cortex-review-consumer-federated-direct-andreas-echo",
      ),
    ).toBe(true);
  });
});

describe("wireReviewConsumers — per-agent failure isolation", () => {
  test("a synchronous failure inside startForAgent is caught and logged, not thrown", async () => {
    const reviewConsumers: ReviewConsumer[] = [];
    const { startForAgent } = wireReviewConsumers(
      baseOpts({
        reviewConsumers,
        buildSessionOpts: () => {
          throw new Error("synthetic buildSessionOpts failure");
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
      // Per CLAUDE.md "no empty catch blocks" — the wiring never rejects;
      // it logs and moves on so sibling agents still wire (cortex.ts's
      // `for (const agent of reviewCapableAgents)` boot loop depends on this).
      await expect(startForAgent(agent("echo", ["code-review.typescript"]))).resolves.toBeUndefined();
    } finally {
      process.stderr.write = original;
    }

    expect(stderr).toContain("review consumer init failed");
    expect(stderr).toContain("agent=echo");
    expect(stderr).toContain("synthetic buildSessionOpts failure");
    // The failure happened before `makeConsumer`/`.push()` ran.
    expect(reviewConsumers).toHaveLength(0);
  });
});
