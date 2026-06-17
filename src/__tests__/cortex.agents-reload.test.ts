/**
 * B-0 (cortex#1021, design-bot-packs §7 + §11) — daemon-level agents.d/ hot
 * reload tests.
 *
 * Drives `startCortex` with a real `agents.d/` tmp dir + injected recording
 * runtime, then exercises the reconcile path through the handle's
 * `reloadAgents()` (deterministic — no fs.watch timing) AND through the live
 * fs.watch watcher (debounce overridden short). Asserts:
 *
 *   - a fragment ADD starts the new agent's review consumer + bumps generation
 *   - a fragment REMOVE drains the agent's consumer + bumps generation
 *   - a fragment CHANGE is remove+add
 *   - capability registry is re-published on reload (deliverable 3)
 *   - derived provided_by: a declaration-only capability needs no catalog edit
 *   - an invalid fragment is rejected without killing the daemon (old
 *     generation retained, prior consumers intact)
 *   - a no-op reload does not bump the generation
 *   - the live fs.watch path fires the same reconcile
 *
 * No real NATS, Discord, or `claude` spawning. Persona files are real tmp
 * files (the loader stats them).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { startCortex, type CortexHandle } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type {
  EnvelopeHandler,
  MyelinRuntime,
  MyelinSubscribePullOpts,
} from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";

// ---------------------------------------------------------------------------
// Harness (mirrors cortex.review-consumer-boot.test.ts)
// ---------------------------------------------------------------------------

function minimalConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-reload-test-published" },
  });
}

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
  subscribePullCalls: MyelinSubscribePullOpts[];
  stoppedSubscribers: string[];
}

function createRecordingRuntime(): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const subscribePullCalls: MyelinSubscribePullOpts[] = [];
  const stoppedSubscribers: string[] = [];
  return {
    enabled: false,
    published,
    subscribePullCalls,
    stoppedSubscribers,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return { unregister: () => onEnvelopeHandlers.delete(handler) };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    subscribePull: (opts: MyelinSubscribePullOpts): MyelinSubscriber => {
      subscribePullCalls.push(opts);
      return {
        pattern: opts.pattern,
        ready: Promise.resolve(),
        stop: async () => {
          stoppedSubscribers.push(opts.durable ?? opts.pattern);
        },
      } as unknown as MyelinSubscriber;
    },
    stop: async () => {},
  };
}

let tmpAgentsDir: string;
let tmpPersonasDir: string;
const handles: CortexHandle[] = [];

beforeEach(() => {
  tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-reload-agentsd-"));
  tmpPersonasDir = mkdtempSync(join(tmpdir(), "cortex-reload-personas-"));
});

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.stop();
  }
  rmSync(tmpAgentsDir, { recursive: true, force: true });
  rmSync(tmpPersonasDir, { recursive: true, force: true });
});

/** Write a fragment YAML for `id` declaring the given capabilities. */
function writeFragment(
  id: string,
  capabilities: string[],
  opts: { broken?: boolean } = {},
): void {
  if (opts.broken) {
    writeFileSync(join(tmpAgentsDir, `${id}.yaml`), `id: "${id}\n`); // unterminated quote
    return;
  }
  const personaPath = join(tmpPersonasDir, `${id}.md`);
  writeFileSync(personaPath, `# ${id} persona\n`);
  const caps = capabilities.map((c) => `    - "${c}"`).join("\n");
  const yaml = `id: ${id}
displayName: ${id.charAt(0).toUpperCase() + id.slice(1)}
persona: "${personaPath}"
presence: {}
runtime:
  substrate: claude-code
  mode: in-process
  capabilities:
${caps}
`;
  writeFileSync(join(tmpAgentsDir, `${id}.yaml`), yaml);
}

function removeFragment(id: string): void {
  unlinkSync(join(tmpAgentsDir, `${id}.yaml`));
}

