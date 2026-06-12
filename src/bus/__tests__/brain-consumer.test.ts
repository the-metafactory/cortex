/**
 * `brain-consumer` unit tests (Bot Packs B-1).
 *
 * Two layers:
 *   1. Stubbed `runBrainTask` — drives the consumer's POLICY + LIFECYCLE paths
 *      deterministically (backpressure, sovereignty ceiling, dispatch allow-list,
 *      ask_principal gate, terminal envelope publication, ack/nak/term mapping).
 *   2. Real fixture brain via `makeExecBrainRunner` — one end-to-end happy path
 *      (bus task → brain → post published → completed envelope), reusing the
 *      test-brain fixture pattern from `src/brain/__tests__`.
 *
 * No real NATS — a recording runtime captures publishes. No real `claude`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  BrainConsumer,
  DenyAllPrincipalGate,
  checkDowngradeOnly,
  deriveTaskSource,
  brainReasonToDispatchReason,
  buildDispatchTaskEnvelope,
  type BrainConsumerAgent,
  type BrainConsumerOpts,
  type PrincipalGate,
} from "../brain-consumer";
import type { Envelope } from "../myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../myelin/runtime";
import type { SystemEventSource } from "../system-events";
import type {
  RunBrainTask,
  BrainTaskHooks,
  BrainTaskRunResult,
} from "../../brain/exec-brain-runner";
import { makeExecBrainRunner } from "../../brain/exec-brain-runner";
import type { TaskEvent, ResultEffect } from "../../brain/protocol";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: SystemEventSource = {
  principal: "jc",
  agent: "cortex",
  instance: "local",
};

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const handlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    stop: async () => {},
  };
}

/**
 * A runtime whose `publish` throws for envelope types matching `failTypes`
 * (cortex#1033 §HonestOracle probe). Other publishes record normally.
 */
function createPublishFailingRuntime(failTypes: string[]): RecordingRuntime {
  const published: Envelope[] = [];
  const handlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    onEnvelope(handler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: async (envelope: Envelope) => {
      if (failTypes.includes(envelope.type)) {
        throw new Error(`publish failed for ${envelope.type}`);
      }
      published.push(envelope);
    },
    stop: async () => {},
  };
}

function buildAgent(over: Partial<BrainConsumerAgent> = {}): BrainConsumerAgent {
  return {
    id: "yarrow",
    capabilities: ["soc.compose.flow"],
    dispatchCapabilities: [],
    modelClass: "local-only",
    ...over,
  };
}

/** A bus task envelope carrying a brain payload. `model_class` defaults local. */
function makeTaskEnvelope(
  over: Partial<Envelope["sovereignty"]> = {},
  payload: Record<string, unknown> = { scenario: "phish" },
): Envelope {
  return {
    id: crypto.randomUUID(),
    source: "jc.metafactory.pilot",
    type: "tasks.soc.compose.flow",
    timestamp: new Date().toISOString(),
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
      ...over,
    },
    payload,
  };
}

/** A `runBrainTask` stub resolving a fixed result; optionally drives hooks. */
function stubRunner(
  result: ResultEffect,
  driveHooks?: (hooks: BrainTaskHooks, task: TaskEvent) => Promise<void>,
): RunBrainTask {
  return async (task, hooks): Promise<BrainTaskRunResult> => {
    if (driveHooks) await driveHooks(hooks, task);
    return { result, logs: [], stderrTail: "", exitCode: 0 };
  };
}

function completeResult(taskId: string, summary?: string): ResultEffect {
  return {
    v: 1,
    type: "result",
    task_id: taskId,
    status: "complete",
    ...(summary !== undefined && { summary }),
  };
}

function baseOpts(over: Partial<BrainConsumerOpts> = {}): BrainConsumerOpts {
  const { runBrainTask, daemonHost, ...rest } = over;
  const base = {
    agent: buildAgent(),
    source: SOURCE,
    runtime: over.runtime ?? createRecordingRuntime(),
    ...rest,
  };
  // The opts type is a discriminated union: a daemon agent passes `daemonHost`
  // (no per-task runner), a per-task agent passes `runBrainTask`. Build the
  // correct variant so neither field leaks onto the other path.
  if (daemonHost !== undefined) {
    return { ...base, daemonHost };
  }
  return { ...base, runBrainTask: runBrainTask ?? stubRunner(completeResult("x")) };
}

