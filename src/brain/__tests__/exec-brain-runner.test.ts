/**
 * `exec-brain-runner` end-to-end tests (Bot Packs B-1).
 *
 * Each test writes a tiny brain fixture (a .ts script) to a temp dir and runs
 * it through the real runner via `bun`, exercising one protocol path:
 *   - happy path (task → post → result complete)
 *   - gate flow (ask_principal → gate_verdict with principal → result)
 *   - foreign task_id → effect_rejected, dropped
 *   - dispatch hook rejection → effect_rejected delivered to the brain
 *   - brain crash → synthesized failed (cant_do)
 *   - timeout → SIGTERM/KILL → synthesized failed
 *   - typed refusal (result failed not_now) passes through
 *
 * The fixtures speak `cortex-brain/v1` by hand (raw JSON lines on stdout,
 * reading events off stdin) so the test exercises the wire, not the codec.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeExecBrainRunner,
  type BrainTaskHooks,
} from "../exec-brain-runner";
import type {
  TaskEvent,
  PostEffect,
  AskPrincipalEffect,
  DispatchEffect,
  LogEffect,
  GateVerdictValue,
  BrainReason,
} from "../protocol";

// ---------------------------------------------------------------------------
// Fixture harness
// ---------------------------------------------------------------------------

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "brain-fixtures-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Write a brain fixture script and return its path. */
function writeFixture(name: string, body: string): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

/** A baseline task event. */
function makeTask(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    v: 1,
    type: "task",
    task_id: "task-1",
    capability: "soc.compose.flow",
    payload: { scenario: "phish" },
    source: { surface: "mattermost", channel: "c1", thread: "th1", user: "u1" },
    persona: "You are a test brain.",
    ...overrides,
  };
}

/** Recording hooks with sensible defaults; override per test. */
function makeHooks(over: Partial<BrainTaskHooks> = {}): BrainTaskHooks & {
  posts: PostEffect[];
  asks: AskPrincipalEffect[];
  dispatches: DispatchEffect[];
  brainLogs: LogEffect[];
} {
  const posts: PostEffect[] = [];
  const asks: AskPrincipalEffect[] = [];
  const dispatches: DispatchEffect[] = [];
  const brainLogs: LogEffect[] = [];
  return {
    posts,
    asks,
    dispatches,
    brainLogs,
    onPost: over.onPost ?? ((p) => void posts.push(p)),
    onAskPrincipal:
      over.onAskPrincipal ??
      (async (a): Promise<{ verdict: GateVerdictValue; principal: string }> => {
        asks.push(a);
        return { verdict: "pass", principal: "andreas" };
      }),
    onDispatch:
      over.onDispatch ??
      ((d) => {
        dispatches.push(d);
      }),
    onLog: over.onLog ?? ((l) => void brainLogs.push(l)),
  };
}

/**
 * A short timeout-friendly runner. `bun` start-up is ~tens of ms; 8 s leaves
 * ample headroom while keeping the timeout-path test fast.
 */
function runner(fixturePath: string, over: { timeoutMs?: number; killGraceMs?: number } = {}) {
  return makeExecBrainRunner({
    run: `bun ${fixturePath}`,
    packDir: fixtureDir,
    timeoutMs: over.timeoutMs ?? 8_000,
    killGraceMs: over.killGraceMs ?? 1_000,
  });
}

// ---------------------------------------------------------------------------
// Shared fixture prologue — read the task off stdin
// ---------------------------------------------------------------------------
//
// Each brain reads ONE line (the task event) off stdin, then acts. A few also
// keep reading for follow-up events (gate_verdict / effect_rejected).

//
// NB: fixtures read stdin via \`node:readline\`, NOT \`Bun.stdin.stream()\`.
// A spawned child reading \`Bun.stdin.stream()\` does not observe the parent's
// incremental \`FileSink\` writes under \`bun test\` (the second write never
// arrives — the child blocks until EOF). \`node:readline\` over
// \`process.stdin\` delivers lines incrementally and is the portable choice
// for a line-protocol child. This is a TEST-FIXTURE concern only; the runner
// drives real packs, which read their own stdin however they like.

const READ_FIRST_LINE = `
import { createInterface as __ci } from "node:readline";
const __rl = __ci({ input: process.stdin });
const __it = __rl[Symbol.asyncIterator]();
async function firstLine(): Promise<any> {
  const { value } = await __it.next();
  return value === undefined ? null : JSON.parse(value);
}
function emit(o: unknown) { process.stdout.write(JSON.stringify(o) + "\\n"); }
// Emit a terminal effect then exit cleanly — node:readline keeps stdin (and
// thus the event loop) open, so a brain must exit explicitly once done.
function done(o: unknown) { emit(o); __rl.close(); process.exit(0); }
`;

