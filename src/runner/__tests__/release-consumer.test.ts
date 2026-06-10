/**
 * cortex#835 F-4.1 — tests for `release-consumer.ts`.
 *
 * Mirrors the `review-consumer.test.ts` coverage axes for the release lane:
 *
 *   1. Happy path — granted, well-formed claim, all preconditions pass →
 *      executor cuts the release → `dispatch.task.completed` published
 *      (carrying version + URL) + AckDecision is `{ kind: "ack" }`.
 *   2. THE GRANT GATE — well-formed claim with NO principal-grant marker
 *      (`payload.approved_by` absent / empty) → `wont_do` failed envelope
 *      ("release gate is principal-held") + AckDecision `{ kind: "term" }`,
 *      and the executor is NEVER invoked (fail-closed).
 *   3. Non-release subject → `cant_do` + term.
 *   4. Bad payload (missing repo / bad bump) → `cant_do` + term.
 *   5. No capability match → `cant_do` + term.
 *   6. Precondition failures (each named): dirty branch / red checks / no
 *      manifest → `cant_do` ("precondition <name>: …") + term; mutation
 *      (`cutRelease`) is NEVER invoked.
 *   7. Backpressure — release lane serialised (default maxConcurrent 1): a
 *      second concurrent granted claim → `not_now` + nak.
 *   8. Executor throws unexpectedly → defensive `not_now` + nak(0).
 *   9. Redelivery > 1 → ALSO emits `dispatch.task.aborted`.
 *  10. correlation_id contract — request envelope.id === every emitted
 *      envelope's correlation_id (the load-bearing reactor contract).
 *  11. Dormancy — no executor configured → `cant_do` ("no release executor")
 *      + term; AND `start()` against a disabled runtime → `subscribed: false`.
 *  12. The ack-table helper + payload parser unit cases.
 *
 * No real NATS, no real git/gh. All side effects flow through the recording
 * runtime's `published[]` array and the recording executor's call log.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../../bus/myelin/runtime";
import type { AckDecision } from "../../bus/myelin/subscriber";
import type { DispatchEventSource, DispatchTaskFailedReason } from "../../bus/dispatch-events";
import {
  ReleaseConsumer,
  RELEASE_LANE_MAX_CONCURRENT,
  isReleaseCutEnvelope,
  parseReleaseRequestPayload,
  releaseFailedReasonToAckDecision,
  type ReleaseConsumerAgent,
  type ReleaseExecutor,
  type DefaultBranchStatus,
  type ChecksStatus,
  type VersionManifest,
  type ReleaseCutResult,
} from "../release-consumer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "forge",
  instance: "local",
};

const FIXED_CLOCK = () => new Date("2026-06-10T00:00:00.000Z");

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
  publishOutcomes: { ok: boolean; error?: Error }[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const publishOutcomes: { ok: boolean; error?: Error }[] = [];
  let publishCallIndex = 0;
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    publishOutcomes,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return {
        unregister: () => {
          onEnvelopeHandlers.delete(handler);
        },
      };
    },
    publish: async (envelope: Envelope) => {
      const idx = publishCallIndex++;
      const outcome = publishOutcomes[idx];
      if (outcome && !outcome.ok) {
        throw outcome.error ?? new Error("publish failed");
      }
      published.push(envelope);
    },
    stop: async () => {},
  };
}

function buildAgent(
  overrides: Partial<ReleaseConsumerAgent> = {},
): ReleaseConsumerAgent {
  return {
    id: "forge",
    capabilities: ["release.cut"],
    ...overrides,
  };
}

/** A `tasks.release.cut` request envelope (the wire payload uses snake_case). */
function makeReleaseRequest(
  payload: Record<string, unknown> = {},
): Envelope {
  return {
    id: crypto.randomUUID(),
    source: `${SOURCE.principal}.work.${SOURCE.agent}`,
    type: "tasks.release.cut",
    timestamp: "2026-06-10T00:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {
      repo: "the-metafactory/cortex",
      bump: "patch",
      ...payload,
    },
  };
}

