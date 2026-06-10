/**
 * F-2.2 (cortex#835 → cortex#865) — DEV_IMPLEMENT stream boot-wiring tests.
 *
 * cortex provisions a JetStream stream (`DEV_IMPLEMENT`) over the dev-task
 * subject family so the agentic dev-loop's dev-agent consumer (F-2.1,
 * cortex#853) can bind a DURABLE pull consumer and replay history instead of
 * racing a transient core-NATS subscription against a virgin broker. cortex
 * provisions the STREAM only; the durable consumer that reads it is F-2.1's
 * concern (the F-2.1 PR flagged this stream as the sibling slice).
 *
 * This test is the EXACT sibling of `cortex.lifecycle-stream-boot.test.ts`
 * (the REVIEW_LIFECYCLE provisioning test, cortex#851) — same recording-JSM
 * infrastructure, same three pins:
 *
 *   1. With a JSM available, BOTH streams are provisioned — CODE_REVIEW (its
 *      `…tasks.code-review.>` namespace) AND DEV_IMPLEMENT (the dev-task
 *      family `…tasks.dev.>`).
 *   2. OVERLAP INVARIANT — the two streams' subject sets are DISJOINT (no
 *      subject of one is a prefix of, or prefixed by, any subject of the
 *      other). JetStream rejects overlapping subjects across streams; this
 *      test is the codified guard that the partition holds at boot.
 *   3. Config gating — when the runtime exposes NO `jetstreamManager` (dormant
 *      / NATS-absent), NEITHER stream is provisioned. The DEV_IMPLEMENT
 *      provisioning rides the SAME `reviewJsm !== null` gate as CODE_REVIEW, so
 *      byte-identical behaviour holds when the bus/JetStream is not configured.
 *
 * Test infrastructure mirrors the REVIEW_LIFECYCLE test (recording runtime +
 * inline agents + captured logs + recording JSM stub) so the boot path's
 * `streams.add` calls are observable without standing up a real broker. No
 * real NATS, Discord, filesystem-watcher, or `claude` spawning.
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
import type { ProvisionJsm } from "../bus/jetstream/types";
import type { ConsumerInfo, StreamInfo, StreamConfig } from "nats";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-dev-stream-test-published" },
    ...overrides,
  });
}

/** Records every `streams.add` so the boot test can read back the provisioned
 *  stream configs. Stream/consumer `info` always 404s (virgin broker) so the
 *  provisioning helpers take the create path. */
interface JsmRecorder {
  jsm: ProvisionJsm;
  streamAdds: Partial<StreamConfig>[];
}

function makeRecordingJsm(): JsmRecorder {
  const streamAdds: Partial<StreamConfig>[] = [];
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
      add: async (_stream, cfg) =>
        ({ name: cfg.durable_name } as unknown as ConsumerInfo),
      update: async (_stream, durable, cfg) =>
        ({ name: durable, config: cfg } as unknown as ConsumerInfo),
    },
  };
  return { jsm, streamAdds };
}

interface RecordingRuntime extends MyelinRuntime {
  onEnvelopeHandlers: Set<EnvelopeHandler>;
  published: Envelope[];
  subscribePullCalls: MyelinSubscribePullOpts[];
}

/** A runtime that EXPOSES a recording `jetstreamManager` so the boot path
 *  resolves a real JSM and provisions both streams. Omitting `jsm` omits the
 *  helper entirely → `resolveReviewProvisioningJsm` returns null → dormant. */
