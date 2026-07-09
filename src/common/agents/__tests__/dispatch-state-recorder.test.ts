/**
 * cortex#1720 S3 — unit tests for the dispatch-lifecycle state recorder.
 *
 * Covers the enqueue→claim on accept, resolve on terminal, the in-flight
 * correlation→work_item map, and the SOFT-SKIP / NON-FATAL guarantees:
 *   - accept spawns `errands.ts enqueue` (payload = QUEUE METADATA ONLY, no
 *     prompt/message body) then `errands.ts claim`, with the standard env
 *     (MF_AGENT_NAME / MF_HOST / MF_INSTANCE_DIR);
 *   - a completed dispatch spawns `resolve --status=done`; a failed one
 *     `resolve --status=failed`, targeting the id `enqueue` returned;
 *   - a resolve for an id we never enqueued is a logged no-op (never fabricates);
 *   - a missing bundle script SOFT-SKIPS the whole accept (no spawn), and the
 *     paired resolve is itself a logged no-op;
 *   - a non-zero exit / spawn error on any subcommand logs one line and NEVER
 *     throws (the dispatch hot path must not see a state failure).
 *
 * No real `bun` subprocess, no `~/.config` touch — every path is driven through
 * the `errandsScript` / `spawn` / `log` test seams.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  SubprocessDispatchStateRecorder,
  type RecorderSpawn,
  type RecorderSpawnResult,
} from "../dispatch-state-recorder";

const AGENT = { id: "luna" };

let root: string;
let errandsScript: string;
let dashboardScript: string;
let instanceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-recorder-"));
  errandsScript = join(root, "errands.ts");
  // cortex#1720 S4a — the dashboard.ts sibling. Written by default so the
  // regen path is exercised; individual tests point at a missing path to drive
  // the soft-skip branch.
  dashboardScript = join(root, "dashboard.ts");
  instanceDir = join(root, "agents", "luna");
  writeFileSync(errandsScript, "// stub errands.ts\n");
  writeFileSync(dashboardScript, "// stub dashboard.ts\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface SpawnCall {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** A recording spawn that returns a scripted result per subcommand. */
function recordingSpawn(
  results: Record<string, RecorderSpawnResult>,
): { spawn: RecorderSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: RecorderSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    // args = [errandsScript, subcommand, ...]. Route on the subcommand.
    const sub = args[1] ?? "";
    return results[sub] ?? { status: 0 };
  };
  return { spawn, calls };
}

/** The `{ inserted, row }` shape the real `errands.ts enqueue` prints. */
function enqueueStdout(id: string): string {
  return JSON.stringify({ inserted: true, row: { id, kind: "k", status: "pending" } });
}

describe("SubprocessDispatchStateRecorder — accept: enqueue + claim", () => {
  test("spawns enqueue then claim with the standard env + payload discipline", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-1") },
      claim: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({
      correlationId: "corr-1",
      capability: "soc.review",
      subject: "local.jc.stack.brain.soc.review",
      acceptedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(calls.length).toBe(2);

    // 1) enqueue --id corr-1 --kind soc.review --payload <json> --owner luna
    const enqueue = calls[0]!;
    expect(enqueue.cmd).toBe("bun");
    expect(enqueue.args[1]).toBe("enqueue");
    expect(enqueue.args).toContain("--id");
    expect(enqueue.args[enqueue.args.indexOf("--id") + 1]).toBe("corr-1");
    expect(enqueue.args[enqueue.args.indexOf("--kind") + 1]).toBe("soc.review");
    expect(enqueue.args[enqueue.args.indexOf("--owner") + 1]).toBe("luna");

    // Payload is QUEUE METADATA ONLY — correlation id + subject + capability +
    // timestamp. NEVER a prompt / message body (§3).
    const payloadStr = enqueue.args[enqueue.args.indexOf("--payload") + 1]!;
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    expect(payload).toEqual({
      correlation_id: "corr-1",
      subject: "local.jc.stack.brain.soc.review",
      capability: "soc.review",
      accepted_at: "2026-07-09T00:00:00.000Z",
    });
    // Belt-and-braces: no content-ish keys leaked into the payload.
    for (const forbidden of ["text", "prompt", "message", "scenario", "content", "payload"]) {
      expect(forbidden in payload).toBe(false);
    }

    // Standard env contract, exactly as S1/S2.
    expect(enqueue.env?.MF_AGENT_NAME).toBe("luna");
    expect(enqueue.env?.MF_HOST).toBe("cortex");
    expect(enqueue.env?.MF_INSTANCE_DIR).toBe(instanceDir);

    // 2) claim --id corr-1 --owner luna (the id echoed by enqueue's row).
    const claim = calls[1]!;
    expect(claim.args[1]).toBe("claim");
    expect(claim.args[claim.args.indexOf("--id") + 1]).toBe("corr-1");
    expect(claim.args[claim.args.indexOf("--owner") + 1]).toBe("luna");
  });

  test("claims the work_item id echoed by enqueue's row, not the correlation id", () => {
    // The bundle echoes `--id`, so row.id === correlationId here; but the
    // recorder reads it BACK from the row to stay honest to the bundle's id.
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("bundle-id-xyz") },
      claim: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({
      correlationId: "corr-2",
      capability: "c",
      subject: "s",
      acceptedAt: "t",
    });

    const claim = calls[1]!;
    expect(claim.args[claim.args.indexOf("--id") + 1]).toBe("bundle-id-xyz");
  });
});

