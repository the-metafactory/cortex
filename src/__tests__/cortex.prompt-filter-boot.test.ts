/**
 * cortex#2184 — `cortex start` hard-fails when @metafactory/content-filter
 * failed to load, unless the deliberate opt-out env var is set.
 *
 * `assertPromptFilterReady("cortex start")` is the FIRST statement in
 * `startCortex` (src/cortex.ts) — a load failure rejects the boot promise
 * before any runtime/NATS/dispatch wiring runs, so these tests don't need
 * the heavier recording-runtime harness other boot tests use (e.g.
 * `cortex.security-posture-boot.test.ts`).
 *
 * The load failure is simulated via prompt-filter's `__set…ForTests` test
 * seam — never by uninstalling @metafactory/content-filter (verified working
 * on this machine; cortex#2184 issue body).
 */

import { describe, test, expect, afterEach } from "bun:test";
import { startCortex, bootOrDie } from "../cortex";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import {
  __setPromptFilterLoadErrorForTests,
} from "../runner/prompt-filter";

function minimalConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-promptfilter-boot-test-published" },
  });
}

describe("startCortex — prompt-filter boot gate (cortex#2184)", () => {
  const ENV_VAR = "CORTEX_ALLOW_UNSCANNED_PROMPTS";
  const originalEnv = process.env[ENV_VAR];

  afterEach(() => {
    __setPromptFilterLoadErrorForTests(null);
    if (originalEnv === undefined) delete process.env.CORTEX_ALLOW_UNSCANNED_PROMPTS;
    else process.env[ENV_VAR] = originalEnv;
  });

  test("content-filter NOT loadable + opt-out unset → startCortex rejects with an actionable error", async () => {
    __setPromptFilterLoadErrorForTests("simulated: Cannot find package '@metafactory/content-filter'");
    delete process.env.CORTEX_ALLOW_UNSCANNED_PROMPTS;

    await expect(startCortex(minimalConfig())).rejects.toThrow(
      /@metafactory\/content-filter/,
    );
  });

  test("content-filter NOT loadable → bootOrDie maps the rejection to process.exit(1) (mirrors every other fatal boot check)", async () => {
    __setPromptFilterLoadErrorForTests("simulated load failure");
    delete process.env.CORTEX_ALLOW_UNSCANNED_PROMPTS;

    const origExit = process.exit;
    const origError = console.error;
    let exitCode: number | undefined;
    const errors: string[] = [];
    process.exit = (code?: number): never => {
      exitCode = code;
      // bootOrDie doesn't use the return value; throw to unwind like a real
      // process.exit would (no code after it runs in production).
      throw new Error("__test_process_exit__");
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      await expect(
        bootOrDie(() => startCortex(minimalConfig()), "/tmp/grove-cortex-promptfilter-boot-test.pid"),
      ).rejects.toThrow("__test_process_exit__");
    } finally {
      process.exit = origExit;
      console.error = origError;
    }

    expect(exitCode).toBe(1);
    expect(errors.some((l) => l.includes("FATAL") && l.includes("@metafactory/content-filter"))).toBe(true);
  });

  test("content-filter NOT loadable + opt-out set → startCortex proceeds past the gate (fails later for unrelated harness reasons, not the gate)", async () => {
    __setPromptFilterLoadErrorForTests("simulated load failure");
    process.env[ENV_VAR] = "1";

    const logged: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    try {
      // No `nats:` block in minimalConfig() → no real NATS connect attempted,
      // so startCortex can fully resolve here. We only assert it did NOT fail
      // with the prompt-filter gate's message (i.e. it proceeded past the
      // gate), and that the one loud SECURITY warning fired. Stop the handle
      // either way so no boot-started timers/watchers leak into other test
      // files in the same process.
      const handle = await startCortex(minimalConfig()).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain("REFUSING TO PROCEED");
        return null;
      });
      if (handle) await handle.stop();
    } finally {
      console.error = orig;
    }

    const warnings = logged.filter((l) => l.includes("SECURITY") && l.includes(ENV_VAR));
    expect(warnings.length).toBe(1);
  });
});
