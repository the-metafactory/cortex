/**
 * F-2.1 (cortex#835) — tests for `runner/dev-consumer.ts`.
 *
 * Coverage axes (mirrors `bus/__tests__/review-consumer.test.ts`):
 *
 *   1. Happy path — valid request, capability match, CC succeeds, gates green,
 *      PR opens → started + completed{pr} published, AckDecision is `ack`.
 *   2. Non-dev subject/type → `cant_do` failed + term.
 *   3. Bad payload → `cant_do` failed + term.
 *   4. No capability match → `cant_do` failed + term.
 *   5. Gates red → `cant_do` failed (detail names the gate) + term.
 *   6. CC failure → `cant_do` failed + term.
 *   7. CC abort (timeout) → `not_now` failed + nak.
 *   8. Backpressure at maxConcurrent → `not_now` failed + nak(delay).
 *   9. Forge openPr throws → `cant_do` failed + term.
 *  10. Redelivery > 1 → ALSO emits `dispatch.task.aborted`.
 *  11. correlation_id contract — request.id === started/completed/failed
 *      correlation_id (the load-bearing reactor contract).
 *  12. Warm sessions — two tasks on the same chain: the second RESUMES the
 *      first's CC session (fake records `resumeSessionId`).
 *  13. Worktree removed on every exit path (success + failure).
 *  14. failedReasonToAckDecision mapping table.
 *
 * The DORMANT-boot proof (no capability declared → byte-identical boot) is in
 * the cortex smoke test `src/__tests__/cortex.test.ts` and the boot-wiring
 * test `src/__tests__/cortex.dev-consumer-boot.test.ts` (the §3 boot loop).
 *
 * No real NATS, no real CC, no real git/gh. All seams are fakes.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../../bus/myelin/runtime";
import type { DispatchEventSource, DispatchTaskFailedReason } from "../../bus/dispatch-events";
import type { AckDecision } from "../../bus/myelin/subscriber";
import type { JsMsg } from "nats";
import {
  createDevImplementRequestEvent,
  type DevImplementPayload,
} from "../../bus/dev-events";
import {
  DevConsumer,
  failedReasonToAckDecision,
  type DevConsumerAgent,
  type DevConsumerOpts,
  type DevWorkspace,
  type DevCommandRunner,
  type DevCommandResult,
  type DevForge,
  type DevPrRef,
} from "../dev-consumer";
import { MemoryDevSessionStore, type DevSessionStore } from "../dev-session-store";
import type { CCSessionFactory, CCSessionLike } from "../../substrates/claude-code/harness";
import type { CCSessionOpts, CCSessionResult } from "../cc-session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

const PAYLOAD: DevImplementPayload = {
  repo: "the-metafactory/cortex",
  branch: "feat/c-300-panel",
  base: "main",
  brief: "Implement the dashboard panel per design §4 — closes the issue.",
  issue: 300,
  gates: ["bunx tsc --noEmit", "bun test src/"],
  feature: "C-300",
  title: "feat: dashboard panel",
};

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  const onEnvelopeHandlers = new Set<EnvelopeHandler>();
  return {
    enabled: false,
    published,
    onEnvelope(handler) {
      onEnvelopeHandlers.add(handler);
      return { unregister: () => onEnvelopeHandlers.delete(handler) };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    stop: async () => {},
  };
}

function buildAgent(overrides: Partial<DevConsumerAgent> = {}): DevConsumerAgent {
  return { id: "forge", capabilities: ["dev.implement"], ...overrides };
}

function makeRequest(
  payload: DevImplementPayload = PAYLOAD,
  correlationId?: string,
): Envelope {
  const env = createDevImplementRequestEvent({ source: SOURCE, payload });
  if (correlationId !== undefined) {
    (env as { correlation_id?: string }).correlation_id = correlationId;
  }
  return env;
}

// --- fake seams ------------------------------------------------------------

interface FakeWorkspace extends DevWorkspace {
  created: { repo: string; branch: string; base: string; chainId: string }[];
  removed: { path: string }[];
}
function fakeWorkspace(opts: { path?: string; failCreate?: boolean } = {}): FakeWorkspace {
  const created: FakeWorkspace["created"] = [];
  const removed: FakeWorkspace["removed"] = [];
  const path = opts.path ?? "/tmp/Cortex-c-300";
  return {
    created,
    removed,
    create: async (c) => {
      created.push(c);
      if (opts.failCreate) throw new Error("worktree add failed: branch exists");
      return { path };
    },
    remove: async (r) => {
      removed.push(r);
    },
  };
}

interface FakeRunner extends DevCommandRunner {
  ran: { command: string; cwd: string }[];
}
function fakeRunner(
  outcome: (command: string) => DevCommandResult | Promise<DevCommandResult> = () => ({
    ok: true,
  }),
): FakeRunner {
  const ran: FakeRunner["ran"] = [];
  return {
    ran,
    run: async ({ command, cwd }) => {
      ran.push({ command, cwd });
      return outcome(command);
    },
  };
}

interface FakeForge extends DevForge {
  calls: { repo: string; branch: string; cwd: string }[];
}
function fakeForge(opts: { fail?: boolean; pr?: DevPrRef } = {}): FakeForge {
  const calls: FakeForge["calls"] = [];
  const pr = opts.pr ?? {
    repo: "the-metafactory/cortex",
    number: 57,
    url: "https://github.com/the-metafactory/cortex/pull/57",
  };
  return {
    calls,
    openPr: async ({ repo, branch, cwd }) => {
      calls.push({ repo, branch, cwd });
      if (opts.fail) throw new Error("gh pr create failed: auth");
      return pr;
    },
  };
}

/** A CC session factory returning a fixed result; records the opts it saw. */
function fakeCcFactory(
  result: CCSessionResult,
  seen?: { opts: CCSessionOpts[] },
): CCSessionFactory {
  return (opts: CCSessionOpts): CCSessionLike => {
    seen?.opts.push(opts);
    return {
      start() {
        return this;
      },
      wait: async () => result,
    };
  };
}

