/**
 * cortex#400 — unit tests for `buildReviewSessionOpts`.
 *
 * The boot wiring at `cortex.ts:894` (per-agent ReviewConsumer
 * instantiation loop) hands the per-agent `sessionOpts` to the
 * review-consumer; the consumer forwards them through PR-5's pipeline
 * into `CCSession`. Without these opts the spawned CC sees neither
 * `--permission-mode bypassPermissions` nor `allowedTools/allowedDirs`,
 * and the `/review owner/repo#N` slash command refuses with "I don't
 * have access to GitHub CLI tools" (root cause of #400).
 *
 * The boot test (`cortex.review-consumer-boot.test.ts`) asserts the
 * subscribePull + ready-log surface but never inspects sessionOpts —
 * deleting the wiring leaves all six boot tests green. This file
 * closes that regression gap by asserting the projection directly.
 */

import { describe, expect, test } from "bun:test";
import { BotConfigSchema, type BotConfig } from "../common/types/config";
import type { Agent } from "../common/types/cortex-config";
import { buildReviewSessionOpts } from "../cortex";

function configWith(claudeOverrides: Partial<BotConfig["claude"]>): BotConfig {
  return BotConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
      operatorId: "test-op",
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
      ...claudeOverrides,
    },
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
  });
}

function agent(
  overrides: Partial<Pick<Agent, "id" | "displayName">> = {},
): Pick<Agent, "id" | "displayName"> {
  return {
    id: overrides.id ?? "holly",
    displayName: overrides.displayName ?? "Holly",
  };
}

describe("buildReviewSessionOpts — bus-side review-consumer CC opts", () => {
  test("projects config.claude.additionalArgs verbatim (the bypassPermissions vehicle)", () => {
    const config = configWith({
      additionalArgs: ["--permission-mode", "bypassPermissions"],
    });
    const opts = buildReviewSessionOpts(config, agent());
    expect(opts.additionalArgs).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  test("projects allowedTools / disallowedTools / allowedDirs verbatim", () => {
    const config = configWith({
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Write"],
      allowedDirs: ["/home/clawbox/code"],
    });
    const opts = buildReviewSessionOpts(config, agent());
    expect(opts.allowedTools).toEqual(["Bash", "Read"]);
    expect(opts.disallowedTools).toEqual(["Write"]);
    expect(opts.allowedDirs).toEqual(["/home/clawbox/code"]);
  });

  test("uses asyncTimeoutMs (review work is async — matches the Discord path)", () => {
    const config = configWith({ asyncTimeoutMs: 1_800_000 });
    const opts = buildReviewSessionOpts(config, agent());
    expect(opts.timeoutMs).toBe(1_800_000);
  });

  test("threads the agent id + displayName so CC sets GROVE_AGENT_* env vars", () => {
    const opts = buildReviewSessionOpts(
      configWith({}),
      agent({ id: "holly", displayName: "Holly" }),
    );
    expect(opts.agentId).toBe("holly");
    expect(opts.agentName).toBe("Holly");
  });

  test("sets cwd to process.cwd() so the spawned CC inherits the daemon's working dir", () => {
    const opts = buildReviewSessionOpts(configWith({}), agent());
    expect(opts.cwd).toBe(process.cwd());
  });

  test("propagates bashAllowlist when present", () => {
    const config = configWith({
      bashAllowlist: {
        rules: [{ pattern: "^git ", repos: ["cortex"] }],
        repos: ["cortex"],
      },
    });
    const opts = buildReviewSessionOpts(config, agent());
    expect(opts.bashAllowlist).toEqual({
      rules: [{ pattern: "^git ", repos: ["cortex"] }],
      repos: ["cortex"],
    });
  });

  test("omits bashAllowlist when config.claude.bashAllowlist is undefined", () => {
    const opts = buildReviewSessionOpts(configWith({}), agent());
    expect("bashAllowlist" in opts).toBe(false);
  });
});
