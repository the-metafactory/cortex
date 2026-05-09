import { describe, test, expect } from "bun:test";
import { TaskTracker } from "../task-tracker";
import { EventEmitter } from "events";

/** Minimal mock CCSession for testing (just needs EventEmitter + kill) */
function mockSession(): any {
  const emitter = new EventEmitter();
  (emitter as any).kill = () => { emitter.emit("exit", 0); };
  (emitter as any).sessionId = "mock-session-123";
  return emitter;
}

describe("TaskTracker", () => {
  test("tracks and completes tasks", () => {
    const tracker = new TaskTracker();
    const session = mockSession();

    tracker.track("task-1", session, "channel-123", "test task");
    expect(tracker.size).toBe(1);
    expect(tracker.active()).toHaveLength(1);
    expect(tracker.active()[0]!.channelId).toBe("channel-123");
    expect(tracker.active()[0]!.description).toBe("test task");

    tracker.complete("task-1");
    expect(tracker.size).toBe(0);
    expect(tracker.active()).toHaveLength(0);
  });

  test("tracks multiple tasks", () => {
    const tracker = new TaskTracker();

    tracker.track("task-1", mockSession(), "ch-1");
    tracker.track("task-2", mockSession(), "ch-2");
    tracker.track("task-3", mockSession(), "ch-3");

    expect(tracker.size).toBe(3);

    tracker.complete("task-2");
    expect(tracker.size).toBe(2);

    const active = tracker.active();
    expect(active.map((t) => t.id)).toEqual(["task-1", "task-3"]);
  });

  test("active() reports duration", async () => {
    const tracker = new TaskTracker();
    tracker.track("task-1", mockSession(), "ch-1");

    // Wait a bit so duration > 0
    await new Promise((resolve) => setTimeout(resolve, 50));

    const active = tracker.active();
    expect(active[0]!.durationMs).toBeGreaterThan(0);
  });

  test("completing unknown task is a no-op", () => {
    const tracker = new TaskTracker();
    tracker.complete("nonexistent"); // Should not throw
    expect(tracker.size).toBe(0);
  });

  test("shutdown kills all sessions and clears tasks", async () => {
    const tracker = new TaskTracker();
    const sessions = [mockSession(), mockSession()];

    tracker.track("task-1", sessions[0], "ch-1");
    tracker.track("task-2", sessions[1], "ch-2");

    await tracker.shutdown(1000);

    expect(tracker.size).toBe(0);
  });

  test("shutdown is a no-op when empty", async () => {
    const tracker = new TaskTracker();
    await tracker.shutdown(); // Should not throw or hang
    expect(tracker.size).toBe(0);
  });
});