describe("SubprocessDispatchStateRecorder — terminal: resolve", () => {
  test("completed → resolve --status=done targeting the enqueued id", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-3") },
      claim: { status: 0 },
      resolve: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-3", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-3", "done");

    const resolve = calls.find((c) => c.args[1] === "resolve")!;
    expect(resolve).toBeDefined();
    expect(resolve.args[resolve.args.indexOf("--id") + 1]).toBe("corr-3");
    expect(resolve.args[resolve.args.indexOf("--status") + 1]).toBe("done");
    expect(resolve.env?.MF_INSTANCE_DIR).toBe(instanceDir);
  });

  test("failed → resolve --status=failed", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-4") },
      claim: { status: 0 },
      resolve: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-4", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-4", "failed");

    const resolve = calls.find((c) => c.args[1] === "resolve")!;
    expect(resolve.args[resolve.args.indexOf("--status") + 1]).toBe("failed");
  });

  test("resolve for an id we never enqueued is a logged no-op (never fabricates)", () => {
    const { spawn, calls } = recordingSpawn({ resolve: { status: 0 } });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: (l) => logs.push(l),
    });

    recorder.onDispatchResolved("unknown-corr", "done");

    // No resolve spawned — we only resolve ids we created.
    expect(calls.length).toBe(0);
    expect(logs.join("")).toMatch(/no-work-item/);
  });

  test("the in-flight id is cleared after resolve (a second resolve is a no-op)", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-5") },
      claim: { status: 0 },
      resolve: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-5", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-5", "done");
    const afterFirst = calls.filter((c) => c.args[1] === "resolve").length;
    recorder.onDispatchResolved("corr-5", "done"); // second call — no row left.
    const afterSecond = calls.filter((c) => c.args[1] === "resolve").length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // unchanged — no duplicate resolve.
  });
});

