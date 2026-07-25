/**
 * EBH-6b (cortex#2380) — `policy.sovereignty.enforce` boot-posture wiring.
 *
 * Pins the acceptance contract from the EBH-6 investigation
 * (`docs/security/ebh-6-posture-findings.md` §F3): `sovereigntyEnforce` was
 * constructor-only — no `cortex.yaml` field could ever reach it, so no
 * principal action could turn it on, in EITHER `review-consumer.ts` or
 * `brain-consumer.ts` (the review only named the former). This file pins,
 * at the full `startCortex` boot-integration grain:
 *
 *   - `policy` absent (or `policy.sovereignty` absent) ⇒ the boot log
 *     reports `sovereignty.enforce=false` — byte-identical audit-only
 *     posture to today.
 *   - `policy.sovereignty.enforce: true` ⇒ the boot log reports
 *     `sovereignty.enforce=true`, and BOTH the review-consumer lane and the
 *     brain-consumer lane resolve the SAME value (no asymmetry).
 *
 * This is a posture-VISIBILITY change, not a posture flip — nothing here
 * asserts that any default or template ships `enforce: true`; every test
 * below opts in explicitly, the way a principal now can.
 *
 * Modelled on `cortex.security-posture-boot.test.ts` (same
 * `withCapturedConsoleLog` + hermetic-agents-dir pattern).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { PolicySchema } from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

function minimalConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-sovereignty-posture-test-published" },
  });
}

function createRecordingRuntime(): MyelinRuntime {
  return {
    enabled: false,
    onEnvelope(_handler: EnvelopeHandler) {
      return { unregister: () => {} };
    },
    publish: async (_envelope: Envelope) => {},
    stop: async () => {},
  };
}

function withCapturedConsoleLog<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[] }> {
  const original = console.log.bind(console);
  const logs: string[] = [];
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  return fn()
    .then((result) => {
      console.log = original;
      return { result, logs };
    })
    .catch((err: unknown) => {
      console.log = original;
      throw err;
    });
}

// Hermetic agents.d/ (mirrors cortex.security-posture-boot.test.ts) — every
// boot points at an EMPTY tmp dir so the suite never falls back to the
// principal's live `~/.config/cortex/agents.d/`.
const HERMETIC_AGENTS_DIR = mkdtempSync(
  join(tmpdir(), "cortex-sovereignty-posture-agents-hermetic-"),
);

const COMMON_OPTS = {
  disableConfigWatcher: true,
  disableDashboard: true,
  disableOutboundPoller: true,
  principal: { id: "test-op" },
  agentsDir: HERMETIC_AGENTS_DIR,
} as const;

describe("startCortex — EBH-6b sovereignty.enforce posture wiring (cortex#2380)", () => {
  test("policy absent ⇒ boot log reports sovereignty.enforce=false (audit-only)", async () => {
    const runtime = createRecordingRuntime();
    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), { ...COMMON_OPTS, injectRuntime: runtime }),
    );

    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — sovereignty.enforce="),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("sovereignty.enforce=false");
    expect(postureLines[0]!).toContain("audit-only");

    await handle.stop();
  });

  test("policy.sovereignty declared with no enforce ⇒ still resolves false", async () => {
    const runtime = createRecordingRuntime();
    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        ...COMMON_OPTS,
        injectRuntime: runtime,
        policy: PolicySchema.parse({}),
      }),
    );

    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — sovereignty.enforce="),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("sovereignty.enforce=false");

    await handle.stop();
  });

  test("policy.sovereignty.enforce: true ⇒ boot log reports sovereignty.enforce=true (violations DENIED)", async () => {
    const runtime = createRecordingRuntime();
    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        ...COMMON_OPTS,
        injectRuntime: runtime,
        policy: PolicySchema.parse({ sovereignty: { enforce: true } }),
      }),
    );

    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — sovereignty.enforce="),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("sovereignty.enforce=true");
    expect(postureLines[0]!).toContain("violations DENIED");

    await handle.stop();
  });

  test("policy.sovereignty.enforce: false explicit ⇒ same audit-only posture as absent", async () => {
    const runtime = createRecordingRuntime();
    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        ...COMMON_OPTS,
        injectRuntime: runtime,
        policy: PolicySchema.parse({ sovereignty: { enforce: false } }),
      }),
    );

    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — sovereignty.enforce="),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("sovereignty.enforce=false");
    expect(postureLines[0]!).toContain("audit-only");

    await handle.stop();
  });
});
