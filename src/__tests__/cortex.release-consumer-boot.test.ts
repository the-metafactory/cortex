/**
 * cortex#835 F-4.1 — release-consumer boot wiring tests.
 *
 * Asserts the boot loop mirrors the review-consumer wiring:
 *
 *   for each agent in mergedAgents:
 *     if agent.runtime?.capabilities contains "release" or "release.cut":
 *       new ReleaseConsumer(...) → one instance per such agent → start()
 *
 * Covers:
 *
 *   1. One agent declaring `release.cut` → one consumer; ready log line;
 *      subscribePull invoked once with the canonical pattern + durable +
 *      stream.
 *   2. THE HARD CONTRACT — zero release-capable agents → BYTE-IDENTICAL boot:
 *      zero subscribePull calls AND no release-lane log line at all (the block
 *      is fully gated; an opt-out roster boots exactly as before this PR).
 *   3. Dormant subscribePull (returns null) → DORMANT log, not ready.
 *   4. One consumer init throws → siblings still wire; boot completes; stderr
 *      carries the failing agent id.
 *
 * Per-envelope behaviour (the grant gate, preconditions, lifecycle) is covered
 * by `src/runner/__tests__/release-consumer.test.ts`. This boot test exercises
 * instantiation + subscribe + the byte-identical-when-absent contract only.
 *
 * No real NATS, Discord, filesystem-watcher I/O, or `claude` spawning.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Agent, AgentRuntime } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";

// ---------------------------------------------------------------------------
// Test helpers — mirror cortex.review-consumer-boot.test.ts.
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
    },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-release-test-published" },
    ...overrides,
  });
}

interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
  subscribePullCalls: MyelinSubscribePullOpts[];
}

function createRecordingRuntime(): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const subscribePullCalls: MyelinSubscribePullOpts[] = [];
  return {
    enabled: false,
    onEnvelopeHandlers,
    published,
    subscribePullCalls,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return {
        unregister: () => {
          onEnvelopeHandlers.delete(handler);
        },
      };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    subscribePull: (opts: MyelinSubscribePullOpts): MyelinSubscriber => {
      subscribePullCalls.push(opts);
      return {
        pattern: opts.pattern,
        ready: Promise.resolve(),
        stop: async () => {},
      } as unknown as MyelinSubscriber;
    },
    stop: async () => {},
  };
}

function makeAgent(
  id: string,
  capabilities: readonly string[] | undefined,
  maxConcurrent?: number,
): Agent {
  const runtime: AgentRuntime | undefined =
    capabilities === undefined
      ? undefined
      : {
          substrate: "claude-code",
          mode: "in-process",
          capabilities: [...capabilities],
          ...(maxConcurrent !== undefined && { maxConcurrent }),
        };

  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    persona: `/tmp/${id}-persona.md`,
    trust: [],
    presence: {},
    ...(runtime !== undefined && { runtime }),
  };
}

function withCapturedStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: unknown): boolean => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => {
      process.stderr.write = original;
      return { result, stderr: buf };
    })
    .catch((err: unknown) => {
      process.stderr.write = original;
      throw err;
    });
}

function withCapturedConsoleLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const original = console.log.bind(console);
  const logs: string[] = [];
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  return fn()
    .then((result) => {
      console.log = original;
      return { result, logs };
    })
    .catch((err: unknown) => {
      console.log = original;
      throw err;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — release-consumer boot wiring (cortex#835 F-4.1)", () => {
  test("one agent declaring release.cut → one consumer; ready log; subscribePull with canonical pattern + durable + stream", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-relboot-1-"));
    const inlineAgents: Agent[] = [makeAgent("forge", ["release.cut"])];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: "test-op" },
      }),
    );

    const readyLines = logs.filter((l) =>
      l.includes("cortex: release consumer ready"),
    );
    expect(readyLines.length).toBe(1);
    expect(readyLines[0]!).toContain("agent=forge");
    expect(readyLines[0]!).toContain("capability=release.cut");
    expect(readyLines[0]!).toContain("PRINCIPAL-GATED");
    expect(readyLines[0]!).toContain("ALWAYS-HUMAN");
    // F-4.1 — the forge executor seam is not yet wired.
    expect(readyLines[0]!).toContain("executor=none");

    // Exactly one subscribePull, on the canonical release subject + durable.
    const releaseCalls = runtime.subscribePullCalls.filter((c) =>
      c.pattern.includes("tasks.release.cut"),
    );
    expect(releaseCalls.length).toBe(1);
    expect(releaseCalls[0]!.pattern).toBe(
      "local.test-op.default.tasks.release.cut",
    );
    expect(releaseCalls[0]!.durable).toBe(
      "cortex-release-consumer-test-op-forge",
    );
    expect(releaseCalls[0]!.stream).toBe("RELEASE");

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("HARD CONTRACT — zero release-capable agents → byte-identical boot: NO release subscribePull, NO release log line", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-relboot-zero-"));
    // A roster with reviewers but no release-capable agent. The release block
    // must add ZERO behaviour: no subscribePull on a release subject, and no
    // release-lane log line at all (NOT even a "skipped" message — release is
    // opt-in, unlike review's always-on first-install warning).
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript"]),
      makeAgent("luna", undefined),
      makeAgent("holly", ["research.web"]),
    ];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: "test-op" },
      }),
    );

    // No release subject was ever subscribed.
    const releaseCalls = runtime.subscribePullCalls.filter((c) =>
      c.pattern.includes("release"),
    );
    expect(releaseCalls.length).toBe(0);

    // No release-lane log line — neither "ready", "DORMANT", nor any "release
    // consumer" / "RELEASE" stream provisioning line. The block is fully gated.
    const releaseLines = logs.filter(
      (l) =>
        l.includes("release consumer") ||
        l.includes('stream "RELEASE"') ||
        l.includes("release-consumer"),
    );
    expect(releaseLines).toEqual([]);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("generic `release` capability also wires a consumer", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-relboot-generic-"));
    const inlineAgents: Agent[] = [makeAgent("forge", ["release"])];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: "test-op" },
      }),
    );

    const readyLines = logs.filter((l) =>
      l.includes("cortex: release consumer ready"),
    );
    expect(readyLines.length).toBe(1);
    expect(
      runtime.subscribePullCalls.filter((c) =>
        c.pattern.includes("tasks.release.cut"),
      ).length,
    ).toBe(1);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("dormant subscribePull (returns null) → DORMANT log, not ready", async () => {
    const onEnvelopeHandlers = new Set<EnvelopeHandler>();
    const published: Envelope[] = [];
    const subscribePullCalls: MyelinSubscribePullOpts[] = [];
    const dormantRuntime: RecordingRuntime = {
      enabled: false,
      onEnvelopeHandlers,
      published,
      subscribePullCalls,
      onEnvelope(handler) {
        onEnvelopeHandlers.add(handler);
        return {
          unregister: () => {
            onEnvelopeHandlers.delete(handler);
          },
        };
      },
      publish: async (envelope: Envelope) => {
        published.push(envelope);
      },
      subscribePull: (opts: MyelinSubscribePullOpts) => {
        subscribePullCalls.push(opts);
        return null;
      },
      stop: async () => {},
    };

    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-relboot-dormant-"));
    const inlineAgents: Agent[] = [makeAgent("forge", ["release.cut"])];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: dormantRuntime,
        inlineAgents,
        principal: { id: "test-op" },
      }),
    );

    const dormantLines = logs.filter((l) =>
      l.includes("cortex: release consumer DORMANT"),
    );
    expect(dormantLines.length).toBe(1);
    expect(dormantLines[0]!).toContain("agent=forge");
    expect(dormantLines[0]!).toContain("G-1111 pending");

    const readyLines = logs.filter((l) =>
      l.includes("cortex: release consumer ready"),
    );
    expect(readyLines.length).toBe(0);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("one consumer init throws → siblings still wire; boot completes; stderr logged with failing agent id", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-relboot-throw-"));
    const forgeAgent = makeAgent("forge", ["release.cut"]);
    const sageAgent = makeAgent("sage", ["release.cut"]);

    // Poison ONLY `maxConcurrent` (the filter reads `capabilities` only, so
    // forge passes the filter; the per-iteration try/catch reads
    // `maxConcurrent` to build consumerAgent — that read throws).
    Object.defineProperty(forgeAgent.runtime!, "maxConcurrent", {
      get: () => {
        throw new Error("synthetic maxConcurrent-access failure");
      },
      configurable: true,
    });

    const { result: bootResult, stderr } = await withCapturedStderr(() =>
      withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          disableConfigWatcher: true,
          disableDashboard: true,
          disableOutboundPoller: true,
          agentsDir: tmpAgentsDir,
          injectRuntime: runtime,
          inlineAgents: [forgeAgent, sageAgent],
          principal: { id: "test-op" },
        }),
      ),
    );
    const { result: handle, logs } = bootResult;

    expect(handle).toBeDefined();
    expect(stderr).toContain("release consumer init failed");
    expect(stderr).toContain("agent=forge");
    expect(stderr).toContain("synthetic maxConcurrent-access failure");

    // Sage wired successfully despite forge's failure.
    const sageReady = logs.find(
      (l) => l.includes("release consumer ready") && l.includes("agent=sage"),
    );
    expect(sageReady).toBeDefined();

    // Exactly one subscribePull (sage only).
    const releaseCalls = runtime.subscribePullCalls.filter((c) =>
      c.pattern.includes("tasks.release.cut"),
    );
    expect(releaseCalls.length).toBe(1);
    expect(releaseCalls[0]!.durable).toBe(
      "cortex-release-consumer-test-op-sage",
    );

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });
});
