import { test, expect, describe } from "bun:test";
import { parseMessageKeywords } from "../message-parser";

describe("parseMessageKeywords", () => {
  const defaultDepth = 10;

  describe("sync mode (default)", () => {
    test("plain message returns sync", () => {
      const result = parseMessageKeywords("hello world", defaultDepth);
      expect(result.mode).toBe("sync");
      expect(result.content).toBe("hello world");
      expect(result.contextDepth).toBeUndefined();
    });

    test("empty string returns sync", () => {
      const result = parseMessageKeywords("", defaultDepth);
      expect(result.mode).toBe("sync");
      expect(result.content).toBe("");
    });
  });

  describe("async mode", () => {
    test("async: prefix extracts content", () => {
      const result = parseMessageKeywords("async: do something", defaultDepth);
      expect(result.mode).toBe("async");
      expect(result.content).toBe("do something");
    });

    test("async: is case-insensitive", () => {
      const result = parseMessageKeywords("ASYNC: do something", defaultDepth);
      expect(result.mode).toBe("async");
      expect(result.content).toBe("do something");
    });

    test("async: with no content", () => {
      const result = parseMessageKeywords("async:", defaultDepth);
      expect(result.mode).toBe("async");
      expect(result.content).toBe("");
    });

    test("async: with extra whitespace", () => {
      const result = parseMessageKeywords("async:   lots of space  ", defaultDepth);
      expect(result.mode).toBe("async");
      expect(result.content).toBe("lots of space");
    });
  });

  describe("team mode", () => {
    test("team: prefix extracts content", () => {
      const result = parseMessageKeywords("team: analyze this", defaultDepth);
      expect(result.mode).toBe("team");
      expect(result.content).toBe("analyze this");
    });

    test("team: is case-insensitive", () => {
      const result = parseMessageKeywords("Team: analyze this", defaultDepth);
      expect(result.mode).toBe("team");
      expect(result.content).toBe("analyze this");
    });
  });

  describe("help mode", () => {
    test("/help triggers help mode", () => {
      const result = parseMessageKeywords("/help", defaultDepth);
      expect(result.mode).toBe("help");
      expect(result.content).toBe("");
    });

    test("help without slash triggers help mode", () => {
      const result = parseMessageKeywords("help", defaultDepth);
      expect(result.mode).toBe("help");
      expect(result.content).toBe("");
    });

    test("/commands triggers help mode", () => {
      const result = parseMessageKeywords("/commands", defaultDepth);
      expect(result.mode).toBe("help");
      expect(result.content).toBe("");
    });

    test("HELP is case-insensitive", () => {
      const result = parseMessageKeywords("HELP", defaultDepth);
      expect(result.mode).toBe("help");
      expect(result.content).toBe("");
    });

    test("help with trailing text still matches", () => {
      const result = parseMessageKeywords("help me please", defaultDepth);
      expect(result.mode).toBe("help");
      expect(result.content).toBe("");
    });
  });

  describe("context:N", () => {
    test("context:N extracts depth", () => {
      const result = parseMessageKeywords("context:50 what is this", defaultDepth);
      expect(result.mode).toBe("sync");
      expect(result.content).toBe("what is this");
      expect(result.contextDepth).toBe(50);
    });

    test("context with space separator", () => {
      const result = parseMessageKeywords("context 20 what is this", defaultDepth);
      expect(result.mode).toBe("sync");
      expect(result.content).toBe("what is this");
      expect(result.contextDepth).toBe(20);
    });

    test("context:N capped at 100", () => {
      const result = parseMessageKeywords("context:999 question", defaultDepth);
      expect(result.contextDepth).toBe(100);
    });

    test("context:0 returns 0", () => {
      const result = parseMessageKeywords("context:0 question", defaultDepth);
      expect(result.contextDepth).toBe(0);
    });

    test("context:N combines with async:", () => {
      const result = parseMessageKeywords("context:20 async: do it", defaultDepth);
      expect(result.mode).toBe("async");
      expect(result.content).toBe("do it");
      expect(result.contextDepth).toBe(20);
    });

    test("context:N combines with team:", () => {
      const result = parseMessageKeywords("context:30 team: analyze", defaultDepth);
      expect(result.mode).toBe("team");
      expect(result.content).toBe("analyze");
      expect(result.contextDepth).toBe(30);
    });

    test("context:N in middle of message", () => {
      const result = parseMessageKeywords("hey context:5 what's up", defaultDepth);
      expect(result.contextDepth).toBe(5);
      expect(result.content).toBe("hey what's up");
    });
  });
});
