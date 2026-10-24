import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsumerInfo, StreamInfo } from "nats";
import { bootOrDie, startCortex } from "../../cortex";
import { AgentConfigSchema } from "../../common/types/config";
import { NatsConfigSchema } from "../../common/types/cortex-config";
import { hermeticBootPaths } from "../../common/test-utils";
import {
  JetstreamBootTimeoutError,
  retryJetstreamBootStep,
  runJetstreamBootStep,
} from "../jetstream/boot-retry";
import { DEFAULT_ACK_WAIT_NS, provisionPullConsumer, provisionStream } from "../jetstream/provision";
import type { ProvisionJsm } from "../jetstream/types";
import type { MyelinRuntime } from "../myelin/runtime";
import type { MyelinSubscriber } from "../myelin/subscriber";
import { ReflexActivationListener, inMemoryReflexDedup } from "../reflex-activation-listener";

const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

function retryClock() {
  let elapsed = 0;
  const delays: number[] = [];
  const lines: string[] = [];
  return {
    delays,
    lines,
    options: {
      now: () => elapsed,
      sleep: async (ms: number) => { delays.push(ms); elapsed += ms; },
      log: { warn: (line: string) => { lines.push(line); } },
    },
  };
}

function provisioningManager() {
  const consumerInfo = { config: { filter_subject: "local.synthetic.default.reflex.activation.fired", ack_wait: DEFAULT_ACK_WAIT_NS } } as ConsumerInfo;
  const streamInfo = { config: { subjects: ["local.synthetic.default.reflex.>"] } } as StreamInfo;
  return {
    consumers: {
      info: mock(async () => consumerInfo),
      add: mock(async () => consumerInfo),
      update: mock(async () => consumerInfo),
      delete: mock(async () => true),
    },
    streams: {
      info: mock(async () => streamInfo),
      add: mock(async () => streamInfo),
      update: mock(async () => streamInfo),
    },
  } satisfies ProvisionJsm;
}

