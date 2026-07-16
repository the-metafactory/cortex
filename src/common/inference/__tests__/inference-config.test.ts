/**
 * API-P0.2 (epic #2055, Phase 0, D6) — `inference` config schema + secret-
 * reference resolution.
 *
 * This is a SECURITY-SENSITIVE lane (provider credentials + model egress). The
 * tests lock in the three load-time invariants and the one call-time seam:
 *
 *   1. ACCEPT — the design §Configuration example block parses.
 *   2. REJECT — a profile referencing a missing provider fails load with a
 *      descriptive, path-pointed error; a literal (non-`env:`) secret is rejected.
 *   3. REDACTION — a loaded/serialized config shows `env:NAME` references only;
 *      no resolved secret value ever appears on the object or in a dump/log.
 *   4. RESOLUTION — the secret VALUE is materialized only by `resolveSecretRef`,
 *      at call time, from the environment; a missing env var throws (never a value).
 */

import { test, expect, describe } from "bun:test";
import { InferenceConfigSchema } from "../../types/cortex-config";
import {
  SecretRefSchema,
  resolveSecretRef,
  secretRefEnvVar,
  SecretRefResolutionError,
  SECRET_REF_PATTERN,
} from "../secret-ref";

// The design §Configuration example block (issue #2057 "What to build").
const EXAMPLE_INFERENCE = {
  providers: {
    anthropic: {
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "env:ANTHROPIC_API_KEY",
      headers: {
        "anthropic-beta": "env:ANTHROPIC_BETA_HEADER",
      },
      capabilities: {
        streaming: true,
        tools: true,
        images: true,
        structuredOutput: false,
      },
    },
    "local-llama": {
      protocol: "openai-chat-completions",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "env:LOCAL_LLAMA_KEY",
    },
  },
  profiles: {
    "default-frontier": {
      provider: "anthropic",
      model: "claude-opus-4-8",
      maxOutputTokens: 8192,
      modelClass: "frontier",
      dataResidency: "us",
    },
    "on-box": {
      provider: "local-llama",
      model: "llama-3.3-70b",
      modelClass: "local-only",
      options: {
        anthropic: { foo: "bar" },
      },
    },
  },
} as const;

describe("InferenceConfigSchema — accept", () => {
  test("parses the design §Configuration example block without error", () => {
    const parsed = InferenceConfigSchema.parse(EXAMPLE_INFERENCE);
    expect(Object.keys(parsed.providers)).toEqual(["anthropic", "local-llama"]);
    expect(Object.keys(parsed.profiles)).toEqual(["default-frontier", "on-box"]);
    expect(parsed.profiles["default-frontier"]?.modelClass).toBe("frontier");
    expect(parsed.profiles["on-box"]?.modelClass).toBe("local-only");
  });

  test("empty providers/profiles maps are valid (block is optional)", () => {
    const parsed = InferenceConfigSchema.parse({});
    expect(parsed.providers).toEqual({});
    expect(parsed.profiles).toEqual({});
  });

  test("modelClass accepts exactly local-only | frontier | any", () => {
    for (const modelClass of ["local-only", "frontier", "any"] as const) {
      const parsed = InferenceConfigSchema.parse({
        providers: { p: { protocol: "anthropic-messages", baseUrl: "https://x.example", apiKey: "env:K" } },
        profiles: { pr: { provider: "p", model: "m", modelClass } },
      });
      expect(parsed.profiles.pr?.modelClass).toBe(modelClass);
    }
  });
});

