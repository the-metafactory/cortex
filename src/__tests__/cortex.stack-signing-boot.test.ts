/**
 * cortex#324 (v2.0.3) — boot-time WARNING when stack signing is not
 * configured.
 *
 * Walk-the-talk: stack signing is ON by default. When the operator's
 * config lacks `stack.nkey_seed_path`, cortex publishes UNSIGNED envelopes
 * (same shape as today) but emits a loud stderr WARNING with the
 * actionable fix-path. This test pins the contract:
 *
 *   - WARN appears on stderr when `options.stack.nkey_seed_path` is absent.
 *   - WARN includes the `arc upgrade Cortex` fix-path AND the manual
 *     `stack.nkey_seed_path` fix-path AND the SOP doc cross-link.
 *   - The pre-existing info-level `console.log` line stays (operability).
 *   - When `nkey_seed_path` IS set with a valid seed, no WARN appears.
 *
 * Mirror of the cortex#314 review-consumer-boot test
 * (`cortex.review-consumer-boot.test.ts` lines 321+): same stderr/console
 * capture pattern, same WARNING-is-additive shape.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createUser } from "nkeys.js";

import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Helpers — kept local-to-this-file so the test stays self-contained.
// ---------------------------------------------------------------------------

function minimalConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    agent: {
      name: "test-cortex",
      displayName: "TestCortex",
      operatorId: "test-op",
    },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
  });
}

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}

function createRecordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  return {
    enabled: false,
    published,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onEnvelope(_handler: EnvelopeHandler) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return { unregister: () => {} };
    },
    publish: async (envelope: Envelope) => {
      published.push(envelope);
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stop: async () => {},
  };
}

function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: unknown): boolean => {
    buf += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => {
      process.stderr.write = original;
      return { result, stderr: buf };
    })
    .catch((err: unknown) => {
      process.stderr.write = original;
      throw err;
    });
}

function withCapturedConsoleLog<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — stack-signing boot warning (cortex#324)", () => {
  test("no stack.nkey_seed_path → stderr carries the WARNING with the actionable fix-path", async () => {
    // No `options.stack` at all — the legacy opt-in shape that's the
    // dominant install state pre-v2.0.3. Boot must surface the WARN.
    const runtime = createRecordingRuntime();
    const { result: bootResult, stderr } = await withCapturedStderr(() =>
      withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          disableConfigWatcher: true,
          disableDashboard: true,
          disableOutboundPoller: true,
          injectRuntime: runtime,
        }),
      ),
    );
    const { result: handle, logs } = bootResult;

    // Info-level log line stays — daemon log shippers + structured log
    // handlers benefit from the info entry. The WARN is additive.
    const infoLines = logs.filter((l) =>
      l.includes("cortex: stack signing key not configured"),
    );
    expect(infoLines.length).toBe(1);

    // stderr carries the WARNING tag.
    expect(stderr).toContain("WARNING: stack identity not configured");
    // …and the runtime consequence so operators understand the impact.
    expect(stderr).toContain("unsigned envelopes");
    expect(stderr).toContain("verify signed_by");
    // …and BOTH fix-paths so operators see auto-provision + manual edit.
    expect(stderr).toContain("arc upgrade Cortex");
    expect(stderr).toContain("stack.nkey_seed_path");
    // …and the SOP cross-link.
    expect(stderr).toContain("docs/sop-stack-identity.md");

    expect(handle).toBeDefined();
    await handle.stop();
  });

  test("stack: {id} declared but no nkey_seed_path → WARN still fires (id alone is not enough)", async () => {
    // Operators on Phase A.5 wired `stack.id` for namespace routing but
    // never declared `stack.nkey_seed_path` (B.3 was opt-in). The WARN
    // must still fire — the id alone doesn't enable signing.
    const runtime = createRecordingRuntime();
    const { result: bootResult, stderr } = await withCapturedStderr(() =>
      withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          stack: { id: "test-op/research" },
          disableConfigWatcher: true,
          disableDashboard: true,
          disableOutboundPoller: true,
          injectRuntime: runtime,
        }),
      ),
    );
    const { result: handle } = bootResult;

    expect(stderr).toContain("WARNING: stack identity not configured");
    expect(stderr).toContain("arc upgrade Cortex");

    await handle.stop();
  });

  test("stack.nkey_seed_path SET with a valid SU seed → no WARN, info log absent", async () => {
    // Happy path: operator (or arc) wired the field, seed exists at
    // chmod 600 with `SU` prefix. The signer stages cleanly and the
    // WARN does NOT fire.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-stack-signing-warn-test-"));
    const seedPath = join(tmp, "stack.nk");
    const seed = new TextDecoder().decode(createUser().getSeed());
    writeFileSync(seedPath, seed);
    chmodSync(seedPath, 0o600);

    try {
      const runtime = createRecordingRuntime();
      const { result: bootResult, stderr } = await withCapturedStderr(() =>
        withCapturedConsoleLog(() =>
          startCortex(minimalConfig(), {
            stack: { id: "test-op/research", nkey_seed_path: seedPath },
            disableConfigWatcher: true,
            disableDashboard: true,
            disableOutboundPoller: true,
            injectRuntime: runtime,
          }),
        ),
      );
      const { result: handle, logs } = bootResult;

      // Boot's positive log line for the staged signer.
      const stagedLines = logs.filter((l) =>
        l.includes("cortex: stack signing key staged"),
      );
      expect(stagedLines.length).toBe(1);
      expect(stagedLines[0]!).toContain("principal=did:mf:test-op-research");

      // No WARN — the field is set + valid.
      expect(stderr).not.toContain("WARNING: stack identity not configured");
      // No "not configured" info log either.
      const skipLines = logs.filter((l) =>
        l.includes("cortex: stack signing key not configured"),
      );
      expect(skipLines.length).toBe(0);

      await handle.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