async function bootWatcherless(
  runtime: RecordingRuntime,
  opts: {
    brainPackBaseDir?: string;
    principal?: { id: string; mattermostId?: string; discordId?: string; slackId?: string };
  } = {},
): Promise<CortexHandle> {
  const handle = await startCortex(minimalConfig(), {
    disableConfigWatcher: true,
    disableDashboard: true,
    disableOutboundPoller: true,
    disableAgentsWatcher: true, // drive reloads through handle.reloadAgents()
    agentsDir: tmpAgentsDir,
    configPath: join(tmpAgentsDir, "cortex.yaml"), // so agentsDir resolution + pid path are coherent
    injectRuntime: runtime,
    principal: opts.principal ?? { id: "test-op" },
    ...(opts.brainPackBaseDir !== undefined && {
      brainPackBaseDir: opts.brainPackBaseDir,
    }),
  });
  handles.push(handle);
  return handle;
}

/**
 * Bot Packs B-1 — write an exec-brain agent fragment. Declares a `brain:` block
 * with `kind: exec` + a `run` pointing at the pack's `brain/main.ts` (`{pack}`
 * expands to `{brainPackBaseDir}/{id}`).
 */
function writeBrainFragment(id: string, capabilities: string[]): void {
  const personaPath = join(tmpPersonasDir, `${id}.md`);
  writeFileSync(personaPath, `# ${id} persona\n`);
  const caps = capabilities.map((c) => `    - "${c}"`).join("\n");
  const yaml = `id: ${id}
displayName: ${id.charAt(0).toUpperCase() + id.slice(1)}
persona: "${personaPath}"
presence: {}
runtime:
  mode: in-process
  capabilities:
${caps}
  brain:
    kind: exec
    run: "bun {pack}/brain/main.ts"
`;
  writeFileSync(join(tmpAgentsDir, `${id}.yaml`), yaml);
}

// Capability-registration envelopes carry the per-agent payload.
function capRegAgentIds(published: Envelope[]): string[] {
  return published
    .filter((e) => e.type === "agents.capabilities.registered")
    .map((e) => (e.payload as { agent_id?: string }).agent_id ?? "?");
}

// Capability registrations as (agent_id, capability-count) pairs — lets a test
// tell a real registration (caps > 0) apart from a TOMBSTONE (caps === 0).
function capRegEvents(
  published: Envelope[],
): { agentId: string; capCount: number }[] {
  return published
    .filter((e) => e.type === "agents.capabilities.registered")
    .map((e) => {
      const p = e.payload as { agent_id?: string; capabilities?: unknown[] };
      return {
        agentId: p.agent_id ?? "?",
        capCount: Array.isArray(p.capabilities) ? p.capabilities.length : -1,
      };
    });
}

// Tombstones are capability registrations with an EMPTY capabilities array.
function tombstonedAgentIds(published: Envelope[]): string[] {
  return capRegEvents(published)
    .filter((e) => e.capCount === 0)
    .map((e) => e.agentId);
}

// ---------------------------------------------------------------------------
// Tests — handle.reloadAgents() (deterministic)
// ---------------------------------------------------------------------------

