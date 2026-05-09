import { test, expect, describe, beforeEach } from "bun:test";
import { MockAdapter } from "../../adapters/mock";
import { DispatchHandler } from "../dispatch-handler";
import type { InboundMessage } from "../../adapters/types";
import type { BotConfig } from "../../common/types/config";

// Minimal config that satisfies BotConfig shape for testing
function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    agent: {
      name: "test-agent",
      displayName: "TestBot",
      operatorDiscordId: "operator1",
      operatorMattermostId: undefined,
    },
    discord: [{
      token: "fake-token",
      guildId: "guild1",
      agentChannelId: "ch1",
      logChannelId: "log1",
      contextDepth: 10,
      enableAgentLog: false,
      roles: [],
      defaultRole: "allow-all",
    }],
    mattermost: [],
    claude: {
      timeoutMs: 120_000,
      asyncTimeoutMs: 900_000,
      additionalArgs: [],
      allowedTools: [],
      disallowedTools: [],
      allowedDirs: [],
      readOnlyDirs: [],
    },
    attachments: {
      enabled: false,
      maxFileSizeBytes: 10_000_000,
      maxTotalSizeBytes: 25_000_000,
      maxAttachmentsPerMessage: 10,
    },
    execution: {
      default: "local",
      backends: [],
    },
    paths: {
      publishedEventsDir: "/tmp/grove-test/published",
      logDir: "/tmp/grove-test/logs",
    },
    // Test-fixture completion: the grove-v2 source test pre-dates the addition of
    // `github` and `networks` to BotConfig and crashes at construction time
    // (`getAllRepos(config.github.repos)` on undefined). Filling the minimum schema
    // here so the lift's tests run; the runtime code is byte-identical to source.
    github: {
      webhookSecret: "",
      repos: [],
      agentDetection: {
        commitTrailers: [],
        branchPatterns: [],
        commentPatterns: [],
      },
    },
    networks: [],
    ...overrides,
  } as BotConfig;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "mock",
    instanceId: "mock-instance",
    authorId: "user1",
    authorName: "TestUser",
    content: "hello",
    channelId: "ch1",
    attachments: [],
    timestamp: new Date(),
    ...overrides,
  };
}

describe("DispatchHandler", () => {
  let adapter: MockAdapter;
  let router: DispatchHandler;

  beforeEach(() => {
    adapter = new MockAdapter();
    router = new DispatchHandler({
      config: makeConfig(),
      securityPreamble: "",
    });
  });

  describe("access control", () => {
    test("denied user gets error response", async () => {
      adapter.accessDecision = {
        allowed: false,
        features: { chat: false, async: false, team: false },
        denyReason: "Not authorized",
      };

      await router.handleMessage(adapter, makeMsg());

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Not authorized");
    });
  });

  describe("help mode", () => {
    test("/help returns help text without CC invocation", async () => {
      await router.handleMessage(adapter, makeMsg({ content: "/help" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("TestBot");
      expect(adapter.sentMessages[0]!.text).toContain("Chat");
      expect(adapter.sentMessages[0]!.text).toContain("async:");
    });

    test("help (no slash) also works", async () => {
      await router.handleMessage(adapter, makeMsg({ content: "help" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("TestBot");
    });
  });

  describe("async mode", () => {
    test("async: without feature access is denied", async () => {
      adapter.accessDecision = {
        allowed: true,
        features: { chat: true, async: false, team: false },
      };

      await router.handleMessage(adapter, makeMsg({ content: "async: do something" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Async tasks aren't available");
    });
  });

  describe("team mode", () => {
    test("team: without feature access is denied", async () => {
      adapter.accessDecision = {
        allowed: true,
        features: { chat: true, async: false, team: false },
      };

      await router.handleMessage(adapter, makeMsg({ content: "team: analyze this" }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.text).toContain("Team mode isn't available");
    });
  });

  describe("operator notification", () => {
    test("non-operator triggers notification", async () => {
      // user1 is not operator1, so notification should fire
      await router.handleMessage(adapter, makeMsg({
        platform: "discord",
        authorId: "user999",
        authorName: "Stranger",
        content: "/help",
      }));

      expect(adapter.operatorNotifications).toHaveLength(1);
      expect(adapter.operatorNotifications[0]!).toContain("Stranger");
    });

    test("operator does not trigger notification", async () => {
      await router.handleMessage(adapter, makeMsg({
        platform: "discord",
        authorId: "operator1",
        content: "/help",
      }));

      expect(adapter.operatorNotifications).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    test("router catches adapter errors gracefully", async () => {
      // Make resolveAccess throw
      const brokenAdapter = new MockAdapter();
      brokenAdapter.resolveAccess = () => { throw new Error("Boom"); };

      // Should not throw — router catches internally
      await router.handleMessage(brokenAdapter, makeMsg());

      // Should post error response
      expect(brokenAdapter.sentMessages).toHaveLength(1);
      expect(brokenAdapter.sentMessages[0]!.text).toContain("error occurred");
    });
  });

  describe("response target", () => {
    test("thread message targets the thread", async () => {
      await router.handleMessage(adapter, makeMsg({
        content: "/help",
        threadId: "thread123",
      }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.target.threadId).toBe("thread123");
    });

    test("channel message targets the channel", async () => {
      await router.handleMessage(adapter, makeMsg({
        content: "/help",
        channelId: "ch42",
      }));

      expect(adapter.sentMessages).toHaveLength(1);
      expect(adapter.sentMessages[0]!.target.channelId).toBe("ch42");
      expect(adapter.sentMessages[0]!.target.threadId).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    test("shutdown completes cleanly", async () => {
      // Just verify it doesn't throw
      await router.shutdown();
    });
  });
});
