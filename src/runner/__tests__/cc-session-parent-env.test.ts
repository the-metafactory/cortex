import { describe, test, expect } from "bun:test";
import { buildSessionEnv } from "../cc-session";

/**
 * ST-P1 (cortex#964, refs #952) — spawning a child CC session stamps the
 * PINNED env var `CORTEX_PARENT_SESSION_ID` so the EventLogger hook in the
 * child can read it and link the child's events to the parent session.
 */
describe("buildSessionEnv — ST-P1 stamps CORTEX_PARENT_SESSION_ID", () => {
  const baseEnv = { PATH: "/usr/bin" } as Record<string, string>;

  test("sets CORTEX_PARENT_SESSION_ID from opts.parentSessionId", () => {
    const env = buildSessionEnv(baseEnv, {
      parentSessionId: "moderator-session-123",
    });
    expect(env.CORTEX_PARENT_SESSION_ID).toBe("moderator-session-123");
  });

  test("omits CORTEX_PARENT_SESSION_ID when parentSessionId is unset", () => {
    const env = buildSessionEnv(baseEnv, {
      groveChannel: "ivy",
    });
    expect(env.CORTEX_PARENT_SESSION_ID).toBeUndefined();
  });

  test("preserves the inherited base env alongside the parent stamp", () => {
    const env = buildSessionEnv(baseEnv, {
      parentSessionId: "moderator-session-123",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CORTEX_PARENT_SESSION_ID).toBe("moderator-session-123");
  });
});
