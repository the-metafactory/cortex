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
  buildDevSessionOpts,
  devSubjectPattern,
  devDurableName,
  DEFAULT_DEV_BASH_ALLOWLIST,
  type DevBootAgent,
  type DevGuardrailConfig,
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
    expect(consumers[0]!.consumer.agent.id).toBe("forge");
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
    expect(consumers[0]!.consumer.agent.maxConcurrent).toBe(3);
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

describe("buildDevSessionOpts — §3.5b guardrail parity", () => {
  const agent: DevBootAgent = {
    id: "forge",
    displayName: "Forge",
    runtime: { capabilities: ["dev.implement"] },
  };

  test("ALWAYS sets groveChannel — bash-guard Gate-1 engagement precondition", () => {
    // Without a channel, cc-session never sets CORTEX_CHANNEL and the guard
    // disengages (pass-through). The channel MUST be present on both the
    // no-config and the with-config paths.
    expect(buildDevSessionOpts(agent, undefined).groveChannel).toBe("forge");
    expect(buildDevSessionOpts(agent, { allowedTools: ["Bash"] }).groveChannel).toBe("forge");
  });

  test("ALWAYS sets bashAllowlist — conservative default when config declares none", () => {
    const opts = buildDevSessionOpts(agent, undefined);
    expect(opts.bashAllowlist).toBe(DEFAULT_DEV_BASH_ALLOWLIST);
    // Setting bashAllowlist is what keeps the session OUT of bash-guard's
    // Gate-2 CLI-bypass (AGENT_ID && !CORTEX_BASH_GUARD). It must be present.
    expect(opts.bashAllowlist).toBeDefined();
    // And the guard is NOT disabled on the higher-authority push session.
    expect((opts as { bashGuardDisabled?: boolean }).bashGuardDisabled).toBeUndefined();
  });

  test("config bashAllowlist wins over the default", () => {
    const custom = { rules: [{ pattern: "^git push" }], repos: ["the-metafactory/cortex"] };
    const opts = buildDevSessionOpts(agent, { bashAllowlist: custom });
    expect(opts.bashAllowlist).toBe(custom);
  });

  test("threads allowedTools / disallowedTools / allowedDirs / timeout from config", () => {
    const g: DevGuardrailConfig = {
      allowedTools: ["Bash", "Read", "Edit", "Write"],
      disallowedTools: ["WebFetch"],
      allowedDirs: ["/repo", "/shared-cache"],
      asyncTimeoutMs: 1_800_000,
      additionalArgs: ["--verbose"],
    };
    const opts = buildDevSessionOpts(agent, g);
    expect(opts.allowedTools).toEqual(["Bash", "Read", "Edit", "Write"]);
    expect(opts.disallowedTools).toEqual(["WebFetch"]);
    expect(opts.allowedDirs).toEqual(["/repo", "/shared-cache"]);
    expect(opts.timeoutMs).toBe(1_800_000);
    expect(opts.additionalArgs).toEqual(["--verbose"]);
  });

  test("absent allowedDirs is NOT set here (consumer defaults it to the worktree)", () => {
    // The worktree path isn't known at boot, so an absent allowedDirs is left
    // unset in the boot opts; DevConsumer fills it with the worktree per-task.
    const opts = buildDevSessionOpts(agent, undefined);
    expect(opts.allowedDirs).toBeUndefined();
  });

  test("wired consumers carry the guardrails end-to-end", () => {
    const g: DevGuardrailConfig = { allowedTools: ["Bash"], asyncTimeoutMs: 1_000_000 };
    const consumers = wireDevConsumers(baseOpts([agent], { guardrails: g }));
    expect(consumers).toHaveLength(1);
    // The consumer doesn't expose sessionOpts publicly; the contract is proven
    // by buildDevSessionOpts above + the consumer's worktree-allowedDir test in
    // dev-consumer.test.ts. Here we just confirm wiring doesn't throw.
    expect(consumers[0]!.consumer.agent.id).toBe("forge");
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
