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
  RESERVED_ENV_PREFIXES,
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

describe("AgentEnvSchema — REJECTS the broadened reserved prefixes (cortex#2133)", () => {
  test("an ANTHROPIC_* key is rejected (auth / endpoint redirect vector)", () => {
    // Claude Code honours ANTHROPIC_BASE_URL / _API_KEY / _AUTH_TOKEN / _MODEL —
    // a declared value would redirect auth or the inference endpoint.
    expect(AgentEnvSchema.safeParse({ ANTHROPIC_BASE_URL: "https://evil" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ ANTHROPIC_API_KEY: "sk-evil" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ ANTHROPIC_AUTH_TOKEN: "t" }).success).toBe(false);
  });

  test("a CORTEX_* control var is rejected (would disable a cortex guard)", () => {
    // The MAJOR-1 vector: a declared CORTEX_BASH_GUARD could disable/widen the guard.
    const result = AgentEnvSchema.safeParse({
      CORTEX_BASH_GUARD: '{"rules":[{"pattern":".*"}]}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain("CORTEX_BASH_GUARD");
      expect(msg).toContain("default-deny");
    }
    expect(AgentEnvSchema.safeParse({ CORTEX_SKILL_GRANTS: "[]" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ CORTEX_MCP_GRANTS: "[]" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ CORTEX_CHANNEL: "spoofed" }).success).toBe(false);
  });

  test("a GROVE_* legacy-alias control var is rejected", () => {
    expect(AgentEnvSchema.safeParse({ GROVE_CHANNEL: "spoofed" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ GROVE_OPERATOR: "x" }).success).toBe(false);
  });

  test("the broadened deny is case-insensitive across all reserved prefixes", () => {
    expect(AgentEnvSchema.safeParse({ anthropic_base_url: "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ cortex_bash_guard: "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ Grove_Channel: "x" }).success).toBe(false);
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
  test("denies every reserved prefix case-insensitively; allows everything else", () => {
    // CLAUDE_
    expect(isDeniedAgentEnvKey("CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isDeniedAgentEnvKey("claude_config_dir")).toBe(true);
    expect(isDeniedAgentEnvKey("Claude_X")).toBe(true);
    // ANTHROPIC_
    expect(isDeniedAgentEnvKey("ANTHROPIC_BASE_URL")).toBe(true);
    expect(isDeniedAgentEnvKey("anthropic_api_key")).toBe(true);
    // CORTEX_ (now denied — this is the #2133 broadening)
    expect(isDeniedAgentEnvKey("CORTEX_BASH_GUARD")).toBe(true);
    expect(isDeniedAgentEnvKey("CORTEX_CHANNEL")).toBe(true);
    expect(isDeniedAgentEnvKey("cortex_skill_grants")).toBe(true);
    // GROVE_
    expect(isDeniedAgentEnvKey("GROVE_CHANNEL")).toBe(true);
    expect(isDeniedAgentEnvKey("grove_operator")).toBe(true);
    // Allowed — outside every reserved prefix.
    expect(isDeniedAgentEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(false);
    expect(isDeniedAgentEnvKey("GWS_PROFILE")).toBe(false);
    // A var that merely CONTAINS a reserved token (not a prefix) is fine.
    expect(isDeniedAgentEnvKey("MY_CLAUDE_HELPER")).toBe(false);
    expect(isDeniedAgentEnvKey("MY_CORTEX_HELPER")).toBe(false);
  });

  test("RESERVED_ENV_PREFIXES lists the four guarded namespaces", () => {
    expect([...RESERVED_ENV_PREFIXES]).toEqual([
      "CLAUDE_",
      "ANTHROPIC_",
      "CORTEX_",
      "GROVE_",
    ]);
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
