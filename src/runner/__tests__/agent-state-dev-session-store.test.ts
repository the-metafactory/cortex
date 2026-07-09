/**
 * cortex#1720 S4b — unit tests for the AgentState-backed warm-session store.
 *
 * `AgentStateDevSessionStore` retires the file-backed `dev-session-store`
 * bridge onto agent-state's KV surface (`errands.ts list`/`enqueue`/`annotate`)
 * WITHOUT changing the `DevSessionStore` seam the dev-consumer depends on.
 *
 * The invariants under test (all seam-driven — no real `bun`, no `~/.config`):
 *   - rehydrate-on-start: ONE `list`-style pass at construction fills the
 *     in-memory map from work_items whose notes carry a `session_id`;
 *   - hot read never spawns: `get(chainId)` is a pure `Map.get` — zero spawns
 *     after construction;
 *   - write off-path: `set()` updates the map synchronously (a following `get`
 *     sees it before any subprocess), then fire-and-forget `enqueue`(idempotent)
 *     + `annotate --notes-json {"session_id":…}` targeting the chainId row;
 *   - failure non-fatal: a spawn error / non-zero exit / throw on the write path
 *     logs one line and never rejects; the map still holds the value;
 *   - bundle-missing fallback lives in the factory (`createDevSessionStore`):
 *     a stateful agent with an absent bundle script → FileDevSessionStore, one
 *     log line; a stateless agent → FileDevSessionStore with no bundle probe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  AgentStateDevSessionStore,
  createDevSessionStore,
  DEV_SESSION_WORK_ITEM_KIND,
} from "../agent-state-dev-session-store";
import { FileDevSessionStore } from "../dev-session-store";
import type { AgentStateSpawn, AgentStateSpawnResult } from "../../common/agents/agent-state-spawn";

const AGENT = { id: "coder", state: { blueprint: "dev", version: "1" } };

let root: string;
let errandsScript: string;
let instanceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-devsession-"));
  errandsScript = join(root, "errands.ts");
  instanceDir = join(root, "agents", "coder");
  writeFileSync(errandsScript, "// stub errands.ts\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface SpawnCall {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * A recording spawn that returns a scripted result per subcommand. `args` is
 * `[errandsScript, subcommand, ...]`, so we route on `args[1]`.
 */
function recordingSpawn(results: Record<string, AgentStateSpawnResult>): {
  spawn: AgentStateSpawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: AgentStateSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const sub = args[1] ?? "";
    return results[sub] ?? { status: 0, stdout: "" };
  };
  return { spawn, calls };
}

/** One `list` row (a work_item as `errands.ts list` prints it, JSON-per-line). */
function listRow(id: string, notes: Record<string, unknown> | null): string {
  return JSON.stringify({
    id,
    kind: DEV_SESSION_WORK_ITEM_KIND,
    payload: "{}",
    status: "pending",
    owner_agent: "coder",
    notes: notes === null ? null : JSON.stringify(notes),
  });
}

/** The `{ inserted, row }` an `enqueue` prints; the `row` from `annotate`. */
function enqueueStdout(id: string): string {
  return JSON.stringify({ inserted: true, row: { id, kind: DEV_SESSION_WORK_ITEM_KIND } });
}

