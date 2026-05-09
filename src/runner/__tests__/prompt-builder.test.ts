import { test, expect, describe } from "bun:test";
import { buildPrompt } from "../prompt-builder";
import type { InboundMessage } from "../../adapters/types";
import type { ContextMessage } from "../../common/types/context";

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "test-instance",
    authorId: "user123",
    authorName: "TestUser",
    content: "hello world",
    channelId: "ch1",
    attachments: [],
    timestamp: new Date(),
    ...overrides,
  };
}

const sampleContext: ContextMessage[] = [
  { role: "human", author: "Alice", content: "Hey there", timestamp: "2026-01-01T00:00:00Z" },
  { role: "assistant", author: "Ivy", content: "Hi Alice!", timestamp: "2026-01-01T00:00:01Z" },
];

describe("buildPrompt", () => {
  describe("resumed session", () => {
    test("includes author attribution with content", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "what about errors?" }),
        context: [],
        isResume: true,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toBe("[Message from TestUser]: what about errors?");
    });

    test("bare mention on resume", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "" }),
        context: [],
        isResume: true,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("TestUser");
      expect(result).toContain("mentioned you again");
    });
  });

  describe("new conversation", () => {
    test("includes context header and latest message", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "what is this?" }),
        context: sampleContext,
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("Discord");
      expect(result).toContain("recent conversation");
      expect(result).toContain("Alice");
      expect(result).toContain("what is this?");
      expect(result).toContain("TestUser");
    });

    test("thread context mentions thread", () => {
      const result = buildPrompt({
        msg: makeMsg({ threadId: "thread1", content: "in a thread" }),
        context: sampleContext,
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("thread");
    });

    test("channel context mentions channel", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "in a channel" }),
        context: sampleContext,
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("channel");
    });

    test("no context, just content", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "standalone question" }),
        context: [],
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toBe("standalone question");
    });

    test("mattermost platform name", () => {
      const result = buildPrompt({
        msg: makeMsg({ platform: "mattermost", content: "hi" }),
        context: sampleContext,
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("Mattermost");
    });
  });

  describe("bare mention (no content)", () => {
    test("new conversation bare mention includes context", () => {
      const result = buildPrompt({
        msg: makeMsg({ content: "" }),
        context: sampleContext,
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "",
      });
      expect(result).toContain("mentioned you");
      expect(result).toContain("TestUser");
      expect(result).toContain("Alice");
    });
  });

  describe("attachments and security", () => {
    test("attachment prompt appended", () => {
      const result = buildPrompt({
        msg: makeMsg(),
        context: [],
        isResume: false,
        attachmentPrompt: "\n\n[Attached: report.pdf]",
        securityPreamble: "",
      });
      expect(result).toContain("[Attached: report.pdf]");
    });

    test("security preamble prepended", () => {
      const result = buildPrompt({
        msg: makeMsg(),
        context: [],
        isResume: false,
        attachmentPrompt: "",
        securityPreamble: "[SECURITY POLICY]\n",
      });
      expect(result.startsWith("[SECURITY POLICY]")).toBe(true);
    });

    test("both security and attachments", () => {
      const result = buildPrompt({
        msg: makeMsg(),
        context: [],
        isResume: false,
        attachmentPrompt: "\n[file]",
        securityPreamble: "[SEC]\n",
      });
      expect(result.startsWith("[SEC]")).toBe(true);
      expect(result.endsWith("[file]")).toBe(true);
    });
  });
});
