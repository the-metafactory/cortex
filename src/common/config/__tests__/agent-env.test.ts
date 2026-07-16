/**
 * cortex#2133 (epic #2164, TRUST-PATH) — per-agent env passthrough SCHEMA tests.
 *
 * The security-critical assertion: {@link AgentEnvSchema} is DENY-BY-DEFAULT (an
 * ALLOWLIST). Only the exact, case-sensitive names in
 * {@link ALLOWED_AGENT_ENV_KEYS} load; EVERY other name is rejected at
 * config-load time. This replaced a reserved-prefix DENYLIST that an adversarial
 * review of PR #2171 proved un-completable — the session-hijack set is
 * open-ended (BASH_ENV, PATH, NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES,
 * GIT_SSH_COMMAND, *_PROXY, NODE_EXTRA_CA_CERTS, CLAUDE_/ANTHROPIC_/CORTEX_/…).
 * The runtime defence-in-depth (resolveAgentEnv re-asserts the allowlist) is
 * asserted in `src/runner/__tests__/agent-env-passthrough.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import {
  AgentEnvSchema,
  isAllowedAgentEnvKey,
  isReservedRefSource,
  ALLOWED_AGENT_ENV_KEYS,
  AGENT_ENV_KEY_PATTERN,
} from "../agent-env";

/**
 * The adversarial hit-list — the open-ended set of session-hijacking env vars a
 * denylist could never fully enumerate. Every one MUST be rejected by the
 * allowlist at schema load AND dropped at runtime (the runtime half lives in the
 * passthrough test). Parametrised so this is a standing regression fence.
 */
const REJECT_LIST = [
  "BASH_ENV",
  "PATH",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "GIT_SSH_COMMAND",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_BASE_URL",
  "CORTEX_BASH_GUARD",
];

describe("AgentEnvSchema — accepts ONLY allowlisted keys", () => {
  test("the sole allowlisted var GOOGLE_APPLICATION_CREDENTIALS (a credential PATH) is accepted", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/andreas/.config/gws/sa.json",
    });
    expect(result.success).toBe(true);
  });

  test("an `env:NAME` secret reference on an allowlisted key is accepted (resolved at call time)", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "env:GWS_SA_PATH",
    });
    expect(result.success).toBe(true);
  });

  test("an empty map is accepted (no passthrough)", () => {
    expect(AgentEnvSchema.safeParse({}).success).toBe(true);
  });

  test("ALLOWED_AGENT_ENV_KEYS is seeded with exactly GOOGLE_APPLICATION_CREDENTIALS", () => {
    expect([...ALLOWED_AGENT_ENV_KEYS]).toEqual(["GOOGLE_APPLICATION_CREDENTIALS"]);
  });
});

describe("AgentEnvSchema — REJECTS the adversarial hit-list (deny-by-default regression fence)", () => {
  test.each(REJECT_LIST)("%s is rejected at schema load", (key) => {
    const result = AgentEnvSchema.safeParse({ [key]: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain(key);
      expect(msg.toLowerCase()).toContain("deny-by-default");
    }
  });

  test("a hit-list key is rejected even alongside the allowlisted key", () => {
    const result = AgentEnvSchema.safeParse({
      GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json",
      LD_PRELOAD: "/tmp/evil.so",
    });
    expect(result.success).toBe(false);
  });
});

describe("AgentEnvSchema — REJECTS non-allowlisted + case-variant keys", () => {
  test("an arbitrary non-allowlisted key FOO_BAR is rejected", () => {
    const result = AgentEnvSchema.safeParse({ FOO_BAR: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain("FOO_BAR");
      expect(msg.toLowerCase()).toContain("deny-by-default");
    }
  });

  test("case variants of the allowed key are rejected (env var names are case-sensitive)", () => {
    expect(
      AgentEnvSchema.safeParse({ google_application_credentials: "/x" }).success,
    ).toBe(false);
    expect(
      AgentEnvSchema.safeParse({ Google_Application_Credentials: "/x" }).success,
    ).toBe(false);
  });
});

describe("AgentEnvSchema — key/value shape validation (secondary POSIX-grammar gate)", () => {
  test("a non-identifier key is rejected", () => {
    expect(AgentEnvSchema.safeParse({ "bad-key": "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ "9LEADING_DIGIT": "x" }).success).toBe(false);
    expect(AgentEnvSchema.safeParse({ "has space": "x" }).success).toBe(false);
  });

  test("an empty-string value on the allowlisted key is rejected", () => {
    expect(
      AgentEnvSchema.safeParse({ GOOGLE_APPLICATION_CREDENTIALS: "" }).success,
    ).toBe(false);
  });
});

describe("isAllowedAgentEnvKey — the single-source allowlist predicate", () => {
  test("permits the blessed spelling; denies everything else, case-sensitively", () => {
    // Permitted — the exact blessed name.
    expect(isAllowedAgentEnvKey("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    // Case variants are NOT the blessed spelling (POSIX names are case-sensitive).
    expect(isAllowedAgentEnvKey("google_application_credentials")).toBe(false);
    expect(isAllowedAgentEnvKey("Google_Application_Credentials")).toBe(false);
    // The whole adversarial hit-list is denied.
    for (const key of REJECT_LIST) {
      expect(isAllowedAgentEnvKey(key)).toBe(false);
    }
    // An arbitrary key is denied.
    expect(isAllowedAgentEnvKey("FOO_BAR")).toBe(false);
  });
});

describe("isReservedRefSource — the env:NAME ref-source prefix deny (different shape)", () => {
  test("denies cortex/substrate control namespaces case-insensitively; allows others", () => {
    // A ref SOURCE is a READ from the daemon env — guarded by a prefix deny.
    expect(isReservedRefSource("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isReservedRefSource("anthropic_api_key")).toBe(true);
    expect(isReservedRefSource("CORTEX_BASH_GUARD")).toBe(true);
    expect(isReservedRefSource("grove_channel")).toBe(true);
    // A non-reserved daemon var is a legitimate credential source.
    expect(isReservedRefSource("GWS_SA_PATH")).toBe(false);
    expect(isReservedRefSource("MANDA_GWS_TOKEN")).toBe(false);
  });
});

describe("AGENT_ENV_KEY_PATTERN — POSIX identifier grammar (secondary gate)", () => {
  test("matches valid identifiers and rejects invalid ones", () => {
    expect(AGENT_ENV_KEY_PATTERN.test("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(AGENT_ENV_KEY_PATTERN.test("_UNDERSCORE_START")).toBe(true);
    expect(AGENT_ENV_KEY_PATTERN.test("1BAD")).toBe(false);
    expect(AGENT_ENV_KEY_PATTERN.test("has-dash")).toBe(false);
  });
});