/**
 * A recording executor whose every method is overridable per test. Defaults
 * are the all-green happy path; tests override one seam to drive a failure.
 */
interface RecordingExecutor extends ReleaseExecutor {
  calls: string[];
}

function createRecordingExecutor(
  overrides: Partial<ReleaseExecutor> = {},
): RecordingExecutor {
  const calls: string[] = [];
  const defaults: ReleaseExecutor = {
    getDefaultBranchStatus: async (): Promise<DefaultBranchStatus> => ({
      branch: "main",
      clean: true,
    }),
    getChecksStatus: async (): Promise<ChecksStatus> => ({ allGreen: true }),
    locateVersionManifest: async (): Promise<VersionManifest | null> => ({
      path: "arc-manifest.yaml",
      currentVersion: "5.5.0",
    }),
    cutRelease: async (): Promise<ReleaseCutResult> => ({
      version: "v5.5.1",
      releaseUrl: "https://github.com/the-metafactory/cortex/releases/tag/v5.5.1",
    }),
  };
  return {
    calls,
    getDefaultBranchStatus: async (repo) => {
      calls.push("getDefaultBranchStatus");
      return (overrides.getDefaultBranchStatus ?? defaults.getDefaultBranchStatus)(repo);
    },
    getChecksStatus: async (repo) => {
      calls.push("getChecksStatus");
      return (overrides.getChecksStatus ?? defaults.getChecksStatus)(repo);
    },
    locateVersionManifest: async (repo) => {
      calls.push("locateVersionManifest");
      return (overrides.locateVersionManifest ?? defaults.locateVersionManifest)(repo);
    },
    cutRelease: async (input) => {
      calls.push("cutRelease");
      return (overrides.cutRelease ?? defaults.cutRelease)(input);
    },
  };
}

function makeConsumer(
  agent: ReleaseConsumerAgent,
  runtime: RecordingRuntime,
  executor?: ReleaseExecutor,
): ReleaseConsumer {
  return new ReleaseConsumer({
    agent,
    source: SOURCE,
    runtime,
    ...(executor !== undefined && { executor }),
    clock: FIXED_CLOCK,
  });
}

/** The grant marker every "happy" test stamps. */
const GRANTED = { approved_by: "andreas" };

// ---------------------------------------------------------------------------
// Helpers for assertions
// ---------------------------------------------------------------------------

function envelopesOfType(runtime: RecordingRuntime, type: string): Envelope[] {
  return runtime.published.filter((e) => e.type === type);
}

function failedReason(env: Envelope): DispatchTaskFailedReason | undefined {
  const p = env.payload as { reason?: DispatchTaskFailedReason };
  return p.reason;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — happy path", () => {
  test("granted + all preconditions green → cutRelease runs, completed published, ack", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const req = makeReleaseRequest(GRANTED);
    const decision = await consumer.processEnvelope(req, "local.andreas.work.tasks.release.cut", null);

    expect(decision).toEqual({ kind: "ack" });

    // Preconditions verified, then the single mutating call.
    expect(executor.calls).toEqual([
      "getDefaultBranchStatus",
      "getChecksStatus",
      "locateVersionManifest",
      "cutRelease",
    ]);

    // started then completed (in order), no failed.
    const started = envelopesOfType(runtime, "dispatch.task.started");
    const completed = envelopesOfType(runtime, "dispatch.task.completed");
    const failed = envelopesOfType(runtime, "dispatch.task.failed");
    expect(started.length).toBe(1);
    expect(completed.length).toBe(1);
    expect(failed.length).toBe(0);

    // Completed carries the version + URL.
    const cp = completed[0]!.payload;
    expect(String(cp.result_summary)).toContain("v5.5.1");
    expect(cp.chat_response).toBe(
      "https://github.com/the-metafactory/cortex/releases/tag/v5.5.1",
    );
  });

  test("cutRelease receives the located manifest, branch, bump, and grant", async () => {
    const runtime = createRecordingRuntime();
    let captured: Parameters<ReleaseExecutor["cutRelease"]>[0] | undefined;
    const executor = createRecordingExecutor({
      cutRelease: async (input) => {
        captured = input;
        return {
          version: "v6.0.0",
          releaseUrl: "https://example.test/r",
        };
      },
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    await consumer.processEnvelope(
      makeReleaseRequest({ ...GRANTED, bump: "major", refs: ["cortex#835"] }),
      "local.andreas.work.tasks.release.cut",
      null,
    );

    expect(captured).toBeDefined();
    expect(captured!.repo).toBe("the-metafactory/cortex");
    expect(captured!.bump).toBe("major");
    expect(captured!.branch).toBe("main");
    expect(captured!.approvedBy).toBe("andreas");
    expect(captured!.manifest.currentVersion).toBe("5.5.0");
    expect(captured!.refs).toEqual(["cortex#835"]);
  });
});