// A reader that yields parsed JSON lines (for brains awaiting follow-ups).
const LINE_ITER = `
import { createInterface as __ci } from "node:readline";
const __rl = __ci({ input: process.stdin });
async function* lines() {
  for await (const __line of __rl) {
    const __t = __line.trim();
    if (__t.length > 0) yield JSON.parse(__t);
  }
}
function emit(o: unknown) { process.stdout.write(JSON.stringify(o) + "\\n"); }
// Emit a terminal effect then exit cleanly — node:readline keeps stdin (and
// thus the event loop) open, so a brain must exit explicitly once done.
function done(o: unknown) { emit(o); __rl.close(); process.exit(0); }
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exec-brain-runner — happy path", () => {
  test("task → post → result complete", async () => {
    const fx = writeFixture(
      "happy.ts",
      `${READ_FIRST_LINE}
const task = await firstLine();
emit({ v: 1, type: "post", task_id: task.task_id, text: "hello from brain" });
emit({ v: 1, type: "log", level: "info", text: "did the thing" });
done({ v: 1, type: "result", task_id: task.task_id, status: "complete", summary: "ok" });
`,
    );
    const hooks = makeHooks();
    const out = await runner(fx)(makeTask(), hooks);

    expect(out.result.status).toBe("complete");
    if (out.result.status === "complete") {
      expect(out.result.summary).toBe("ok");
    }
    expect(hooks.posts).toHaveLength(1);
    expect(hooks.posts[0]?.text).toBe("hello from brain");
    expect(out.logs).toContain("did the thing");
    expect(out.exitCode).toBe(0);
  });
});

describe("exec-brain-runner — gate flow", () => {
  test("ask_principal → gate_verdict with principal → result", async () => {
    const fx = writeFixture(
      "gate.ts",
      `${LINE_ITER}
let task: any;
const it = lines();
const first = await it.next();
task = first.value;
emit({ v: 1, type: "ask_principal", task_id: task.task_id, gate: "principal-ack", prompt: "Run it?" });
// Await the gate_verdict the runner feeds back.
for await (const ev of it) {
  if (ev.type === "gate_verdict") {
    emit({ v: 1, type: "post", task_id: task.task_id, text: "verdict=" + ev.verdict + " principal=" + ev.principal });
    done({ v: 1, type: "result", task_id: task.task_id, status: ev.verdict === "pass" ? "complete" : "failed", ...(ev.verdict === "pass" ? { summary: "ran" } : { reason: { kind: "wont_do", detail: "denied" } }) });
  }
}
`,
    );
    const hooks = makeHooks({
      onAskPrincipal: async (a) => {
        expect(a.gate).toBe("principal-ack");
        return { verdict: "pass", principal: "andreas", notes: "go" };
      },
    });
    const out = await runner(fx)(makeTask(), hooks);

    expect(out.result.status).toBe("complete");
    expect(hooks.posts[0]?.text).toBe("verdict=pass principal=andreas");
  });
});

describe("exec-brain-runner — task_id correlation", () => {
  test("foreign task_id → effect_rejected, effect dropped (not delivered to hooks)", async () => {
    const fx = writeFixture(
      "foreign.ts",
      `${LINE_ITER}
const it = lines();
const task = (await it.next()).value;
// Emit a post for a DIFFERENT task id — runner must reject + drop it.
emit({ v: 1, type: "post", task_id: "someone-elses-task", text: "should be dropped" });
// Await the effect_rejected the runner sends back, then close cleanly.
for await (const ev of it) {
  if (ev.type === "effect_rejected") {
    done({ v: 1, type: "result", task_id: task.task_id, status: "complete", summary: "rejected=" + ev.reason.kind });
  }
}
`,
    );
    const hooks = makeHooks();
    const out = await runner(fx)(makeTask(), hooks);

    // The foreign post never reached the onPost hook.
    expect(hooks.posts).toHaveLength(0);
    expect(out.result.status).toBe("complete");
    if (out.result.status === "complete") {
      expect(out.result.summary).toBe("rejected=wont_do");
    }
  });
});

describe("exec-brain-runner — dispatch rejection", () => {
  test("dispatch hook rejection → effect_rejected delivered to brain", async () => {
    const fx = writeFixture(
      "dispatch-reject.ts",
      `${LINE_ITER}
