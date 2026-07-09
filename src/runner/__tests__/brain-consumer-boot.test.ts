/**
 * S8 (epic #1514, cortex#1522) — brain-consumer boot-wiring tests.
 *
 * Unit-level coverage of `wireBrainConsumers` IN ISOLATION — no
 * `startCortex`, no filesystem beyond a throwaway persona file, no NATS, no
 * `agents.d/` boot machinery. Assertions the pre-extraction inline closure
 * never had at this grain: that `startForAgent` can be exercised directly
 * against a fixture opts object, that it binds the expected `brain.`-family
 * subject pattern + durable per declared capability via the runtime's
 * `subscribePull`, and that it pushes onto the shared `brainConsumers[]`
 * array passed in (this module doesn't own that array's lifecycle — see the
 * file header in `brain-consumer-boot.ts`).
 *
 * The full `startCortex` integration coverage (hot-add/remove/change,
 * mutual exclusion with the review lane, dormancy) lives in
 * `src/__tests__/cortex.agents-reload.test.ts` and continues to pass
 * unchanged against this extraction — that file is the
 * byte-identical-behaviour regression guard; this one is the new module's
 * own unit contract.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  wireBrainConsumers,
  type BrainBootAgent,
  type WireBrainConsumersOpts,
} from "../brain-consumer-boot";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { BrainConsumer } from "../../bus/brain-consumer";
import { DaemonBrainHost } from "../../brain/daemon-brain-host";

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

// A throwaway persona file per test file run — `loadBrainPersona` reads it
// from disk (a missing file is non-fatal, but we exercise the happy path).
const personaDir = mkdtempSync(join(tmpdir(), "cortex-brain-boot-test-"));
const personaPath = join(personaDir, "persona.md");
writeFileSync(personaPath, "# test persona\n");
afterAll(() => {
  rmSync(personaDir, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<WireBrainConsumersOpts> = {}): WireBrainConsumersOpts {
  return {
    brainPackBaseDir: personaDir,
    reviewPrincipalId: "andreas",
    stack: "work",
    systemEventSource: { principal: "andreas", agent: "cortex", instance: "local" },
    runtime: fakeRuntime(),
    brainPresenceHolder: { producer: null },
    brainConsumers: [],
    daemonBrainHosts: [],
    reviewJsm: null,
    brainTasksStream: "BRAIN_TASKS",
    reviewConsumerMaxDeliver: 5,
    ...overrides,
  };
}

function agent(
  id: string,
  capabilities: readonly string[],
  brainOverrides: Partial<NonNullable<NonNullable<BrainBootAgent["runtime"]>["brain"]>> = {},
): BrainBootAgent {
  return {
    id,
    persona: personaPath,
    runtime: {
      capabilities,
      brain: {
        kind: "exec",
        run: "bun {pack}/brain/main.ts",
        lifecycle: "per-task",
        secrets: [],
        dispatch_capabilities: [],
        maxRestarts: 3,
        ...brainOverrides,
      },
    },
  };
}

describe("wireBrainConsumers — per-capability binding", () => {
  test("startForAgent binds one durable per capability and pushes onto the shared brainConsumers[]", async () => {
    const runtime = fakeRuntime();
    const brainConsumers: BrainConsumer[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({ runtime, brainConsumers }),
    );

    await startForAgent(agent("yarrow", ["soc.compose.flow"]));

    expect(brainConsumers).toHaveLength(1);
    expect(brainConsumers[0]!.agent.id).toBe("yarrow");

    expect(runtime.subscribePullCalls).toHaveLength(1);
    expect(runtime.subscribePullCalls[0]!.pattern).toBe(
      "local.andreas.work.brain.soc.compose.flow",
    );
    expect(runtime.subscribePullCalls[0]!.durable).toBe(
      "cortex-brain-consumer-andreas-yarrow-soc-compose-flow",
    );
    expect(runtime.subscribePullCalls[0]!.stream).toBe("BRAIN_TASKS");
  });

  test("a builtin/absent brain (no kind: exec) is a no-op — no consumer constructed", async () => {
    const runtime = fakeRuntime();
    const brainConsumers: BrainConsumer[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({ runtime, brainConsumers }),
    );

    await startForAgent({
      id: "echo",
      persona: personaPath,
      runtime: { capabilities: ["code-review"] },
    });

    expect(brainConsumers).toHaveLength(0);
    expect(runtime.subscribePullCalls).toHaveLength(0);
  });

  test("dormant runtime (no subscribePull) → consumer still constructed, no throw", async () => {
    const dormantRuntime: MyelinRuntime = {
      enabled: false,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      stop: async () => {},
      // subscribePull omitted — BrainConsumer.start() treats that as dormant.
    };
    const brainConsumers: BrainConsumer[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({ runtime: dormantRuntime, brainConsumers }),
    );

    await startForAgent(agent("yarrow", ["soc.compose.flow"]));

    expect(brainConsumers).toHaveLength(1);
  });
});

describe("wireBrainConsumers — daemon lifecycle", () => {
  // Note: `wireBrainConsumers` fires `daemonHost.start()` non-blockingly
  // (`void … .catch(...)`, mirroring the pre-extraction closure — see the
  // module's file header). There is no `{pack}/brain/main.ts` under
  // `personaDir` for this test, so that background spawn+connect rejects and
  // logs a caught (not unhandled) stderr line sometime after this test's
  // synchronous assertions — harmless, and not this test's concern (the real
  // daemon connect/protocol lifecycle is `daemon-brain-host.test.ts`'s job).
  test("lifecycle: daemon pushes a DaemonBrainHost onto the shared daemonBrainHosts[]", async () => {
    const runtime = fakeRuntime();
    const brainConsumers: BrainConsumer[] = [];
    const daemonBrainHosts: DaemonBrainHost[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({ runtime, brainConsumers, daemonBrainHosts }),
    );

    await startForAgent(
      agent("yarrow", ["soc.compose.flow"], { lifecycle: "daemon" }),
    );

    expect(brainConsumers).toHaveLength(1);
    expect(daemonBrainHosts).toHaveLength(1);
    expect(daemonBrainHosts[0]!.agentId).toBe("yarrow");
  });
});

describe("wireBrainConsumers — dispatch state recorder gating (cortex#1720 S3)", () => {
  test("a STATEFUL agent (declares state) gets a dispatch state recorder", async () => {
    const runtime = fakeRuntime();
    const madeFor: string[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({
        runtime,
        makeDispatchStateRecorder: (a) => {
          madeFor.push(a.id);
          return { onDispatchAccepted() {}, onDispatchResolved() {} };
        },
      }),
    );

    await startForAgent({
      ...agent("luna", ["soc.compose.flow"]),
      state: { blueprint: "AgentState", version: ">=0.1.0" },
    });

    // The factory was consulted exactly once, for the stateful agent — proof the
    // recorder is constructed behind `if (agent.state)`.
    expect(madeFor).toEqual(["luna"]);
  });

  test("REGRESSION: a STATELESS agent (no state) gets NO recorder — zero new code paths", async () => {
    const runtime = fakeRuntime();
    const madeFor: string[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({
        runtime,
        makeDispatchStateRecorder: (a) => {
          madeFor.push(a.id);
          return { onDispatchAccepted() {}, onDispatchResolved() {} };
        },
      }),
    );

    // No `state` block — the stateless default.
    await startForAgent(agent("yarrow", ["soc.compose.flow"]));

    // The factory was NEVER consulted — the `if (agent.state)` guard short-circuits.
    expect(madeFor).toEqual([]);
  });

  test("a mixed roster wires a recorder ONLY for the stateful fragment", async () => {
    const runtime = fakeRuntime();
    const madeFor: string[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({
        runtime,
        makeDispatchStateRecorder: (a) => {
          madeFor.push(a.id);
          return { onDispatchAccepted() {}, onDispatchResolved() {} };
        },
      }),
    );

    await startForAgent(agent("yarrow", ["soc.compose.flow"])); // stateless
    await startForAgent({
      ...agent("luna", ["soc.compose.flow"]),
      state: { blueprint: "AgentState", version: ">=0.2.0" },
    }); // stateful

    expect(madeFor).toEqual(["luna"]);
  });
});

describe("wireBrainConsumers — per-agent failure isolation", () => {
  test("a synchronous failure inside startForAgent is caught and logged, not thrown", async () => {
    // A runtime whose `subscribePull` throws synchronously — simulates the
    // consumer's construction/subscribe path failing partway through.
    const throwingRuntime: MyelinRuntime = {
      enabled: false,
      onEnvelope: () => ({ unregister: () => {} }),
      publish: async () => {},
      stop: async () => {},
      subscribePull: () => {
        throw new Error("synthetic subscribePull failure");
      },
    };
    const brainConsumers: BrainConsumer[] = [];
    const { startForAgent } = wireBrainConsumers(
      baseOpts({ runtime: throwingRuntime, brainConsumers }),
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
      // `for (const agent of brainAgents)` boot loop depends on this).
      await expect(
        startForAgent(agent("yarrow", ["soc.compose.flow"])),
      ).resolves.toBeUndefined();
    } finally {
      process.stderr.write = original;
    }

    expect(stderr).toContain("brain consumer init failed");
    expect(stderr).toContain("agent=yarrow");
    expect(stderr).toContain("synthetic subscribePull failure");
    // The consumer was pushed onto brainConsumers[] BEFORE the failing
    // subscribe (mirrors the pre-extraction closure's ordering), so the
    // shutdown drain still sees it.
    expect(brainConsumers).toHaveLength(1);
  });
});