describe("startCortex — agents.d/ hot reload (B-0, cortex#1021)", () => {
  test("ADD a fragment → new review consumer started + generation bumped", async () => {
    const runtime = createRecordingRuntime();
    // Boot with one fragment already present.
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);

    expect(handle.agentGeneration).toBe(0);
    expect(handle.agentRegistry.getAll().map((a) => a.id)).toEqual(["echo"]);
    expect(runtime.subscribePullCalls.length).toBe(1); // echo

    // Drop a second fragment, reload.
    writeFragment("luna", ["code-review.security"]);
    await handle.reloadAgents("cli");

    expect(handle.agentGeneration).toBe(1);
    expect(handle.agentRegistry.getAll().map((a) => a.id).sort()).toEqual([
      "echo",
      "luna",
    ]);
    // Luna's consumer subscribed (echo's was already subscribed at boot).
    const lunaDurable = runtime.subscribePullCalls.find((c) =>
      (c.durable ?? "").includes("luna"),
    );
    expect(lunaDurable).toBeDefined();
  });

  test("REMOVE a fragment → consumer drained + generation bumped", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    writeFragment("luna", ["code-review.security"]);
    const handle = await bootWatcherless(runtime);
    expect(handle.agentRegistry.getAll().length).toBe(2);
    const subsBefore = runtime.subscribePullCalls.length;

    removeFragment("luna");
    await handle.reloadAgents("cli");

    expect(handle.agentGeneration).toBe(1);
    expect(handle.agentRegistry.getAll().map((a) => a.id)).toEqual(["echo"]);
    // Luna's subscriber was stopped (drained).
    expect(
      runtime.stoppedSubscribers.some((d) => d.includes("luna")),
    ).toBe(true);
    // No new subscriptions opened by a pure removal.
    expect(runtime.subscribePullCalls.length).toBe(subsBefore);
  });

  test("CHANGE a fragment (new capability) → remove+add, generation bumped", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);
    const subsBefore = runtime.subscribePullCalls.length;

    // Rewrite echo with an extra flavor.
    writeFragment("echo", ["code-review.typescript", "code-review.security"]);
    await handle.reloadAgents("cli");

    expect(handle.agentGeneration).toBe(1);
    // Old consumer drained, new consumer started → a fresh subscribe happened.
    expect(runtime.stoppedSubscribers.some((d) => d.includes("echo"))).toBe(true);
    expect(runtime.subscribePullCalls.length).toBeGreaterThan(subsBefore);
    // The flavor set reflects the change.
    const echo = handle.agentRegistry.getById("echo");
    expect(echo.runtime?.capabilities).toEqual([
      "code-review.typescript",
      "code-review.security",
    ]);
  });

  test("reload re-publishes the capability registry (deliverable 3)", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);
    const bootCount = capRegAgentIds(runtime.published).length;
    expect(bootCount).toBeGreaterThanOrEqual(1);

    writeFragment("luna", ["code-review.security"]);
    await handle.reloadAgents("cli");

    // Re-publish fired: luna now appears among the capability registrations.
    expect(capRegAgentIds(runtime.published)).toContain("luna");
  });

  test("REMOVE a fragment → capability registration is TOMBSTONED (Sage cortex#1027)", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    writeFragment("luna", ["code-review.security"]);
    const handle = await bootWatcherless(runtime);
    const before = runtime.published.length;

    removeFragment("luna");
    await handle.reloadAgents("cli");

    // A tombstone (empty-capability registration) was published for luna so its
    // prior registration is OVERWRITTEN — it no longer registers as a provider.
    const tombstoned = tombstonedAgentIds(runtime.published.slice(before));
    expect(tombstoned).toContain("luna");
    // echo, unchanged, is NOT tombstoned.
    expect(tombstoned).not.toContain("echo");
  });

  test("diff-only republish — an unchanged agent is NOT re-published on an unrelated add (Sage cortex#1027)", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);
    const before = runtime.published.length;

    // Add luna; echo is untouched.
    writeFragment("luna", ["code-review.security"]);
    await handle.reloadAgents("cli");

    const reloadRegs = capRegEvents(runtime.published.slice(before));
    // luna (the added agent) is republished…
    expect(reloadRegs.some((e) => e.agentId === "luna" && e.capCount > 0)).toBe(true);
    // …but echo (unchanged) is NOT re-published (no O(total agents) churn).
    expect(reloadRegs.some((e) => e.agentId === "echo")).toBe(false);
  });

  test("CHANGE an agent to zero capabilities → tombstoned (Sage cortex#1027)", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    // nova starts WITH a (non-review) capability so it's a registered provider.
    writeFragment("nova", ["deploy.k8s"]);
    const handle = await bootWatcherless(runtime);
    const before = runtime.published.length;

    // Rewrite nova with an empty capability set.
    const personaPath = join(tmpPersonasDir, "nova.md");
    writeFileSync(personaPath, "# nova persona\n");
    writeFileSync(
      join(tmpAgentsDir, "nova.yaml"),
      `id: nova
displayName: Nova
persona: "${personaPath}"
presence: {}
runtime:
  substrate: claude-code
  mode: in-process
  capabilities: []
`,
    );
    await handle.reloadAgents("cli");

    // nova dropped to zero caps → tombstoned so its stale registration clears.
    expect(tombstonedAgentIds(runtime.published.slice(before))).toContain("nova");
  });

  test("derived provided_by — a declaration-only capability needs no catalog edit", async () => {
    // The agent declares a capability that exists in NO top-level catalog;
    // boot + reload accept it and publish it. (deliverable 4 end-to-end)
    const runtime = createRecordingRuntime();
    writeFragment("nova", ["deploy.k8s"]); // not code-review; not catalogued
    const handle = await bootWatcherless(runtime);

    expect(handle.agentRegistry.getById("nova").runtime?.capabilities).toEqual([
      "deploy.k8s",
    ]);
    // The capability registry published nova's declared capability.
    expect(capRegAgentIds(runtime.published)).toContain("nova");

    // Reload still accepts it and re-publishes.
    writeFragment("nova", ["deploy.k8s", "deploy.fly"]);
    await handle.reloadAgents("cli");
    expect(handle.agentGeneration).toBe(1);
    expect(handle.agentRegistry.getById("nova").runtime?.capabilities).toEqual([
      "deploy.k8s",
      "deploy.fly",
    ]);
  });

  test("invalid fragment → rejected, old generation retained, daemon survives", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);
    expect(handle.agentGeneration).toBe(0);

    // Drop a malformed fragment + reload.
    writeFragment("broken", [], { broken: true });
    await handle.reloadAgents("cli");

    // Generation NOT bumped; echo's consumer is intact; the daemon is alive.
    expect(handle.agentGeneration).toBe(0);
    expect(handle.agentRegistry.getAll().map((a) => a.id)).toEqual(["echo"]);
  });

  test("no-op reload (nothing changed) does not bump the generation", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const handle = await bootWatcherless(runtime);
    expect(handle.agentGeneration).toBe(0);

    // Reload with no on-disk change.
    await handle.reloadAgents("cli");
    expect(handle.agentGeneration).toBe(0);
    expect(handle.agentRegistry.getAll().map((a) => a.id)).toEqual(["echo"]);
  });

  test("onAgentsReloaded hook reports add/remove/change sets + generation", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    const events: {
      generation: number;
      added: string[];
      removed: string[];
      changed: string[];
      failed: boolean;
    }[] = [];
    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      disableAgentsWatcher: true,
      agentsDir: tmpAgentsDir,
      configPath: join(tmpAgentsDir, "cortex.yaml"),
      injectRuntime: runtime,
      principal: { id: "test-op" },
      onAgentsReloaded: (info) => {
        events.push({
          generation: info.generation,
          added: info.added,
          removed: info.removed,
          changed: info.changed,
          failed: info.failed,
        });
      },
    });
    handles.push(handle);

    writeFragment("luna", ["code-review.security"]);
    await handle.reloadAgents("cli");

    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      generation: 1,
      added: ["luna"],
      removed: [],
      changed: [],
      failed: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — live fs.watch path
