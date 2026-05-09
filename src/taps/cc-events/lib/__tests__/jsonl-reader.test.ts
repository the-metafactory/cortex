import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { JsonlReader } from "../jsonl-reader";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".test-jsonl");

function writeEvent(file: string, event: Record<string, unknown>) {
  const { appendFileSync } = require("fs");
  appendFileSync(file, JSON.stringify(event) + "\n");
}

const sampleEvent = (n: number) => ({
  event_id: `id-${n}`,
  event_type: "agent.task.completed",
  timestamp: "2026-03-27T10:00:00.000Z",
  session_id: "session-1",
  source: { hook: "Stop" },
  payload: { summary: `Event ${n}` },
});

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("JsonlReader", () => {
  test("returns events after stored offset", () => {
    const file = join(TEST_DIR, "test.jsonl");
    const reader = new JsonlReader();

    // Write 3 events, read them
    writeEvent(file, sampleEvent(1));
    writeEvent(file, sampleEvent(2));
    writeEvent(file, sampleEvent(3));

    const first = reader.readNew(file);
    expect(first).toHaveLength(3);

    // Write 2 more, should only get new ones
    writeEvent(file, sampleEvent(4));
    writeEvent(file, sampleEvent(5));

    const second = reader.readNew(file);
    expect(second).toHaveLength(2);
    expect(second[0]!.event_id).toBe("id-4");
    expect(second[1]!.event_id).toBe("id-5");
  });

  test("returns empty array for non-existent file", () => {
    const reader = new JsonlReader();
    const result = reader.readNew(join(TEST_DIR, "nonexistent.jsonl"));
    expect(result).toEqual([]);
  });

  test("skips malformed JSONL lines", () => {
    const file = join(TEST_DIR, "malformed.jsonl");
    const reader = new JsonlReader();

    writeEvent(file, sampleEvent(1));
    const { appendFileSync } = require("fs");
    appendFileSync(file, "this is not json\n");
    writeEvent(file, sampleEvent(2));

    const events = reader.readNew(file);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_id).toBe("id-1");
    expect(events[1]!.event_id).toBe("id-2");
  });

  test("handles empty file", () => {
    const file = join(TEST_DIR, "empty.jsonl");
    writeFileSync(file, "");
    const reader = new JsonlReader();
    const result = reader.readNew(file);
    expect(result).toEqual([]);
  });

  test("tracks offset per file independently", () => {
    const file1 = join(TEST_DIR, "s1.jsonl");
    const file2 = join(TEST_DIR, "s2.jsonl");
    const reader = new JsonlReader();

    writeEvent(file1, sampleEvent(1));
    writeEvent(file2, sampleEvent(2));

    reader.readNew(file1);
    reader.readNew(file2);

    writeEvent(file1, sampleEvent(3));
    // file2 has no new events

    const f1new = reader.readNew(file1);
    const f2new = reader.readNew(file2);

    expect(f1new).toHaveLength(1);
    expect(f1new[0]!.event_id).toBe("id-3");
    expect(f2new).toHaveLength(0);
  });

  test("reset clears offset for a file", () => {
    const file = join(TEST_DIR, "reset.jsonl");
    const reader = new JsonlReader();

    writeEvent(file, sampleEvent(1));
    writeEvent(file, sampleEvent(2));
    reader.readNew(file); // read all

    reader.reset(file);

    const after = reader.readNew(file);
    expect(after).toHaveLength(2); // re-reads everything
  });

  test("multiple calls return only new events each time", () => {
    const file = join(TEST_DIR, "incremental.jsonl");
    const reader = new JsonlReader();

    writeEvent(file, sampleEvent(1));
    expect(reader.readNew(file)).toHaveLength(1);

    writeEvent(file, sampleEvent(2));
    expect(reader.readNew(file)).toHaveLength(1);

    writeEvent(file, sampleEvent(3));
    writeEvent(file, sampleEvent(4));
    expect(reader.readNew(file)).toHaveLength(2);

    // No new events
    expect(reader.readNew(file)).toHaveLength(0);
  });

  test("skipToEnd skips all existing events", () => {
    const file = join(TEST_DIR, "skip.jsonl");
    const reader = new JsonlReader();

    writeEvent(file, sampleEvent(1));
    writeEvent(file, sampleEvent(2));

    reader.skipToEnd(file);

    const events = reader.readNew(file);
    expect(events).toHaveLength(0);

    // New events after skip are still readable
    writeEvent(file, sampleEvent(3));
    const newEvents = reader.readNew(file);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.event_id).toBe("id-3");
  });
});