function okCcResult(sessionId = "sess-abc"): CCSessionResult {
  return { success: true, response: "done", sessionId, exitCode: 0, durationMs: 1000 };
}

function makeJsMsg(redeliveryCount: number): JsMsg {
  return {
    info: { redeliveryCount },
    redelivered: redeliveryCount > 1,
  } as unknown as JsMsg;
}

function baseOpts(overrides: Partial<DevConsumerOpts> = {}): DevConsumerOpts {
  return {
    agent: buildAgent(),
    source: SOURCE,
    runtime: overrides.runtime ?? createRecordingRuntime(),
    ccSessionFactory: overrides.ccSessionFactory ?? fakeCcFactory(okCcResult()),
    promptBuilder: ({ payload }) => `Implement ${payload.branch}`,
    workspace: overrides.workspace ?? fakeWorkspace(),
    commandRunner: overrides.commandRunner ?? fakeRunner(),
    forge: overrides.forge ?? fakeForge(),
    sessionStore: overrides.sessionStore ?? new MemoryDevSessionStore(),
    ...overrides,
  };
}

const LOCAL_SUBJECT = "local.andreas.work.tasks.dev.implement";

function reasonOf(env: Envelope): DispatchTaskFailedReason | undefined {
  const p = env.payload as { reason?: DispatchTaskFailedReason };
  return p.reason;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DevConsumer.processEnvelope — F-2.1", () => {
  test("1. happy path → started + completed{pr} + ack", async () => {
    const runtime = createRecordingRuntime();
    const workspace = fakeWorkspace();
    const runner = fakeRunner();
    const forge = fakeForge();
    const request = makeRequest();

    const consumer = new DevConsumer(
      baseOpts({ runtime, workspace, commandRunner: runner, forge }),
    );
    const decision = await consumer.processEnvelope(request, LOCAL_SUBJECT, null);

    expect(decision).toEqual({ kind: "ack" });

    // started + completed, in order.
    expect(runtime.published.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);

    // Worktree created from origin base, then removed.
    expect(workspace.created).toHaveLength(1);
    expect(workspace.created[0]!.repo).toBe("the-metafactory/cortex");
    expect(workspace.created[0]!.base).toBe("main");
    expect(workspace.removed).toHaveLength(1);

    // Both gates ran in declared order, in the worktree.
    expect(runner.ran.map((r) => r.command)).toEqual(["bunx tsc --noEmit", "bun test src/"]);
    expect(runner.ran.every((r) => r.cwd === "/tmp/Cortex-c-300")).toBe(true);

    // Forge opened the PR in the worktree.
    expect(forge.calls).toHaveLength(1);
    expect(forge.calls[0]!.cwd).toBe("/tmp/Cortex-c-300");

    // completed carries the PR ref.
    const completed = runtime.published[1]!;
    const chat = (completed.payload as { chat_response?: string }).chat_response;
    expect(chat).toBeDefined();
    expect(JSON.parse(chat!)).toEqual({
      pr: {
        repo: "the-metafactory/cortex",
        number: 57,
        url: "https://github.com/the-metafactory/cortex/pull/57",
      },
    });
    expect((completed.payload as { result_summary?: string }).result_summary).toBe(
      "opened the-metafactory/cortex#57",
    );
  });

  test("2. non-dev subject/type → cant_do + term (no worktree)", async () => {
    const runtime = createRecordingRuntime();
    const workspace = fakeWorkspace();
    // Forge a foreign-typed envelope.
    const request = makeRequest();
    (request as { type: string }).type = "tasks.code-review.typescript";

    const consumer = new DevConsumer(baseOpts({ runtime, workspace }));
    const decision = await consumer.processEnvelope(request, "local.x.y.tasks.code-review.typescript", null);

    expect(decision.kind).toBe("term");
    expect(workspace.created).toHaveLength(0);
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("cant_do");
  });

  test("3. bad payload → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest();
    // Blank brief is invalid.
    request.payload.brief = "   ";

    const consumer = new DevConsumer(baseOpts({ runtime }));
    const decision = await consumer.processEnvelope(request, LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("cant_do");
    expect((reasonOf(failed) as { detail: string }).detail).toContain("payload validation");
  });

  test("4. no capability match → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const consumer = new DevConsumer(
      baseOpts({ runtime, agent: buildAgent({ capabilities: ["code-review.typescript"] }) }),
    );
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect((reasonOf(failed) as { detail: string }).detail).toContain("does not claim dev.implement");
  });

  test("bare `dev` capability claims dev.implement (family wildcard)", async () => {
    const runtime = createRecordingRuntime();
    const consumer = new DevConsumer(
      baseOpts({ runtime, agent: buildAgent({ capabilities: ["dev"] }) }),
    );
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    expect(decision).toEqual({ kind: "ack" });
  });

  test("5. gates red → cant_do (names the gate) + term; PR never opens", async () => {
    const runtime = createRecordingRuntime();
    const forge = fakeForge();
    const runner = fakeRunner((cmd) =>
      cmd === "bun test src/" ? { ok: false, output: "2 tests failed" } : { ok: true },
    );

    const consumer = new DevConsumer(baseOpts({ runtime, commandRunner: runner, forge }));
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    // tsc ran, test ran (and failed) — fail-fast stopped before opening the PR.
    expect(runner.ran.map((r) => r.command)).toEqual(["bunx tsc --noEmit", "bun test src/"]);
    expect(forge.calls).toHaveLength(0);
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    const detail = (reasonOf(failed) as { detail: string }).detail;
    expect(detail).toContain('gate "bun test src/" failed');
    expect(detail).toContain("2 tests failed");
  });

  test("6. CC failure (non-zero exit) → cant_do + term", async () => {
    const runtime = createRecordingRuntime();
    const forge = fakeForge();
    const cc = fakeCcFactory({
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 100,
    });

    const consumer = new DevConsumer(baseOpts({ runtime, ccSessionFactory: cc, forge }));
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    expect(forge.calls).toHaveLength(0);
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("cant_do");
  });

  test("7. CC abort (timeout) → not_now + nak", async () => {
    const runtime = createRecordingRuntime();
    const cc = fakeCcFactory({
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 100,
      aborted: true,
      abortReason: "timeout",
    });

    const consumer = new DevConsumer(baseOpts({ runtime, ccSessionFactory: cc }));
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("nak");
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("not_now");
  });

  test("8. backpressure at maxConcurrent → not_now + nak(delay)", async () => {
    const runtime = createRecordingRuntime();
    // Block CC so the first task stays in-flight while we send a second.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cc: CCSessionFactory = () => ({
      start() {
        return this;
      },
      wait: async () => {
        await gate;
        return okCcResult();
      },
    });

    const consumer = new DevConsumer(
      baseOpts({ runtime, ccSessionFactory: cc, agent: buildAgent({ maxConcurrent: 1 }) }),
    );

    const first = consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    // Let the first task pass the concurrency gate and enter the pipeline.
    await Promise.resolve();
    await Promise.resolve();

    const second = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    expect(second.kind).toBe("nak");
    expect((second as { delayMs?: number }).delayMs).toBe(5000);
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("not_now");

    release();
    expect((await first).kind).toBe("ack");
  });

  test("9. forge openPr throws → cant_do + term; worktree still removed", async () => {
    const runtime = createRecordingRuntime();
    const workspace = fakeWorkspace();
    const forge = fakeForge({ fail: true });

    const consumer = new DevConsumer(baseOpts({ runtime, workspace, forge }));
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    expect(workspace.removed).toHaveLength(1); // cleanup ran on the failure path
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect((reasonOf(failed) as { detail: string }).detail).toContain("forge openPr failed");
  });

  test("10. redelivery > 1 → also emits dispatch.task.aborted", async () => {
    const runtime = createRecordingRuntime();
    const consumer = new DevConsumer(baseOpts({ runtime }));
    await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, makeJsMsg(2));

    const aborted = runtime.published.find((e) => e.type === "dispatch.task.aborted");
    expect(aborted).toBeDefined();
    expect((aborted!.payload as { reason?: string }).reason).toContain("redelivery");
  });

  test("11. correlation_id contract — request.id threads every lifecycle envelope", async () => {
    const runtime = createRecordingRuntime();
    const request = makeRequest();
    const consumer = new DevConsumer(baseOpts({ runtime }));
    await consumer.processEnvelope(request, LOCAL_SUBJECT, null);

    for (const env of runtime.published) {
      expect(env.correlation_id).toBe(request.id);
    }
  });

  test("12. warm sessions — fix cycle on the same chain RESUMES the CC session", async () => {
    const runtime = createRecordingRuntime();
    const store: DevSessionStore = new MemoryDevSessionStore();
    const seen = { opts: [] as CCSessionOpts[] };
    const cc = fakeCcFactory(okCcResult("sess-warm-1"), seen);

    const consumer = new DevConsumer(baseOpts({ runtime, ccSessionFactory: cc, sessionStore: store }));

    // First task — chain root. Its correlation_id is the chain id.
    const chainId = crypto.randomUUID();
    const first = makeRequest(PAYLOAD, chainId);
    await consumer.processEnvelope(first, LOCAL_SUBJECT, null);

    // Cold first run — no resume id passed.
    expect(seen.opts[0]!.resumeSessionId).toBeUndefined();
    // The session id was persisted under the chain.
    expect(await store.get(chainId)).toBe("sess-warm-1");

    // Second task on the SAME chain (the fix cycle).
    const second = makeRequest(PAYLOAD, chainId);
    await consumer.processEnvelope(second, LOCAL_SUBJECT, null);

    // Warm — the second CC session resumed the first's session id.
    expect(seen.opts[1]!.resumeSessionId).toBe("sess-warm-1");
  });

  test("13. worktree removed on the success path", async () => {
    const workspace = fakeWorkspace();
    const consumer = new DevConsumer(baseOpts({ workspace }));
    await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    expect(workspace.removed).toEqual([{ path: "/tmp/Cortex-c-300" }]);
  });

  test("worktree create failure → cant_do + term; no CC spawned", async () => {
    const runtime = createRecordingRuntime();
    const workspace = fakeWorkspace({ failCreate: true });
    const seen = { opts: [] as CCSessionOpts[] };
    const cc = fakeCcFactory(okCcResult(), seen);

    const consumer = new DevConsumer(baseOpts({ runtime, workspace, ccSessionFactory: cc }));
    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(decision.kind).toBe("term");
    expect(seen.opts).toHaveLength(0); // CC never ran
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect((reasonOf(failed) as { detail: string }).detail).toContain("worktree create failed");
  });

  test("no gates declared → opens PR without running any (gating deferred to review)", async () => {
    const runner = fakeRunner();
    const forge = fakeForge();
    const noGates: DevImplementPayload = { ...PAYLOAD, gates: undefined };
    delete (noGates as { gates?: unknown }).gates;

    const consumer = new DevConsumer(baseOpts({ commandRunner: runner, forge }));
    const decision = await consumer.processEnvelope(makeRequest(noGates), LOCAL_SUBJECT, null);

    expect(decision).toEqual({ kind: "ack" });
    expect(runner.ran).toHaveLength(0);
    expect(forge.calls).toHaveLength(1);
  });

  test("§3.5b guardrails — CC session is scoped to the worktree when boot supplies no allowedDirs", async () => {
    const seen = { opts: [] as CCSessionOpts[] };
    const cc = fakeCcFactory(okCcResult(), seen);
    // No sessionOpts.allowedDirs → the consumer must default to the worktree.
    const consumer = new DevConsumer(baseOpts({ ccSessionFactory: cc }));
    await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    expect(seen.opts).toHaveLength(1);
    // cwd IS the worktree; allowedDirs is scoped to ONLY the worktree (the one
    // dir this higher-authority push session legitimately writes to) — never
    // unrestricted.
    expect(seen.opts[0]!.cwd).toBe("/tmp/Cortex-c-300");
    expect(seen.opts[0]!.allowedDirs).toEqual(["/tmp/Cortex-c-300"]);
    expect(seen.opts[0]!.bashGuardDisabled).toBeUndefined();
  });

  test("§3.5b guardrails — boot-supplied allowedDirs + channel + bashAllowlist flow into the CC session", async () => {
    const seen = { opts: [] as CCSessionOpts[] };
    const cc = fakeCcFactory(okCcResult(), seen);
    const bashAllowlist = { rules: [{ pattern: "^git" }], repos: [] };
    const consumer = new DevConsumer(
      baseOpts({
        ccSessionFactory: cc,
        sessionOpts: {
          agentId: "forge",
          // The bash-guard Gate-1 engagement precondition.
          groveChannel: "forge",
          bashAllowlist,
          allowedTools: ["Bash", "Read"],
          allowedDirs: ["/repo"],
        },
      }),
    );
    await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);

    const o = seen.opts[0]!;
    // Channel present → bash-guard engages (not pass-through).
    expect(o.groveChannel).toBe("forge");
    // bashAllowlist present → guard has rules AND the session avoids the
    // CLI-bypass (CORTEX_BASH_GUARD set).
    expect(o.bashAllowlist).toEqual(bashAllowlist);
    expect(o.allowedTools).toEqual(["Bash", "Read"]);
    // Boot-supplied allowedDirs wins over the worktree default.
    expect(o.allowedDirs).toEqual(["/repo"]);
  });
});

