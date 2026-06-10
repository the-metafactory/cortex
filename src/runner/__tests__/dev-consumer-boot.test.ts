/**
 * F-2.1 (cortex#835) — dev-consumer boot-wiring tests.
 *
 * The DORMANCY PROOF at the wiring level: `wireDevConsumers` returns an empty
 * array — touching NOTHING — when no agent declares `dev.implement`. Plus the
 * §3.5b authority warning (loud when no scoped token) and the subject/durable
 * naming.
 *
 * The full boot smoke (`startCortex` with no dev capability → no consumer) is
 * proven by `src/__tests__/cortex.test.ts` running green unchanged.
 */

import { describe, expect, test } from "bun:test";
import {
  wireDevConsumers,
  devSubjectPattern,
  devDurableName,
  type DevBootAgent,
  type WireDevConsumersOpts,
} from "../dev-consumer-boot";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../../bus/myelin/runtime";
import type { DispatchEventSource } from "../../bus/dispatch-events";
import type {
  DevWorkspace,
  DevCommandRunner,
  DevForge,
} from "../dev-consumer";
import { MemoryDevSessionStore } from "../dev-session-store";

const SOURCE: DispatchEventSource = { principal: "andreas", agent: "cortex", instance: "local" };

function fakeRuntime(): MyelinRuntime {
  const handlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    onEnvelope(h) {
      handlers.add(h);
      return { unregister: () => handlers.delete(h) };
    },
    publish: async (_e: Envelope) => {},
    stop: async () => {},
  };
}

// Inert seams so the boot test never reaches real git/gh/CC even when a dev
// agent IS declared.
const NOOP_SEAMS: NonNullable<WireDevConsumersOpts["seamsOverride"]> = {
  workspace: {
    create: async () => ({ path: "/tmp/x" }),
    remove: async () => {},
  } satisfies DevWorkspace,
  commandRunner: { run: async () => ({ ok: true }) } satisfies DevCommandRunner,
  forge: {
    openPr: async () => ({ repo: "o/r", number: 1, url: "u" }),
  } satisfies DevForge,
  sessionStore: new MemoryDevSessionStore(),
};

function baseOpts(
  agents: DevBootAgent[],
  overrides: Partial<WireDevConsumersOpts> = {},
): WireDevConsumersOpts {
  return {
    agents,
    runtime: fakeRuntime(),
    source: SOURCE,
    principalId: "andreas",
    stack: "work",
    seamsOverride: NOOP_SEAMS,
    env: {},
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  };
}

describe("wireDevConsumers — dormancy", () => {
  test("no dev-capable agent → EMPTY array, no warning, no seams touched", () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    const consumers = wireDevConsumers({
      agents: [
        { id: "luna", runtime: { capabilities: ["chat"] } },
        { id: "echo", runtime: { capabilities: ["code-review.typescript"] } },
        { id: "headless" }, // no runtime block at all
      ],
      runtime: fakeRuntime(),
      source: SOURCE,
      principalId: "andreas",
      stack: "work",
      env: {},
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    });
    expect(consumers).toEqual([]);
    // Silent — no token warning, because no dev agent means no forge identity.
    expect(logs.warn).toHaveLength(0);
    expect(logs.info).toHaveLength(0);
  });

  test("dev.implement-capable agent → one consumer", () => {
    const consumers = wireDevConsumers(
      baseOpts([{ id: "forge", displayName: "Forge", runtime: { capabilities: ["dev.implement"] } }]),
    );
    expect(consumers).toHaveLength(1);
    expect(consumers[0]!.agent.id).toBe("forge");
  });

  test("bare `dev` capability also qualifies", () => {
    const consumers = wireDevConsumers(
      baseOpts([{ id: "forge", runtime: { capabilities: ["dev"] } }]),
    );
    expect(consumers).toHaveLength(1);
  });

  test("maxConcurrent carried onto the consumer agent", () => {
    const consumers = wireDevConsumers(
      baseOpts([
        { id: "forge", runtime: { capabilities: ["dev.implement"], maxConcurrent: 3 } },
      ]),
    );
    expect(consumers[0]!.agent.maxConcurrent).toBe(3);
  });
});

describe("wireDevConsumers — §3.5b authority warning", () => {
  test("no scoped token → LOUD warning citing the accepted-risk note", () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    wireDevConsumers({
      agents: [{ id: "forge", runtime: { capabilities: ["dev.implement"] } }],
      runtime: fakeRuntime(),
      source: SOURCE,
      principalId: "andreas",
      stack: "work",
      seamsOverride: NOOP_SEAMS,
      env: {}, // CORTEX_DEV_GH_TOKEN unset
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    });
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("AMBIENT");
    expect(logs.warn[0]).toContain("§3.5b");
    expect(logs.warn[0]).toContain("CORTEX_DEV_GH_TOKEN");
  });

  test("scoped token present → info line, no warning", () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    wireDevConsumers({
      agents: [{ id: "forge", runtime: { capabilities: ["dev.implement"] } }],
      runtime: fakeRuntime(),
      source: SOURCE,
      principalId: "andreas",
      stack: "work",
      seamsOverride: NOOP_SEAMS,
      env: { CORTEX_DEV_GH_TOKEN: "ghp_scoped_machine_user" },
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    });
    expect(logs.warn).toHaveLength(0);
    expect(logs.info.some((m) => m.includes("scoped forge identity"))).toBe(true);
  });

  test("custom token env name honoured", () => {
    const logs = { info: [] as string[], warn: [] as string[] };
    wireDevConsumers({
      agents: [{ id: "forge", runtime: { capabilities: ["dev.implement"] } }],
      runtime: fakeRuntime(),
      source: SOURCE,
      principalId: "andreas",
      stack: "work",
      seamsOverride: NOOP_SEAMS,
      devGhTokenEnv: "FORGE_PAT",
      env: { FORGE_PAT: "x" },
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    });
    expect(logs.warn).toHaveLength(0);
  });
});

describe("naming helpers", () => {
  test("subject pattern + durable name", () => {
    expect(devSubjectPattern("andreas", "work")).toBe(
      "local.andreas.work.tasks.dev.implement",
    );
    expect(devDurableName("andreas", "forge")).toBe("cortex-dev-consumer-andreas-forge");
  });
});
