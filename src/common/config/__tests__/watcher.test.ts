/**
 * F-092: Config Watcher Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigWatcher } from "../watcher";
import type { BotConfig } from "../../types/config";

const TEST_CONFIG: BotConfig = {
  agent: {
    name: "test",
    displayName: "Test Bot",
  },
  discord: [],
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
    enabled: true,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxTotalSizeBytes: 25 * 1024 * 1024,
    maxAttachmentsPerMessage: 10,
  },
  execution: {
    default: "local",
    backends: [],
  },
  github: {
    webhookSecret: "",
    repos: [],
    agentDetection: {
      commitTrailers: ["Co-Authored-By: Claude"],
      branchPatterns: ["^feat/(g|f|i)-\\d+"],
      commentPatterns: ["^Starting:", "^Completed:"],
    },
  },
  api: {
    enabled: false,
    port: 8766,
    corsOrigin: "*",
    mode: "local",
    endpoint: "",
    apiKey: "",
    operatorId: "",
    cfAccessClientId: "",
    cfAccessClientSecret: "",
  },
  grove: {
    notifications: { discord: false },
    baseUrl: "",
  },
  paths: {
    publishedEventsDir: "~/.claude/events/published",
    logDir: "~/.config/grove/logs",
  },
  networksDir: "./networks",
  networks: [],
};

describe("ConfigWatcher", () => {
  let testConfigPath: string;

  beforeEach(() => {
    testConfigPath = join(tmpdir(), `test-bot-${Date.now()}.yaml`);
    // Write initial config
    const yaml = `
agent:
  name: test
  displayName: Test Bot
discord: []
mattermost: []
claude:
  timeoutMs: 120000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
  disallowedTools: []
  allowedDirs: []
  readOnlyDirs: []
attachments:
  enabled: true
  maxFileSizeBytes: 10485760
  maxTotalSizeBytes: 26214400
  maxAttachmentsPerMessage: 10
execution:
  default: local
  backends: []
github:
  webhookSecret: ""
  repos: []
  agentDetection:
    commitTrailers:
      - "Co-Authored-By: Claude"
    branchPatterns:
      - "^feat/(g|f|i)-\\\\d+"
    commentPatterns:
      - "^Starting:"
      - "^Completed:"
api:
  enabled: false
  port: 8766
  corsOrigin: "*"
  mode: local
  endpoint: ""
  apiKey: ""
  operatorId: ""
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;
    writeFileSync(testConfigPath, yaml, "utf-8");
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
  });

  test("identifies safe field changes", async () => {
    let capturedEvent: any = null;

    const watcher = new ConfigWatcher(testConfigPath, TEST_CONFIG, (event) => {
      capturedEvent = event;
    });

    // Update a safe field (timeoutMs)
    const updatedYaml = `
agent:
  name: test
  displayName: Test Bot
discord: []
mattermost: []
claude:
  timeoutMs: 180000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
  disallowedTools: []
  allowedDirs: []
  readOnlyDirs: []
attachments:
  enabled: true
  maxFileSizeBytes: 10485760
  maxTotalSizeBytes: 26214400
  maxAttachmentsPerMessage: 10
execution:
  default: local
  backends: []
github:
  webhookSecret: ""
  repos: []
  agentDetection:
    commitTrailers:
      - "Co-Authored-By: Claude"
    branchPatterns:
      - "^feat/(g|f|i)-\\\\d+"
    commentPatterns:
      - "^Starting:"
      - "^Completed:"
api:
  enabled: false
  port: 8766
  corsOrigin: "*"
  mode: local
  endpoint: ""
  apiKey: ""
  operatorId: ""
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    writeFileSync(testConfigPath, updatedYaml, "utf-8");

    // Wait for debounced reload
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.applied).toContain("claude.timeoutMs");
    expect(capturedEvent.requiresRestart).toHaveLength(0);
  });

  test("identifies restart-required field changes", async () => {
    let capturedEvent: any = null;

    const watcher = new ConfigWatcher(testConfigPath, TEST_CONFIG, (event) => {
      capturedEvent = event;
    });

    // Update a restart field (agent.name)
    const updatedYaml = `
agent:
  name: new-name
  displayName: Test Bot
discord: []
mattermost: []
claude:
  timeoutMs: 120000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
  disallowedTools: []
  allowedDirs: []
  readOnlyDirs: []
attachments:
  enabled: true
  maxFileSizeBytes: 10485760
  maxTotalSizeBytes: 26214400
  maxAttachmentsPerMessage: 10
execution:
  default: local
  backends: []
github:
  webhookSecret: ""
  repos: []
  agentDetection:
    commitTrailers:
      - "Co-Authored-By: Claude"
    branchPatterns:
      - "^feat/(g|f|i)-\\\\d+"
    commentPatterns:
      - "^Starting:"
      - "^Completed:"
api:
  enabled: false
  port: 8766
  corsOrigin: "*"
  mode: local
  endpoint: ""
  apiKey: ""
  operatorId: ""
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    writeFileSync(testConfigPath, updatedYaml, "utf-8");

    // Wait for debounced reload
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.requiresRestart).toContain("agent.name");
    expect(capturedEvent.applied).toHaveLength(0);
  });
});