describe("DevConsumer.stop — drain", () => {
  test("idempotent; drains the in-flight pipeline before resolving", async () => {
    const runtime = createRecordingRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cc: CCSessionFactory = () => ({
      start() {
        return this;
      },
      wait: async () => {
        await gate;
        return okCcResult();
      },
    });

    const consumer = new DevConsumer(baseOpts({ runtime, ccSessionFactory: cc }));
    const inflight = consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    await Promise.resolve();
    await Promise.resolve();

    let drained = false;
    const stopP = consumer.stop().then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false); // still draining the in-flight task

    release();
    await inflight;
    await stopP;
    expect(drained).toBe(true);

    // Idempotent — second stop resolves without error.
    await consumer.stop();
  });

  test("after stop, a new task refuses with not_now + nak", async () => {
    const runtime = createRecordingRuntime();
    const consumer = new DevConsumer(baseOpts({ runtime }));
    await consumer.stop();

    const decision = await consumer.processEnvelope(makeRequest(), LOCAL_SUBJECT, null);
    expect(decision.kind).toBe("nak");
    const failed = runtime.published.find((e) => e.type === "dispatch.task.failed")!;
    expect(reasonOf(failed)!.kind).toBe("not_now");
  });
});

describe("DevConsumer.start — dormancy", () => {
  test("runtime without subscribePull → DORMANT (subscribed:false), no throw", async () => {
    const consumer = new DevConsumer(baseOpts());
    const info = await consumer.start({
      pattern: LOCAL_SUBJECT,
      stream: "DEV_IMPLEMENT",
      durable: "cortex-dev-consumer-andreas-forge",
    });
    expect(info).toEqual({ agentId: "forge", subscribed: false });
  });

  test("subscribePull returning null → DORMANT", async () => {
    const runtime = createRecordingRuntime();
    (runtime as { subscribePull?: unknown }).subscribePull = () => null;
    const consumer = new DevConsumer(baseOpts({ runtime }));
    const info = await consumer.start({
      pattern: LOCAL_SUBJECT,
      stream: "DEV_IMPLEMENT",
      durable: "d",
    });
    expect(info.subscribed).toBe(false);
  });
});

describe("failedReasonToAckDecision", () => {
  test("maps each reason kind to the right ack control", () => {
    expect(failedReasonToAckDecision(undefined)).toEqual({ kind: "ack" });
    expect(failedReasonToAckDecision({ kind: "cant_do", detail: "x" })).toEqual({
      kind: "term",
      reason: "cant_do: x",
    });
    expect(failedReasonToAckDecision({ kind: "wont_do", detail: "y" })).toEqual({
      kind: "term",
      reason: "wont_do: y",
    });
    expect(
      failedReasonToAckDecision({ kind: "not_now", detail: "busy", retry_after_ms: 250 }),
    ).toEqual({ kind: "nak", delayMs: 250 });
    expect(failedReasonToAckDecision({ kind: "policy_denied", deny: { role: "x" } })).toEqual({
      kind: "term",
      reason: "policy_denied: role",
    });
    expect(failedReasonToAckDecision({ kind: "compliance_block", detail: "z" })).toEqual({
      kind: "term",
      reason: "v1 does not handle compliance_block",
    });
  });
});