function published(runtime: RecordingRuntime, type: string): Envelope[] {
  return runtime.published.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("brain-consumer helpers", () => {
  test("checkDowngradeOnly: undefined request always OK (inherits ceiling)", () => {
    expect(checkDowngradeOnly(undefined, "local-only")).toEqual({ ok: true });
    expect(checkDowngradeOnly(undefined, undefined)).toEqual({ ok: true });
  });

  test("checkDowngradeOnly: tighten is allowed, loosen is refused", () => {
    // ceiling = any → request frontier (tighter) OK; request any (equal) OK.
    expect(checkDowngradeOnly("frontier", "any").ok).toBe(true);
    expect(checkDowngradeOnly("any", "any").ok).toBe(true);
    // ceiling = local-only → request frontier (looser) REFUSED.
    const refused = checkDowngradeOnly("frontier", "local-only");
    expect(refused.ok).toBe(false);
    // ceiling = frontier → request any (looser) REFUSED.
    expect(checkDowngradeOnly("any", "frontier").ok).toBe(false);
    // ceiling = frontier → request local-only (tighter) OK.
    expect(checkDowngradeOnly("local-only", "frontier").ok).toBe(true);
  });

  test("checkDowngradeOnly: class-less agent ceiling is the loosest (any)", () => {
    expect(checkDowngradeOnly("local-only", undefined).ok).toBe(true);
    expect(checkDowngradeOnly("frontier", undefined).ok).toBe(true);
  });

  test("checkDowngradeOnly: unknown requested class is refused", () => {
    const r = checkDowngradeOnly("bogus", "any");
    expect(r.ok).toBe(false);
  });

  test("deriveTaskSource: bus-originated default + response_routing read", () => {
    expect(deriveTaskSource(makeTaskEnvelope())).toEqual({
      surface: "bus",
      channel: "",
      thread: "",
      user: "",
    });
    const withRouting = makeTaskEnvelope({}, {
      response_routing: { surface: "mattermost", channel: "c1", thread: "t1" },
      user: "u1",
    });
    expect(deriveTaskSource(withRouting)).toEqual({
      surface: "mattermost",
      channel: "c1",
      thread: "t1",
      user: "u1",
    });
  });

  test("brainReasonToDispatchReason: not_now carries retry_after_ms", () => {
    expect(
      brainReasonToDispatchReason({ kind: "not_now", detail: "busy", retry_after_ms: 500 }),
    ).toEqual({ kind: "not_now", detail: "busy", retry_after_ms: 500 });
    expect(brainReasonToDispatchReason({ kind: "cant_do", detail: "x" })).toEqual({
      kind: "cant_do",
      detail: "x",
    });
  });

  test("buildDispatchTaskEnvelope: type=tasks.{cap}, local-only ⇒ frontier_ok=false", () => {
    const env = buildDispatchTaskEnvelope({
      source: SOURCE,
      capability: "soc.triage.email",
      payload: { a: 1 },
      modelClass: "local-only",
    });
    expect(env.type).toBe("tasks.soc.triage.email");
    expect(env.sovereignty.model_class).toBe("local-only");
    expect(env.sovereignty.frontier_ok).toBe(false);
    expect(env.source).toBe("jc.cortex.local");
    expect(env.payload).toEqual({ a: 1 });
  });

  test("DenyAllPrincipalGate fails closed with the B-2 reason", async () => {
    const v = await new DenyAllPrincipalGate().resolve();
    expect(v.verdict).toBe("fail");
    expect(v.principal).toBe("");
    expect(v.notes).toContain("B-2");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — happy path (stubbed runner)
// ---------------------------------------------------------------------------

describe("BrainConsumer — happy path", () => {
  test("bus task → started + completed lifecycle envelopes; ack", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        runBrainTask: stubRunner(completeResult(env.id, "done")),
      }),
    );

    const decision = await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(decision).toEqual({ kind: "ack" });
    expect(published(runtime, "dispatch.task.started").length).toBe(1);
    const completed = published(runtime, "dispatch.task.completed");
    expect(completed.length).toBe(1);
    expect(completed[0]?.correlation_id).toBe(env.id);
    expect((completed[0]?.payload as { result_summary?: string }).result_summary).toBe("done");
  });

  test("brain post effect → dispatch.task.post lifecycle envelope with task source + text", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope({}, {
      response_routing: { surface: "mattermost", channel: "c9", thread: "t9" },
      user: "alice",
    });
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          await hooks.onPost({
            v: 1,
            type: "post",
            task_id: env.id,
            text: "Composed the flow.",
          });
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    const posts = published(runtime, "dispatch.task.post");
    expect(posts.length).toBe(1);
    const p = posts[0]?.payload as { text?: string; response_routing?: unknown; triggered_by?: string };
    expect(p.text).toBe("Composed the flow.");
    expect(p.response_routing).toEqual({
      surface: "mattermost",
      channel: "c9",
      thread: "t9",
    });
    expect(p.triggered_by).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// Terminal publish failure — must NOT silently ack (cortex#1033 §HonestOracle)
// ---------------------------------------------------------------------------

describe("BrainConsumer — terminal publish failure", () => {
  test(
    "completed publish throws → nak-with-redelivery, NOT ack (result not stranded)",
    async () => {
      const runtime = createPublishFailingRuntime(["dispatch.task.completed"]);
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(
        baseOpts({
          runtime,
          runBrainTask: stubRunner(completeResult(env.id, "done")),
        }),
      );

      const decision = await consumer.processEnvelope(
        env,
        "subj",
        null,
        "soc.compose.flow",
      );

      // A dropped terminal must redeliver, never ack into the void.
      expect(decision).toEqual({ kind: "nak", delayMs: 0 });
      // The completed envelope did NOT land (publish threw).
      expect(published(runtime, "dispatch.task.completed").length).toBe(0);
    },
  );

  test(
    "failed publish throws → nak-with-redelivery, NOT the mapped failure ack",
    async () => {
      const runtime = createPublishFailingRuntime(["dispatch.task.failed"]);
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(
        baseOpts({
          runtime,
          runBrainTask: stubRunner({
            v: 1,
            type: "result",
            task_id: env.id,
            status: "failed",
            reason: { kind: "cant_do", detail: "nope" },
          }),
        }),
      );

      const decision = await consumer.processEnvelope(
        env,
        "subj",
        null,
        "soc.compose.flow",
      );

      expect(decision).toEqual({ kind: "nak", delayMs: 0 });
      expect(published(runtime, "dispatch.task.failed").length).toBe(0);
    },
  );

  test(
    "clean terminal publish still acks (no false-positive redelivery)",
    async () => {
      const runtime = createRecordingRuntime();
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(
        baseOpts({ runtime, runBrainTask: stubRunner(completeResult(env.id)) }),
      );

      const decision = await consumer.processEnvelope(
        env,
        "subj",
        null,
        "soc.compose.flow",
      );

      expect(decision).toEqual({ kind: "ack" });
      expect(published(runtime, "dispatch.task.completed").length).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Sovereignty ceiling
// ---------------------------------------------------------------------------

describe("BrainConsumer — sovereignty ceiling", () => {
  test("frontier agent + local-only task → enforce deny (term + failed wont_do)", async () => {
    const runtime = createRecordingRuntime();
    // Task demands a local model; the agent is frontier-capable → breach.
    const env = makeTaskEnvelope({ model_class: "local-only", frontier_ok: false });
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ modelClass: "frontier" }),
        sovereigntyEnforce: true,
      }),
    );

    const decision = await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(decision.kind).toBe("term");
    const failed = published(runtime, "dispatch.task.failed");
    expect(failed.length).toBe(1);
    expect((failed[0]?.payload as { reason?: { kind?: string } }).reason?.kind).toBe("wont_do");
    // The brain was never run — no started envelope on the deny path.
    expect(published(runtime, "dispatch.task.started").length).toBe(0);
  });

  test("frontier agent + local-only task → audit-parity proceeds (no deny)", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope({ model_class: "local-only", frontier_ok: false });
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ modelClass: "frontier" }),
        sovereigntyEnforce: false, // audit-parity
        runBrainTask: stubRunner(completeResult(env.id)),
      }),
    );

    const decision = await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(decision.kind).toBe("ack");
    expect(published(runtime, "dispatch.task.started").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dispatch allow-list + downgrade-only sovereignty
// ---------------------------------------------------------------------------

describe("BrainConsumer — dispatch effect enforcement", () => {
  test("dispatch outside allow-list → effect_rejected (wont_do) reaches the brain", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    let rejection: { rejected: boolean; reason?: { kind: string; detail: string } } | undefined;
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        // allow-list is EMPTY — any dispatch is refused.
        agent: buildAgent({ dispatchCapabilities: [] }),
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          const outcome = await hooks.onDispatch({
            v: 1,
            type: "dispatch",
            task_id: env.id,
            capability: "soc.triage.email",
            payload: {},
          });
          rejection = outcome;
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(rejection?.rejected).toBe(true);
    expect(rejection?.reason?.kind).toBe("wont_do");
    // No fleet dispatch envelope was published.
    expect(published(runtime, "tasks.soc.triage.email").length).toBe(0);
  });

  test("dispatch in allow-list → fleet task envelope published, accepted", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    let outcome: { rejected: boolean } | undefined;
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ dispatchCapabilities: ["soc.triage.email"] }),
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          outcome = await hooks.onDispatch({
            v: 1,
            type: "dispatch",
            task_id: env.id,
            capability: "soc.triage.email",
            payload: { msg: "x" },
          });
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(outcome?.rejected).toBe(false);
    const dispatched = published(runtime, "tasks.soc.triage.email");
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.payload).toEqual({ msg: "x" });
  });

  test("dispatch loosening sovereignty → refused (downgrade-only)", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    let outcome: { rejected: boolean; reason?: { detail: string } } | undefined;
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        // Agent ceiling local-only; the brain requests frontier (looser).
        agent: buildAgent({
          dispatchCapabilities: ["soc.triage.email"],
          modelClass: "local-only",
        }),
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          outcome = await hooks.onDispatch({
            v: 1,
            type: "dispatch",
            task_id: env.id,
            capability: "soc.triage.email",
            payload: {},
            sovereignty: { model_class: "frontier" },
          });
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(outcome?.rejected).toBe(true);
    expect(outcome?.reason?.detail).toContain("tighten");
    expect(published(runtime, "tasks.soc.triage.email").length).toBe(0);
  });

  test(
    "cortex#1033 §Security — dispatch with OMITTED sovereignty inherits the " +
      "agent ceiling, NOT 'any' (no frontier loosening)",
    async () => {
      const runtime = createRecordingRuntime();
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(
        baseOpts({
          runtime,
          // local-only brain dispatches WITHOUT a sovereignty block. The
          // downgrade-only check passes (omitted ⇒ inherit), but the published
          // envelope must carry the agent's local-only ceiling — never default
          // to `any`/frontier-ok, which would let a local-only brain publish a
          // frontier-allowed downstream task.
          agent: buildAgent({
            dispatchCapabilities: ["soc.triage.email"],
            modelClass: "local-only",
          }),
          runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
            await hooks.onDispatch({
              v: 1,
              type: "dispatch",
              task_id: env.id,
              capability: "soc.triage.email",
              payload: {},
              // no `sovereignty` — the regression vector.
            });
          }),
        }),
      );

      await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

      const dispatched = published(runtime, "tasks.soc.triage.email");
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.sovereignty.model_class).toBe("local-only");
      expect(dispatched[0]?.sovereignty.frontier_ok).toBe(false);
    },
  );

  test(
    "cortex#1033 §Security — class-less agent (undefined ceiling) omitting " +
      "sovereignty still falls through to 'any' (documented loosest default)",
    async () => {
      const runtime = createRecordingRuntime();
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(
        baseOpts({
          runtime,
          agent: buildAgent({
            dispatchCapabilities: ["soc.triage.email"],
            modelClass: undefined,
          }),
          runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
            await hooks.onDispatch({
              v: 1,
              type: "dispatch",
              task_id: env.id,
              capability: "soc.triage.email",
              payload: {},
            });
          }),
        }),
      );

      await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

      const dispatched = published(runtime, "tasks.soc.triage.email");
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.sovereignty.model_class).toBe("any");
      expect(dispatched[0]?.sovereignty.frontier_ok).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// ask_principal gate