// ---------------------------------------------------------------------------
// 2. THE GRANT GATE — the load-bearing ALWAYS-HUMAN contract
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — the principal-grant gate (§3.5 ALWAYS-HUMAN)", () => {
  test("no approved_by marker → wont_do (release gate is principal-held) + term; executor NEVER runs", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(), // no approved_by
      "local.andreas.work.tasks.release.cut",
      null,
    );

    expect(decision.kind).toBe("term");
    expect((decision as { reason: string }).reason).toContain("release gate is principal-held");

    // Fail-closed: the executor is never touched on an ungranted claim.
    expect(executor.calls).toEqual([]);

    // A failed envelope with a wont_do reason was published; NO started.
    expect(envelopesOfType(runtime, "dispatch.task.started").length).toBe(0);
    const failed = envelopesOfType(runtime, "dispatch.task.failed");
    expect(failed.length).toBe(1);
    const reason = failedReason(failed[0]!);
    expect(reason?.kind).toBe("wont_do");
    expect((reason as { detail: string }).detail).toContain("principal-held");
    expect((reason as { detail: string }).detail).toContain("approved_by");
  });

  test("empty-string approved_by is treated as ABSENT → still refused", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest({ approved_by: "" }),
      "local.andreas.work.tasks.release.cut",
      null,
    );

    expect(decision.kind).toBe("term");
    expect(executor.calls).toEqual([]);
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("wont_do");
  });

  // BLOCKER (mellanon review, cortex#874): a whitespace-only `approved_by`
  // ("   ", length 3 > 0) must NOT pass the gate. The parser trims-before-
  // non-empty so it never reaches the gate as present, and the gate ALSO trims
  // (belt-and-suspenders) so a blank grant can never invoke the executor.
  test("whitespace-only approved_by ('   ') is treated as ABSENT → wont_do + term; executor NEVER runs", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest({ approved_by: "   " }),
      "local.andreas.work.tasks.release.cut",
      null,
    );

    expect(decision.kind).toBe("term");
    expect((decision as { reason: string }).reason).toContain("release gate is principal-held");

    // Fail-closed: a whitespace-only grant must never reach the executor.
    expect(executor.calls).toEqual([]);

    // No started; a wont_do failed envelope was published.
    expect(envelopesOfType(runtime, "dispatch.task.started").length).toBe(0);
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("wont_do");
  });

  // MAJOR (mellanon review, cortex#874): the trust model is PRESENCE-ONLY, not
  // authenticated. `approved_by` is whatever the envelope says — any principal
  // who can publish to the gate's subject can stamp `approved_by: "andreas"`
  // with no cryptographic proof. Authenticity rests on the NATS account layer
  // controlling publish rights to `local.{principal}.{stack}.tasks.release.cut`.
  // This test makes the presence-only model explicit: an UNRELATED principal's
  // name in `approved_by` is accepted as a grant by the consumer (the consumer
  // cannot tell — that is the documented v1 assumption; cryptographic proof is
  // the cortex trust track TC-0/1/2).
  test("TRUST MODEL is presence-only: any non-blank approved_by is accepted as a grant (NOT cryptographically verified)", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    // An attacker-controlled value the consumer has no way to authenticate.
    const decision = await consumer.processEnvelope(
      makeReleaseRequest({ approved_by: "not-the-real-principal" }),
      "local.andreas.work.tasks.release.cut",
      null,
    );

    // The gate PASSES on presence alone — the consumer cannot prove authenticity.
    expect(decision.kind).not.toBe("term");
    expect(envelopesOfType(runtime, "dispatch.task.started").length).toBe(1);
    // The executor ran through to the mutating cutRelease — the unauthenticated
    // grant was accepted because the consumer has no way to verify it.
    expect(executor.calls).toContain("cutRelease");
  });
});

