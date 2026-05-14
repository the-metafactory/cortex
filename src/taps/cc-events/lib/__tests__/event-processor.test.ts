import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { EventProcessor } from "../event-processor";
import { JsonlReader } from "../jsonl-reader";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import type { RelayPolicy } from "../policy-schema";

const TEST_DIR = join(import.meta.dir, ".test-processor");
const RAW_DIR = join(TEST_DIR, "raw");
const PUB_DIR = join(TEST_DIR, "published");

function writeEvent(file: string, event: Record<string, unknown>) {
  appendFileSync(file, JSON.stringify(event) + "\n");
}

const sampleRawEvent = (n: number, overrides: Record<string, unknown> = {}) => ({
  event_id: `550e8400-e29b-41d4-a716-44665544000${n}`,
  event_type: "agent.task.completed",
  timestamp: "2026-03-27T10:00:00.000Z",
  session_id: `session-${n}`,
  grove_channel: "ivy",
  source: { hook: "Stop" },
  payload: { summary: `Task ${n} done`, duration_ms: 1000 * n },
  ...overrides,
});

const testPolicy: RelayPolicy = {
  allow_events: ["agent.task.completed", "agent.task.started"],
  fields: {
    "agent.task.completed": { include: ["summary", "duration_ms"] },
    "agent.task.started": { include: ["prompt_preview"] },
  },
  redact: [],
  drop_if: [],
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(PUB_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("EventProcessor", () => {
  test("writes published events to output file", () => {
    const rawFile = join(RAW_DIR, "s1.jsonl");
    const pubFile = join(PUB_DIR, "s1.jsonl");
    const processor = new EventProcessor(testPolicy);

    writeEvent(rawFile, sampleRawEvent(1));
    writeEvent(rawFile, sampleRawEvent(2));

    const count = processor.processFile(rawFile, pubFile);
    expect(count).toBe(2);
    expect(existsSync(pubFile)).toBe(true);

    const lines = readFileSync(pubFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const pub1 = JSON.parse(lines[0]!);
    expect(pub1.event_type).toBe("agent.task.completed");
    expect(pub1.payload.summary).toBe("Task 1 done");
    // source should NOT be in published event
    expect(pub1.source).toBeUndefined();
  });

  test("filters out disallowed events", () => {
    const rawFile = join(RAW_DIR, "s2.jsonl");
    const pubFile = join(PUB_DIR, "s2.jsonl");
    const processor = new EventProcessor(testPolicy);

    writeEvent(rawFile, sampleRawEvent(1)); // allowed
    writeEvent(rawFile, sampleRawEvent(2, { event_type: "tool.bash.executed" })); // not allowed

    const count = processor.processFile(rawFile, pubFile);
    expect(count).toBe(1);

    const lines = readFileSync(pubFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  test("creates published directory if missing", () => {
    const rawFile = join(RAW_DIR, "s3.jsonl");
    const newPubDir = join(TEST_DIR, "new-published");
    const pubFile = join(newPubDir, "s3.jsonl");
    const processor = new EventProcessor(testPolicy);

    writeEvent(rawFile, sampleRawEvent(1));
    processor.processFile(rawFile, pubFile);

    expect(existsSync(newPubDir)).toBe(true);
    expect(existsSync(pubFile)).toBe(true);
  });

  test("returns 0 for empty raw file", () => {
    const rawFile = join(RAW_DIR, "empty.jsonl");
    const pubFile = join(PUB_DIR, "empty.jsonl");
    writeFileSync(rawFile, "");

    const processor = new EventProcessor(testPolicy);
    const count = processor.processFile(rawFile, pubFile);
    expect(count).toBe(0);
  });

  test("two readers on same published file both get all events", () => {
    const rawFile = join(RAW_DIR, "shared.jsonl");
    const pubFile = join(PUB_DIR, "shared.jsonl");
    const processor = new EventProcessor(testPolicy);

    writeEvent(rawFile, sampleRawEvent(1));
    writeEvent(rawFile, sampleRawEvent(2));
    writeEvent(rawFile, sampleRawEvent(3));
    processor.processFile(rawFile, pubFile);

    // Two independent readers on the same published file
    const reader1 = new JsonlReader();
    const reader2 = new JsonlReader();

    const events1 = reader1.readNew(pubFile);
    const events2 = reader2.readNew(pubFile);

    expect(events1).toHaveLength(3);
    expect(events2).toHaveLength(3);
    expect(events1[0]!.event_id).toBe(events2[0]!.event_id);
  });

  test("concurrent sessions write to separate files", () => {
    const rawFile1 = join(RAW_DIR, "session-a.jsonl");
    const rawFile2 = join(RAW_DIR, "session-b.jsonl");
    const pubFile1 = join(PUB_DIR, "session-a.jsonl");
    const pubFile2 = join(PUB_DIR, "session-b.jsonl");

    const processor = new EventProcessor(testPolicy);

    writeEvent(rawFile1, sampleRawEvent(1, { session_id: "session-a" }));
    writeEvent(rawFile2, sampleRawEvent(2, { session_id: "session-b" }));

    const count1 = processor.processFile(rawFile1, pubFile1);
    const count2 = processor.processFile(rawFile2, pubFile2);

    expect(count1).toBe(1);
    expect(count2).toBe(1);

    const pub1 = JSON.parse(readFileSync(pubFile1, "utf-8").trim());
    const pub2 = JSON.parse(readFileSync(pubFile2, "utf-8").trim());

    expect(pub1.session_id).toBe("session-a");
    expect(pub2.session_id).toBe("session-b");
  });

  // ---------------------------------------------------------------------------
  // MIG-5b — onPublished hook
  // ---------------------------------------------------------------------------

  describe("onPublished hook", () => {
    test("invoked once per filtered event with the published shape", () => {
      const rawFile = join(RAW_DIR, "hook.jsonl");
      const pubFile = join(PUB_DIR, "hook.jsonl");
      const captured: { event_id: string; event_type: string }[] = [];

      const processor = new EventProcessor(testPolicy, {
        onPublished: (event) => {
          captured.push({ event_id: event.event_id, event_type: event.event_type });
        },
      });

      writeEvent(rawFile, sampleRawEvent(1));
      writeEvent(rawFile, sampleRawEvent(2));
      const count = processor.processFile(rawFile, pubFile);

      expect(count).toBe(2);
      expect(captured).toHaveLength(2);
      expect(captured[0]!.event_type).toBe("agent.task.completed");
      expect(captured[1]!.event_type).toBe("agent.task.completed");
    });

    test("not invoked for events filtered by policy", () => {
      const rawFile = join(RAW_DIR, "filter.jsonl");
      const pubFile = join(PUB_DIR, "filter.jsonl");
      const captured: string[] = [];

      const processor = new EventProcessor(testPolicy, {
        onPublished: (event) => {
          captured.push(event.event_type);
        },
      });

      writeEvent(rawFile, sampleRawEvent(1)); // allowed (agent.task.completed)
      writeEvent(rawFile, sampleRawEvent(2, { event_type: "tool.bash.executed" })); // dropped
      processor.processFile(rawFile, pubFile);

      expect(captured).toEqual(["agent.task.completed"]);
    });

    test("hook throws are swallowed (do not break JSONL pipeline)", () => {
      const rawFile = join(RAW_DIR, "throw.jsonl");
      const pubFile = join(PUB_DIR, "throw.jsonl");

      const processor = new EventProcessor(testPolicy, {
        onPublished: () => {
          throw new Error("nats publish boom");
        },
      });

      writeEvent(rawFile, sampleRawEvent(1));
      // Must NOT throw — the JSONL append is the durable primary path
      expect(() => processor.processFile(rawFile, pubFile)).not.toThrow();

      // JSONL output unaffected by hook failure
      const lines = readFileSync(pubFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const pub = JSON.parse(lines[0]!);
      expect(pub.event_type).toBe("agent.task.completed");
    });

    test("absence of hook is identical to pre-MIG-5b behaviour", () => {
      const rawFile = join(RAW_DIR, "noop.jsonl");
      const pubFile = join(PUB_DIR, "noop.jsonl");

      // No options — same constructor signature as before MIG-5b
      const processor = new EventProcessor(testPolicy);

      writeEvent(rawFile, sampleRawEvent(1));
      const count = processor.processFile(rawFile, pubFile);
      expect(count).toBe(1);
      expect(existsSync(pubFile)).toBe(true);
    });
  });
});
