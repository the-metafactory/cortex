/**
 * cortex#237 PR-7 — capability-registry boot wiring tests.
 *
 * Asserts the §3.4 boot loop:
 *
 *   for each agent in mergedAgents:
 *     if agent.runtime?.capabilities?.length > 0:
 *       publishCapabilityRegistry → one envelope per such agent
 *
 * Covers:
 *
 *   1. N agents-with-capabilities → N publishes (per-agent ordering, payload
 *      shape, type constant, classification default).
 *   2. Per-envelope publish failure → log to stderr; sibling envelopes still
 *      emit; boot completes.
 *   3. Zero agents-with-capabilities → zero publishes; boot completes.
 *   4. Agents WITHOUT `runtime.capabilities` (or with empty array) are
 *      silently skipped — `mergedAgents` may contain a mix.
 *   5. Idempotency under double-boot: same logical agent_ids re-emit (the
 *      bucket dedup is the consumer's job per §3.3).
 *
 * Test infrastructure mirrors `cortex.test.ts`:
 *   - `minimalConfig` factory for a NATS-absent AgentConfig.
 *   - `createRecordingRuntime` factory — same `Set<EnvelopeHandler>`-based
 *     fake the surface-router tests already use; `published` array captures
 *     every envelope that landed on `runtime.publish`.
 *   - `inlineAgents` injected via `StartCortexOptions.inlineAgents` so the
 *     test can construct the agent mix without writing fragments to disk.
 *
 * No real NATS, Discord, or filesystem-watcher I/O.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Agent, AgentRuntime } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import { CAPABILITY_REGISTERED_EVENT_TYPE } from "../bus";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Test helpers — kept local rather than re-imported from cortex.test.ts to
// avoid cross-test-file coupling (the existing test deliberately keeps its
// helpers private; mirroring the shape here is cheap and keeps both files
// independently editable).
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
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
    ...overrides,
  });
}

interface PublishResult {
  ok: boolean;
  error?: Error;
}

interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
  /**
   * Per-call publish behaviour control. When set, the i-th `publish` call
   * resolves with the i-th entry: `{ok: true}` resolves, `{ok: false}`
   * rejects with `entry.error`. Indices beyond the list use the default
   * `{ok: true}` behaviour. The error path tests use this to surface a
   * mid-loop failure without breaking the runtime's contract.
   */
  publishOutcomes: PublishResult[];
}

function createRecordingRuntime(): RecordingRuntime {
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  const published: Envelope[] = [];
  const publishOutcomes: PublishResult[] = [];
  let publishCallIndex = 0;
  return {
    enabled: false,
    onEnvelopeHandlers,
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
      // Only record successful publishes — matches "what landed on the wire"
      // semantics (an exception means nothing reached the bus). The boot
      // wiring's wrapped-publish swallows the error, so the test cares
      // about (a) the publish-call count via outcomes, and (b) the
      // recorded-envelope count for successful publishes.
      published.push(envelope);
    },
    stop: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Agent fixture — keeps the per-test inline-agent block compact. Builds an
// Agent matching AgentSchema with the requested id + capabilities (and the
// minimum presence shape so the parser doesn't reject downstream).
// ---------------------------------------------------------------------------

function makeAgent(id: string, capabilities: readonly string[] | undefined): Agent {
  // Build a minimal headless presence (cortex#245) so no Discord/Slack/MM
  // adapter wiring kicks in. `runtime` is omitted when `capabilities` is
  // `undefined`, set to a complete `AgentRuntime` (with the requested
  // `capabilities[]`) when an array is supplied (including the empty array
  // — the boot loop's "≥1 capability" filter is what we want to exercise).
  const runtime: AgentRuntime | undefined =
    capabilities === undefined
      ? undefined
      : {
          substrate: "claude-code",
          mode: "in-process",
          capabilities: [...capabilities],
        };

  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    // Persona path is read-checked only when an adapter starts; for our
    // headless boot path nothing tries to open it.
    persona: `/tmp/${id}-persona.md`,
    trust: [],
    presence: {},
    ...(runtime !== undefined && { runtime }),
  };
}