// ---------------------------------------------------------------------------

describe("BrainConsumer — ask_principal gate", () => {
  test("DenyAll gate (default) → brain receives fail + empty principal", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    let verdict: { verdict: string; principal: string } | undefined;
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        // no principalGate ⇒ DenyAllPrincipalGate
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          verdict = await hooks.onAskPrincipal({
            v: 1,
            type: "ask_principal",
            task_id: env.id,
            gate: "principal-ack",
            prompt: "Run this flow?",
          });
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(verdict?.verdict).toBe("fail");
    expect(verdict?.principal).toBe("");
  });

  test("stub gate that passes → brain receives pass + resolved principal", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    const passGate: PrincipalGate = {
      resolve: async () => ({ verdict: "pass", principal: "jc", notes: "run it" }),
    };
    let verdict: { verdict: string; principal: string } | undefined;
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        principalGate: passGate,
        runBrainTask: stubRunner(completeResult(env.id), async (hooks) => {
          verdict = await hooks.onAskPrincipal({
            v: 1,
            type: "ask_principal",
            task_id: env.id,
            gate: "principal-ack",
            prompt: "Run this flow?",
          });
        }),
      }),
    );

    await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    expect(verdict?.verdict).toBe("pass");
    expect(verdict?.principal).toBe("jc");
  });
});