describe("SubprocessDispatchStateRecorder — soft-skip + non-fatal", () => {
  test("missing bundle script → accept SOFT-SKIPS (no spawn), resolve is a no-op", () => {
    const { spawn, calls } = recordingSpawn({});
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript: join(root, "does-not-exist.ts"),
      spawn,
      log: (l) => logs.push(l),
    });

    expect(() =>
      recorder.onDispatchAccepted({ correlationId: "c", capability: "k", subject: "s", acceptedAt: "t" }),
    ).not.toThrow();
    expect(calls.length).toBe(0);
    expect(logs.join("")).toMatch(/script-absent/);

    // No id landed → resolve is a logged no-op, never a spawn.
    recorder.onDispatchResolved("c", "done");
    expect(calls.length).toBe(0);
  });

  test("enqueue non-zero exit → logged, claim NOT attempted, never throws", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 1, stderr: "boom" },
    });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: (l) => logs.push(l),
    });

    expect(() =>
      recorder.onDispatchAccepted({ correlationId: "c", capability: "k", subject: "s", acceptedAt: "t" }),
    ).not.toThrow();

    // enqueue failed → NO claim spawned.
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[1]).toBe("enqueue");
    expect(logs.join("")).toMatch(/enqueue.*FAILED/);
  });

  test("spawn error on resolve → logged, never throws", () => {
    const { spawn } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-6") },
      claim: { status: 0 },
      resolve: { status: null, error: new Error("ENOENT bun") },
    });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: (l) => logs.push(l),
    });

    recorder.onDispatchAccepted({ correlationId: "corr-6", capability: "c", subject: "s", acceptedAt: "t" });
    expect(() => recorder.onDispatchResolved("corr-6", "done")).not.toThrow();
    expect(logs.join("")).toMatch(/resolve.*FAILED.*spawn-error/);
  });

  test("a throwing spawn seam is caught (belt-and-braces), never propagates", () => {
    const throwingSpawn: RecorderSpawn = () => {
      throw new Error("spawn blew up");
    };
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn: throwingSpawn,
      log: (l) => logs.push(l),
    });

    expect(() =>
      recorder.onDispatchAccepted({ correlationId: "c", capability: "k", subject: "s", acceptedAt: "t" }),
    ).not.toThrow();
    expect(logs.join("")).toMatch(/spawn threw/);
  });

  test("MF_AGENT_STATE_ERRANDS_SCRIPT is read PER CALL, not frozen at import", () => {
    // A recorder with NO errandsScript opt resolves the path from the env at
    // CONSTRUCTION via defaultErrandsScript(); set the env (to a real file)
    // after module import and confirm it's honoured (proves it's not a frozen
    // module const).
    const lateScript = join(root, "late-errands.ts");
    writeFileSync(lateScript, "// stub\n");
    const savedEnv = process.env.MF_AGENT_STATE_ERRANDS_SCRIPT;
    process.env.MF_AGENT_STATE_ERRANDS_SCRIPT = lateScript;
    let sawScript: string | undefined;
    const spawn: RecorderSpawn = (_cmd, args) => {
      sawScript = args[0];
      return { status: 0, stdout: enqueueStdout("corr-env") };
    };
    try {
      const recorder = new SubprocessDispatchStateRecorder(AGENT, {
        instanceDir,
        spawn,
        log: () => {},
      });
      recorder.onDispatchAccepted({ correlationId: "corr-env", capability: "c", subject: "s", acceptedAt: "t" });
      expect(sawScript).toBe(lateScript);
    } finally {
      if (savedEnv !== undefined) process.env.MF_AGENT_STATE_ERRANDS_SCRIPT = savedEnv;
      else delete process.env.MF_AGENT_STATE_ERRANDS_SCRIPT;
    }
  });
});