/** Drain the fire-and-forget write microtask so assertions see the spawn. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("AgentStateDevSessionStore — rehydrate on start", () => {
  test("ONE list pass fills the map from work_items whose notes carry session_id", async () => {
    const { spawn, calls } = recordingSpawn({
      list: {
        status: 0,
        stdout:
          listRow("chain-a", { session_id: "ccs-a" }) +
          "\n" +
          listRow("chain-b", { session_id: "ccs-b" }) +
          "\n" +
          // a row with no session_id must NOT land in the map
          listRow("chain-c", { note: "unrelated" }) +
          "\n",
      },
    });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });

    // Exactly one subprocess (the rehydrate `list`), and it is a `list`.
    expect(calls.length).toBe(1);
    expect(calls[0]?.args[1]).toBe("list");
    // Scoped to the dev-session kind + standard env.
    expect(calls[0]?.args).toContain("--kind");
    expect(calls[0]?.args).toContain(DEV_SESSION_WORK_ITEM_KIND);
    expect(calls[0]?.env?.MF_AGENT_NAME).toBe("coder");
    expect(calls[0]?.env?.MF_INSTANCE_DIR).toBe(instanceDir);

    expect(await store.get("chain-a")).toBe("ccs-a");
    expect(await store.get("chain-b")).toBe("ccs-b");
    expect(await store.get("chain-c")).toBeUndefined();
  });

  test("a rehydrate list failure is non-fatal — an empty (cold) map, one log line", async () => {
    const logs: string[] = [];
    const { spawn } = recordingSpawn({ list: { status: 1, stderr: "boom" } });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: (l) => logs.push(l),
    });
    expect(await store.get("chain-a")).toBeUndefined();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("rehydrate");
  });
});

describe("AgentStateDevSessionStore — hot read never spawns", () => {
  test("get() after construction issues ZERO subprocesses", async () => {
    const { spawn, calls } = recordingSpawn({
      list: { status: 0, stdout: listRow("chain-a", { session_id: "ccs-a" }) + "\n" },
    });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });
    const spawnsAfterCtor = calls.length; // the single rehydrate list

    await store.get("chain-a");
    await store.get("missing");
    await store.get("chain-a");

    // Not one extra spawn for any read.
    expect(calls.length).toBe(spawnsAfterCtor);
  });
});

describe("AgentStateDevSessionStore — set() writes off-path", () => {
  test("map updates synchronously; enqueue+annotate fire AFTER, targeting the chainId row", async () => {
    const { spawn, calls } = recordingSpawn({
      list: { status: 0, stdout: "" },
      enqueue: { status: 0, stdout: enqueueStdout("chain-x") },
      annotate: { status: 0, stdout: "" },
    });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });
    const beforeSet = calls.length;

    await store.set("chain-x", "ccs-x");

    // The awaited `set` resolves with the value already in the map: a following
    // get sees it WITHOUT waiting on any subprocess (the write is off-path).
    expect(await store.get("chain-x")).toBe("ccs-x");

    await flush();

    const writeCalls = calls.slice(beforeSet).map((c) => c.args[1]);
    expect(writeCalls).toEqual(["enqueue", "annotate"]);

    const annotate = calls.find((c) => c.args[1] === "annotate");
    // annotate --id chain-x --notes-json {"session_id":"ccs-x"}
    expect(annotate?.args).toContain("--id");
    expect(annotate?.args).toContain("chain-x");
    const notesIdx = annotate?.args.indexOf("--notes-json") ?? -1;
    expect(notesIdx).toBeGreaterThanOrEqual(0);
    const notes = JSON.parse(annotate?.args[notesIdx + 1] ?? "{}") as { session_id?: string };
    expect(notes.session_id).toBe("ccs-x");

    // enqueue is host-namespaced to the dev-session kind, keyed by the chainId.
    const enqueue = calls.find((c) => c.args[1] === "enqueue");
    expect(enqueue?.args).toContain(DEV_SESSION_WORK_ITEM_KIND);
    expect(enqueue?.args).toContain("chain-x");
  });

  test("set() on a chain already in the map SKIPS enqueue and only annotates", async () => {
    const { spawn, calls } = recordingSpawn({
      list: { status: 0, stdout: listRow("chain-known", { session_id: "old" }) + "\n" },
      annotate: { status: 0, stdout: "" },
    });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
    });
    const beforeSet = calls.length;

    await store.set("chain-known", "new");
    await flush();

    // Row already exists (seen at rehydrate) → no re-enqueue, just annotate.
    const writeCalls = calls.slice(beforeSet).map((c) => c.args[1]);
    expect(writeCalls).toEqual(["annotate"]);
    expect(await store.get("chain-known")).toBe("new");
  });

  test("a write-path spawn failure is non-fatal: set() resolves, map holds, one log line", async () => {
    const logs: string[] = [];
    const { spawn } = recordingSpawn({
      list: { status: 0, stdout: "" },
      enqueue: { status: 1, stderr: "enqueue exploded" },
    });
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: (l) => logs.push(l),
    });

    // Must NOT reject even though the write path errors.
    await store.set("chain-fail", "ccs-fail");
    await flush();

    expect(await store.get("chain-fail")).toBe("ccs-fail");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.join("")).toContain("chain-fail");
  });

  test("a THROWING spawn on the write path never propagates", async () => {
    const logs: string[] = [];
    const throwingSpawn: AgentStateSpawn = (_cmd, args) => {
      if (args[1] === "list") return { status: 0, stdout: "" };
      throw new Error("spawn threw");
    };
    const store = new AgentStateDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn: throwingSpawn,
      log: (l) => logs.push(l),
    });
    await store.set("chain-t", "ccs-t");
    await flush();
    expect(await store.get("chain-t")).toBe("ccs-t");
    expect(logs.join("")).toContain("chain-t");
  });
});

describe("createDevSessionStore — per-agent selection + fallback", () => {
  test("stateful agent + present bundle → AgentStateDevSessionStore", () => {
    const { spawn } = recordingSpawn({ list: { status: 0, stdout: "" } });
    const store = createDevSessionStore(AGENT, {
      instanceDir,
      errandsScript,
      spawn,
      log: () => {},
      fileStorePath: join(root, "warm.json"),
    });
    expect(store).toBeInstanceOf(AgentStateDevSessionStore);
  });

  test("stateless agent → FileDevSessionStore, NO bundle probe, no spawn", () => {
    const { spawn, calls } = recordingSpawn({ list: { status: 0, stdout: "" } });
    const store = createDevSessionStore(
      { id: "plain" },
      {
        instanceDir,
        errandsScript,
        spawn,
        log: () => {},
        fileStorePath: join(root, "warm.json"),
      },
    );
    expect(store).toBeInstanceOf(FileDevSessionStore);
    // Stateless takes zero new code paths — the bundle is never invoked.
    expect(calls.length).toBe(0);
  });

  test("stateful agent + absent bundle script → FileDevSessionStore fallback, one log line", () => {
    const logs: string[] = [];
    const { spawn, calls } = recordingSpawn({ list: { status: 0, stdout: "" } });
    const store = createDevSessionStore(AGENT, {
      instanceDir,
      errandsScript: join(root, "does-not-exist.ts"),
      spawn,
      log: (l) => logs.push(l),
      fileStorePath: join(root, "warm.json"),
    });
    expect(store).toBeInstanceOf(FileDevSessionStore);
    // No rehydrate spawn (we fell back before constructing the AgentState store).
    expect(calls.length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("fallback");
  });
});