// ---------------------------------------------------------------------------
// 3–5. Routing / shape failures (cant_do + term)
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — routing + shape failures", () => {
  test("non-release subject → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    const env = makeReleaseRequest(GRANTED);
    env.type = "tasks.code-review.typescript"; // not release.cut

    const decision = await consumer.processEnvelope(env, "local.andreas.work.tasks.code-review.typescript", null);
    expect(decision.kind).toBe("term");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("cant_do");
  });

  test("bad payload (missing repo) → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    const env = makeReleaseRequest(GRANTED);
    delete env.payload.repo;

    const decision = await consumer.processEnvelope(env, "local.andreas.work.tasks.release.cut", null);
    expect(decision.kind).toBe("term");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("cant_do");
    expect((reason as { detail: string }).detail).toContain("payload validation");
  });

  test("bad payload (invalid bump) → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    const decision = await consumer.processEnvelope(
      makeReleaseRequest({ ...GRANTED, bump: "huge" }),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    expect(failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!)?.kind).toBe("cant_do");
  });

  test("agent does not claim release.cut → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(
      buildAgent({ capabilities: ["code-review.typescript"] }),
      runtime,
      createRecordingExecutor(),
    );
    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("cant_do");
    expect((reason as { detail: string }).detail).toContain("does not claim release.cut");
  });

  test("generic `release` capability also claims a release.cut request", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(
      buildAgent({ capabilities: ["release"] }),
      runtime,
      executor,
    );
    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision).toEqual({ kind: "ack" });
    expect(executor.calls).toContain("cutRelease");
  });
});

// ---------------------------------------------------------------------------
// 6. Precondition failures (each named; mutation never runs)
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — precondition gates (release-checklist.md Phase 1)", () => {
  test("dirty default branch → cant_do (precondition dirty_default_branch) + term; no cutRelease", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor({
      getDefaultBranchStatus: async () => ({ branch: "main", clean: false }),
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    expect((decision as { reason: string }).reason).toContain("dirty_default_branch");
    expect(executor.calls).not.toContain("cutRelease");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("cant_do");
    expect((reason as { detail: string }).detail).toContain("dirty_default_branch");
  });

  test("checks not green → cant_do (precondition checks_not_green) + term; no cutRelease", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor({
      getChecksStatus: async () => ({ allGreen: false, summary: "tsc failing" }),
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    expect((decision as { reason: string }).reason).toContain("checks_not_green");
    expect(executor.calls).not.toContain("cutRelease");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect((reason as { detail: string }).detail).toContain("tsc failing");
  });

  test("manifest not found → cant_do (precondition manifest_not_found) + term; no cutRelease", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor({
      locateVersionManifest: async () => null,
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    expect((decision as { reason: string }).reason).toContain("manifest_not_found");
    expect(executor.calls).not.toContain("cutRelease");
  });
});

// ---------------------------------------------------------------------------
// 7. Backpressure — release lane serialised (default maxConcurrent 1)
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — concurrency (serialised release lane)", () => {
  test("default maxConcurrent is 1 even when agent omits it", () => {
    const consumer = makeConsumer(buildAgent(), createRecordingRuntime(), createRecordingExecutor());
    expect(consumer.maxConcurrent).toBe(RELEASE_LANE_MAX_CONCURRENT);
    expect(consumer.maxConcurrent).toBe(1);
  });

  test("second concurrent granted claim while one is in flight → not_now + nak", async () => {
    const runtime = createRecordingRuntime();
    // Gate the first cut so it stays in flight while the second arrives.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor = createRecordingExecutor({
      cutRelease: async () => {
        await firstHeld;
        return { version: "v5.5.1", releaseUrl: "https://example.test/r" };
      },
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const first = consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    // Let the first reach the in-flight set + the cutRelease await.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));

    const secondDecision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(secondDecision.kind).toBe("nak");
    expect((secondDecision as { delayMs: number }).delayMs).toBe(1000);
    const failed = envelopesOfType(runtime, "dispatch.task.failed");
    expect(failedReason(failed[failed.length - 1]!)?.kind).toBe("not_now");

    releaseFirst();
    expect((await first).kind).toBe("ack");
  });

  test("after a cut completes the counter decrements so the next claim admits", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const d1 = await consumer.processEnvelope(makeReleaseRequest(GRANTED), "s", null);
    const d2 = await consumer.processEnvelope(makeReleaseRequest(GRANTED), "s", null);
    expect(d1).toEqual({ kind: "ack" });
    expect(d2).toEqual({ kind: "ack" });
  });
});

