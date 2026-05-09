import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { JsonlTailReader } from "../hooks/jsonl-reader";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RawHookEvent } from "../hooks/types";

function makeEvent(id: string, sessionId: string): RawHookEvent {
  return {
    event_id: id,
    event_type: "test.event",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    source: { hook: "PostToolUse" },
    payload: { test: true },
  };
}

describe("JsonlTailReader", () => {
  let reader: JsonlTailReader;
  let tmpDir: string;

  beforeEach(() => {
    reader = new JsonlTailReader();
    tmpDir = join(tmpdir(), `mc-jsonl-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads all lines from a new file", () => {
    const file = join(tmpDir, "session-1.jsonl");
    const e1 = makeEvent("e-1", "session-1");
    const e2 = makeEvent("e-2", "session-1");
    writeFileSync(file, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");

    const events = reader.readNew(file);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_id).toBe("e-1");
    expect(events[1]!.event_id).toBe("e-2");
  });

  it("reads incrementally — only new lines after cursor", () => {
    const file = join(tmpDir, "session-2.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");

    const first = reader.readNew(file);
    expect(first).toHaveLength(1);

    // Append more lines
    appendFileSync(file, JSON.stringify(makeEvent("e-2", "s")) + "\n");
    appendFileSync(file, JSON.stringify(makeEvent("e-3", "s")) + "\n");

    const second = reader.readNew(file);
    expect(second).toHaveLength(2);
    expect(second[0]!.event_id).toBe("e-2");
    expect(second[1]!.event_id).toBe("e-3");
  });

  it("returns empty for nonexistent file", () => {
    const events = reader.readNew(join(tmpDir, "nope.jsonl"));
    expect(events).toHaveLength(0);
  });

  it("returns empty when no new data", () => {
    const file = join(tmpDir, "session-3.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");

    reader.readNew(file); // consume
    const second = reader.readNew(file);
    expect(second).toHaveLength(0);
  });

  it("skips malformed lines without throwing", () => {
    const file = join(tmpDir, "session-4.jsonl");
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "s")) +
        "\n" +
        "NOT VALID JSON\n" +
        JSON.stringify(makeEvent("e-3", "s")) +
        "\n"
    );

    const events = reader.readNew(file);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_id).toBe("e-1");
    expect(events[1]!.event_id).toBe("e-3");
  });

  it("does not parse partial lines (no trailing newline)", () => {
    const file = join(tmpDir, "session-5.jsonl");
    // Write a complete line and an incomplete one
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "s")) + "\n" + '{"event_id":"e-2","partial'
    );

    const events = reader.readNew(file);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe("e-1");

    // Complete the partial line
    appendFileSync(file, '":true}\n');
    // Should now read the completed line (though it won't parse as RawHookEvent perfectly, it'll parse as JSON)
  });

  it("skipToEnd sets cursor to file end", () => {
    const file = join(tmpDir, "session-6.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");

    reader.skipToEnd(file);

    // Should read nothing since we skipped past existing content
    const events = reader.readNew(file);
    expect(events).toHaveLength(0);

    // New content should still be readable
    appendFileSync(file, JSON.stringify(makeEvent("e-2", "s")) + "\n");
    const newEvents = reader.readNew(file);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.event_id).toBe("e-2");
  });

  it("exportOffsets and importOffsets round-trip", () => {
    const file = join(tmpDir, "session-7.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");
    reader.readNew(file);

    const offsets = reader.exportOffsets();
    expect(offsets.get(file)).toBeGreaterThan(0);

    const reader2 = new JsonlTailReader();
    reader2.importOffsets(offsets);
    expect(reader2.getOffset(file)).toBe(offsets.get(file)!);
  });

  it("reset clears offset for a file", () => {
    const file = join(tmpDir, "session-8.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");
    reader.readNew(file);

    expect(reader.getOffset(file)).toBeGreaterThan(0);
    reader.reset(file);
    expect(reader.getOffset(file)).toBe(0);
  });

  it("detects file truncation and re-reads from start", () => {
    const file = join(tmpDir, "session-trunc.jsonl");
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "s")) + "\n" +
      JSON.stringify(makeEvent("e-2", "s")) + "\n"
    );

    // Read both lines — cursor advances past them
    const first = reader.readNew(file);
    expect(first).toHaveLength(2);
    const offsetBefore = reader.getOffset(file);
    expect(offsetBefore).toBeGreaterThan(0);

    // Truncate: replace file with a single shorter line
    writeFileSync(file, JSON.stringify(makeEvent("e-3", "s")) + "\n");

    // Next read detects truncation (stat.size < offset), resets, re-reads
    const second = reader.readNew(file);
    expect(second).toHaveLength(1);
    expect(second[0]!.event_id).toBe("e-3");
    // Cursor should now be at the end of the new (smaller) file
    expect(reader.getOffset(file)).toBeLessThan(offsetBefore);
  });

  it("detects file rotation (replaced with new content) and re-reads", () => {
    const file = join(tmpDir, "session-rotate.jsonl");
    const bigEvent = makeEvent("e-1", "s");
    writeFileSync(
      file,
      JSON.stringify(bigEvent) + "\n" +
      JSON.stringify(bigEvent) + "\n" +
      JSON.stringify(bigEvent) + "\n"
    );

    reader.readNew(file); // advance cursor to end of 3 events
    const offsetAfterFirst = reader.getOffset(file);

    // Simulate rotation: overwrite with one new event (smaller file)
    writeFileSync(file, JSON.stringify(makeEvent("e-new", "s")) + "\n");

    const afterRotate = reader.readNew(file);
    expect(afterRotate).toHaveLength(1);
    expect(afterRotate[0]!.event_id).toBe("e-new");
    expect(reader.getOffset(file)).toBeLessThan(offsetAfterFirst);
  });

  it("handles UTF-8 multi-byte characters without crashing", () => {
    const file = join(tmpDir, "session-utf8.jsonl");
    const event = makeEvent("e-utf8", "s");
    (event as any).payload = { emoji: "🎉", text: "日本語テスト" };
    writeFileSync(file, JSON.stringify(event) + "\n");

    const events = reader.readNew(file);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe("e-utf8");
    const payload = events[0]!.payload as Record<string, string>;
    expect(payload.emoji).toBe("🎉");
    expect(payload.text).toBe("日本語テスト");
  });

  it("handles concurrent append during read (new lines added while reading)", () => {
    const file = join(tmpDir, "session-concurrent.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "s")) + "\n");

    // First read captures e-1
    const first = reader.readNew(file);
    expect(first).toHaveLength(1);

    // Simulate concurrent appends between reads
    appendFileSync(file, JSON.stringify(makeEvent("e-2", "s")) + "\n");
    appendFileSync(file, JSON.stringify(makeEvent("e-3", "s")) + "\n");

    // Second read only gets the new lines
    const second = reader.readNew(file);
    expect(second).toHaveLength(2);
    expect(second[0]!.event_id).toBe("e-2");
    expect(second[1]!.event_id).toBe("e-3");

    // Third read returns nothing — cursor is at end
    const third = reader.readNew(file);
    expect(third).toHaveLength(0);
  });
});
