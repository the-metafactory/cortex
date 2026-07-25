/**
 * cortex#2347 (EBH-5 follow-up, adversarial review Finding 2 — availability)
 * — boot-level proof that `system.plugins.signing: "enforce"` with an EMPTY
 * plugin trust root REFUSES TO BOOT immediately, with a named/actionable
 * error, rather than crashing several stages later at the renderer-coverage
 * guard with an error that looks unrelated to `signing`.
 *
 * Modelled on `cortex.security-posture-boot.test.ts`'s
 * "TC-1b: enforce + no stack identity → REFUSES TO BOOT" test (same
 * `startCortex(...).rejects.toThrow(/REFUSING TO BOOT/i)` shape) — this is
 * the SAME class of boot-time fail-fast guard, for the plugin-signing
 * posture instead of the envelope-signing posture.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

function minimalConfig(plugins?: AgentConfig["plugins"]): AgentConfig {
  const base = AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-plugin-signing-posture-test-published" },
  });
  return plugins === undefined ? base : { ...base, plugins };
}

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  return {
    enabled: false,
    published,
    onEnvelope(_handler: EnvelopeHandler) {
      return { unregister: () => {} };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    stop: async () => {},
  };
}

// Hermetic agents.d/ (R26 P1 PR hygiene, cortex#1371) — same rationale as
// `cortex.security-posture-boot.test.ts`: never fall back to the
// principal's LIVE `~/.config/cortex/agents.d/`.
const HERMETIC_AGENTS_DIR = mkdtempSync(join(tmpdir(), "cortex-plugin-signing-posture-agents-hermetic-"));

const COMMON_OPTS = {
  disableConfigWatcher: true,
  disableDashboard: true,
  disableOutboundPoller: true,
  principal: { id: "test-op" },
  agentsDir: HERMETIC_AGENTS_DIR,
} as const;

describe("startCortex — system.plugins.signing boot guard (cortex#2347 follow-up, Finding 2)", () => {
  test("enforce + EMPTY trust root → REFUSES TO BOOT immediately, naming plugins.signing (not a downstream coverage crash)", async () => {
    const runtime = createRecordingRuntime();
    const cfg = minimalConfig({ external: false, signing: "enforce" });

    await expect(
      startCortex(cfg, {
        ...COMMON_OPTS,
        injectRuntime: runtime,
      }),
    ).rejects.toThrow(/REFUSING TO BOOT.*system\.plugins\.signing="enforce".*trust root is EMPTY/is);
  });

  test("permissive + EMPTY trust root does NOT refuse to boot (never refuses a bundle, so no availability risk)", async () => {
    const runtime = createRecordingRuntime();
    const cfg = minimalConfig({ external: false, signing: "permissive" });

    const handle = await startCortex(cfg, {
      ...COMMON_OPTS,
      injectRuntime: runtime,
    });
    await handle.stop();
  });

  test("off (default) + EMPTY trust root does NOT refuse to boot — byte-identical pre-EBH-5 behaviour", async () => {
    const runtime = createRecordingRuntime();
    const cfg = minimalConfig();

    const handle = await startCortex(cfg, {
      ...COMMON_OPTS,
      injectRuntime: runtime,
    });
    await handle.stop();
  });
});
