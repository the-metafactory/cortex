import { describe, test, expect, beforeEach } from "bun:test";
import { SessionManager } from "../session-manager";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({ idleTimeoutMs: 1000 });
  });

  test("returns null for unknown thread", () => {
    expect(manager.getSession("unknown-thread")).toBeNull();
  });

  test("stores and retrieves session by thread ID", () => {
    manager.setSession("thread-1", "session-abc");
    const session = manager.getSession("thread-1");
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("session-abc");
  });

  test("updates lastActivity on getSession", () => {
    manager.setSession("thread-1", "session-abc");
    const first = manager.getSession("thread-1");
    const firstTime = first!.lastActivity;

    // Small delay
    const start = Date.now();
    while (Date.now() - start < 10) { /* busy wait 10ms */ }

    const second = manager.getSession("thread-1");
    expect(second!.lastActivity).toBeGreaterThanOrEqual(firstTime);
  });

  test("removes session explicitly", () => {
    manager.setSession("thread-1", "session-abc");
    manager.removeSession("thread-1");
    expect(manager.getSession("thread-1")).toBeNull();
  });

  test("cleanupIdle removes expired sessions", async () => {
    manager.setSession("thread-old", "session-old");

    // Wait for idle timeout
    await Bun.sleep(1100);

    manager.setSession("thread-new", "session-new");

    const removed = manager.cleanupIdle();
    expect(removed).toContain("thread-old");
    expect(removed).not.toContain("thread-new");
    expect(manager.getSession("thread-old")).toBeNull();
    expect(manager.getSession("thread-new")).not.toBeNull();
  });

  test("cleanupIdle keeps active sessions", () => {
    manager.setSession("thread-1", "session-1");
    const removed = manager.cleanupIdle();
    expect(removed).toHaveLength(0);
    expect(manager.getSession("thread-1")).not.toBeNull();
  });

  test("listSessions returns all active sessions", () => {
    manager.setSession("thread-1", "session-1");
    manager.setSession("thread-2", "session-2");
    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
  });

  test("hasSession checks existence", () => {
    manager.setSession("thread-1", "session-1");
    expect(manager.hasSession("thread-1")).toBe(true);
    expect(manager.hasSession("thread-2")).toBe(false);
  });

  test("isThreadMessage detects thread channels", () => {
    // Thread channel IDs in Discord have a parent
    expect(SessionManager.isThreadContext("thread-123", true)).toBe(true);
    expect(SessionManager.isThreadContext("channel-123", false)).toBe(false);
  });
});
