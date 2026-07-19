/**
 * `daemon-brain-host` tests (Bot Packs B-2; `docs/design-bot-packs.md` §5/§7/§12).
 *
 * Drives the host through an IN-MEMORY transport double — a controllable "brain"
 * that the test scripts to emit effects, crash, or stall. No real socket / no
 * real subprocess; the protocol multiplexing, supervision, drain, attachment
 * budget, and scratch confinement are all exercised deterministically.
 *
 * Covered (task deliverable 7):
 *   - daemon round-trip: hello → task → post → result (over the transport)
 *   - multiplexed two concurrent tasks (interleaved effects, correlated by id)
 *   - crash → restart → maxRestarts → degraded presence emit
 *   - in-flight tasks fail (cant_do, "brain crashed") on crash
 *   - drain with an open ask_principal gate → cancellation notice + not_now
 *   - 4 MiB attachment budget → effect_rejected wont_do
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DaemonBrainHost,
  CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR,
  type DaemonTransport,
  type DaemonBrainProcess,
  type CreatePrivateThreadFn,
} from "../daemon-brain-host";
import { MAX_TASK_ATTACHMENT_BYTES } from "../attachment-budget";
import { type TaskEvent, type GateVerdictValue } from "../protocol";
import type { BrainTaskHooks } from "../exec-brain-runner";
import {
  FakeDaemonBrain,
  makeFakeDaemonTransport,
} from "./fake-daemon-brain";

// The in-memory daemon-brain double + sequencing transport are shared with the
// consumer integration tests; see `./fake-daemon-brain.ts`.
const FakeBrain = FakeDaemonBrain;
const makeFakeTransport = makeFakeDaemonTransport;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let scratchDirs: string[] = [];
function scratchFactory(): string {
  const d = mkdtempSync(join(tmpdir(), "daemon-test-scratch-"));
  scratchDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  scratchDirs = [];
});

function makeTask(over: Partial<TaskEvent> = {}): TaskEvent {
  return {
    v: 1,
    type: "task",
    task_id: "t-1",
    capability: "soc.compose.flow",
    payload: { scenario: "phish" },
    source: { surface: "mattermost", channel: "c1", thread: "th1", user: "u1" },
    ...over,
  };
}

function makeHooks(over: Partial<BrainTaskHooks> = {}): BrainTaskHooks & {
  posts: unknown[];
  asks: unknown[];
  dispatches: unknown[];
} {
  const posts: unknown[] = [];
  const asks: unknown[] = [];
  const dispatches: unknown[] = [];
  return {
    posts,
    asks,
    dispatches,
    onPost: over.onPost ?? ((p) => void posts.push(p)),
    onAskPrincipal:
      over.onAskPrincipal ??
      (async (a): Promise<{ verdict: GateVerdictValue; principal: string }> => {
        asks.push(a);
        return { verdict: "pass", principal: "andreas" };
      }),
    onDispatch: over.onDispatch ?? ((d) => void dispatches.push(d)),
    onLog: over.onLog ?? (() => {}),
    // cortex#2248 — optional retarget hook; forwarded only when a test
    // supplies one (the default hooks omit it, mirroring per-task callers).
    ...(over.onThreadCreated !== undefined && { onThreadCreated: over.onThreadCreated }),
  };
}

/**
 * cortex#2206 — a fake `create_private_thread` I/O seam. Records every call
 * and, by default, succeeds with a deterministic incrementing thread id.
 * Tests that need the adapter-failure path override via `result`.
 */
function makeThreadFn(
  result?: (opts: { channelId: string; name: string; memberIds: string[] }) =>
    | { ok: true; threadId: string }
    | { ok: false; detail: string },
): CreatePrivateThreadFn & {
  calls: { channelId: string; name: string; memberIds: string[] }[];
} {
  const calls: { channelId: string; name: string; memberIds: string[] }[] = [];
  const fn = async (opts: { channelId: string; name: string; memberIds: string[] }) => {
    calls.push(opts);
    if (result) return result(opts);
    return { ok: true as const, threadId: `thread-${calls.length}` };
  };
  return Object.assign(fn, { calls });
}

