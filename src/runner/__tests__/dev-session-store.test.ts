/**
 * F-2.1 (cortex#835) — tests for the warm-session store (§3.6b).
 *
 * Covers the in-memory fake (used by the consumer tests) and the
 * file-backed durable store (the production durability clause: "a restarted
 * agent resumes rather than restarts").
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  MemoryDevSessionStore,
  FileDevSessionStore,
} from "../dev-session-store";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "dev-session-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("MemoryDevSessionStore", () => {
  test("get/set/delete", async () => {
    const s = new MemoryDevSessionStore();
    expect(await s.get("c1")).toBeUndefined();
    await s.set("c1", "sess-1");
    expect(await s.get("c1")).toBe("sess-1");
    await s.set("c1", "sess-2"); // overwrite — last write wins
    expect(await s.get("c1")).toBe("sess-2");
    await s.delete("c1");
    expect(await s.get("c1")).toBeUndefined();
  });
});

describe("FileDevSessionStore", () => {
  test("persists across instances (the restart-resume clause)", async () => {
    const path = join(tmpDir(), "warm.json");
    const a = new FileDevSessionStore(path);
    await a.set("chain-x", "sess-warm");

    // A fresh instance (simulating a daemon restart) reads the same map.
    const b = new FileDevSessionStore(path);
    expect(await b.get("chain-x")).toBe("sess-warm");
  });

  test("delete persists", async () => {
    const path = join(tmpDir(), "warm.json");
    const a = new FileDevSessionStore(path);
    await a.set("chain-x", "sess-warm");
    await a.delete("chain-x");

    const b = new FileDevSessionStore(path);
    expect(await b.get("chain-x")).toBeUndefined();
  });

  test("missing file → empty map (cold first boot)", async () => {
    const path = join(tmpDir(), "does-not-exist.json");
    const s = new FileDevSessionStore(path);
    expect(await s.get("anything")).toBeUndefined();
  });

  test("corrupt file → empty map, no throw (degrade to cold-start)", async () => {
    const path = join(tmpDir(), "corrupt.json");
    writeFileSync(path, "{ not json", "utf8");
    const s = new FileDevSessionStore(path);
    expect(await s.get("anything")).toBeUndefined();
    // Still writable after a corrupt read.
    await s.set("c", "sess");
    expect(await s.get("c")).toBe("sess");
  });

  test("non-object JSON → empty map", async () => {
    const path = join(tmpDir(), "array.json");
    writeFileSync(path, "[1,2,3]", "utf8");
    const s = new FileDevSessionStore(path);
    expect(await s.get("anything")).toBeUndefined();
  });
});
