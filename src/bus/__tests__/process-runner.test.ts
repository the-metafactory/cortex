/**
 * Generic `process` reflex code-handler tests.
 *
 * Axes:
 *  1. resolveArgv — fills declared params from payload/default, type-checks
 *     (int / string-enum), substitutes `{token}`; rejects missing/typed-wrong.
 *  2. loadProcessSpec — loads + validates a spec file; rejects a traversal
 *     name, a name/filename mismatch, and an undeclared argv token.
 *  3. createProcessRunner handler — exit 0 → started+completed; non-zero /
 *     spawn-throw / watchdog timeout → failed + THROWS (re-fireable);
 *     no-process-name / bad-spec → failed + RETURNS (deterministic, no throw);
 *     the spec name comes from target.process, NEVER the payload.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { FiredActivation } from "../reflex-activation-listener";
import type { ReflexTarget } from "../../common/types/cortex-config";
import {
  createProcessRunner,
  loadProcessSpec,
  resolveArgv,
  type ProcessSpec,
  type Spawn,
} from "../process-runner";

const SOURCE = { principal: "jc", agent: "cortex", instance: "local" };

const SPEC: ProcessSpec = {
  name: "build-journal",
  cwd: "/abs/pulse",
  argv: ["bun", "examples/build-journal/run-journal.ts", "--llm", "--days", "{days}", "--post", "--deploy"],
  timeout_ms: 900_000,
  detach: false,
  params: { days: { type: "int", default: 7 } },
};

function target(over: Partial<ReflexTarget> = {}): ReflexTarget {
  return {
    target: "@jc/build-journal",
    capability: "process.run",
    assistant: "cortex",
    handler: "process",
    process: "build-journal",
    ...over,
  };
}

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

function fakeSpawn(opts: { exitCode?: number; throwOnSpawn?: boolean; hang?: boolean; ignoreSigterm?: boolean } = {}) {
  const calls: { cmd: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const signals: string[] = [];
  let killed = false;
  const spawn: Spawn = (cmd, o) => {
    calls.push({ cmd, cwd: o.cwd, ...(o.env !== undefined && { env: o.env }) });
    if (opts.throwOnSpawn === true) throw new Error("spawn boom");
    let resolveExit!: (n: number) => void;
    const exited = new Promise<number>((r) => { resolveExit = r; });
    // ignoreSigterm implies the run is in-flight until SIGKILL.
    if (opts.hang !== true && opts.ignoreSigterm !== true) resolveExit(opts.exitCode ?? 0);
    return {
      exited,
      kill: (sig) => {
        signals.push(sig ?? "SIGTERM");
        if (opts.ignoreSigterm === true && (sig ?? "SIGTERM") !== "SIGKILL") return; // child traps SIGTERM
        killed = true;
        resolveExit(opts.exitCode ?? 143);
      },
    };
  };
  return { spawn, calls, signals, wasKilled: () => killed };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

const events = (published: Envelope[]) =>
  published.filter((e) => e.type === "system.bus.process").map((e) => e.payload);
const outcomes = (published: Envelope[]) => events(published).map((p) => p.outcome);
const last = (published: Envelope[]) => { const e = events(published); return e[e.length - 1]; };

// ===========================================================================

describe("resolveArgv", () => {
  test("substitutes a declared int param (payload over default)", () => {
    expect(resolveArgv(SPEC, { days: 4 })).toEqual([
      "bun", "examples/build-journal/run-journal.ts", "--llm", "--days", "4", "--post", "--deploy",
    ]);
  });
  test("falls back to the default when payload omits the param", () => {
    expect(resolveArgv(SPEC, {})[4]).toBe("7");
  });
  test("rejects a non-integer int param (no argv injection)", () => {
    expect(() => resolveArgv(SPEC, { days: "--rm-rf" })).toThrow(/integer/);
    expect(() => resolveArgv(SPEC, { days: 1.5 })).toThrow(/integer/);
  });
  test("string param honours an enum", () => {
    const s: ProcessSpec = { name: "x", cwd: "/c", argv: ["echo", "{mode}"], timeout_ms: 1000, detach: false, params: { mode: { type: "string", enum: ["a", "b"] } } };
    expect(resolveArgv(s, { mode: "a" })).toEqual(["echo", "a"]);
    expect(() => resolveArgv(s, { mode: "c" })).toThrow(/one of/);
  });
  test("missing required param (no default) throws", () => {
    const s: ProcessSpec = { name: "x", cwd: "/c", argv: ["echo", "{v}"], timeout_ms: 1000, detach: false, params: { v: { type: "string" } } };
    expect(() => resolveArgv(s, {})).toThrow(/required/);
  });
});

describe("loadProcessSpec", () => {
  let dir = "";
  const write = (name: string, body: string) => writeFileSync(join(dir, `${name}.yaml`), body);
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "cortex-processes-")); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test("loads + validates a well-formed spec", async () => {
    write("good", "name: good\ncwd: /abs\nargv: [bun, run.ts, --days, \"{days}\"]\nparams:\n  days: { type: int, default: 7 }\n");
    const spec = await loadProcessSpec(dir, "good");
    expect(spec.cwd).toBe("/abs");
    expect(spec.timeout_ms).toBeGreaterThan(0); // schema default applied
  });
  test("rejects a traversal / non-segment name", async () => {
    await expect(loadProcessSpec(dir, "../etc/passwd")).rejects.toThrow(/process name/);
  });
  test("rejects a relative cwd", async () => {
    write("relcwd", "name: relcwd\ncwd: ./rel\nargv: [echo, hi]\n");
    await expect(loadProcessSpec(dir, "relcwd")).rejects.toThrow(/absolute/);
  });
  test("rejects a name/filename mismatch", async () => {
    write("mism", "name: other\ncwd: /abs\nargv: [echo, hi]\n");
    await expect(loadProcessSpec(dir, "mism")).rejects.toThrow(/must match filename/);
  });
  test("rejects an undeclared argv token (fail-closed)", async () => {
    write("badtok", "name: badtok\ncwd: /abs\nargv: [echo, \"{nope}\"]\n");
    await expect(loadProcessSpec(dir, "badtok")).rejects.toThrow(/no declared param/);
  });
  test("rejects `enum` on an int param (fail-closed)", async () => {
    write("intenum", "name: intenum\ncwd: /abs\nargv: [echo, \"{n}\"]\nparams:\n  n: { type: int, enum: [\"1\", \"2\"] }\n");
    await expect(loadProcessSpec(dir, "intenum")).rejects.toThrow(/enum/);
  });
  test("rejects an unconstrained string param (needs enum or freeform)", async () => {
    write("freestr", "name: freestr\ncwd: /abs\nargv: [echo, \"{s}\"]\nparams:\n  s: { type: string }\n");
    await expect(loadProcessSpec(dir, "freestr")).rejects.toThrow(/enum.*freeform|freeform/);
  });
  test("accepts an explicitly free-form string param", async () => {
    write("freeok", "name: freeok\ncwd: /abs\nargv: [echo, \"{s}\"]\nparams:\n  s: { type: string, freeform: true }\n");
    expect((await loadProcessSpec(dir, "freeok")).params.s!.freeform).toBe(true);
  });
  test("rejects a non-integer default on an int param", async () => {
    write("badint", "name: badint\ncwd: /abs\nargv: [echo, \"{n}\"]\nparams:\n  n: { type: int, default: 1.5 }\n");
    await expect(loadProcessSpec(dir, "badint")).rejects.toThrow(/default.*integer/);
  });
  test("rejects a timeout_ms over the ack_wait ceiling", async () => {
    write("slow", "name: slow\ncwd: /abs\nargv: [echo, hi]\ntimeout_ms: 1500000\n"); // 25 min > 19 min cap
    await expect(loadProcessSpec(dir, "slow")).rejects.toThrow(/ack_wait|timeout_ms/);
  });
  test("the shipped examples/processes/build-journal.yaml is a valid spec", async () => {
    const examplesDir = join(import.meta.dir, "..", "..", "..", "examples", "processes");
    const spec = await loadProcessSpec(examplesDir, "build-journal");
    expect(spec.detach).toBe(true);
    expect(spec.params.days!.type).toBe("int");
  });
});

describe("createProcessRunner", () => {
  test("exit 0 → started+completed, no throw, spawned with spec cwd + resolved argv", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ exitCode: 0 });
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => SPEC, spawn: sp.spawn });

    await handler(activation({ days: 7 }), target());
    await flush();

    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]!.cwd).toBe("/abs/pulse");
    expect(sp.calls[0]!.cmd).toContain("--days");
    expect(sp.calls[0]!.cmd).toContain("7");
    expect(outcomes(published)).toEqual(["started", "completed"]);
    expect(last(published)!.process).toBe("build-journal");
  });

  test("env allow-list → child gets only the listed vars (omitted → inherit)", async () => {
    globalThis.process.env.PR_TEST_ALLOWED = "yes";
    globalThis.process.env.PR_TEST_SECRET = "nope";
    // allow-list set → restricted env
    const sp1 = fakeSpawn({ exitCode: 0 });
    const allowSpec: ProcessSpec = { ...SPEC, env: ["PR_TEST_ALLOWED"] };
    await createProcessRunner({ runtime: fakeRuntime().runtime, source: SOURCE, processesDir: "/x", loadSpec: () => allowSpec, spawn: sp1.spawn })(activation({}), target());
    await flush();
    expect(sp1.calls[0]!.env).toEqual({ PR_TEST_ALLOWED: "yes" }); // PR_TEST_SECRET excluded
    // omitted → inherit (no env passed to spawn)
    const sp2 = fakeSpawn({ exitCode: 0 });
    await createProcessRunner({ runtime: fakeRuntime().runtime, source: SOURCE, processesDir: "/x", loadSpec: () => SPEC, spawn: sp2.spawn })(activation({}), target());
    await flush();
    expect(sp2.calls[0]!.env).toBeUndefined();
    delete globalThis.process.env.PR_TEST_ALLOWED;
    delete globalThis.process.env.PR_TEST_SECRET;
  });

  test("the spec name comes from target.process, NOT the payload", async () => {
    const { runtime } = fakeRuntime();
    const seen: string[] = [];
    const handler = createProcessRunner({
      runtime, source: SOURCE, processesDir: "/unused",
      loadSpec: (name) => { seen.push(name); return SPEC; },
      spawn: fakeSpawn({ exitCode: 0 }).spawn,
    });
    // payload tries to smuggle a different process name — must be ignored.
    await handler(activation({ days: 7, process: "evil", argv: ["rm", "-rf", "/"] }), target({ process: "build-journal" }));
    await flush();
    expect(seen).toEqual(["build-journal"]);
  });

  test("non-zero exit → failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => SPEC, spawn: fakeSpawn({ exitCode: 2 }).spawn });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(threw).toBe(true);
    expect(outcomes(published)).toEqual(["started", "failed"]);
    expect(last(published)!.reason).toBe("exit-2");
  });

  test("watchdog timeout → kills + failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ hang: true });
    const fastSpec: ProcessSpec = { ...SPEC, timeout_ms: 10 };
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => fastSpec, spawn: sp.spawn });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(threw).toBe(true);
    expect(sp.wasKilled()).toBe(true);
    expect(String(last(published)!.reason)).toContain("timeout");
  });

  test("spawn throws → failed + throws", async () => {
    const { runtime, published } = fakeRuntime();
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => SPEC, spawn: fakeSpawn({ throwOnSpawn: true }).spawn });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(threw).toBe(true);
    expect(String(last(published)!.reason)).toContain("spawn");
  });

  test("watchdog escalates SIGTERM → SIGKILL when the child ignores SIGTERM", async () => {
    const { runtime, published } = fakeRuntime();
    const sp = fakeSpawn({ ignoreSigterm: true });
    const fastSpec: ProcessSpec = { ...SPEC, timeout_ms: 10 };
    const handler = createProcessRunner({
      runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => fastSpec, spawn: sp.spawn, sigkillGraceMs: 10,
    });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(sp.signals).toContain("SIGKILL");   // escalated past the ignored SIGTERM
    expect(threw).toBe(true);
    expect(String(last(published)!.reason)).toContain("timeout");
  });

  test("detach: handler returns before the run finishes; completes in background", async () => {
    const { runtime, published } = fakeRuntime();
    const detachSpec: ProcessSpec = { ...SPEC, detach: true };
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => detachSpec, spawn: fakeSpawn({ exitCode: 0 }).spawn });
    await handler(activation({}), target());   // returns without awaiting the run
    await flush();                             // background supervise settles
    expect(outcomes(published)).toEqual(["started", "completed"]);
  });

  test("detach + non-zero exit → failed visibility, NO throw (can't re-fire)", async () => {
    const { runtime, published } = fakeRuntime();
    const detachSpec: ProcessSpec = { ...SPEC, detach: true };
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => detachSpec, spawn: fakeSpawn({ exitCode: 1 }).spawn });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(threw).toBe(false);
    expect(outcomes(published)).toEqual(["started", "failed"]);
  });

  test("no process name → failed + RETURNS (deterministic, no throw, no started)", async () => {
    const { runtime, published } = fakeRuntime();
    const handler = createProcessRunner({ runtime, source: SOURCE, processesDir: "/unused", loadSpec: () => SPEC, spawn: fakeSpawn().spawn });
    await handler(activation({}), target({ process: undefined }));
    await flush();
    expect(outcomes(published)).toEqual(["failed"]);
    expect(last(published)!.reason).toBe("no-process-name");
  });

  test("bad spec → failed + RETURNS (deterministic, no throw)", async () => {
    const { runtime, published } = fakeRuntime();
    const handler = createProcessRunner({
      runtime, source: SOURCE, processesDir: "/unused",
      loadSpec: () => { throw new Error("ENOENT"); },
      spawn: fakeSpawn().spawn,
    });
    let threw = false;
    try { await handler(activation({}), target()); } catch { threw = true; }
    await flush();
    expect(threw).toBe(false);
    expect(outcomes(published)).toEqual(["failed"]);
    expect(String(last(published)!.reason)).toContain("spec:");
  });
});
