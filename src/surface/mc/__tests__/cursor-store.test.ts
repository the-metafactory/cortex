import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { CursorStore } from "../hooks/cursor-store";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("CursorStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-cursor-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save + load round-trips offsets", () => {
    const store = new CursorStore(join(tmpDir, "cursor.json"));
    const offsets = new Map([
      ["/path/to/file1.jsonl", 1500],
      ["/path/to/file2.jsonl", 3200],
    ]);

    store.save(offsets);
    const loaded = store.load();

    expect(loaded.size).toBe(2);
    expect(loaded.get("/path/to/file1.jsonl")).toBe(1500);
    expect(loaded.get("/path/to/file2.jsonl")).toBe(3200);
  });

  it("load returns empty map when file does not exist", () => {
    const store = new CursorStore(join(tmpDir, "nonexistent.json"));
    const loaded = store.load();
    expect(loaded.size).toBe(0);
  });

  it("load returns empty map when file is corrupt", () => {
    const path = join(tmpDir, "corrupt.json");
    writeFileSync(path, "NOT VALID JSON{{{");

    const store = new CursorStore(path);
    const loaded = store.load();
    expect(loaded.size).toBe(0);
  });

  it("save creates parent directories", () => {
    const store = new CursorStore(join(tmpDir, "deep", "nested", "cursor.json"));
    const offsets = new Map([["test", 42]]);

    store.save(offsets);
    const loaded = store.load();
    expect(loaded.get("test")).toBe(42);
  });

  it("save overwrites existing cursor file", () => {
    const path = join(tmpDir, "cursor.json");
    const store = new CursorStore(path);

    store.save(new Map([["file1", 100]]));
    store.save(new Map([["file2", 200]]));

    const loaded = store.load();
    expect(loaded.has("file1")).toBe(false);
    expect(loaded.get("file2")).toBe(200);
  });

  it("save is atomic — no .tmp file left behind on success", () => {
    const path = join(tmpDir, "cursor-atomic.json");
    const store = new CursorStore(path);

    store.save(new Map([["file1", 42]]));

    // The final file should exist, but the temp file should not
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);

    // And the data should be correct
    const loaded = store.load();
    expect(loaded.get("file1")).toBe(42);
  });

  it("save via rename preserves old cursor if something goes wrong", () => {
    const path = join(tmpDir, "cursor-recover.json");
    const store = new CursorStore(path);

    // Write initial valid state
    store.save(new Map([["file1", 100]]));

    // Manually corrupt the .tmp file to simulate partial write
    writeFileSync(path + ".tmp", "CORRUPT PARTIAL DATA");

    // Original cursor file should still be readable
    const loaded = store.load();
    expect(loaded.get("file1")).toBe(100);
  });
});
