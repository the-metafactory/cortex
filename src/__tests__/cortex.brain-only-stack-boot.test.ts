/**
 * cortex#2247 — brain-ONLY stack boot provisioning.
 *
 * A stack whose only agents are exec-brain (`runtime.brain.kind: exec`, zero
 * review-capable agents) must provision the BRAIN_TASKS stream AND its
 * per-capability brain durables at boot on a virgin broker, then subscribe.
 * Pre-fix, BRAIN_TASKS + the brain durables rode the `reviewJsm !== null`
 * gate — `resolveReviewProvisioningJsm` returns `null` with zero
 * review-capable agents, so a brain-only stack booted its brain consumer
 * DORMANT and every inbound surface mention was published onto a subject no
 * stream captured, then silently dropped (first live repro: the first
 * brain-only stack ever deployed; the coupling was self-documented at the
 * provisioning site as "not reachable today").
 *
 * Test infrastructure mirrors `cortex.dev-stream-boot.test.ts` (recording
 * runtime + recording JSM + captured logs), extended to record
 * `consumers.add` calls so the per-capability durable provisioning is
 * observable too. No real NATS, Discord, filesystem-watcher, or `claude`
 * spawning. All ids are obviously-fake, non-numeric placeholders
 * (confidentiality gate).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { AgentSchema, type Agent } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import type { ProvisionJsm } from "../bus/jetstream/types";
import type { ConsumerInfo, StreamInfo, StreamConfig, ConsumerConfig } from "nats";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-brain-only-boot-test-published" },
    ...overrides,
  });
}

/** Records every `streams.add` AND `consumers.add` so the boot test can read
 *  back both the provisioned stream configs and the per-capability durables.
 *  Stream/consumer `info` always 404s (virgin broker) so the provisioning
 *  helpers take the create path. */
interface JsmRecorder {
  jsm: ProvisionJsm;
  streamAdds: Partial<StreamConfig>[];
  consumerAdds: { stream: string; config: Partial<ConsumerConfig> }[];
}

function makeRecordingJsm(): JsmRecorder {
  const streamAdds: Partial<StreamConfig>[] = [];
  const consumerAdds: { stream: string; config: Partial<ConsumerConfig> }[] = [];
  const notFound = (kind: "stream" | "consumer"): Error => {
    const err = new Error(`${kind} not found`);
    (err as unknown as { api_error: { err_code: number } }).api_error = {
      err_code: kind === "stream" ? 10059 : 10014,
    };
    return err;
  };
  const jsm: ProvisionJsm = {
    streams: {
      info: async () => {
        throw notFound("stream");
      },
      add: async (cfg) => {
        streamAdds.push(cfg);
        return { config: cfg } as unknown as StreamInfo;
      },
    },
    consumers: {
      info: async () => {
        throw notFound("consumer");
      },
      add: async (stream, cfg) => {
        consumerAdds.push({ stream, config: cfg });
        return { name: cfg.durable_name } as unknown as ConsumerInfo;
      },
      update: async (_stream, durable, cfg) =>
        ({ name: durable, config: cfg } as unknown as ConsumerInfo),
      delete: async () => true,
    },
  };
  return { jsm, streamAdds, consumerAdds };
}

interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
  subscribePullCalls: MyelinSubscribePullOpts[];
}

function createRecordingRuntime(opts: { jsm?: ProvisionJsm }): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const subscribePullCalls: MyelinSubscribePullOpts[] = [];
  const runtime: RecordingRuntime = {
    enabled: true,
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
    subscribePull: (o: MyelinSubscribePullOpts): MyelinSubscriber => {
      subscribePullCalls.push(o);
      return {
        pattern: o.pattern,
        ready: Promise.resolve(),
        stop: async () => {},
      } as unknown as MyelinSubscriber;
    },
    stop: async () => {},
  };
  if (opts.jsm !== undefined) {
    runtime.jetstreamManager = async () => opts.jsm!;
  }
  return runtime;
}

/** A minimal, valid, per-task exec-brain agent — the ONLY agent on the stack
 *  (zero review-capable agents), mirroring the live brain-only repro shape
 *  (a single `kind: exec` agent with capabilities `[chat]`). */