// ===========================================================================
// cortex#1720 S4a — RegenerateDashboard on terminal resolve.
// ===========================================================================
describe("SubprocessDispatchStateRecorder — S4a: dashboard regen on resolve", () => {
  /** The `regen` spawn, if one fired. */
  function regenCall(calls: SpawnCall[]): SpawnCall | undefined {
    return calls.find((c) => c.args[1] === "regen");
  }

  test("completed resolve ALSO regenerates the dashboard (regen subcommand, std env)", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d1") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d1", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-d1", "done");

    const regen = regenCall(calls);
    expect(regen).toBeDefined();
    // Invokes `bun <dashboardScript> regen` — the REQUIRED subcommand (agent-state#6).
    expect(regen!.cmd).toBe("bun");
    expect(regen!.args[0]).toBe(dashboardScript);
    expect(regen!.args[1]).toBe("regen");
    // Standard bundle env, same instance dir as the errands calls.
    expect(regen!.env?.MF_AGENT_NAME).toBe(AGENT.id);
    expect(regen!.env?.MF_HOST).toBe("cortex");
    expect(regen!.env?.MF_INSTANCE_DIR).toBe(instanceDir);
    // Ordering: regen fires AFTER the resolve (it reflects the transition).
    const idxResolve = calls.findIndex((c) => c.args[1] === "resolve");
    const idxRegen = calls.findIndex((c) => c.args[1] === "regen");
    expect(idxRegen).toBeGreaterThan(idxResolve);
  });

  test("failed resolve ALSO regenerates the dashboard", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d2") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d2", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-d2", "failed");

    expect(regenCall(calls)).toBeDefined();
  });

  test("a no-work-item resolve does NOT regenerate (no transition, no regen)", () => {
    const { spawn, calls } = recordingSpawn({ regen: { status: 0 } });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchResolved("never-enqueued", "done");

    expect(calls.length).toBe(0); // no resolve, and therefore no regen.
  });

  test("dashboard script ABSENT → regen SOFT-SKIPS (no regen spawn), resolve still runs, no throw", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d3") },
      claim: { status: 0 },
      resolve: { status: 0 },
    });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript: join(root, "no-dashboard.ts"), // missing
      spawn,
      log: (l) => logs.push(l),
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d3", capability: "c", subject: "s", acceptedAt: "t" });
    expect(() => recorder.onDispatchResolved("corr-d3", "done")).not.toThrow();

    // resolve fired, regen did NOT (soft-skip logged).
    expect(calls.find((c) => c.args[1] === "resolve")).toBeDefined();
    expect(regenCall(calls)).toBeUndefined();
    expect(logs.join("")).toMatch(/dashboard regen SKIPPED.*script-absent/);
  });

  test("regen non-zero exit → logged FAILED, never throws, resolve unaffected", () => {
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d4") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: 2, stderr: "usage: dashboard.ts regen" },
    });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript,
      spawn,
      log: (l) => logs.push(l),
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d4", capability: "c", subject: "s", acceptedAt: "t" });
    expect(() => recorder.onDispatchResolved("corr-d4", "done")).not.toThrow();
    expect(calls.find((c) => c.args[1] === "resolve")).toBeDefined();
    expect(logs.join("")).toMatch(/dashboard regen FAILED.*nonzero-exit/);
  });

  test("regen spawn error → logged FAILED, never throws", () => {
    const { spawn } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d5") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: null, error: new Error("ENOENT bun") },
    });
    const logs: string[] = [];
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      dashboardScript,
      spawn,
      log: (l) => logs.push(l),
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d5", capability: "c", subject: "s", acceptedAt: "t" });
    expect(() => recorder.onDispatchResolved("corr-d5", "done")).not.toThrow();
    expect(logs.join("")).toMatch(/dashboard regen FAILED.*spawn-error/);
  });

  test("dashboard script defaults to the errands.ts SIBLING when not overridden", () => {
    // No `dashboardScript` opt → derived as dirname(errandsScript)/dashboard.ts,
    // which beforeEach wrote — so regen fires and targets exactly that sibling.
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d6") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: 0 },
    });
    const recorder = new SubprocessDispatchStateRecorder(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    recorder.onDispatchAccepted({ correlationId: "corr-d6", capability: "c", subject: "s", acceptedAt: "t" });
    recorder.onDispatchResolved("corr-d6", "done");

    expect(regenCall(calls)?.args[0]).toBe(dashboardScript);
  });

  test("MF_AGENT_STATE_DASHBOARD_SCRIPT overrides the derived sibling", () => {
    const overrideScript = join(root, "override-dashboard.ts");
    writeFileSync(overrideScript, "// stub\n");
    const saved = process.env.MF_AGENT_STATE_DASHBOARD_SCRIPT;
    process.env.MF_AGENT_STATE_DASHBOARD_SCRIPT = overrideScript;
    const { spawn, calls } = recordingSpawn({
      enqueue: { status: 0, stdout: enqueueStdout("corr-d7") },
      claim: { status: 0 },
      resolve: { status: 0 },
      regen: { status: 0 },
    });
    try {
      const recorder = new SubprocessDispatchStateRecorder(AGENT, {
        instanceDir,
        errandsScript,
        spawn,
        log: () => {},
      });
      recorder.onDispatchAccepted({ correlationId: "corr-d7", capability: "c", subject: "s", acceptedAt: "t" });
      recorder.onDispatchResolved("corr-d7", "done");
      expect(regenCall(calls)?.args[0]).toBe(overrideScript);
    } finally {
      if (saved !== undefined) process.env.MF_AGENT_STATE_DASHBOARD_SCRIPT = saved;
      else delete process.env.MF_AGENT_STATE_DASHBOARD_SCRIPT;
    }
  });
});
