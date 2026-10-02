import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCSession, type CCSessionResult } from "../cc-session";
import { ClaudeCodeHarness } from "../../substrates/claude-code/harness";
import type { MyelinEnvelope } from "../../common/substrates/types";

/**
 * A spawn that THROWS must end the session with an error result — never
 * leave `wait()` pending.
 *
 * `CCSession.start()` catches a spawn failure and emits `error` + `exit`
 * synchronously, inside `start()`. What a caller then sees depended on
 * whether an `error` listener was already attached:
 *
 *   - NO listener (ClaudeCodeHarness, review-pipeline, dev-consumer,
 *     brain-compose): EventEmitter re-throws the unhandled `error` out of
 *     `start()`, the caller's try/catch turns it into a failure. Settles.
 *   - A listener attached BEFORE `start()` (dispatch-handler, agent-team,
 *     and any caller wiring progress/heartbeat first): `start()` returns
 *     normally, both events have already fired, and a later `wait()`
 *     attached its listeners too late — pending forever. Worse, `wait()`
 *     saw `proc === null` and called `start()` a SECOND time.
 *
 * The failures that reach this path are real ones: ENOENT (no `claude` on
 * PATH), EACCES (not executable), E2BIG, and the EBH-4 egress proxy's
 * fail-closed refusal under `enforce`.
 *
 * Every assertion is bounded: a hang shows up as `"HANG"`, not as a stuck
 * test run.
 */

const BOUND_MS = 3_000;

function bounded<T>(p: Promise<T>): Promise<T | "HANG"> {
  return Promise.race([
    p,
    new Promise<"HANG">((resolve) => setTimeout(() => resolve("HANG"), BOUND_MS)),
  ]);
}

let root = "";
let emptyBin = "";
let noExecBin = "";
let originalPath: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cc-session-spawn-failure-"));
  emptyBin = join(root, "empty");
  noExecBin = join(root, "noexec");
  mkdirSync(emptyBin);
  mkdirSync(noExecBin);
  const claude = join(noExecBin, "claude");
  writeFileSync(claude, "#!/bin/sh\necho never\n");
  chmodSync(claude, 0o644); // present, NOT executable → EACCES
  originalPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = originalPath;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

function expectErrorResult(r: CCSessionResult | "HANG"): void {
  expect(r).not.toBe("HANG");
  const result = r as CCSessionResult;
  expect(result.success).toBe(false);
  expect(result.exitCode).not.toBe(0);
}

/** Spawn with an `error` listener already attached, as dispatch-handler and agent-team do. */
function startWithListener(s: CCSession): Error[] {
  const seen: Error[] = [];
  s.on("error", (e: Error) => seen.push(e));
  s.start();
  return seen;
}

describe("CCSession — a spawn that throws ends with an error, never pending", () => {
  test("ENOENT: no claude on PATH", async () => {
    process.env.PATH = emptyBin;
    const s = new CCSession({ prompt: "hi", channel: "test", timeoutMs: 60_000 });
    const seen = startWithListener(s);
    expectErrorResult(await bounded(s.wait()));
    expect(seen).toHaveLength(1); // wait() did not re-run start()
  }, 10_000);

  test("EACCES: claude present but not executable", async () => {
    process.env.PATH = noExecBin;
    const s = new CCSession({ prompt: "hi", channel: "test", timeoutMs: 60_000 });
    startWithListener(s);
    expectErrorResult(await bounded(s.wait()));
  }, 10_000);

  test("a fail-closed refusal thrown from spawn", async () => {
    const spy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("[cc-session] EBH-4 egress proxy failed to start under mode \"enforce\" — refusing to launch (fail-closed)");
    });
    try {
      const s = new CCSession({ prompt: "hi", channel: "test", timeoutMs: 60_000 });
      startWithListener(s);
      const r = await bounded(s.wait());
      expectErrorResult(r);
      expect((r as CCSessionResult).stderr).toMatch(/fail-closed/);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);

  test("wait() called later (after an await) still settles", async () => {
    process.env.PATH = emptyBin;
    const s = new CCSession({ prompt: "hi", channel: "test", timeoutMs: 60_000 });
    startWithListener(s);
    await new Promise((r) => setTimeout(r, 50));
    expectErrorResult(await bounded(s.wait()));
  }, 10_000);

  test("no listener: start() still throws the spawn error (unchanged), and a later wait() settles", async () => {
    process.env.PATH = emptyBin;
    const s = new CCSession({ prompt: "hi", channel: "test", timeoutMs: 60_000 });
    expect(() => s.start()).toThrow();
    expectErrorResult(await bounded(s.wait()));
  }, 10_000);
});

describe("ClaudeCodeHarness — a spawn failure yields a FAILED terminal envelope", () => {
  test("ENOENT: the dispatch ends with dispatch.task.failed carrying the spawn error", async () => {
    process.env.PATH = emptyBin;
    const h = new ClaudeCodeHarness({
      source: { principal: "metafactory", agent: "cortex", instance: "local" },
    });
    const drain = async (): Promise<MyelinEnvelope[]> => {
      const out: MyelinEnvelope[] = [];
      for await (const env of h.dispatch({
        prompt: "hi",
        tools: { allow: [] },
        context: [],
        agent: { id: "cortex", displayName: "Cortex" },
        requestId: "22222222-2222-4222-8222-222222222222",
        timeoutMs: 60_000,
      })) out.push(env);
      return out;
    };
    const r = await bounded(drain());
    expect(r).not.toBe("HANG");
    const envelopes = r as MyelinEnvelope[];
    expect(envelopes.map((e) => e.type)).toEqual(["dispatch.task.started", "dispatch.task.failed"]);
    expect(JSON.stringify(envelopes[1]?.payload)).toMatch(/ENOENT|not found|No such file|claude/i);
  }, 10_000);
});