// ---------------------------------------------------------------------------
// Backpressure + failed terminal
// ---------------------------------------------------------------------------

describe("BrainConsumer — backpressure + failure", () => {
  test("over maxConcurrent → nak not_now + failed envelope", async () => {
    const runtime = createRecordingRuntime();
    // A runner that blocks until we release it, to hold a slot in-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const env1 = makeTaskEnvelope();
    const env2 = makeTaskEnvelope();
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        agent: buildAgent({ maxConcurrent: 1 }),
        runBrainTask: async (task): Promise<BrainTaskRunResult> => {
          await gate;
          return { result: completeResult(task.task_id), logs: [], stderrTail: "", exitCode: 0 };
        },
      }),
    );

    // First task occupies the only slot (don't await — it blocks on `gate`).
    const first = consumer.processEnvelope(env1, "s", null, "soc.compose.flow");
    // Let `first` register itself in the in-flight set (it yields on the
    // `dispatch.task.started` publish + the blocked runner before the slot is
    // claimed). A couple of macrotask ticks is ample and deterministic.
    await new Promise((r) => setTimeout(r, 20));
    // Second task hits the ceiling.
    const second = await consumer.processEnvelope(env2, "s", null, "soc.compose.flow");

    expect(second.kind).toBe("nak");
    const failed = published(runtime, "dispatch.task.failed");
    expect(failed.some((e) => (e.payload as { reason?: { kind?: string } }).reason?.kind === "not_now")).toBe(true);

    release();
    await first;
  });

  test("brain result failed (not_now) → failed envelope + nak", async () => {
    const runtime = createRecordingRuntime();
    const env = makeTaskEnvelope();
    const consumer = new BrainConsumer(
      baseOpts({
        runtime,
        runBrainTask: stubRunner({
          v: 1,
          type: "result",
          task_id: env.id,
          status: "failed",
          reason: { kind: "not_now", detail: "transient", retry_after_ms: 250 },
        }),
      }),
    );

    const decision = await consumer.processEnvelope(env, "s", null, "soc.compose.flow");

    expect(decision.kind).toBe("nak");
    expect((decision as { delayMs?: number }).delayMs).toBe(250);
    const failed = published(runtime, "dispatch.task.failed");
    expect(failed.length).toBe(1);
    expect((failed[0]?.payload as { reason?: { kind?: string } }).reason?.kind).toBe("not_now");
  });
});

