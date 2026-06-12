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
  type DaemonTransport,
  type DaemonBrainProcess,
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
  };
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
      onPost: (p) => void posts.push(p as { text: string }),
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