// ---------------------------------------------------------------------------
// 8. Defensive executor throw
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — defensive executor throw", () => {
  test("executor throws → not_now + nak(0)", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor({
      cutRelease: async () => {
        throw new Error("gh exploded");
      },
    });
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision).toEqual({ kind: "nak", delayMs: 0 });
    const failed = envelopesOfType(runtime, "dispatch.task.failed");
    const reason = failedReason(failed[failed.length - 1]!);
    expect(reason?.kind).toBe("not_now");
    expect((reason as { detail: string }).detail).toContain("gh exploded");
  });
});

// ---------------------------------------------------------------------------
// 9. Redelivery
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — redelivery", () => {
  test("redelivery > 1 → emits dispatch.task.aborted in addition to the terminal", async () => {
    const runtime = createRecordingRuntime();
    const executor = createRecordingExecutor();
    const consumer = makeConsumer(buildAgent(), runtime, executor);

    const msg = { redelivered: true, info: { redeliveryCount: 2 } } as unknown as import("nats").JsMsg;
    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      msg,
    );
    expect(decision).toEqual({ kind: "ack" });
    expect(envelopesOfType(runtime, "dispatch.task.aborted").length).toBe(1);
    expect(envelopesOfType(runtime, "dispatch.task.completed").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. correlation_id contract
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — correlation_id contract", () => {
  test("every emitted envelope echoes request.id as correlation_id (happy path)", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    const req = makeReleaseRequest(GRANTED);

    await consumer.processEnvelope(req, "local.andreas.work.tasks.release.cut", null);
    expect(runtime.published.length).toBeGreaterThan(0);
    for (const env of runtime.published) {
      expect(env.correlation_id).toBe(req.id);
    }
  });

  test("failed (grant-gate) envelope echoes request.id as correlation_id", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    const req = makeReleaseRequest(); // ungranted

    await consumer.processEnvelope(req, "local.andreas.work.tasks.release.cut", null);
    const failed = envelopesOfType(runtime, "dispatch.task.failed");
    expect(failed[0]!.correlation_id).toBe(req.id);
  });
});

