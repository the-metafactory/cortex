import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateExecutionRunFinished, type MyelinEnvelope } from "@the-metafactory/myelin";
import { AgentConfigSchema } from "../common/types/config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";
import {
  createDispatchTaskAbortedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskStartedEvent,
} from "../bus/dispatch-events";

describe("cortex run-ledger boot", () => {
  test.each([
    [false, false, "default"],
    [false, true, "work"],
    [true, false, "default"],
    [true, true, "work"],
  ] as const)("registers with mc=%s vigil=%s stack=%s", async (mcEnabled, vigilEnabled, stack) => {
    const directory = mkdtempSync(join(tmpdir(), "cortex-run-ledger-"));
    const handlers = new Set<EnvelopeHandler>();
    const published: { envelope: Envelope; subject: string }[] = [];
    const runtime: MyelinRuntime = {
      enabled: false,
      onEnvelope(handler) {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async () => {},
      publishOnSubject: async (envelope, subject) => { published.push({ envelope, subject }); },
      stop: async () => {},
    };
    const config = Object.assign(AgentConfigSchema.parse({
      agent: { name: "test-cortex", displayName: "TestCortex" },
      discord: [],
      mattermost: [],
      claude: { timeoutMs: 120_000 },
      paths: { publishedEventsDir: join(directory, "published") },
      mc: { enabled: mcEnabled },
    }), { vigil: { enabled: vigilEnabled } });
    const handle = await startCortex(config, {
      injectRuntime: runtime,
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: directory,
      principal: { id: "jc" },
      stack: { id: `jc/${stack}` },
    });
    const common = {
      source: { principal: "jc", agent: "cortex", instance: stack },
      agentId: "sage",
      startedAt: new Date("2026-10-12T10:00:00.000Z"),
    };
    const end = new Date("2026-10-12T10:00:05.000Z");
    const terminal = [
      createDispatchTaskCompletedEvent({ ...common, taskId: "t1", completedAt: end }),
      createDispatchTaskFailedEvent({ ...common, taskId: "t2", failedAt: end, errorSummary: "failed" }),
      createDispatchTaskAbortedEvent({ ...common, taskId: "t3", abortedAt: end, reason: "timeout" }),
    ];
    const deliver = async (envelope: Envelope, subject: string) => {
      for (const handler of handlers) handler(envelope, subject);
      // The runtime-to-router hook deliberately fans out without awaiting renders.
      await Bun.sleep(0);
    };
    try {
      for (const envelope of terminal) {
        await deliver(envelope, `local.jc.${stack}.${envelope.type}`);
      }
      expect(published).toHaveLength(3);
      expect(published.map(event => event.envelope.payload.outcome)).toEqual([
        "succeeded", "failed", "cancelled",
      ]);
      expect(published.map(event => event.envelope.payload.run_id)).toEqual(["t1", "t2", "t3"]);
      for (const event of published) {
        expect(event.subject).toBe(`local.jc.${stack}.execution.run.finished`);
        // createEnvelope emits the canonical shape; the runtime interface also admits legacy stamps.
        expect(validateExecutionRunFinished(event.envelope as MyelinEnvelope).valid).toBe(true);
      }
      await deliver(createDispatchTaskStartedEvent({ ...common, taskId: "started" }),
        `local.jc.${stack}.dispatch.task.started`);
      for (const envelope of terminal) {
        await deliver(envelope, `local.jc.switch.${envelope.type}`);
        await deliver(envelope, `federated.jc.${stack}.${envelope.type}`);
      }
      expect(published).toHaveLength(3);
    } finally {
      await handle.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
