/**
 * F-092: Config Watcher Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigWatcher } from "../watcher";
import type { AgentConfig } from "../../types/config";

/**
 * Poll `condition` every `intervalMs` until it returns truthy or `timeoutMs`
 * expires (default 2000ms). Returns true when condition satisfied, false on
 * timeout. Replaces fixed-duration `setTimeout(300)` waits that proved racy
 * under loaded CI runners where fs.watch + the 200ms ConfigWatcher debounce
 * together could exceed 300ms (cortex#699).
 */
async function pollUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 30,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return condition();
}

/**
 * Small grace period after `watcher.start()` before writing a file.
 * ConfigWatcher uses `node:fs.watch` whose subscription is not guaranteed to
 * be bound synchronously — writing the file immediately after start() risks
 * missing the event (macOS FSEvents / Linux inotify subscription races).
 * 100ms is deliberately larger than AgentsDirectoryWatcher's 30ms
 * `registrationGraceMs` to provide margin on slow CI runners (cortex#699).
 */
function watcherReady(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 100));
}

/**
 * Write a single-file config fixture at 0600. TC-4a (cortex#636): the
 * single-file config read enforces chmod 600 (it carries platform bot
 * tokens), so the watcher's reload path rejects looser modes. `chmodSync`
 * (not the writeFileSync `mode` option) because reload tests rewrite an
 * existing fixture in place, and the `mode` option only applies on creation.
 */
function writeConfigFixture(path: string, yaml: string): void {
  writeFileSync(path, yaml, "utf-8");
  chmodSync(path, 0o600);
}

const TEST_CONFIG: AgentConfig = {
  agent: {
    name: "test",
    displayName: "Test Bot",
  },
  discord: [],
  mattermost: [],
  slack: [],
  security: {
    signing: "off",
    encryption: { payload: "off", at_rest: "off" },
    transport: { mtls: "off" },
  },
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
  cockpit: {
    enabled: false,
    docsDir: "docs",
    repo: "",
    refreshIntervalMs: 300_000,
    attention: { surface: "discord", channel: "" },
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
    writeConfigFixture(testConfigPath, yaml);
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
    // Grace period: ensure the fs.watch subscription is bound before writing
    // (cortex#699 — see watcherReady() above).
    await watcherReady();
    writeConfigFixture(testConfigPath, updatedYaml);

    // Poll until callback fires: fs.watch + 200ms debounce can exceed a fixed
    // 300ms wait on loaded CI runners (cortex#699). 4 s stays inside the bun
    // default 5 s per-test timeout while absorbing kernel inotify/FSEvents
    // delays under peak I/O.
    await pollUntil(() => capturedEvent !== null, 4_000);
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
    await watcherReady();
    writeConfigFixture(testConfigPath, updatedYaml);

    // Poll until callback fires (cortex#699 — see comment in "identifies safe
    // field changes" for why a fixed 300ms wait is racy on loaded CI).
    await pollUntil(() => capturedEvent !== null);
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
    writeConfigFixture(testConfigPath, INITIAL_YAML);
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
    await watcherReady();
    writeConfigFixture(testConfigPath, updatedYaml);
    await pollUntil(() => capturedEvent !== null);
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
    await watcherReady();
    writeConfigFixture(testConfigPath, updatedYaml);
    await pollUntil(() => capturedEvent !== null);
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.applied).toContain("github.repos");
    expect(capturedEvent.config.github.repos).toHaveLength(0);
  });
});