// ---------------------------------------------------------------------------
// End-to-end with a real fixture brain
// ---------------------------------------------------------------------------

describe("BrainConsumer — real fixture brain (end-to-end)", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "brain-consumer-fixtures-"));
  });
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test(
    "bus task → real brain posts + completes → dispatch.task.post + completed published",
    async () => {
      // A brain that reads the task off stdin (node:readline — incremental, the
      // portable line-protocol reader the runner tests use), posts a line, then
      // completes.
      const brainPath = join(fixtureDir, "happy-brain.ts");
      writeFileSync(
        brainPath,
        `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const it = rl[Symbol.asyncIterator]();
function emit(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
const { value } = await it.next();
const task = JSON.parse(value);
emit({ v: 1, type: "post", task_id: task.task_id, text: "hello from brain" });
emit({ v: 1, type: "result", task_id: task.task_id, status: "complete", summary: "ok" });
rl.close();
process.exit(0);
`,
        "utf8",
      );

      const runtime = createRecordingRuntime();
      const runBrainTask = makeExecBrainRunner({
        run: `bun ${brainPath}`,
        packDir: fixtureDir,
        timeoutMs: 8_000,
        killGraceMs: 1_000,
      });
      const env = makeTaskEnvelope();
      const consumer = new BrainConsumer(baseOpts({ runtime, runBrainTask }));

      const decision = await consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

      expect(decision).toEqual({ kind: "ack" });
      expect(published(runtime, "dispatch.task.post").length).toBe(1);
      expect(published(runtime, "dispatch.task.completed").length).toBe(1);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// B-2 — daemon host integration
// ---------------------------------------------------------------------------
//
// The consumer is lifecycle-agnostic: given a DaemonBrainHost, it multiplexes
// tasks through the host's `runTask` and DRAINS the host on `stop()`. These
// tests use a minimal in-memory transport double so no real socket/subprocess
// is needed — the consumer↔host↔(fake brain) round-trip is fully driven.

import { DaemonBrainHost } from "../../brain/daemon-brain-host";
import {
  FakeDaemonBrain,
  singleFakeDaemonTransport,
} from "../../brain/__tests__/fake-daemon-brain";

// The daemon-brain double + single-brain transport are shared with the host's
// own unit tests; see `src/brain/__tests__/fake-daemon-brain.ts`.
const DaemonFakeBrain = FakeDaemonBrain;
const daemonTransport = singleFakeDaemonTransport;

async function tick(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 2));
}