const it = lines();
const task = (await it.next()).value;
emit({ v: 1, type: "dispatch", task_id: task.task_id, capability: "soc.forbidden", payload: {} });
for await (const ev of it) {
  if (ev.type === "effect_rejected") {
    done({ v: 1, type: "result", task_id: task.task_id, status: "failed", reason: { kind: ev.reason.kind, detail: "host refused: " + ev.reason.detail } });
  }
}
`,
    );
    const hooks = makeHooks({
      onDispatch: (d): { rejected: true; reason: BrainReason } => {
        expect(d.capability).toBe("soc.forbidden");
        return { rejected: true, reason: { kind: "wont_do", detail: "capability outside manifest" } };
      },
    });
    const out = await runner(fx)(makeTask(), hooks);

    expect(out.result.status).toBe("failed");
    if (out.result.status === "failed") {
      expect(out.result.reason.kind).toBe("wont_do");
      expect(out.result.reason.detail).toContain("capability outside manifest");
    }
  });
});

describe("exec-brain-runner — brain crash", () => {
  test("brain exits without result → synthesized failed (cant_do) with stderr tail", async () => {
    const fx = writeFixture(
      "crash.ts",
      `${READ_FIRST_LINE}
await firstLine();
process.stderr.write("boom: something broke\\n");
process.exit(3);
`,
    );
    const hooks = makeHooks();
    const out = await runner(fx)(makeTask(), hooks);

    expect(out.result.status).toBe("failed");
    if (out.result.status === "failed") {
      expect(out.result.reason.kind).toBe("cant_do");
      expect(out.result.reason.detail).toContain("without result");
      expect(out.result.reason.detail).toContain("boom");
    }
    expect(out.stderrTail).toContain("boom");
    expect(out.exitCode).toBe(3);
  });
});

describe("exec-brain-runner — timeout", () => {
  test("brain that never returns → SIGTERM/KILL → synthesized failed", async () => {
    const fx = writeFixture(
      "hang.ts",
      `${READ_FIRST_LINE}
const task = await firstLine();
if (task !== null) emit({ v: 1, type: "log", level: "info", text: "going to sleep forever" });
// Never emit a result; sleep past the runner timeout.
await new Promise(() => {});
`,
    );
    const hooks = makeHooks();
    // timeoutMs generous enough that the brain reliably reads the task and
    // emits its log before we trip the timeout (bun cold-start is ~100-300ms),
    // but short enough to keep the test fast.
    const out = await runner(fx, { timeoutMs: 1_500, killGraceMs: 400 })(makeTask(), hooks);

    expect(out.result.status).toBe("failed");
    if (out.result.status === "failed") {
      expect(out.result.reason.kind).toBe("cant_do");
      expect(out.result.reason.detail).toContain("timed out");
    }
  }, 10_000);
});

describe("exec-brain-runner — typed refusal passthrough", () => {
  test("result failed not_now passes through unflattened", async () => {
    const fx = writeFixture(
      "refuse.ts",
      `${READ_FIRST_LINE}
const task = await firstLine();
done({ v: 1, type: "result", task_id: task.task_id, status: "failed", reason: { kind: "not_now", detail: "substrate busy, retry later" } });
`,
    );
    const hooks = makeHooks();
    const out = await runner(fx)(makeTask(), hooks);

    expect(out.result.status).toBe("failed");
    if (out.result.status === "failed") {
      expect(out.result.reason.kind).toBe("not_now");
      expect(out.result.reason.detail).toContain("retry later");
    }
    // A typed refusal is a CLEAN exit, not a crash.
    expect(out.exitCode).toBe(0);
  });
});

describe("exec-brain-runner — secrets + env scoping", () => {
  test("only declared secrets + minimal env reach the brain; no ambient creds", async () => {
    const fx = writeFixture(
      "env.ts",
      `${READ_FIRST_LINE}
const task = await firstLine();
done({ v: 1, type: "result", task_id: task.task_id, status: "complete", summary: JSON.stringify({
  secret: process.env.VT_API_KEY ?? null,
  ambient: process.env.SHOULD_NOT_LEAK ?? null,
  hasTmp: typeof process.env.TMPDIR === "string",
}) });
`,
    );
    // Set an ambient var that must NOT leak through.
    process.env.SHOULD_NOT_LEAK = "leaked!";
    const run = makeExecBrainRunner({
      run: `bun ${fx}`,
      packDir: fixtureDir,
      secrets: { VT_API_KEY: "sekret" },
      timeoutMs: 8_000,
    });
    const out = await run(makeTask(), makeHooks());
    delete process.env.SHOULD_NOT_LEAK;

    expect(out.result.status).toBe("complete");
    if (out.result.status === "complete") {
      const parsed = JSON.parse(out.result.summary ?? "{}");
      expect(parsed.secret).toBe("sekret");
      expect(parsed.ambient).toBeNull();
      expect(parsed.hasTmp).toBe(true);
    }
  });
});
