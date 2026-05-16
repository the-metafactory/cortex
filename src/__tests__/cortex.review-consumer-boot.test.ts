/**
 * cortex#237 PR-6 — review-consumer boot wiring tests.
 *
 * Asserts the §3 boot loop:
 *
 *   for each agent in mergedAgents:
 *     if agent.runtime?.capabilities contains "code-review" or "code-review.<flavor>":
 *       new ReviewConsumer(...) → one instance per such agent
 *
 * Covers:
 *
 *   1. N code-review-capable agents → N consumer instances, each logged with
 *      the right flavor summary.
 *   2. Zero code-review-capable agents → zero consumers; boot completes
 *      silently with the documented skip message.
 *   3. One consumer constructor throws → siblings still wire; boot completes;
 *      stderr carries the failing agent id.
 *
 * The pure-instantiation contract is the right boot-test surface because the
 * actual pull-mode `consumer.start({ link })` is deferred to a follow-up PR
 * once the runtime exposes its `NatsLink` (see the boot wiring's
 * "Subscription deferral" docblock in `src/cortex.ts`). Per-envelope
 * behaviour is covered by `src/bus/__tests__/review-consumer.test.ts`.
 *
 * Test infrastructure mirrors `cortex.capability-boot.test.ts`:
 *   - `minimalConfig` factory for a NATS-absent BotConfig.
 *   - `createRecordingRuntime` factory — same shape as the capability-boot
 *     test's recorder so reviewers see one pattern.
 *   - `inlineAgents` injected via `StartCortexOptions.inlineAgents`.
 *
 * No real NATS, Discord, filesystem-watcher I/O, or `claude` spawning.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { BotConfigSchema, type BotConfig } from "../common/types/config";
import type { Agent, AgentRuntime } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Test helpers — mirror cortex.capability-boot.test.ts so reviewers see one
// pattern across PR-7 + PR-6 boot tests. Kept local to avoid cross-test-file
// coupling per the same rationale documented in the capability-boot helper.
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): BotConfig {
  return BotConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
      operatorId: "test-op",
    },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
    ...overrides,
  });
}

interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  return {
    enabled: false,
    onEnvelopeHandlers,
    published,
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
    roles: [],
    trust: [],
    presence: {},
    ...(runtime !== undefined && { runtime }),
  };
}

/**
 * stderr capture for the consumer-init-failure path. Same pattern as the
 * capability-boot test's `withCapturedStderr`.
 */
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

/**
 * console.log capture — the boot path logs one "review consumer ready"
 * line per instantiated consumer. Test asserts on those lines rather than
 * the consumer's internal state (the consumer module's own tests cover
 * processEnvelope behaviour; the boot test cares about WHICH consumers
 * got wired).
 */
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

describe("startCortex — review-consumer boot wiring (cortex#237 PR-6)", () => {
  test("2 agents each declaring code-review.typescript + code-review.security → 2 consumers instantiated + logged", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-revboot-N-"));
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript", "code-review.security"]),
      makeAgent("luna", ["code-review.typescript", "code-review.security"]),
    ];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
      }),
    );

    // Two "review consumer ready" log lines — one per agent. The line
    // shape is locked in by the boot wiring; assert both the agent id
    // and the flavor summary.
    const readyLines = logs.filter((l) =>
      l.includes("cortex: review consumer ready"),
    );
    expect(readyLines.length).toBe(2);

    const echoLine = readyLines.find((l) => l.includes("agent=echo"));
    const lunaLine = readyLines.find((l) => l.includes("agent=luna"));
    expect(echoLine).toBeDefined();
    expect(lunaLine).toBeDefined();
    expect(echoLine!).toContain("flavors=[typescript,security]");
    expect(lunaLine!).toContain("flavors=[typescript,security]");

    // The "skipped" line MUST NOT appear when at least one consumer wired.
    const skipLines = logs.filter((l) =>
      l.includes("cortex: review-consumer skipped"),
    );
    expect(skipLines.length).toBe(0);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("zero code-review-capable agents → zero consumers; boot completes silently with the skip log", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-revboot-zero-"));
    // Mix that should NOT trigger any consumer:
    //   - luna: no `runtime` at all
    //   - holly: `code-review` substring absent (research only)
    //   - ivy: `runtime.capabilities` is the empty array
    const inlineAgents: Agent[] = [
      makeAgent("luna", undefined),
      makeAgent("holly", ["research.web", "research.papers"]),
      makeAgent("ivy", []),
    ];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
      }),
    );

    const readyLines = logs.filter((l) =>
      l.includes("cortex: review consumer ready"),
    );
    expect(readyLines.length).toBe(0);

    const skipLines = logs.filter((l) =>
      l.includes("cortex: review-consumer skipped"),
    );
    expect(skipLines.length).toBe(1);
    expect(skipLines[0]!).toContain(
      "0 agents declare code-review capabilities",
    );

    expect(handle).toBeDefined();
    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("one consumer init throws → siblings still wire; boot completes; stderr logged with failing agent id", async () => {
    // The boot wiring filters `mergedAgents` by `a.runtime?.capabilities`
    // (reads `capabilities`) and then, inside a try/catch, reads
    // `agent.runtime?.maxConcurrent`. To hit the per-iteration try/catch
    // (the contract we want to exercise) without crashing the pre-filter,
    // poison ONLY `maxConcurrent` — the filter doesn't touch it.
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-revboot-throw-"));
    const echoAgent = makeAgent("echo", ["code-review.typescript"]);
    const lunaAgent = makeAgent("luna", ["code-review.typescript"]);

    // Inject a throwing `maxConcurrent` getter on echo's runtime. The
    // filter step reads `capabilities` only, so echo passes through into
    // the per-iteration loop. Inside the try/catch the boot wiring reads
    // `agent.runtime?.maxConcurrent` to build `consumerAgent` — that
    // read throws, the catch fires, stderr logs the failure, and the
    // loop continues to luna.
    Object.defineProperty(echoAgent.runtime!, "maxConcurrent", {
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
          inlineAgents: [echoAgent, lunaAgent],
        }),
      ),
    );
    const { result: handle, logs } = bootResult;

    // Boot completed despite the poisoned agent.
    expect(handle).toBeDefined();

    // Stderr captured the failing-agent log line per the wiring's
    // "no empty catch blocks" rule. Assert on both substrings — the
    // exact wording can drift without breaking the contract.
    expect(stderr).toContain("review consumer init failed");
    expect(stderr).toContain("agent=echo");
    expect(stderr).toContain("synthetic maxConcurrent-access failure");

    // Luna's consumer wired successfully — the failure on echo did NOT
    // abort sibling wiring. Assert on the "ready" log line for luna.
    const lunaReadyLine = logs.find(
      (l) => l.includes("review consumer ready") && l.includes("agent=luna"),
    );
    expect(lunaReadyLine).toBeDefined();

    // Echo did NOT show a "ready" line (failed before the log).
    const echoReadyLine = logs.find(
      (l) => l.includes("review consumer ready") && l.includes("agent=echo"),
    );
    expect(echoReadyLine).toBeUndefined();

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });
});