describe("brain-consumer — daemon host (B-2)", () => {
  test("routes a task through the daemon host to a completed envelope", async () => {
    const runtime = createRecordingRuntime();
    const brain = new DaemonFakeBrain();
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport: daemonTransport(brain),
    });
    await host.start();
    const consumer = new BrainConsumer(baseOpts({ runtime, daemonHost: host }));

    const env = makeTaskEnvelope();
    const decisionP = consumer.processEnvelope(env, "subj", null, "soc.compose.flow");

    // Wait for the task to reach the fake brain, then complete it.
    await tick();
    expect(brain.hasTask()).toBe(true);
    const tid = brain.taskId();
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: tid, text: "hi" }));
    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: tid, status: "complete" }));

    const decision = await decisionP;
    expect(decision).toEqual({ kind: "ack" });
    expect(published(runtime, "dispatch.task.post").length).toBe(1);
    expect(published(runtime, "dispatch.task.completed").length).toBe(1);
    await consumer.stop();
  });

  test("stop() drains the daemon host (sends shutdown)", async () => {
    const runtime = createRecordingRuntime();
    const brain = new DaemonFakeBrain();
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport: daemonTransport(brain),
      killGraceMs: 20,
    });
    await host.start();
    const consumer = new BrainConsumer(
      baseOpts({ runtime, daemonHost: host, drainDeadlineMs: 20 }),
    );
    await consumer.stop();
    expect(brain.received.some((e) => e.type === "shutdown")).toBe(true);
  });

  test("a crashed daemon's in-flight task fails → dispatch.task.failed + nak", async () => {
    const runtime = createRecordingRuntime();
    const brain = new DaemonFakeBrain();
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport: daemonTransport(brain),
      maxRestarts: 0, // crash → straight to degraded; task fails cant_do
    });
    await host.start();
    const consumer = new BrainConsumer(baseOpts({ runtime, daemonHost: host }));

    const env = makeTaskEnvelope();
    const decisionP = consumer.processEnvelope(env, "subj", null, "soc.compose.flow");
    await tick();
    expect(brain.hasTask()).toBe(true);
    brain.crash();

    const decision = await decisionP;
    // cant_do maps to a terminal failure; the consumer publishes failed + maps
    // the ack per failedReasonToAckDecision.
    expect(published(runtime, "dispatch.task.failed").length).toBeGreaterThanOrEqual(1);
    const failed = published(runtime, "dispatch.task.failed")[0];
    expect(JSON.stringify(failed?.payload)).toMatch(/brain crashed/);
    void decision;
    await consumer.stop();
  });
});
