/**
 * build-journal.run code-handler tests.
 *
 * Axes:
 *  1. parseRunSpec — days falls back to the configured default; post/deploy
 *     default true and are only disabled by an explicit `false`.
 *  2. buildRunnerArgv — `--llm --days N` always; `--post`/`--deploy` conditional.
 *  3. createBuildJournalRunner handler — exit 0 → `completed` (no throw);
 *     non-zero exit / spawn throw / watchdog timeout → `failed` + THROWS so the
 *     bridge leaves the Decision un-marked (re-fireable). Always emits `started`.
 */

import { describe, test, expect } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { FiredActivation } from "../reflex-activation-listener";
import {
  createBuildJournalRunner,
  parseRunSpec,
  buildRunnerArgv,
  RUNNER_REL_PATH,
  type Spawn,
} from "../build-journal";

const SOURCE = { principal: "jc", agent: "cortex", instance: "local" };
const PULSE = "/home/jc/work/mf/pulse";

function activation(payload: unknown): FiredActivation {
  return {
    target: "@jc/build-journal",
    payload: payload as Record<string, unknown>,
    decisionId: "decision-1",
    correlationId: "00000000-0000-4000-8000-0000000000aa",
    classification: "local",
  };
}

function fakeRuntime() {
  const published: Envelope[] = [];
  const runtime = {
    enabled: true,
    onEnvelope() { return { unregister: () => {} }; },
    async publish(e: Envelope) { published.push(e); },
    async stop() {},
  } as unknown as MyelinRuntime;
  return { runtime, published };
}

/**
 * Controllable spawn double. `hang: true` keeps the process running until
 * `kill()` is called (drives the watchdog path); otherwise it exits with
 * `exitCode` immediately.
 */
function fakeSpawn(opts: { exitCode?: number; throwOnSpawn?: boolean; hang?: boolean } = {}) {
  const calls: { cmd: string[]; cwd: string }[] = [];
  let killed = false;
  const spawn: Spawn = (cmd, o) => {
    calls.push({ cmd, cwd: o.cwd });
    if (opts.throwOnSpawn === true) throw new Error("spawn boom");
    let resolveExit!: (n: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    if (opts.hang !== true) resolveExit(opts.exitCode ?? 0);
    return {
      exited,
      kill: () => { killed = true; resolveExit(opts.exitCode ?? 143); },
    };
  };
  return { spawn, calls, wasKilled: () => killed };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

const events = (published: Envelope[]) =>
  published.filter((e) => e.type === "system.bus.build_journal").map((e) => e.payload as Record<string, unknown>);
const outcomes = (published: Envelope[]) => events(published).map((p) => p.outcome);

// ===========================================================================

describe("parseRunSpec", () => {
  test("empty payload → days default, post+deploy true", () => {
    expect(parseRunSpec({}, 7)).toEqual({ days: 7, post: true, deploy: true });
    expect(parseRunSpec(null, 7)).toEqual({ days: 7, post: true, deploy: true });
    expect(parseRunSpec("nope", 7)).toEqual({ days: 7, post: true, deploy: true });
  });
  test("explicit days overrides the default; non-positive falls back", () => {
    expect(parseRunSpec({ days: 14 }, 7).days).toBe(14);
    expect(parseRunSpec({ days: 0 }, 7).days).toBe(7);
    expect(parseRunSpec({ days: -3 }, 7).days).toBe(7);
  });
  test("post/deploy disabled only by an explicit false", () => {
    expect(parseRunSpec({ post: false }, 7)).toMatchObject({ post: false, deploy: true });
    expect(parseRunSpec({ deploy: false }, 7)).toMatchObject({ post: true, deploy: false });
  });
});

describe("buildRunnerArgv", () => {
  test("always --llm --days; --post/--deploy conditional", () => {
    expect(buildRunnerArgv(PULSE, { days: 7, post: true, deploy: true })).toEqual([
      "bun", `${PULSE}/${RUNNER_REL_PATH}`, "--llm", "--days", "7", "--post", "--deploy",
    ]);
    expect(buildRunnerArgv(PULSE, { days: 4, post: false, deploy: false })).toEqual([
      "bun", `${PULSE}/${RUNNER_REL_PATH}`, "--llm", "--days", "4",
    ]);
  });
});

describe("createBuildJournalRunner", () => {
  test("exit 0 → started + completed, no throw, spawned with right argv + cwd", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ exitCode: 0 });
    const handler = createBuildJournalRunner({ runtime, source: SOURCE, pulseRepo: PULSE, daysDefault: 7, spawn: sp.spawn });

    await handler(activation({ days: 7 }));
    await flush();

    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]!.cwd).toBe(PULSE);
    expect(sp.calls[0]!.cmd).toContain("--post");
    expect(sp.calls[0]!.cmd).toContain("--deploy");
    expect(outcomes(published)).toEqual(["started", "completed"]);
  });

  test("non-zero exit → failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ exitCode: 1 });
    const handler = createBuildJournalRunner({ runtime, source: SOURCE, pulseRepo: PULSE, daysDefault: 7, spawn: sp.spawn });

    let threw = false;
    try { await handler(activation({})); } catch { threw = true; }
    await flush();

    expect(threw).toBe(true);
    expect(outcomes(published)).toEqual(["started", "failed"]);
    expect(events(published).at(-1)!.reason).toBe("exit-1");
  });

  test("watchdog timeout → kills + failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ hang: true });
    const handler = createBuildJournalRunner({
      runtime, source: SOURCE, pulseRepo: PULSE, daysDefault: 7, spawn: sp.spawn, timeoutMs: 10,
    });

    let threw = false;
    try { await handler(activation({})); } catch { threw = true; }
    await flush();

    expect(threw).toBe(true);
    expect(sp.wasKilled()).toBe(true);
    expect(outcomes(published)).toEqual(["started", "failed"]);
    expect(String(events(published).at(-1)!.reason)).toContain("timeout");
  });

  test("spawn throws → failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ throwOnSpawn: true });
    const handler = createBuildJournalRunner({ runtime, source: SOURCE, pulseRepo: PULSE, daysDefault: 7, spawn: sp.spawn });

    let threw = false;
    try { await handler(activation({})); } catch { threw = true; }
    await flush();

    expect(threw).toBe(true);
    expect(outcomes(published)).toEqual(["started", "failed"]);
    expect(String(events(published).at(-1)!.reason)).toContain("spawn");
  });
});