/** Wait until `cond()` is true (poll), or throw after `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonBrainHost — round-trip", () => {
  test("hello handshake on start, then task → post → result", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun brain.ts",
      packDir: "/packs/yarrow",
      persona: "You are Yarrow.",
      transport,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    // hello sent at connect (host-authoritative identity + persona).
    expect(brain.hasEvent("hello")).toBe(true);
    const hello = brain.received.find((e) => e.type === "hello");
    expect(hello).toMatchObject({
      type: "hello",
      agent: "yarrow",
      persona: "You are Yarrow.",
      protocol: "cortex-brain/v1",
    });

    const hooks = makeHooks();
    const runP = host.runTask(makeTask({ task_id: "t-1" }), hooks);

    await until(() => brain.lastTask()?.task_id === "t-1");
    // Daemon task carries NO persona (persona was delivered via hello).
    expect(brain.lastTask()?.persona).toBeUndefined();

    // Brain posts, then completes.
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: "t-1", text: "flow ready" }));
    brain.emit(
      JSON.stringify({ v: 1, type: "result", task_id: "t-1", status: "complete", summary: "done" }),
    );

    const result = await runP;
    expect(result.result.status).toBe("complete");
    expect(hooks.posts.length).toBe(1);
    await host.stop();
  });

  test("multiplexes two concurrent tasks correlated by task_id", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun brain.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    const hooksA = makeHooks();
    const hooksB = makeHooks();
    const runA = host.runTask(makeTask({ task_id: "A" }), hooksA);
    const runB = host.runTask(makeTask({ task_id: "B" }), hooksB);

    await until(
      () => brain.received.filter((e) => e.type === "task").length === 2,
    );

    // Interleave effects across the two tasks.
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: "B", text: "B1" }));
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: "A", text: "A1" }));
    brain.emit(
      JSON.stringify({ v: 1, type: "result", task_id: "A", status: "complete" }),
    );
    brain.emit(
      JSON.stringify({ v: 1, type: "result", task_id: "B", status: "complete" }),
    );

    const [resA, resB] = await Promise.all([runA, runB]);
    expect(resA.result.task_id).toBe("A");
    expect(resB.result.task_id).toBe("B");
    expect((hooksA.posts[0] as { text: string }).text).toBe("A1");
    expect((hooksB.posts[0] as { text: string }).text).toBe("B1");
    await host.stop();
  });

  test("an open ask_principal gate PAUSES the per-task timeout — no orphan (cortex#1073)", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun brain.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      taskTimeoutMs: 150, // deliberately shorter than the gate wait below
    });
    await host.start();

    let gateResolved = false;
    const hooks = makeHooks({
      onAskPrincipal: async (): Promise<{ verdict: GateVerdictValue; principal: string }> => {
        // A thinking human holds the gate open far longer than taskTimeoutMs.
        await new Promise((r) => setTimeout(r, 450));
        gateResolved = true;
        return { verdict: "pass", principal: "jc" };
      },
    });
    const runP = host.runTask(makeTask({ task_id: "g1" }), hooks);
    await until(() => brain.lastTask()?.task_id === "g1");

    // Open a gate; the host must NOT fail the task during the 450ms wait.
    brain.emit(JSON.stringify({ v: 1, type: "ask_principal", task_id: "g1", gate: "run-ack", prompt: "Run?" }));
    await until(() => gateResolved, 2000);
    // Gate answered → brain completes the (re-armed) task.
    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "g1", status: "complete" }));

    const result = await runP;
    expect(result.result.status).toBe("complete"); // NOT "failed"/timeout
    await host.stop();
  });

  test("an effect for an unknown task_id is refused with effect_rejected", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    // No task in flight — a post for a ghost task_id is rejected.
    brain.emit(JSON.stringify({ v: 1, type: "post", task_id: "ghost", text: "x" }));
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "post" });
    await host.stop();
  });
});

describe("DaemonBrainHost — supervision", () => {
  test("crash restarts up to maxRestarts then marks degraded + emits presence", async () => {
    // 1 original + maxRestarts(2) restarts = 3 brains; the 3rd crash exhausts.
    const brains = [new FakeBrain(), new FakeBrain(), new FakeBrain()];
    const { transport } = makeFakeTransport(brains);
    const degraded: string[] = [];
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      maxRestarts: 2,
      makeScratchDir: scratchFactory,
      onDegraded: (id) => degraded.push(id),
    });
    await host.start();
    expect(brains[0]?.hasEvent("hello")).toBe(true);

    // Crash gen 0 → restart to gen 1.
    brains[0]?.crash();
    await until(() => brains[1]?.hasEvent("hello") === true);
    expect(host.isDegraded).toBe(false);

    // Crash gen 1 → restart to gen 2.
    brains[1]?.crash();
    await until(() => brains[2]?.hasEvent("hello") === true);
    expect(host.isDegraded).toBe(false);

    // Crash gen 2 → budget (2) exhausted → degraded + presence signal.
    brains[2]?.crash();
    await until(() => host.isDegraded);
    expect(degraded).toEqual(["yarrow"]);

    // A degraded host fast-fails new tasks not_now.
    const res = await host.runTask(makeTask(), makeHooks());
    expect(res.result.status).toBe("failed");
    if (res.result.status === "failed") {
      expect(res.result.reason.kind).toBe("not_now");
    }
    await host.stop();
  });

  test("in-flight tasks fail cant_do 'brain crashed' on a crash", async () => {
    const brains = [new FakeBrain(), new FakeBrain()];
    const { transport } = makeFakeTransport(brains);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      maxRestarts: 1,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "live" }), makeHooks());
    await until(() => brains[0]?.lastTask()?.task_id === "live");

    brains[0]?.crash();
    const res = await runP;
    expect(res.result.status).toBe("failed");
    if (res.result.status === "failed") {
      expect(res.result.reason.kind).toBe("cant_do");
      expect(res.result.reason.detail).toContain("brain crashed");
    }
    await host.stop();
  });

  test("healthy uptime resets the restart counter", async () => {
    const brains = [new FakeBrain(), new FakeBrain(), new FakeBrain(), new FakeBrain()];
    const { transport } = makeFakeTransport(brains);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      maxRestarts: 1,
      healthyResetMs: 10, // reset almost immediately
      makeScratchDir: scratchFactory,
    });
    await host.start();

    brains[0]?.crash(); // restart 1/1
    await until(() => brains[1]?.hasEvent("hello") === true);
    // Let the healthy-reset timer fire (10ms) so the counter resets.
    await new Promise((r) => setTimeout(r, 40));
    brains[1]?.crash(); // would be 2/1 without reset → but reset → 1/1 again
    await until(() => brains[2]?.hasEvent("hello") === true);
    expect(host.isDegraded).toBe(false);
    await host.stop();
  });

  // Finding 2 (sage cortex#1035): a restart whose CONNECT always fails must
  // count against the restart budget and degrade — not recurse, not leave a
  // stale proc installed.
  test("a restart that always fails to connect degrades after maxRestarts (no recursion, no stale proc)", async () => {
    const gen0 = new FakeDaemonBrain();
    // gen 0 connects fine; every restart spawn rejects its connection promise.
    let spawnIdx = 0;
    const killedProcs: DaemonBrainProcess[] = [];
    const transport: DaemonTransport = () => {
      const idx = spawnIdx++;
      if (idx === 0) {
        return {
          connection: Promise.resolve(gen0.connection),
          exited: gen0.exited,
          kill: () => gen0.killed(),
        };
      }
      // A failed-connect restart: connection rejects, process already exited.
      const proc: DaemonBrainProcess = {
        connection: Promise.reject(
          new Error(`connect failed for restart spawn #${idx}`),
        ),
        exited: Promise.resolve(1),
        kill: () => {},
      };
      killedProcs.push(proc);
      return proc;
    };

    const degraded: string[] = [];
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      maxRestarts: 2,
      makeScratchDir: scratchFactory,
      onDegraded: (id) => degraded.push(id),
    });
    await host.start();
    expect(gen0.hasEvent("hello")).toBe(true);

    // Crash gen 0 → restart 1 (fails connect) → restart 2 (fails connect) →
    // budget (2) exhausted → degraded. No infinite recursion.
    gen0.crash();
    await until(() => host.isDegraded, 3000);
    expect(degraded).toEqual(["yarrow"]);
    // Exactly 1 original + 2 restart spawns were attempted (budget == 2); a
    // recursion bug would keep spawning well past this.
    expect(spawnIdx).toBe(3);

    // No stale proc installed: a new task fast-fails not_now (degraded), and the
    // host did not silently keep a dead connection.
    const res = await host.runTask(makeTask(), makeHooks());
    expect(res.result.status).toBe("failed");
    if (res.result.status === "failed") {
      expect(res.result.reason.kind).toBe("not_now");
    }
    await host.stop();
  });
});

describe("DaemonBrainHost — drain (hot-swap §7)", () => {
  test("drain with an open gate cancels with a re-trigger notice + not_now", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      killGraceMs: 50,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    // The gate hook never resolves (principal never answers) — so the gate stays
    // open across the drain deadline.
    const posts: { text: string }[] = [];
    let gateResolve: (() => void) | null = null;
    const hooks = makeHooks({
      onPost: (p) => void posts.push(p),
      onAskPrincipal: () =>
        new Promise(() => {
          gateResolve = () => {};
        }),
    });
    const runP = host.runTask(makeTask({ task_id: "g" }), hooks);
    await until(() => brain.lastTask()?.task_id === "g");

    // Brain opens a gate; the hook hangs (open gate).
    brain.emit(
      JSON.stringify({ v: 1, type: "post", task_id: "g", text: "composing…" }),
    );
    brain.emit(
      JSON.stringify({
        v: 1,
        type: "ask_principal",
        task_id: "g",
        gate: "principal-ack",
        prompt: "Run it?",
      }),
    );
    await until(() => posts.length === 1);

    // Drain with a short deadline — the gate is still open, so it must be
    // cancelled: a re-trigger notice posted + the task closed not_now.
    await host.drain(30);

    const res = await runP;
    expect(res.result.status).toBe("failed");
    if (res.result.status === "failed") {
      expect(res.result.reason.kind).toBe("not_now");
    }
    // The upgrade notice was posted into the thread.
    expect(posts.some((p) => /upgraded/i.test(p.text))).toBe(true);
    // shutdown was sent to the brain with the deadline.
    expect(brain.hasEvent("shutdown")).toBe(true);
    void gateResolve;
  });

  test("drain lets an in-flight task finish if it completes before the deadline", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "fin" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "fin");

    // Complete shortly after drain begins, within the deadline.
    const drainP = host.drain(500);
    brain.emit(
      JSON.stringify({ v: 1, type: "result", task_id: "fin", status: "complete" }),
    );
    const res = await runP;
    await drainP;
    expect(res.result.status).toBe("complete");
  });
});

describe("DaemonBrainHost — attachment budget (§12.5)", () => {
  test("an over-budget inline attachment is refused effect_rejected wont_do", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "yarrow",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
    });
    await host.start();

    const hooks = makeHooks();
    const runP = host.runTask(makeTask({ task_id: "big" }), hooks);
    await until(() => brain.lastTask()?.task_id === "big");

    // Build a base64 payload that DECODES to just over 4 MiB. The protocol's
    // 256 KiB INLINE cap would reject a single huge b64 — so instead we post
    // many under-256-KiB attachments until the per-TASK 4 MiB budget trips.
    // One ~192 KiB-decoded attachment, posted ceil(4MiB/192KiB)+1 times.
    const chunkDecodedBytes = 192 * 1024;
    const b64 = Buffer.alloc(chunkDecodedBytes, 0x41).toString("base64");
    const postsToOverflow = Math.ceil(MAX_TASK_ATTACHMENT_BYTES / chunkDecodedBytes) + 1;
    for (let i = 0; i < postsToOverflow; i++) {
      brain.emit(
        JSON.stringify({
          v: 1,
          type: "post",
          task_id: "big",
          text: `chunk ${i}`,
          attachment: { filename: `c${i}.bin`, b64 },
        }),
      );
    }
    // The budget overflow surfaces as an effect_rejected wont_do to the brain.
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "post" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("wont_do");
      expect(rej.reason.detail).toMatch(/budget/i);
    }

    brain.emit(
      JSON.stringify({ v: 1, type: "result", task_id: "big", status: "complete" }),
    );
    await runP;
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// create_private_thread (cortex#2206)
// ---------------------------------------------------------------------------

describe("DaemonBrainHost — create_private_thread (cortex#2206)", () => {
  test("members: \"source\" creates a thread on the agent's OWN channel binding, resolves the source user server-side, and answers thread_created", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
      anonReachable: true,
    });
    await host.start();

    const runP = host.runTask(
      makeTask({
        task_id: "th1",
        source: { surface: "discord", channel: "arrivals", thread: "", user: "newcomer-42" },
      }),
      makeHooks(),
    );
    await until(() => brain.lastTask()?.task_id === "th1");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "th1",
        name: "welcome newcomer-42",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    // Exactly the intended host call: the agent's OWN channel binding, never
    // anything the brain could have named, and the member list resolved
    // server-side from the task's own recorded source user.
    expect(threadFn.calls).toEqual([
      { channelId: "agent-own-channel", name: "welcome newcomer-42", memberIds: ["newcomer-42"] },
    ]);

    const created = brain.received.find((e) => e.type === "thread_created");
    expect(created).toMatchObject({ type: "thread_created", task_id: "th1", thread_id: "thread-1" });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "th1", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("an anon-reachable agent requesting an explicit member list is refused effect_rejected/policy_denied — the adapter is NEVER called", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
      anonReachable: true, // e.g. AgentSchema.openOnboarding: true
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "evil" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "evil");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "evil",
        name: "definitely not a welcome thread",
        members: ["some-arbitrary-platform-user-id"],
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));

    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "create_private_thread" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("policy_denied");
    }
    // The load-bearing assertion: the anon-reachable agent's explicit member
    // list NEVER reached the adapter — the effect was refused before any I/O.
    expect(threadFn.calls.length).toBe(0);
    expect(brain.hasEvent("thread_created")).toBe(false);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "evil", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("a non-anon-reachable (trusted) agent MAY request an explicit member list", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "quest-master",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "quest-board-channel",
      createPrivateThread: threadFn,
      anonReachable: false, // explicit opt-out — this agent has no anon path
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "quest1" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "quest1");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "quest1",
        name: "quest party",
        members: ["party-member-1", "party-member-2"],
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    expect(threadFn.calls).toEqual([
      {
        channelId: "quest-board-channel",
        name: "quest party",
        memberIds: ["party-member-1", "party-member-2"],
      },
    ]);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "quest1", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("the wire effect has no channel field — a brain-supplied `channel` is structurally ignored; the agent's own binding is always used", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "the-real-agent-channel",
      createPrivateThread: threadFn,
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "spoof" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "spoof");

    // Raw wire line carrying an extra `channel` field — not a schema field at
    // all (protocol.ts's CreatePrivateThreadEffectSchema has no such key), so
    // the tolerant-ingest codec strips it before the effect ever reaches the
    // host's switch. This is the "structurally impossible", not merely
    // "refused", guarantee the issue calls for.
    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "spoof",
        name: "spoofed thread",
        members: "source",
        channel: "attacker-chosen-channel",
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    expect(threadFn.calls.length).toBe(1);
    expect(threadFn.calls[0]?.channelId).toBe("the-real-agent-channel");

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "spoof", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("no channel binding / no adapter capability configured → effect_rejected cant_do (structural, not policy)", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const host = new DaemonBrainHost({
      agentId: "no-thread-capability",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      // agentChannelId / createPrivateThread both omitted.
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "nocap" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "nocap");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "nocap",
        name: "will never exist",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("cant_do");
    }

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "nocap", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("an adapter failure maps to effect_rejected not_now (transient, not the brain's fault)", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn(() => ({ ok: false, detail: "discord API 503" }));
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "fail1" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "fail1");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "fail1",
        name: "will fail",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));
    const rej = brain.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "create_private_thread" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("not_now");
      expect(rej.reason.detail).toContain("discord API 503");
    }

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "fail1", status: "complete" }));
    await runP;
    await host.stop();
  });

  test(`rate limit trips at exactly ${CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR}/hour for one agent — the next is refused, a DIFFERENT agent still succeeds`, async () => {
    let nowMs = 1_000_000;
    const clock = () => nowMs;

    const brainA = new FakeBrain();
    const { transport: transportA } = makeFakeTransport([brainA]);
    const threadFnA = makeThreadFn();
    const hostA = new DaemonBrainHost({
      agentId: "agent-a",
      run: "bun b.ts",
      packDir: "/p",
      transport: transportA,
      makeScratchDir: scratchFactory,
      agentChannelId: "channel-a",
      createPrivateThread: threadFnA,
      now: clock,
    });
    await hostA.start();

    const runA = hostA.runTask(makeTask({ task_id: "rl" }), makeHooks());
    await until(() => brainA.lastTask()?.task_id === "rl");

    // Drive CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR (10) successful calls,
    // all well within the hour window.
    for (let i = 0; i < CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR; i++) {
      nowMs += 1_000; // a few seconds apart — still the same window
      brainA.emit(
        JSON.stringify({
          v: 1,
          type: "create_private_thread",
          task_id: "rl",
          name: `thread-${i}`,
          members: "source",
        }),
      );
      await until(
        () => brainA.received.filter((e) => e.type === "thread_created").length === i + 1,
      );
    }
    expect(threadFnA.calls.length).toBe(CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR);

    // The 11th within the SAME window is refused — the budget, not a fluke.
    nowMs += 1_000;
    brainA.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "rl",
        name: "eleventh",
        members: "source",
      }),
    );
    await until(() => brainA.hasEvent("effect_rejected"));
    const rej = brainA.received.find((e) => e.type === "effect_rejected");
    expect(rej).toMatchObject({ type: "effect_rejected", effect: "create_private_thread" });
    if (rej?.type === "effect_rejected") {
      expect(rej.reason.kind).toBe("policy_denied");
      expect(rej.reason.detail).toMatch(/rate|exceeded|limit/i);
    }
    // The 11th never reached the adapter.
    expect(threadFnA.calls.length).toBe(CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR);

    brainA.emit(JSON.stringify({ v: 1, type: "result", task_id: "rl", status: "complete" }));
    await runA;
    await hostA.stop();

    // A DIFFERENT agent (its own DaemonBrainHost instance, its own counter)
    // in the exact same window still succeeds — the budget is per-agent, not
    // a global ceiling one agent's traffic can exhaust for everyone.
    const brainB = new FakeBrain();
    const { transport: transportB } = makeFakeTransport([brainB]);
    const threadFnB = makeThreadFn();
    const hostB = new DaemonBrainHost({
      agentId: "agent-b",
      run: "bun b.ts",
      packDir: "/p",
      transport: transportB,
      makeScratchDir: scratchFactory,
      agentChannelId: "channel-b",
      createPrivateThread: threadFnB,
      now: clock,
    });
    await hostB.start();
    const runB = hostB.runTask(makeTask({ task_id: "rlb" }), makeHooks());
    await until(() => brainB.lastTask()?.task_id === "rlb");

    brainB.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "rlb",
        name: "agent-b's first thread this hour",
        members: "source",
      }),
    );
    await until(() => brainB.hasEvent("thread_created"));
    expect(threadFnB.calls.length).toBe(1);

    brainB.emit(JSON.stringify({ v: 1, type: "result", task_id: "rlb", status: "complete" }));
    await runB;
    await hostB.stop();
  });

  test("an open create_private_thread call PAUSES the per-task timeout — no orphan (mirrors the ask_principal gate-pause, cortex#1073)", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    let resolveThread!: (v: { ok: true; threadId: string }) => void;
    const slowThreadFn: CreatePrivateThreadFn = () =>
      new Promise((resolve) => {
        resolveThread = resolve;
      });
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: slowThreadFn,
      taskTimeoutMs: 150, // deliberately shorter than the in-flight wait below
    });
    await host.start();

    const runP = host.runTask(makeTask({ task_id: "slow" }), makeHooks());
    await until(() => brain.lastTask()?.task_id === "slow");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "slow",
        name: "slow platform round-trip",
        members: "source",
      }),
    );

    // The adapter call is deliberately held open far longer than
    // taskTimeoutMs — the host must NOT fail the task while it's in flight.
    await new Promise((r) => setTimeout(r, 300));
    resolveThread({ ok: true, threadId: "thread-slow" });

    await until(() => brain.hasEvent("thread_created"));
    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "slow", status: "complete" }));

    const result = await runP;
    expect(result.result.status).toBe("complete"); // NOT "failed"/timeout
    await host.stop();
  });
});

// ---------------------------------------------------------------------------
// create_private_thread → onThreadCreated retarget hook (cortex#2248)
// ---------------------------------------------------------------------------

describe("DaemonBrainHost — onThreadCreated retarget hook (cortex#2248)", () => {
  test("a successful create_private_thread fires hooks.onThreadCreated with the created thread id BEFORE the brain hears thread_created", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
      anonReachable: true,
    });
    await host.start();

    // Record the hook firing AND whether `thread_created` had already been
    // sent to the brain at that moment — the ordering is load-bearing: the
    // retarget must land before the brain can react to the event with a
    // `post`, or that post races into the parent channel.
    const hookCalls: { threadId: string; threadCreatedAlreadySent: boolean }[] = [];
    const hooks = makeHooks({
      onThreadCreated: (threadId: string): void => {
        hookCalls.push({
          threadId,
          threadCreatedAlreadySent: brain.hasEvent("thread_created"),
        });
      },
    });

    const runP = host.runTask(
      makeTask({
        task_id: "rt1",
        source: { surface: "discord", channel: "arrivals", thread: "", user: "newcomer-a" },
      }),
      hooks,
    );
    await until(() => brain.lastTask()?.task_id === "rt1");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "rt1",
        name: "welcome newcomer-a",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    expect(hookCalls).toEqual([
      { threadId: "thread-1", threadCreatedAlreadySent: false },
    ]);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "rt1", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("a FAILED create_private_thread (adapter failure) never fires onThreadCreated", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn(() => ({ ok: false, detail: "platform exploded" }));
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
      anonReachable: true,
    });
    await host.start();

    const hookCalls: string[] = [];
    const hooks = makeHooks({
      onThreadCreated: (threadId: string): void => void hookCalls.push(threadId),
    });

    const runP = host.runTask(makeTask({ task_id: "rt2" }), hooks);
    await until(() => brain.lastTask()?.task_id === "rt2");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "rt2",
        name: "will fail",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("effect_rejected"));

    expect(hookCalls).toEqual([]);
    expect(brain.hasEvent("thread_created")).toBe(false);

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "rt2", status: "complete" }));
    await runP;
    await host.stop();
  });

  test("a THROWING onThreadCreated hook is contained: logged, and thread_created still reaches the brain (the thread exists)", async () => {
    const brain = new FakeBrain();
    const { transport } = makeFakeTransport([brain]);
    const threadFn = makeThreadFn();
    const host = new DaemonBrainHost({
      agentId: "escort",
      run: "bun b.ts",
      packDir: "/p",
      transport,
      makeScratchDir: scratchFactory,
      agentChannelId: "agent-own-channel",
      createPrivateThread: threadFn,
      anonReachable: true,
    });
    await host.start();

    const hooks = makeHooks({
      onThreadCreated: (): void => {
        throw new Error("consumer routing update blew up");
      },
    });

    const runP = host.runTask(makeTask({ task_id: "rt3" }), hooks);
    await until(() => brain.lastTask()?.task_id === "rt3");

    brain.emit(
      JSON.stringify({
        v: 1,
        type: "create_private_thread",
        task_id: "rt3",
        name: "hook throws",
        members: "source",
      }),
    );
    await until(() => brain.hasEvent("thread_created"));

    const created = brain.received.find((e) => e.type === "thread_created");
    expect(created).toMatchObject({ type: "thread_created", task_id: "rt3", thread_id: "thread-1" });

    brain.emit(JSON.stringify({ v: 1, type: "result", task_id: "rt3", status: "complete" }));
    await runP;
    await host.stop();
  });
});
