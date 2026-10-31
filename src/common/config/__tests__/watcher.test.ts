/**
 * F-092: Config Watcher Tests
 */

import { test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigWatcher } from "../watcher";
import type { AgentConfig } from "../../types/config";
import { describeWithFsWatch } from "../../test-fs-watch";

// Room for the readiness handshake plus an event wait on a loaded machine.
// Per file: bunfig.toml's `[test] timeout` is not read by Bun 1.3 (node #2576).
setDefaultTimeout(20_000);

/**
 * Poll `condition` every `intervalMs` until it returns truthy or `timeoutMs`
 * expires. Returns true when condition satisfied, false on timeout. Replaces
 * fixed-duration `setTimeout(300)` waits that proved racy under loaded CI
 * runners where fs.watch + the 200ms ConfigWatcher debounce together could
 * exceed 300ms (cortex#699).
 *
 * The default deadline is 8000ms (cortex#771, node #2576): the reload tests
 * depend on a real `node:fs.watch` event PLUS the watcher's 200ms debounce on
 * a loaded machine. With the `waitForReady()` handshake (up to 8s) it stays
 * inside this file's 20s per-test timeout.
 */
async function pollUntil(
  condition: () => boolean,
  timeoutMs = 8000,
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
  ledger: {},
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
  plugins: {
    external: false,
    signing: "off",
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
  vigil: { proposal_timeout_ms: 30_000, enabled: false, soma_homes: {}, cadence: {}, result_base_url: "http://127.0.0.1:8767" },
  mc: {
    enabled: false,
    configPath: "",
    dbPath: "",
    port: 0,
    sideband: "http://127.0.0.1:9092",
    desk: { enabled: true, displayName: "", topN: 5, ranger: { url: "", bin: "", config: "" }, areas: [], sources: [], ask: { parser: [], timeoutSeconds: 30, writers: {}, taskMaps: [] }, interruptions: { transport: "none", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: true } },
    server: { enabled: true },
    aggregateLocalStacks: { enabled: true, dbRead: true, configRoot: "", stacks: [] },
  },
  networksDir: "./networks",
  networks: [],
};

describeWithFsWatch("ConfigWatcher", () => {
  let testConfigPath: string;

  beforeEach(() => {
    // Unique suffix (not just Date.now()) so concurrent test FILES — Bun runs
    // them in parallel — can never collide on the same /tmp fixture path and
    // unlink each other's config mid-watch (cortex#771). Mirrors the
    // github.repos block's `${Date.now()}-${Math.random()}` pattern below.
    testConfigPath = join(
      tmpdir(),
      `test-bot-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`,
    );
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
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    // A write that lands before fs.watch binds is never reported (node #2576).
    await watcher.waitForReady();
    writeConfigFixture(testConfigPath, updatedYaml);

    // Poll until callback fires: fs.watch + 200ms debounce can exceed a fixed
    // 300ms wait on loaded CI runners (cortex#699); see pollUntil for the bound.
    await pollUntil(() => capturedEvent !== null);
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
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    await watcher.waitForReady();
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

describeWithFsWatch("ConfigWatcher — github.repos hot-reload (cortex#135)", () => {
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
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    await watcher.waitForReady();
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
paths:
  publishedEventsDir: "~/.claude/events/published"
  logDir: "~/.config/grove/logs"
`;

    watcher.start();
    await watcher.waitForReady();
    writeConfigFixture(testConfigPath, updatedYaml);
    await pollUntil(() => capturedEvent !== null);
    watcher.stop();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent.applied).toContain("github.repos");
    expect(capturedEvent.config.github.repos).toHaveLength(0);
  });
});