describe("JetStream boot retry", () => {
  test("both config schemas preserve the API timeout and reject invalid values", () => {
    const config = { url: "nats://localhost:4222", jetstreamTimeoutMs: 25_000 };
    expect(NatsConfigSchema.parse(config).jetstreamTimeoutMs).toBe(25_000);
    expect(AgentConfigSchema.parse({ agent: { name: "synthetic", displayName: "Synthetic" }, claude: {}, nats: config }).nats?.jetstreamTimeoutMs).toBe(25_000);
    for (const jetstreamTimeoutMs of [0, -1, 1.5]) {
      expect(NatsConfigSchema.safeParse({ ...config, jetstreamTimeoutMs }).success).toBe(false);
    }
  });

  test.each(["recovered", "exhausted"])("Cortex boots with a %s Reflex manager timeout", async (state) => {
    const agentsDir = mkdtempSync(join(tmpdir(), "synthetic-boot-agents-"));
    const jsm = provisioningManager();
    let calls = 0;
    const bind = mock(() => ({ ready: Promise.resolve(), stop: async () => {} }) as MyelinSubscriber);
    const runtime: MyelinRuntime = {
      enabled: true,
      publish: async () => {},
      onEnvelope: () => ({ unregister: () => {} }),
      stop: async () => {},
      subscribePull: bind,
      jetstreamManager: async () => {
        calls++;
        if (state === "exhausted") {
          return retryJetstreamBootStep("synthetic manager", async () => { throw timeout(); }, { ...retryClock().options, maxAttempts: 1 });
        }
        if (calls === 1) throw timeout();
        return jsm;
      },
    };
    try {
      const config = AgentConfigSchema.parse({ agent: { name: "synthetic", displayName: "Synthetic" }, claude: {} });
      const handle = await startCortex(config, {
        injectRuntime: runtime,
        agentsDir,
        ...hermeticBootPaths(),
        principal: { id: "synthetic" },
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        reflexActivation: { stack: "default", targets: [{ target: "synthetic", capability: "synthetic.run", assistant: "synthetic", prompt: "Synthetic test" }] },
      });
      try {
        expect(calls).toBe(state === "recovered" ? 2 : 1);
        expect(bind).toHaveBeenCalledTimes(state === "recovered" ? 1 : 0);
        expect(handle.agentGeneration).toBe(0);
      } finally {
        await handle.stop();
      }
      expect(handle.lastShutdownAbandoned).toEqual([]);
    } finally {
      rmSync(agentsDir, { recursive: true, force: true });
    }
  });

  test("retries API timeouts with capped backoff and logs every retry", async () => {
    const clock = retryClock();
    let calls = 0;
    const value = await runJetstreamBootStep("synthetic manager", async () => {
      if (++calls < 8) throw timeout();
      return "ready";
    }, clock.options);
    expect(value).toBe("ready");
    expect(clock.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(clock.lines).toHaveLength(7);
    expect(clock.lines.every((line) => line.includes("TIMEOUT; retry"))).toBe(true);
  });

  test("exhaustion degrades the step and boot continues without a fatal exit", async () => {
    const clock = retryClock();
    const action = mock(async () => { throw timeout(); });
    const result = await bootOrDie(async () => {
      const degraded = await runJetstreamBootStep("synthetic subsystem", action, clock.options);
      const sibling = await runJetstreamBootStep("healthy sibling", async () => "running", clock.options);
      return { degraded, sibling };
    }, "/unused-synthetic-boot.pid");
    expect(result).toEqual({ degraded: null, sibling: "running" });
    expect(action).toHaveBeenCalledTimes(8);
    expect(clock.lines.at(-1)).toContain("degraded: synthetic subsystem");
    expect(clock.lines.at(-1)).toContain("after 8 attempt(s)");
  });

  test("elapsed API time counts toward the retry budget", async () => {
    const clock = retryClock();
    const action = mock(async () => {
      await clock.options.sleep(60_000);
      throw timeout();
    });
    expect(await runJetstreamBootStep("slow API", action, clock.options)).toBeNull();
    expect(action).toHaveBeenCalledTimes(3);
    expect(clock.lines.filter((line) => line.includes("retry "))).toHaveLength(2);
  });

  test.each([
    Object.assign(new Error("permission denied"), { code: "PERMISSIONS_VIOLATION" }),
    Object.assign(new Error("invalid stream configuration"), { code: "400" }),
    new Error("TIMEOUT"),
  ])("non-timeout errors fail immediately without retry or degraded handling", async (error) => {
    const clock = retryClock();
    const action = mock(async () => { throw error; });
    await expect(runJetstreamBootStep("bad config", action, clock.options)).rejects.toBe(error);
    expect(action).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
    expect(clock.lines).toEqual([]);
  });

  test("an exhausted inner step does not restart the outer retry budget", async () => {
    const clock = retryClock();
    const inner = mock(async () => { throw timeout(); });
    const outer = mock(() => retryJetstreamBootStep("inner", inner, { ...clock.options, maxAttempts: 2 }));
    expect(await runJetstreamBootStep("outer", outer, clock.options)).toBeNull();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(clock.lines.filter((line) => line.includes("degraded:"))).toHaveLength(1);
  });

  test("consumer provisioning retries consumers.info before reconciling", async () => {
    const clock = retryClock();
    const jsm = provisioningManager();
    const existing = await jsm.consumers.info();
    let attempts = 0;
    jsm.consumers.info = mock(async () => {
      if (++attempts <= 2) throw timeout();
      return existing;
    });
    expect(await provisionPullConsumer({ jsm, stream: "REFLEX", durable: "synthetic", filterSubject: existing.config.filter_subject!, bootRetry: clock.options, log: { info: () => {}, ...clock.options.log } })).toBe("exists");
    expect(clock.delays).toEqual([1_000, 2_000]);
    expect(jsm.consumers.add).not.toHaveBeenCalled();
  });

  test("provisioning exhaustion logs degraded and can be handled by boot", async () => {
    const clock = retryClock();
    const jsm = provisioningManager();
    jsm.streams.info = mock(async () => { throw timeout(); });
    const action = () => provisionStream({ jsm, name: "SYNTHETIC", subjects: ["local.synthetic.default.reflex.>"], bootRetry: { ...clock.options, maxAttempts: 2 }, log: { info: () => {}, ...clock.options.log } });
    expect(await runJetstreamBootStep("stream boot", action, clock.options)).toBeNull();
    expect(jsm.streams.info).toHaveBeenCalledTimes(2);
    expect(clock.lines.at(-1)).toContain("degraded: provision stream SYNTHETIC");
  });

  test("provisioning rejects a configuration error without retries", async () => {
    const clock = retryClock();
    const jsm = provisioningManager();
    const denied = Object.assign(new Error("permission denied"), { code: "403" });
    jsm.consumers.info = mock(async () => { throw denied; });
    await expect(provisionPullConsumer({ jsm, stream: "REFLEX", durable: "synthetic", bootRetry: clock.options })).rejects.toBe(denied);
    expect(jsm.consumers.info).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });

  test.each(["manager", "ready"])("Reflex boot recovers after %s times out twice", async (stage) => {
    const clock = retryClock();
    const jsm = provisioningManager();
    let managerCalls = 0;
    let bindCalls = 0;
    let stopped = 0;
    const runtime: MyelinRuntime = {
      enabled: true,
      publish: async () => {},
      onEnvelope: () => ({ unregister: () => {} }),
      stop: async () => {},
      jetstreamManager: async () => {
        if (++managerCalls <= 2 && stage === "manager") throw timeout();
        return jsm;
      },
      subscribePull: () => {
        const fail = ++bindCalls <= 2 && stage === "ready";
        return {
          ready: fail ? Promise.reject(timeout()) : Promise.resolve(),
          stop: async () => { stopped++; },
        } as MyelinSubscriber;
      },
    };
    const listener = new ReflexActivationListener({
      runtime,
      source: { principal: "synthetic", agent: "cortex", instance: "test" },
      reEmitPrincipal: "synthetic",
      reEmitStack: "default",
      reflexPrincipal: "synthetic",
      reflexStack: "default",
      resolveTarget: () => undefined,
      dedup: inMemoryReflexDedup(),
      log: { info: () => {}, ...clock.options.log },
    });
    await runJetstreamBootStep("reflex activation listener", () => listener.start(), clock.options);
    expect(clock.delays).toEqual([1_000, 2_000]);
    expect(managerCalls).toBe(3);
    expect(bindCalls).toBe(stage === "ready" ? 3 : 1);
    expect(stopped).toBe(stage === "ready" ? 2 : 0);
    await listener.start();
    expect(managerCalls).toBe(3);
    await listener.stop();
    expect(stopped).toBe(stage === "ready" ? 3 : 1);
  });

  test("retry helper preserves exhausted timeout cause", async () => {
    const error = timeout();
    const promise = retryJetstreamBootStep("synthetic", async () => { throw error; }, { ...retryClock().options, maxAttempts: 1 });
    await expect(promise).rejects.toBeInstanceOf(JetstreamBootTimeoutError);
    await expect(promise).rejects.toHaveProperty("cause", error);
  });
});