// ---------------------------------------------------------------------------

describe("startCortex — agents.d/ fs.watch reconcile (B-0, cortex#1021)", () => {
  test("fs.watch fires the reconcile on a fragment add", async () => {
    const runtime = createRecordingRuntime();
    writeFragment("echo", ["code-review.typescript"]);
    let lastGeneration = -1;
    const reloaded: string[][] = [];
    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      // watcher ENABLED with a short debounce
      agentsWatcherDebounceMs: 30,
      agentsDir: tmpAgentsDir,
      configPath: join(tmpAgentsDir, "cortex.yaml"),
      injectRuntime: runtime,
      principal: { id: "test-op" },
      onAgentsReloaded: (info) => {
        lastGeneration = info.generation;
        reloaded.push(info.added);
      },
    });
    handles.push(handle);

    // Drop a fragment; the fs.watch + debounce should fire the reconcile.
    writeFragment("luna", ["code-review.security"]);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && lastGeneration < 1) {
      await new Promise<void>((r) => setTimeout(r, 30));
    }

    expect(handle.agentGeneration).toBeGreaterThanOrEqual(1);
    expect(handle.agentRegistry.getAll().map((a) => a.id).sort()).toEqual([
      "echo",
      "luna",
    ]);
    expect(reloaded.some((added) => added.includes("luna"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — Bot Packs B-1 brain consumers (hot add/remove/change)
// ---------------------------------------------------------------------------

describe("startCortex — exec-brain consumers hot reload (B-1, cortex#1021)", () => {
  let packBase: string;

  beforeEach(() => {
    packBase = mkdtempSync(join(tmpdir(), "cortex-reload-packs-"));
  });
  afterEach(() => {
    rmSync(packBase, { recursive: true, force: true });
  });

  /** Drop a fixture brain at `{packBase}/{id}/brain/main.ts`. */
  function writeBrainPack(id: string): void {
    const dir = join(packBase, id, "brain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "main.ts"),
      `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const it = rl[Symbol.asyncIterator]();
const { value } = await it.next();
const task = JSON.parse(value);
process.stdout.write(JSON.stringify({ v: 1, type: "result", task_id: task.task_id, status: "complete" }) + "\\n");
rl.close();
process.exit(0);
`,
      "utf8",
    );
  }

  /** Brain-consumer durables carry the `cortex-brain-consumer-` prefix. */
  function brainDurables(runtime: RecordingRuntime): string[] {
    return runtime.subscribePullCalls
      .map((c) => c.durable ?? "")
      .filter((d) => d.includes("cortex-brain-consumer-"));
  }

  test("ADD an exec-brain fragment → brain consumer subscribes per capability", async () => {
    const runtime = createRecordingRuntime();
    const handle = await bootWatcherless(runtime, { brainPackBaseDir: packBase });
    expect(brainDurables(runtime).length).toBe(0);

    writeBrainPack("yarrow");
    writeBrainFragment("yarrow", ["soc.compose.flow"]);
    await handle.reloadAgents("cli");

    expect(handle.agentRegistry.getById("yarrow").id).toBe("yarrow");
    // A brain consumer bound a durable for the declared capability — NOT a
    // review consumer (the agent declares no code-review capability anyway).
    const durables = brainDurables(runtime);
    expect(durables.some((d) => d.includes("yarrow"))).toBe(true);
    expect(durables.some((d) => d.includes("soc-compose-flow"))).toBe(true);
  });

  test("exec-brain agent is NOT hosted by a review consumer", async () => {
    const runtime = createRecordingRuntime();
    // Declare an exec brain that ALSO lists a code-review capability — the brain
    // path wins; no review consumer is created for it.
    writeBrainPack("hybrid");
    writeBrainFragment("hybrid", ["code-review.typescript", "soc.compose.flow"]);
    const handle = await bootWatcherless(runtime, { brainPackBaseDir: packBase });

    const reviewDurables = runtime.subscribePullCalls
      .map((c) => c.durable ?? "")
      .filter((d) => d.includes("cortex-review-consumer-"));
    expect(reviewDurables.some((d) => d.includes("hybrid"))).toBe(false);
    // But a brain consumer IS bound.
    expect(brainDurables(runtime).some((d) => d.includes("hybrid"))).toBe(true);
    expect(handle.agentRegistry.getById("hybrid").id).toBe("hybrid");
  });

  test("REMOVE an exec-brain fragment → brain consumer drained", async () => {
    const runtime = createRecordingRuntime();
    writeBrainPack("yarrow");
    writeBrainFragment("yarrow", ["soc.compose.flow"]);
    const handle = await bootWatcherless(runtime, { brainPackBaseDir: packBase });
    expect(brainDurables(runtime).some((d) => d.includes("yarrow"))).toBe(true);

    removeFragment("yarrow");
    await handle.reloadAgents("cli");

    // The brain consumer's subscriber was stopped (drained).
    expect(
      runtime.stoppedSubscribers.some((d) => d.includes("yarrow")),
    ).toBe(true);
    expect(handle.agentRegistry.getAll().map((a) => a.id)).not.toContain("yarrow");
  });

  test("CHANGE an exec-brain fragment (new capability) → remove+add brain consumer", async () => {
    const runtime = createRecordingRuntime();
    writeBrainPack("yarrow");
    writeBrainFragment("yarrow", ["soc.compose.flow"]);
    const handle = await bootWatcherless(runtime, { brainPackBaseDir: packBase });
    const before = runtime.subscribePullCalls.length;

    writeBrainFragment("yarrow", ["soc.compose.flow", "soc.triage.email"]);
    await handle.reloadAgents("cli");

    // Old brain consumer drained, new one started → a fresh subscribe happened
    // (now two capabilities → two durables on the new consumer).
    expect(runtime.stoppedSubscribers.some((d) => d.includes("yarrow"))).toBe(true);
    expect(runtime.subscribePullCalls.length).toBeGreaterThan(before);
    expect(
      brainDurables(runtime).some((d) => d.includes("soc-triage-email")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B-3 (cortex#1021 W-2) — surface principal gate boot probes
// ---------------------------------------------------------------------------

describe("startCortex — surface principal gate boot (B-3, cortex#1021 W-2)", () => {
  let packBase: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    packBase = mkdtempSync(join(tmpdir(), "cortex-gateboot-packs-"));
    logSpy = spyOn(console, "log");
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(packBase, { recursive: true, force: true });
  });

  function writeBrainPack(id: string): void {
    const dir = join(packBase, id, "brain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.ts"), `process.exit(0);\n`, "utf8");
  }

  /** The brain-consumer boot line for `id` (ready or DORMANT — both carry `gate=`). */
  function bootLineFor(id: string): string | undefined {
    return logSpy.mock.calls
      .map((args: unknown[]) => args.map(String).join(" "))
      .find(
        (line: string) =>
          line.includes(`brain consumer`) && line.includes(`agent=${id}`),
      );
  }

  test("principal WITH a surface identity → consumers boot with the surface gate", async () => {
    writeBrainPack("yarrow");
    writeBrainFragment("yarrow", ["soc.compose.flow"]);
    const runtime = createRecordingRuntime();
    await bootWatcherless(runtime, {
      brainPackBaseDir: packBase,
      principal: { id: "test-op", mattermostId: "mm-jc" },
    });
    const line = bootLineFor("yarrow");
    expect(line).toBeDefined();
    expect(line).toContain("gate=surface");
  });

  test("principal WITHOUT any surface identity → DenyAll default retained", async () => {
    writeBrainPack("yarrow");
    writeBrainFragment("yarrow", ["soc.compose.flow"]);
    const runtime = createRecordingRuntime();
    await bootWatcherless(runtime, {
      brainPackBaseDir: packBase,
      principal: { id: "test-op" }, // no mattermostId/discordId/slackId
    });
    const line = bootLineFor("yarrow");
    expect(line).toBeDefined();
    expect(line).toContain("gate=deny-all");
  });

  test("hot-ADDED agent inherits the same gate decision (reload path)", async () => {
    const runtime = createRecordingRuntime();
    const handle = await bootWatcherless(runtime, {
      brainPackBaseDir: packBase,
      principal: { id: "test-op", mattermostId: "mm-jc" },
    });
    writeBrainPack("late");
    writeBrainFragment("late", ["soc.compose.flow"]);
    await handle.reloadAgents("cli");
    const line = bootLineFor("late");
    expect(line).toBeDefined();
    expect(line).toContain("gate=surface");
  });
});