describe("InferenceConfigSchema — reject", () => {
  test("a profile referencing a missing provider fails load with a descriptive error", () => {
    const result = InferenceConfigSchema.safeParse({
      providers: {
        anthropic: { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "env:K" },
      },
      profiles: {
        broken: { provider: "does-not-exist", model: "m", modelClass: "any" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected parse failure");
    const issue = result.error.issues.find((i) => i.path.join(".") === "profiles.broken.provider");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("does-not-exist");
    expect(issue?.message).toContain("not defined in inference.providers");
  });

  test("rejects an invalid modelClass literal", () => {
    const result = InferenceConfigSchema.safeParse({
      providers: { p: { protocol: "anthropic-messages", baseUrl: "https://x.example", apiKey: "env:K" } },
      profiles: { pr: { provider: "p", model: "m", modelClass: "premium" } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a LITERAL apiKey (non-env: reference) — never a raw secret in config", () => {
    const result = InferenceConfigSchema.safeParse({
      providers: {
        anthropic: {
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-ant-THIS-IS-A-LITERAL-SECRET",
        },
      },
      profiles: {},
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected parse failure");
    const issue = result.error.issues.find((i) => i.path.join(".") === "providers.anthropic.apiKey");
    expect(issue?.message).toContain("env:NAME");
  });

  test("rejects a LITERAL header value (non-env: reference)", () => {
    const result = InferenceConfigSchema.safeParse({
      providers: {
        anthropic: {
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          apiKey: "env:K",
          headers: { authorization: "Bearer sk-live-literal" },
        },
      },
      profiles: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown protocol", () => {
    const result = InferenceConfigSchema.safeParse({
      providers: { p: { protocol: "grpc-magic", baseUrl: "https://x.example", apiKey: "env:K" } },
      profiles: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("secret redaction — no resolved value on the parsed/serialized config", () => {
  const SECRET_VALUE = "sk-ant-SUPER-SECRET-VALUE-DO-NOT-LEAK";

  test("a config dump/log shows env:NAME references, never the secret value", () => {
    // Populate the environment as a live daemon would.
    process.env.ANTHROPIC_API_KEY = SECRET_VALUE;
    process.env.ANTHROPIC_BETA_HEADER = "beta-secret-token";
    process.env.LOCAL_LLAMA_KEY = "local-secret";
    try {
      const parsed = InferenceConfigSchema.parse(EXAMPLE_INFERENCE);

      // The reference survives on the object; the value does not.
      expect(parsed.providers.anthropic?.apiKey).toBe("env:ANTHROPIC_API_KEY");
      expect(parsed.providers.anthropic?.headers?.["anthropic-beta"]).toBe("env:ANTHROPIC_BETA_HEADER");

      // A JSON dump (the shape a log/serialize would emit) carries no secret value.
      const dumped = JSON.stringify(parsed);
      expect(dumped).not.toContain(SECRET_VALUE);
      expect(dumped).not.toContain("beta-secret-token");
      expect(dumped).not.toContain("local-secret");
      expect(dumped).toContain("env:ANTHROPIC_API_KEY");

      // Belt-and-suspenders: walk every string leaf, prove no env value leaked.
      const leaves: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") leaves.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(parsed);
      for (const leaf of leaves) {
        expect(leaf).not.toBe(SECRET_VALUE);
        expect(leaf).not.toBe("beta-secret-token");
        expect(leaf).not.toBe("local-secret");
      }
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BETA_HEADER;
      delete process.env.LOCAL_LLAMA_KEY;
    }
  });
});

describe("resolveSecretRef — call-time resolution only", () => {
  test("resolves env:NAME from the injected environment", () => {
    expect(resolveSecretRef("env:MY_KEY", { MY_KEY: "the-value" })).toBe("the-value");
  });

  test("throws (never returns a value) when the env var is unset", () => {
    expect(() => resolveSecretRef("env:MISSING", {})).toThrow(SecretRefResolutionError);
  });

  test("throws when the env var is empty / whitespace-only", () => {
    expect(() => resolveSecretRef("env:BLANK", { BLANK: "   " })).toThrow(SecretRefResolutionError);
  });

  test("throws on a malformed (non-env:) reference — never returns a value", () => {
    // A malformed ref cannot name a resolvable secret; resolution throws rather
    // than silently returning some fallback the harness might send upstream.
    expect(() => resolveSecretRef("not-a-ref", { "not-a-ref": "should-be-ignored" })).toThrow(
      SecretRefResolutionError,
    );
  });

  test("SecretRefSchema + helpers agree on the env:NAME shape", () => {
    expect(SecretRefSchema.safeParse("env:ANTHROPIC_API_KEY").success).toBe(true);
    expect(SecretRefSchema.safeParse("env:").success).toBe(false);
    expect(SecretRefSchema.safeParse("literal").success).toBe(false);
    expect(secretRefEnvVar("env:ABC_123")).toBe("ABC_123");
    expect(secretRefEnvVar("nope")).toBeUndefined();
    expect(SECRET_REF_PATTERN.test("env:X")).toBe(true);
  });
});