function createRecordingRuntime(opts: {
  jsm?: ProvisionJsm;
}): RecordingRuntime {
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

function makeAgent(id: string, capabilities: readonly string[]): Agent {
  const runtime: AgentRuntime = {
    substrate: "claude-code",
    mode: "in-process",
    capabilities: [...capabilities],
  };
  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    persona: `/tmp/${id}-persona.md`,
    trust: [],
    presence: {},
    runtime,
  };
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

/**
 * Subject-set overlap predicate — true iff `a` and `b` would collide as
 * JetStream stream subjects (one is a prefix of the other under the `.`
 * token grammar, treating a trailing `>` as "matches the rest"). This is the
 * relation JetStream uses to reject overlapping subjects across streams; the
 * test asserts NO pair across the two streams satisfies it.
 */
function subjectsOverlap(a: string, b: string): boolean {
  const at = a.split(".");
  const bt = b.split(".");
  const n = Math.min(at.length, bt.length);
  for (let i = 0; i < n; i++) {
    const x = at[i]!;
    const y = bt[i]!;
    if (x === ">" || y === ">") return true; // tail wildcard swallows the rest
    if (x === "*" || y === "*") continue; // single-token wildcard matches either
    if (x !== y) return false; // a literal token diverged → disjoint
  }
  // One subject is a strict token-prefix of the other with no divergence →
  // they overlap only if the shorter ends in a wildcard tail; a shorter
  // subject with no `>`/`*` tail does NOT subsume a longer one here.
  return at.length === bt.length;
}

const PRINCIPAL = "test-op";
const STACK = "default";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — DEV_IMPLEMENT stream boot wiring (F-2.2, cortex#835 → cortex#865)", () => {
  test("provisions DEV_IMPLEMENT covering the dev-task family, alongside CODE_REVIEW", async () => {
    const { jsm, streamAdds } = makeRecordingJsm();
    const runtime = createRecordingRuntime({ jsm });
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-dev-stream-boot-"));
    const inlineAgents: Agent[] = [makeAgent("echo", ["code-review.typescript"])];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: PRINCIPAL },
      }),
    );

    // BOTH streams provisioned.
    const byName = new Map(streamAdds.map((c) => [c.name, c]));
    expect(byName.has("CODE_REVIEW")).toBe(true);
    expect(byName.has("DEV_IMPLEMENT")).toBe(true);

    const dev = byName.get("DEV_IMPLEMENT")!;
    // The dev-task family, stack-aware 6-segment grammar. Covers the exact
    // subject the F-2.1 dev consumer subscribes (`…tasks.dev.implement`) plus
    // room for future `tasks.dev.*` capabilities.
    expect(dev.subjects).toEqual([
      `local.${PRINCIPAL}.${STACK}.tasks.dev.>`,
    ]);
    // Config posture mirrors CODE_REVIEW EXACTLY: Interest retention, File
    // storage, 24h max_age, finite 512 MiB max_bytes, single replica.
    expect(String(dev.retention)).toBe("interest");
    expect(String(dev.storage)).toBe("file");
    expect(dev.max_age).toBe(24 * 3600 * 1e9);
    expect(dev.max_bytes).toBe(512 * 1024 * 1024);
    expect(dev.max_msgs).toBe(-1);
    expect(dev.num_replicas).toBe(1);

    // Boot log surfaces the provisioning.
    const provisionedLog = logs.find(
      (l) =>
        l.includes('provisioned JetStream stream "DEV_IMPLEMENT"') ||
        l.includes('JetStream stream "DEV_IMPLEMENT" already present'),
    );
    expect(provisionedLog).toBeDefined();

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("OVERLAP INVARIANT — CODE_REVIEW and DEV_IMPLEMENT subject sets are disjoint", async () => {
    const { jsm, streamAdds } = makeRecordingJsm();
    const runtime = createRecordingRuntime({ jsm });
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-dev-stream-overlap-"));
    const inlineAgents: Agent[] = [makeAgent("echo", ["code-review.typescript"])];

    const { result: handle } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: PRINCIPAL },
      }),
    );

    // #875 review nit 1: iterate EVERY cross-stream subject pair across ALL
    // provisioned streams (N*(N-1)/2), not just CODE_REVIEW×DEV_IMPLEMENT, so
    // the invariant self-hardens as more streams land (e.g. REVIEW_LIFECYCLE
    // from cortex#851). JetStream rejects the second `streams.add` if ANY pair
    // across ANY two streams overlaps.
    const provisioned = streamAdds.filter((c) => (c.subjects ?? []).length > 0);
    expect(provisioned.length).toBeGreaterThanOrEqual(2);
    expect(provisioned.some((c) => c.name === "DEV_IMPLEMENT")).toBe(true);
    for (let i = 0; i < provisioned.length; i++) {
      for (let j = i + 1; j < provisioned.length; j++) {
        const aSubjects = provisioned[i]?.subjects ?? [];
        const bSubjects = provisioned[j]?.subjects ?? [];
        for (const a of aSubjects) {
          for (const b of bSubjects) {
            expect(subjectsOverlap(a, b)).toBe(false);
          }
        }
      }
    }

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });

  test("config gating — no jetstreamManager → NEITHER stream provisioned (byte-identical when bus/JS unconfigured)", async () => {
    // Runtime omits `jetstreamManager` → `resolveReviewProvisioningJsm`
    // returns null → the whole `reviewJsm !== null` block (both CODE_REVIEW
    // AND DEV_IMPLEMENT provisioning) is skipped. No JSM stub means any
    // accidental provisioning attempt would throw, so the witness is simply
    // that boot completes cleanly and the dev provision log is absent.
    const runtime = createRecordingRuntime({});
    const tmpAgentsDir = mkdtempSync(join(tmpdir(), "cortex-dev-stream-dormant-"));
    const inlineAgents: Agent[] = [makeAgent("echo", ["code-review.typescript"])];

    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmpAgentsDir,
        injectRuntime: runtime,
        inlineAgents,
        principal: { id: PRINCIPAL },
      }),
    );

    const devProvisionLogs = logs.filter((l) =>
      l.includes('JetStream stream "DEV_IMPLEMENT"'),
    );
    expect(devProvisionLogs.length).toBe(0);
    // And no CODE_REVIEW provisioning either — confirms the SHARED gate.
    const codeReviewProvisionLogs = logs.filter(
      (l) =>
        l.includes('provisioned JetStream stream "CODE_REVIEW"') ||
        l.includes('JetStream stream "CODE_REVIEW" already present'),
    );
    expect(codeReviewProvisionLogs.length).toBe(0);

    await handle.stop();
    rmSync(tmpAgentsDir, { recursive: true, force: true });
  });
});