// ---------------------------------------------------------------------------
// 11. Dormancy
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — dormancy", () => {
  test("no executor configured → cant_do (no release executor) + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, undefined);

    const decision = await consumer.processEnvelope(
      makeReleaseRequest(GRANTED),
      "local.andreas.work.tasks.release.cut",
      null,
    );
    expect(decision.kind).toBe("term");
    const reason = failedReason(envelopesOfType(runtime, "dispatch.task.failed")[0]!);
    expect(reason?.kind).toBe("cant_do");
    expect((reason as { detail: string }).detail).toContain("no release executor");
  });

  test("start() against a runtime with no subscribePull → subscribed: false (dormant)", async () => {
    const runtime = createRecordingRuntime(); // no subscribePull helper
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());

    const info = await consumer.start({
      pattern: "local.andreas.work.tasks.release.cut",
      stream: "RELEASE",
      durable: "cortex-release-consumer-andreas-forge",
    });
    expect(info).toEqual({ agentId: "forge", subscribed: false });
  });

  test("start() against a runtime whose subscribePull returns null → subscribed: false", async () => {
    const runtime = createRecordingRuntime();
    (runtime as MyelinRuntime & { subscribePull: unknown }).subscribePull = () => null;
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());

    const info = await consumer.start({
      pattern: "local.andreas.work.tasks.release.cut",
      stream: "RELEASE",
      durable: "cortex-release-consumer-andreas-forge",
    });
    expect(info.subscribed).toBe(false);
  });

  test("stop() is idempotent and drains cleanly with no in-flight", async () => {
    const runtime = createRecordingRuntime();
    const consumer = makeConsumer(buildAgent(), runtime, createRecordingExecutor());
    await consumer.stop();
    await consumer.stop(); // second call resolves the same promise
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Unit helpers
// ---------------------------------------------------------------------------

describe("ReleaseConsumer — helper units", () => {
  test("isReleaseCutEnvelope", () => {
    expect(isReleaseCutEnvelope(makeReleaseRequest())).toBe(true);
    const other = makeReleaseRequest();
    other.type = "tasks.release.cutx";
    expect(isReleaseCutEnvelope(other)).toBe(false);
  });

  test("parseReleaseRequestPayload — valid granted", () => {
    const p = parseReleaseRequestPayload(
      makeReleaseRequest({ approved_by: "andreas", refs: ["a", "b"] }),
    );
    expect(p).toEqual({
      repo: "the-metafactory/cortex",
      bump: "patch",
      approvedBy: "andreas",
      refs: ["a", "b"],
    });
  });

  test("parseReleaseRequestPayload — valid ungranted (grant absent, NOT a parse failure)", () => {
    const p = parseReleaseRequestPayload(makeReleaseRequest());
    expect(p).toEqual({ repo: "the-metafactory/cortex", bump: "patch" });
  });

  test("parseReleaseRequestPayload — empty approved_by collapses to absent", () => {
    const p = parseReleaseRequestPayload(makeReleaseRequest({ approved_by: "" }));
    expect(p?.approvedBy).toBeUndefined();
  });

  // BLOCKER (mellanon review, cortex#874): the parser trims BEFORE the non-empty
  // test, so a whitespace-only grant ("   ", "\t", "\n") parses as ABSENT and the
  // §3.5 gate refuses it — it can never reach the executor as a present grant.
  test("parseReleaseRequestPayload — whitespace-only approved_by collapses to absent", () => {
    for (const ws of ["   ", "\t", "\n", " \t\n "]) {
      const p = parseReleaseRequestPayload(makeReleaseRequest({ approved_by: ws }));
      expect(p?.approvedBy).toBeUndefined();
    }
  });

  test("parseReleaseRequestPayload — bad repo / bad bump → null", () => {
    const bad1 = makeReleaseRequest();
    bad1.payload.repo = "no-slash";
    expect(parseReleaseRequestPayload(bad1)).toBeNull();

    const bad2 = makeReleaseRequest({ bump: "nope" });
    expect(parseReleaseRequestPayload(bad2)).toBeNull();
  });

  test("releaseFailedReasonToAckDecision — the four-way taxonomy", () => {
    expect(releaseFailedReasonToAckDecision({ kind: "cant_do", detail: "x" })).toEqual({
      kind: "term",
      reason: "cant_do: x",
    });
    expect(releaseFailedReasonToAckDecision({ kind: "wont_do", detail: "y" })).toEqual({
      kind: "term",
      reason: "wont_do: y",
    });
    expect(
      releaseFailedReasonToAckDecision({ kind: "not_now", detail: "z", retry_after_ms: 500 }),
    ).toEqual({ kind: "nak", delayMs: 500 });
    expect(releaseFailedReasonToAckDecision({ kind: "policy_denied", deny: { a: 1 } })).toEqual({
      kind: "term",
      reason: "policy_denied: a",
    });
    expect(releaseFailedReasonToAckDecision(undefined)).toEqual({ kind: "ack" });
  });
});
