/**
 * F-092: Config Watcher Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigWatcher } from "../watcher";
import type { AgentConfig } from "../../types/config";

const TEST_CONFIG: AgentConfig = {
  agent: {
    name: "test",
    displayName: "Test Bot",
  },
  discord: [],
  mattermost: [],
  slack: [],
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
    receiver: {
      enabled: false,
      port: 8770,
      hostname: "127.0.0.1",
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

// ---------------------------------------------------------------------------
// cortex#135 — github.repos hot-reload regression test
// ---------------------------------------------------------------------------

describe("ConfigWatcher — github.repos hot-reload (cortex#135)", () => {
  let testConfigPath: string;
  const INITIAL_YAML = `
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
  beforeEach(() => {
    testConfigPath = join(tmpdir(), `cortex-c135-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(testConfigPath, INITIAL_YAML, "utf-8");
  });
  afterEach(() => {
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  test("adding a repo to github.repos applies as a safe field (no restart)", async () => {
    let capturedEvent: any = null;
    const watcher = new ConfigWatcher(testConfigPath, TEST_CONFIG, (event) => {
      capturedEvent = event;
    });

    // Updated config with one repo added — only `github.repos` changes.
    const updatedYaml = `
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
  repos:
    - the-metafactory/gorse
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
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    // github.repos lands in `applied` (safe field) — no restart needed.
    expect(capturedEvent.applied).toContain("github.repos");
    expect(capturedEvent.requiresRestart).not.toContain("github.repos");
    // The new repo is visible on the reloaded config.
    expect(capturedEvent.config.github.repos).toHaveLength(1);
    expect(capturedEvent.config.github.repos[0]).toBe("the-metafactory/gorse");
  });

  test("removing a repo from github.repos also applies as a safe field", async () => {
    // Seed with one repo so removal is a real change.
    const seededConfig: AgentConfig = {
      ...TEST_CONFIG,
      github: {
        ...TEST_CONFIG.github,
        repos: ["the-metafactory/gorse"],
      },
    };

    let capturedEvent: any = null;
    const watcher = new ConfigWatcher(testConfigPath, seededConfig, (event) => {
      capturedEvent = event;
    });

    const updatedYaml = `
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

    watcher.start();
    writeFileSync(testConfigPath, updatedYaml, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 300));
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.applied).toContain("github.repos");
    expect(capturedEvent.config.github.repos).toHaveLength(0);
  });
});