// ---------------------------------------------------------------------------
// stderr capture — the wrapped-publish error path writes to
// `process.stderr.write`. Bun's test runtime doesn't isolate stderr per
// test, so we temporarily monkey-patch `process.stderr.write` for the
// duration of the assertion and restore it after. The patched writer
// captures the chunk verbatim into a string buffer.
// ---------------------------------------------------------------------------

function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  // Match the overload signature `(chunk, encoding?, callback?) => boolean`
  // loosely — the only call site we care about (`process.stderr.write(string)`)
  // hits the single-arg form. TS infers the overload directly from the
  // assignment target's type without a cast.
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

// cortex#288 follow-up — boot-log capture. The success/failure counter fix
// reports via `console.log`. Mirror the stderr capture pattern so tests can
// assert on the exact boot-log line. Restoring the original is critical:
// without it, downstream tests would leak captured output and lose stdout.
function withCapturedConsoleLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
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

describe("startCortex — capability-registry boot wiring (cortex#237 PR-7)", () => {
  test("N agents with capabilities → N publish calls; each carries the right type + payload", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-N-"));
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript", "code-review.bun"]),
      makeAgent("holly", ["research.web"]),
    ];

    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      injectRuntime: runtime,
      inlineAgents,
      principal: { id: "test-op" },
    });

    // One envelope per agent-with-capabilities. The capabilities list is
    // a payload field on the per-agent envelope — NOT one envelope per
    // capability (matches §3.2 example: one registration envelope per
    // agent carrying that agent's `capabilities[]` array).
    expect(runtime.published.length).toBe(2);

    const types = new Set(runtime.published.map((e) => e.type));
    expect(types.size).toBe(1);
    expect([...types][0]).toBe(CAPABILITY_REGISTERED_EVENT_TYPE);

    // Sovereignty defaults per §3.2 — classification: local.
    for (const env of runtime.published) {
      expect(env.sovereignty.classification).toBe("local");
    }

    // Per-agent payload assertions. The publisher emits in agent-list order
    // (sequential per the publisher's concurrency doc). `noUncheckedIndexedAccess`
    // gives us `T | undefined` on positional lookups; the prior length
    // assertion narrows the run-time shape but not the type, so the
    // non-null assertion is the cleanest local fix.
    const echoEnv = runtime.published[0]!;
    const hollyEnv = runtime.published[1]!;
    expect(echoEnv.payload).toMatchObject({
      agent_id: "echo",
      capabilities: ["code-review.typescript", "code-review.bun"],
      instance: "local",
    });
    expect(hollyEnv.payload).toMatchObject({
      agent_id: "holly",
      capabilities: ["research.web"],
      instance: "local",
    });

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("one publish throws → sibling envelopes still emit; error is logged to stderr; boot completes", async () => {
    const runtime = createRecordingRuntime();
    // Force the FIRST publish (echo's registration) to reject. The boot
    // wiring's wrapped-publish must trap this and continue with holly.
    runtime.publishOutcomes.push({ ok: false, error: new Error("simulated bus failure") });

    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-fail-"));
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript"]),
      makeAgent("holly", ["research.web"]),
    ];

    const { result: { result: handle, logs }, stderr } = await withCapturedStderr(() =>
      withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          disableConfigWatcher: true,
          disableDashboard: true,
          disableOutboundPoller: true,
          agentsDir: tmpAgentsDir,
          injectRuntime: runtime,
          inlineAgents,
          principal: { id: "test-op" },
        }),
      ),
    );

    // The recording runtime only pushes envelopes onto `published` on
    // SUCCESS — so only holly's envelope is recorded. The publish call
    // count is what proves both attempts happened: this is observable
    // via `publishOutcomes` consumption (the runtime increments its
    // internal index per call). One simpler witness: holly's envelope
    // landed AND the stderr log carries echo's agent_id.
    expect(runtime.published.length).toBe(1);
    expect(runtime.published[0]!.payload).toMatchObject({ agent_id: "holly" });

    // The error log path must mention the failing agent + the underlying
    // message. Per the wiring's stderr format ("…agent_id=X…: <msg>") we
    // assert on both substrings, not the full template — the exact
    // wording can drift without breaking the contract.
    expect(stderr).toContain("capability-registry publish failed");
    expect(stderr).toContain("agent_id=echo");
    expect(stderr).toContain("simulated bus failure");

    // cortex#288 follow-up — boot log must reflect wire-side reality, not
    // the publisher's "calls invoked" count. With one publish throwing and
    // one succeeding, the principal should see "1 ... (1 failure(s)) for 2".
    // We grep the captured logs rather than asserting a single match: other
    // boot-side `console.log` calls (router start, dispatch wiring) may
    // also land in `logs`, but the capability line is unambiguously
    // identified by its leading "cortex: published ... capability
    // registration" substring.
    const bootLog = logs.find((l) => l.startsWith("cortex: published") && l.includes("capability registration"));
    expect(bootLog).toBeDefined();
    expect(bootLog).toContain("1 capability registration(s)");
    expect(bootLog).toContain("(1 failure(s))");
    expect(bootLog).toContain("for 2 agent(s)");

    // Boot still produced a handle — the per-envelope failure must not
    // abort startup.
    expect(handle).toBeDefined();
    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("cortex#288 follow-up — all publishes succeed → boot log shows success count, omits failure suffix", async () => {
    // Counterpart to the per-envelope failure test: when nothing fails the
    // failure suffix must be ABSENT from the boot log (architect's spec:
    // "only show failure count if non-zero"). With no publishOutcomes
    // entries, every publish resolves successfully.
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-allok-"));
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript"]),
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

    expect(runtime.published.length).toBe(2);

    const bootLog = logs.find((l) => l.startsWith("cortex: published") && l.includes("capability registration"));
    expect(bootLog).toBeDefined();
    expect(bootLog).toContain("2 capability registration(s)");
    expect(bootLog).toContain("for 2 agent(s)");
    // The crux: no failure suffix in the all-success path.
    expect(bootLog).not.toContain("failure");

    expect(handle).toBeDefined();
    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("zero agents-with-capabilities → zero publishes; boot still completes", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-zero-"));
    // Mix of agents that should NOT trigger a publish:
    //   - luna: no `runtime` block at all (the §3.4 "runtime?." guard
    //     short-circuits).
    //   - holly: `runtime.capabilities` is the empty array (the publisher's
    //     "≥1 capability" guard skips silently).
    const inlineAgents: Agent[] = [
      makeAgent("luna", undefined),
      makeAgent("holly", []),
    ];

    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      injectRuntime: runtime,
      inlineAgents,
      principal: { id: "test-op" },
    });

    expect(runtime.published.length).toBe(0);
    expect(handle).toBeDefined();
    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("cortex#314 — zero agents-with-capabilities → stderr carries a principal-actionable WARNING (not just info-level log)", async () => {
    // First-install safety regression guard. The boot wiring used to log
    // a single info-level `console.log("…skipped…")` line, which an
    // principal running interactively (or tailing a non-debug log) does
    // NOT notice. The capability-dispatch consumer then rejects every
    // inbound request with `cant_do` and the principal has no surface
    // signal pointing at the missing capabilities[] block in cortex.yaml.
    //
    // cortex#314's fix promotes the skip to a stderr WARNING with
    // actionable fix-path text. This test pins the contract: when zero
    // agents declare runtime.capabilities[], stderr MUST carry the
    // WARNING tag AND the actionable hint pointing at cortex.yaml.
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-warn-"));
    const inlineAgents: Agent[] = [
      makeAgent("luna", undefined),
      makeAgent("holly", []),
    ];

    const { result: { result: handle, logs }, stderr } = await withCapturedStderr(() =>
      withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          disableConfigWatcher: true,
          disableDashboard: true,
          disableOutboundPoller: true,
          agentsDir: tmpAgentsDir,
          injectRuntime: runtime,
          inlineAgents,
          principal: { id: "test-op" },
        }),
      ),
    );

    // Info-level log line stays (operability — daemon-side log shipping
    // still benefits from the structured info entry). The WARNING is
    // additive, not a replacement.
    const infoSkipLines = logs.filter((l) =>
      l.includes("cortex: capability-registry skipped"),
    );
    expect(infoSkipLines.length).toBe(1);

    // stderr carries the WARNING + the actionable fix-path text.
    expect(stderr).toContain("WARNING: capability-registry skipped");
    expect(stderr).toContain("0 agents declare runtime.capabilities[]");
    expect(stderr).toContain("cant_do");
    expect(stderr).toContain("cortex.yaml");

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("mixed roster — only agents with capabilities publish; others silently skipped", async () => {
    const runtime = createRecordingRuntime();
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-capboot-mix-"));
    const inlineAgents: Agent[] = [
      makeAgent("luna", undefined), // skipped (no runtime)
      makeAgent("echo", ["code-review.typescript"]), // emits
      makeAgent("holly", []), // skipped (empty array)
      makeAgent("ivy", ["research.web", "research.papers"]), // emits
    ];

    const handle = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDir,
      injectRuntime: runtime,
      inlineAgents,
      principal: { id: "test-op" },
    });

    expect(runtime.published.length).toBe(2);
    const agentIds = runtime.published.map((e) => (e.payload as { agent_id: string }).agent_id);
    expect(agentIds).toEqual(["echo", "ivy"]);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("idempotency under double-boot — second startCortex re-publishes the same logical agent_ids (KV bucket dedup is the consumer's contract per §3.3)", async () => {
    // Two back-to-back boots against the SAME injected runtime model the
    // restart-and-replay case: the daemon stops and starts again, the
    // bucket already has entries from the previous boot, and the consumer
    // is expected to overwrite-on-same-key. The wire side may see
    // duplicates — that's the §3.3 contract, restated in the boot wiring's
    // comment. We assert the duplicate emission rather than guard against
    // it (a guard here would obscure the wire-level reality).
    const inlineAgents: Agent[] = [
      makeAgent("echo", ["code-review.typescript"]),
    ];

    const runtimeA = createRecordingRuntime();
    const tmpAgentsDirA = mkdtempSync(join(tmpdir(), "cortex-capboot-idemp-A-"));
    const handleA = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDirA,
      injectRuntime: runtimeA,
      inlineAgents,
      principal: { id: "test-op" },
    });
    await handleA.stop();
    rmSync(tmpAgentsDirA, { recursive: true, force: true });
    expect(runtimeA.published.length).toBe(1);
    const firstAgentId = (runtimeA.published[0]!.payload as { agent_id: string }).agent_id;

    const runtimeB = createRecordingRuntime();
    const tmpAgentsDirB = mkdtempSync(join(tmpdir(), "cortex-capboot-idemp-B-"));
    const handleB = await startCortex(minimalConfig(), {
      disableConfigWatcher: true,
      disableDashboard: true,
      disableOutboundPoller: true,
      agentsDir: tmpAgentsDirB,
      injectRuntime: runtimeB,
      inlineAgents,
      principal: { id: "test-op" },
    });
    await handleB.stop();
    rmSync(tmpAgentsDirB, { recursive: true, force: true });
    expect(runtimeB.published.length).toBe(1);
    const secondAgentId = (runtimeB.published[0]!.payload as { agent_id: string }).agent_id;

    // Same logical key — different envelope (fresh id/timestamp per the
    // publisher doc). The KV bucket would overwrite the slot; the wire
    // saw it twice.
    expect(firstAgentId).toBe(secondAgentId);
    expect(runtimeA.published[0]!.id).not.toBe(runtimeB.published[0]!.id);
  });
});
