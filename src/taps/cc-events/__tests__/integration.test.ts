import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createRawEvent, RawEventSchema, PublishedEventSchema } from "../hooks/lib/event-types";
import { mapHookToEventType } from "../hooks/lib/event-taxonomy";
import { EventProcessor } from "../lib/event-processor";
import { JsonlReader } from "../lib/jsonl-reader";
import { RelayPolicySchema } from "../lib/policy-schema";
import { readFileSync, mkdirSync, rmSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const TEST_DIR = join(import.meta.dir, ".test-integration");
const RAW_DIR = join(TEST_DIR, "raw");
const PUB_DIR = join(TEST_DIR, "published");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(PUB_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// Load the actual default policy
const policyPath = join(import.meta.dir, "..", "relay-policy.yaml");
const policyYaml = readFileSync(policyPath, "utf-8");
const policy = RelayPolicySchema.parse(parse(policyYaml));

function writeRawAndProcess(rawFile: string, pubFile: string, events: ReturnType<typeof createRawEvent>[]) {
  for (const event of events) {
    appendFileSync(rawFile, JSON.stringify(event) + "\n");
  }
  const processor = new EventProcessor(policy);
  return processor.processFile(rawFile, pubFile);
}

describe("Integration: Full Pipeline", () => {
  test("AC#1: raw event → relay → published event has all required fields", () => {
    const rawFile = join(RAW_DIR, "s1.jsonl");
    const pubFile = join(PUB_DIR, "s1.jsonl");

    const event = createRawEvent("agent.task.completed", "Stop", {
      summary: "Built the feature",
      duration_ms: 5000,
    }, { sessionId: "int-test-1" });

    // Validate raw event against schema
    RawEventSchema.parse(event);

    const count = writeRawAndProcess(rawFile, pubFile, [event]);
    expect(count).toBe(1);

    const published = JSON.parse(readFileSync(pubFile, "utf-8").trim());

    // All 6 required published fields
    expect(published.event_id).toBeDefined();
    expect(typeof published.event_id).toBe("string");
    expect(published.event_type).toBe("agent.task.completed");
    expect(published.timestamp).toBeDefined();
    expect(published.session_id).toBe("int-test-1");
    expect(published.payload).toBeDefined();
    expect(typeof published.payload).toBe("object");

    // Validate against PublishedEventSchema
    PublishedEventSchema.parse(published);
  });

  test("AC#2: UserPromptSubmit → agent.task.started with prompt_preview", () => {
    const rawFile = join(RAW_DIR, "s2.jsonl");
    const pubFile = join(PUB_DIR, "s2.jsonl");

    const eventType = mapHookToEventType("UserPromptSubmit");
    expect(eventType).toBe("agent.task.started");

    const event = createRawEvent(eventType, "UserPromptSubmit", {
      prompt_preview: "Build the event bus",
    }, { sessionId: "int-test-2" });

    const count = writeRawAndProcess(rawFile, pubFile, [event]);
    expect(count).toBe(1);

    const published = JSON.parse(readFileSync(pubFile, "utf-8").trim());
    expect(published.event_type).toBe("agent.task.started");
    expect(published.payload.prompt_preview).toBe("Build the event bus");
  });

  test("AC#2: Stop → agent.task.completed with summary", () => {
    const rawFile = join(RAW_DIR, "s3.jsonl");
    const pubFile = join(PUB_DIR, "s3.jsonl");

    const eventType = mapHookToEventType("Stop");
    expect(eventType).toBe("agent.task.completed");

    const event = createRawEvent(eventType, "Stop", {
      summary: "Completed the build",
      duration_ms: 12000,
    }, { sessionId: "int-test-3" });

    const count = writeRawAndProcess(rawFile, pubFile, [event]);
    expect(count).toBe(1);

    const published = JSON.parse(readFileSync(pubFile, "utf-8").trim());
    expect(published.event_type).toBe("agent.task.completed");
    expect(published.payload.summary).toBe("Completed the build");
    expect(published.payload.duration_ms).toBe(12000);
  });

  test("AC#2: PostToolUse Write → tool.file.changed with path", () => {
    const rawFile = join(RAW_DIR, "s4.jsonl");
    const pubFile = join(PUB_DIR, "s4.jsonl");

    const eventType = mapHookToEventType("PostToolUse", "Write");
    expect(eventType).toBe("tool.file.changed");

    const event = createRawEvent(eventType, "PostToolUse", {
      path: "/work/grove/src/main.ts",
      change_type: "create",
    }, { sessionId: "int-test-4", toolName: "Write" });

    const count = writeRawAndProcess(rawFile, pubFile, [event]);
    expect(count).toBe(1);

    const published = JSON.parse(readFileSync(pubFile, "utf-8").trim());
    expect(published.event_type).toBe("tool.file.changed");
    expect(published.payload.path).toBe("/work/grove/src/main.ts");
    expect(published.payload.change_type).toBe("create");
  });

  test("sensitive data is redacted before published output", () => {
    const rawFile = join(RAW_DIR, "s5.jsonl");
    const pubFile = join(PUB_DIR, "s5.jsonl");

    const event = createRawEvent("agent.task.completed", "Stop", {
      summary: "Used API key sk-ant-secret123-key in the project",
      duration_ms: 1000,
    }, { sessionId: "int-test-5" });

    writeRawAndProcess(rawFile, pubFile, [event]);

    const published = JSON.parse(readFileSync(pubFile, "utf-8").trim());
    expect(published.payload.summary).not.toContain("sk-ant-");
    expect(published.payload.summary).toContain("[REDACTED:ANTHROPIC_KEY]");
  });

  test("events matching drop conditions don't appear in published output", () => {
    const rawFile = join(RAW_DIR, "s6.jsonl");
    const pubFile = join(PUB_DIR, "s6.jsonl");

    const safeEvent = createRawEvent("tool.file.changed", "PostToolUse", {
      path: "/work/src/main.ts",
      change_type: "edit",
    }, { sessionId: "int-test-6", toolName: "Edit" });

    const envEvent = createRawEvent("tool.file.changed", "PostToolUse", {
      path: "/work/.env",
      change_type: "edit",
    }, { sessionId: "int-test-6", toolName: "Edit" });

    writeRawAndProcess(rawFile, pubFile, [safeEvent, envEvent]);

    const lines = readFileSync(pubFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).payload.path).not.toContain(".env");
  });

  test("disallowed event types are filtered out", () => {
    const rawFile = join(RAW_DIR, "s7.jsonl");
    const pubFile = join(PUB_DIR, "s7.jsonl");

    const allowed = createRawEvent("agent.task.completed", "Stop", {
      summary: "done",
    }, { sessionId: "int-test-7" });

    const disallowed = createRawEvent("tool.bash.executed", "PostToolUse", {
      command_preview: "ls -la",
    }, { sessionId: "int-test-7", toolName: "Bash" });

    const count = writeRawAndProcess(rawFile, pubFile, [allowed, disallowed]);
    expect(count).toBe(1);
  });
});