function makeBrainOnlyAgent(personaPath: string): Agent {
  return AgentSchema.parse({
    id: "escort-like",
    displayName: "EscortLike",
    persona: personaPath,
    trust: [],
    presence: {},
    runtime: {
      mode: "in-process",
      capabilities: ["chat"],
      brain: {
        kind: "exec",
        run: "bun {pack}/brain/main.ts",
        lifecycle: "per-task",
      },
    },
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

const PRINCIPAL = "test-op";
const STACK = "default";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — brain-only stack boot provisioning (cortex#2247)", () => {
  test("a brain-only stack (zero review-capable agents) provisions BRAIN_TASKS + its per-capability durable and subscribes on a virgin broker", async () => {
    const { jsm, streamAdds, consumerAdds } = makeRecordingJsm();
    const runtime = createRecordingRuntime({ jsm });
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-brain-only-boot-"));
    const personaPath = join(tmpDir, "escort-like.md");
    writeFileSync(personaPath, "# EscortLike persona\n", "utf-8");

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: join(tmpDir, "agents.d"),
        injectRuntime: runtime,
        inlineAgents: [makeBrainOnlyAgent(personaPath)],
        principal: { id: PRINCIPAL },
      }),
    );

    // The review lane is dormant (zero review-capable agents) — CODE_REVIEW /
    // REVIEW_LIFECYCLE / DEV_IMPLEMENT are NOT provisioned…
    const byName = new Map(streamAdds.map((c) => [c.name, c]));
    expect(byName.has("CODE_REVIEW")).toBe(false);
    expect(byName.has("REVIEW_LIFECYCLE")).toBe(false);
    expect(byName.has("DEV_IMPLEMENT")).toBe(false);

    // …but BRAIN_TASKS IS — the cortex#2247 independent gate, keyed on
    // exec-brain-agent presence.
    expect(byName.has("BRAIN_TASKS")).toBe(true);
    const brain = byName.get("BRAIN_TASKS")!;
    expect(brain.subjects).toEqual([`local.${PRINCIPAL}.${STACK}.brain.>`]);
    // Config posture mirrors CODE_REVIEW (Interest retention, File storage).
    expect(String(brain.retention)).toBe("interest");
    expect(String(brain.storage)).toBe("file");

    // The per-capability brain durable is provisioned against BRAIN_TASKS with
    // the exact filter subject the consumer binds.
    const brainDurables = consumerAdds.filter((c) => c.stream === "BRAIN_TASKS");
    expect(brainDurables).toHaveLength(1);
    expect(brainDurables[0]!.config.durable_name).toBe(
      `cortex-brain-consumer-${PRINCIPAL}-escort-like-chat`,
    );
    expect(brainDurables[0]!.config.filter_subject).toBe(
      `local.${PRINCIPAL}.${STACK}.brain.chat`,
    );

    // The consumer actually SUBSCRIBED (not dormant): the pull subscription
    // binds the durable on BRAIN_TASKS…
    const brainSub = runtime.subscribePullCalls.find(
      (c) => c.pattern === `local.${PRINCIPAL}.${STACK}.brain.chat`,
    );
    expect(brainSub).toBeDefined();
    expect(brainSub!.stream).toBe("BRAIN_TASKS");
    expect(brainSub!.durable).toBe(`cortex-brain-consumer-${PRINCIPAL}-escort-like-chat`);

    // …and the boot log says READY with the capability subscribed — the exact
    // line the live brain-only stack only produced after the manual workaround.
    const readyLog = logs.find(
      (l) =>
        l.includes("brain consumer ready for agent=escort-like") &&
        l.includes("subscribed=[chat]"),
    );
    expect(readyLog).toBeDefined();
    const dormantLog = logs.find((l) =>
      l.includes("brain consumer DORMANT for agent=escort-like"),
    );
    expect(dormantLog).toBeUndefined();

    await handle.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a MIXED stack (review + brain agents) provisions BRAIN_TASKS exactly once — unchanged behaviour, no double-provisioning", async () => {
    const { jsm, streamAdds, consumerAdds } = makeRecordingJsm();
    const runtime = createRecordingRuntime({ jsm });
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-brain-mixed-boot-"));
    const personaPath = join(tmpDir, "escort-like.md");
    writeFileSync(personaPath, "# EscortLike persona\n", "utf-8");
    const reviewer = AgentSchema.parse({
      id: "echo",
      displayName: "Echo",
      persona: join(tmpDir, "echo.md"),
      trust: [],
      presence: {},
      runtime: {
        substrate: "claude-code",
        mode: "in-process",
        capabilities: ["code-review.typescript"],
      },
    });

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: join(tmpDir, "agents.d"),
        injectRuntime: runtime,
        inlineAgents: [reviewer, makeBrainOnlyAgent(personaPath)],
        principal: { id: PRINCIPAL },
      }),
    );

    // Review lane provisions as before…
    const names = streamAdds.map((c) => c.name);
    expect(names).toContain("CODE_REVIEW");
    // …and BRAIN_TASKS is provisioned EXACTLY once (the brain gate reuses the
    // already-resolved review JSM; no second streams.add).
    expect(names.filter((n) => n === "BRAIN_TASKS")).toHaveLength(1);

    // The brain durable + subscription still wire.
    expect(
      consumerAdds.some(
        (c) =>
          c.stream === "BRAIN_TASKS" &&
          c.config.durable_name === `cortex-brain-consumer-${PRINCIPAL}-escort-like-chat`,
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes("brain consumer ready for agent=escort-like") &&
          l.includes("subscribed=[chat]"),
      ),
    ).toBe(true);

    await handle.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dormant runtime (no jetstreamManager) — a brain-only stack provisions nothing and the consumer stays dormant in lockstep", async () => {
    // No JSM stub at all: any accidental provisioning attempt would throw.
    const runtime = createRecordingRuntime({});
    const tmpDir = mkdtempSync(join(tmpdir(), "cortex-brain-only-dormant-"));
    const personaPath = join(tmpDir, "escort-like.md");
    writeFileSync(personaPath, "# EscortLike persona\n", "utf-8");

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: join(tmpDir, "agents.d"),
        injectRuntime: runtime,
        inlineAgents: [makeBrainOnlyAgent(personaPath)],
        principal: { id: PRINCIPAL },
      }),
    );

    const brainProvisionLogs = logs.filter((l) =>
      l.includes('JetStream stream "BRAIN_TASKS"'),
    );
    expect(brainProvisionLogs).toHaveLength(0);

    await handle.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
