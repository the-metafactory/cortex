/**
 * cortex#2133 (epic #2164, TRUST-PATH) — per-agent env passthrough SCHEMA tests.
 *
 * The security-critical assertion: {@link AgentEnvSchema} REJECTS any `CLAUDE_*`
 * key at config-load time, so the passthrough can never be a route to widen the
 * cortex#701 default-deny isolation boundary (the #2132 revert is the
 * precedent). The runtime defence-in-depth (resolveAgentEnv drops CLAUDE_* too)
 * is asserted in `src/runner/__tests__/agent-env-passthrough.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import {
  AgentEnvSchema,
  isDeniedAgentEnvKey,
  AGENT_ENV_KEY_PATTERN,
} from "../agent-env";

describe("AgentEnvSchema — accepts valid passthrough maps", () => {
  test("a non-secret literal (a credential PATH) is accepted", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/andreas/.config/gws/sa.json",
    });
    expect(result.success).toBe(true);
  });

  test("an `env:NAME` secret reference value is accepted (resolved at call time)", () => {
    const result = AgentEnvSchema.safeParse({
      SOME_TOKEN: "env:SOME_TOKEN",
    });
    expect(result.success).toBe(true);
  });

  test("an empty map is accepted (no passthrough)", () => {
    expect(AgentEnvSchema.safeParse({}).success).toBe(true);
  });

  test("a mix of several non-CLAUDE keys is accepted", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json",
      GWS_PROFILE: "manda",
      HTTPS_PROXY: "http://proxy.internal:8080",
    });
    expect(result.success).toBe(true);
  });
});

describe("AgentEnvSchema — REJECTS CLAUDE_* keys (cortex#701 security assertion)", () => {
  test("a bare CLAUDE_CONFIG_DIR key is rejected", () => {
    const result = AgentEnvSchema.safeParse({
      CLAUDE_CONFIG_DIR: "/tmp/evil-home",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error names the offending key and cites the isolation boundary.
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain("CLAUDE_CONFIG_DIR");
      expect(msg).toContain("default-deny");
    }
  });

  test("any CLAUDE_* var is rejected, even an unknown/future one", () => {
    expect(
      AgentEnvSchema.safeParse({ CLAUDE_CODE_EXTRA_SETTINGS_SOURCES: "/x" }).success,
    ).toBe(false);
    expect(
      AgentEnvSchema.safeParse({ CLAUDE_SOMETHING_NEW: "x" }).success,
    ).toBe(false);
  });

  test("the deny is case-insensitive — lower/mixed-case claude_ spellings are rejected", () => {
    expect(AgentEnvSchema.safeParse({ claude_config_dir: "/x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ Claude_Config_Dir: "/x" }).success).toBe(false);
  });

  test("a CLAUDE_* key is rejected even alongside otherwise-valid keys", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-evil",
    });
    expect(result.success).toBe(false);
  });
});

describe("AgentEnvSchema — key/value shape validation", () => {
  test("a non-identifier key is rejected", () => {
    expect(AgentEnvSchema.safeParse({ "bad-key": "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ "9LEADING_DIGIT": "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ "has space": "x" }).success).toBe(false);
  });

  test("an empty-string value is rejected", () => {
    expect(AgentEnvSchema.safeParse({ GOOD_KEY: "" }).success).toBe(false);
  });
});

describe("isDeniedAgentEnvKey — the single-source deny predicate", () => {
  test("denies CLAUDE_* case-insensitively; allows everything else", () => {
    expect(isDeniedAgentEnvKey("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isDeniedAgentEnvKey("claude_config_dir")).toBe(true);
    expect(isDeniedAgentEnvKey("Claude_X")).toBe(true);
    expect(isDeniedAgentEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(false);
    expect(isDeniedAgentEnvKey("CORTEX_CHANNEL")).toBe(false);
    // Not a CLAUDE_ prefix — a var that merely contains "claude" is fine.
    expect(isDeniedAgentEnvKey("MY_CLAUDE_HELPER")).toBe(false);
  });
});

describe("AGENT_ENV_KEY_PATTERN — POSIX identifier grammar", () => {
  test("matches valid identifiers and rejects invalid ones", () => {
    expect(AGENT_ENV_KEY_PATTERN.test("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(AGENT_ENV_KEY_PATTERN.test("_UNDERSCORE_START")).toBe(true);
    expect(AGENT_ENV_KEY_PATTERN.test("1BAD")).toBe(false);
    expect(AGENT_ENV_KEY_PATTERN.test("has-dash")).toBe(false);
  });
});
