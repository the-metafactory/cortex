/**
 * TC-0 (Trust & Confidentiality, #628) — security-posture boot wiring.
 *
 * Pins the BACKWARD-COMPAT INVARIANT (hard acceptance criterion):
 *
 *   With `security` absent (default `signing: "off"`) AND no
 *   `stack.nkey_seed_path`, the boot verifier knobs are NON-REJECTING —
 *   byte-identical to today's unsigned dev-stack boot:
 *     rejectEmpty=false · signFailureMode=fallback · no signer attached.
 *
 * Most dev stacks have NO seed and never declared a `security:` block, so
 * this is the dominant install state. The invariant guarantees the TC-0
 * default does not silently start rejecting their traffic.
 *
 * Also pins the EXPLICIT-OFF behaviour:
 *
 *   A stack that DOES have a seed but runs `signing: off` does NOT attach
 *   the signer (publishes unsigned). Since cortex#1000 a seed-configured
 *   stack only reaches this state via an EXPLICIT `signing: off` — the
 *   loader's seed-aware default (`applySeedAwareSigningDefault`) bumps an
 *   UNSET toggle to `permissive` before the schema parse. These tests feed
 *   `startCortex` a pre-parsed AgentConfig (loader bypassed), which models
 *   the explicit-off case. `permissive`/`enforce` retain signing.
 *
 * Modelled on `cortex.stack-signing-boot.test.ts` (same recording-runtime +
 * stderr/console capture pattern).
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createUser } from "nkeys.js";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import type { Agent } from "../common/types/cortex-config";
import { startCortex, bootOrDie } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";

// ---------------------------------------------------------------------------
// Helpers (local-to-file, mirroring cortex.stack-signing-boot.test.ts).
// ---------------------------------------------------------------------------

function minimalConfig(security?: AgentConfig["security"]): AgentConfig {
  const base = AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-posture-test-published" },
  });
  return security === undefined ? base : { ...base, security };
}

/**
 * Minimal inline `Agent` so the boot path has a `firstAgent` to run the TC-1b
 * (#632) self-check against under `enforce`. Trust is empty (the self-check
 * exercises the own-stack short-circuit, not peer trust).
 */
function enforceAgentFixture(): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: {},
  } as Agent;
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

// Hermetic agents.d/ (R26 P1 PR hygiene, cortex#1371): point every boot at an
// EMPTY tmp agents dir so the suite never falls back to the principal's LIVE
// `~/.config/cortex/agents.d/` — a live fragment whose `trust:` names an id
// unknown to the test config crashes registry assembly (machine-state flake).
const HERMETIC_AGENTS_DIR = mkdtempSync(join(tmpdir(), "cortex-posture-agents-hermetic-"));

const COMMON_OPTS = {
  disableConfigWatcher: true,
  disableDashboard: true,
  disableOutboundPoller: true,
  principal: { id: "test-op" },
  agentsDir: HERMETIC_AGENTS_DIR,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startCortex — TC-0 security posture wiring (#628)", () => {
  test("BACKWARD-COMPAT: security absent + no seed → non-rejecting knobs (rejectEmpty=false, fallback), no signer", async () => {
    const runtime = createRecordingRuntime();
    const { result: handle, logs } = await withCapturedConsoleLog(() =>
      startCortex(minimalConfig(), {
        ...COMMON_OPTS,
        injectRuntime: runtime,
      }),
    );

    // The boot posture line reports the resolved knobs. Default `off` must
    // resolve to the non-rejecting, fallback-publish, no-signer shape that
    // matches today's unsigned dev-stack boot EXACTLY.
    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — signing=off"),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("attachSigner=false");
    expect(postureLines[0]!).toContain("rejectEmpty=false");
    expect(postureLines[0]!).toContain("signFailureMode=fallback");

    // No seed declared → the legacy "not configured" path runs (unsigned
    // publish). The signer-staged line must be ABSENT.
    const stagedLines = logs.filter((l) =>
      l.includes("cortex: stack signing key staged"),
    );
    expect(stagedLines.length).toBe(0);

    await handle.stop();
  });

  test("EXPLICIT-OFF (cortex#1000): seed present but signing=off → signer NOT attached, publishes unsigned", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cortex-posture-off-seed-"));
    const seedPath = join(tmp, "stack.nk");
    writeFileSync(seedPath, new TextDecoder().decode(createUser().getSeed()));
    chmodSync(seedPath, 0o600);

    try {
      const runtime = createRecordingRuntime();
      const { result: handle, logs } = await withCapturedConsoleLog(() =>
        startCortex(minimalConfig(), {
          ...COMMON_OPTS,
          stack: { id: "test-op/research", nkey_seed_path: seedPath },
          injectRuntime: runtime,
        }),
      );

      // Explicit `off` posture → attachSigner=false even though a seed loads.
      const postureLines = logs.filter((l) =>
        l.includes("cortex: security posture — signing=off"),
      );
      expect(postureLines.length).toBe(1);
      expect(postureLines[0]!).toContain("attachSigner=false");

      // The TC-0 suppression branch fires: seed present, signing off →
      // NOT attaching signer.
      const suppressLines = logs.filter((l) =>
        l.includes("present but security.signing=off"),
      );
      expect(suppressLines.length).toBe(1);

      // The pre-TC-0 "staged" line MUST be absent (no signer attached).
      const stagedLines = logs.filter((l) =>
        l.includes("cortex: stack signing key staged"),
      );
      expect(stagedLines.length).toBe(0);

      await handle.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("permissive + seed → signer staged (retains pre-TC-0 sign-when-seed behaviour), non-rejecting", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cortex-posture-permissive-seed-"));
    const seedPath = join(tmp, "stack.nk");
    writeFileSync(seedPath, new TextDecoder().decode(createUser().getSeed()));
    chmodSync(seedPath, 0o600);

    try {
      const runtime = createRecordingRuntime();
      const cfg = minimalConfig({
        signing: "permissive",
        encryption: { payload: "off", at_rest: "off" },
        transport: { mtls: "off" },
      });
      const { result: handle, logs } = await withCapturedConsoleLog(() =>
        startCortex(cfg, {
          ...COMMON_OPTS,
          stack: { id: "test-op/research", nkey_seed_path: seedPath },
          injectRuntime: runtime,
        }),
      );

      const postureLines = logs.filter((l) =>
        l.includes("cortex: security posture — signing=permissive"),
      );
      expect(postureLines.length).toBe(1);
      expect(postureLines[0]!).toContain("attachSigner=true");
      // permissive verifies but never rejects.
      expect(postureLines[0]!).toContain("rejectEmpty=false");

      // Signer staged — the seed-present happy path.
      const stagedLines = logs.filter((l) =>
        l.includes("cortex: stack signing key staged"),
      );
      expect(stagedLines.length).toBe(1);

      await handle.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("enforce → rejecting knobs (rejectEmpty=true, drop)", async () => {
    // The posture-knob log line is emitted at boot independent of stack
    // identity / agents. Under TC-1b (#632) an `enforce` stack with no
    // self-verifiable identity FAILS FAST after that line, so we capture logs
    // around the (expected) throw and assert the knob resolution still logged.
    const runtime = createRecordingRuntime();
    const cfg = minimalConfig({
      signing: "enforce",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    });

    const originalLog = console.log.bind(console);
    const logs: string[] = [];
    console.log = (...args: unknown[]): void => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    let threw = false;
    try {
      await startCortex(cfg, { ...COMMON_OPTS, injectRuntime: runtime });
    } catch (err) {
      threw = true;
      expect(err instanceof Error ? err.message : String(err)).toMatch(/REFUSING TO BOOT/i);
    } finally {
      console.log = originalLog;
    }
    expect(threw).toBe(true);

    const postureLines = logs.filter((l) =>
      l.includes("cortex: security posture — signing=enforce"),
    );
    expect(postureLines.length).toBe(1);
    expect(postureLines[0]!).toContain("rejectEmpty=true");
    expect(postureLines[0]!).toContain("signFailureMode=drop");
  });

  test("TC-1b: enforce + valid stack identity + agent → boots clean", async () => {
    // The positive path: a provisioned seed + an agent that can receive the
    // self-check envelope. The boot self-check round-trips and boot proceeds.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-posture-enforce-ok-"));
    const seedPath = join(tmp, "stack.nk");
    writeFileSync(seedPath, new TextDecoder().decode(createUser().getSeed()));
    chmodSync(seedPath, 0o600);
    try {
      const runtime = createRecordingRuntime();
      const cfg = minimalConfig({
        signing: "enforce",
        encryption: { payload: "off", at_rest: "off" },
        transport: { mtls: "off" },
      });
      const { result: handle, logs } = await withCapturedConsoleLog(() =>
        startCortex(cfg, {
          ...COMMON_OPTS,
          stack: { id: "test-op/research", nkey_seed_path: seedPath },
          inlineAgents: [enforceAgentFixture()],
          injectRuntime: runtime,
        }),
      );
      // Self-check round-tripped under enforce → boot proceeded.
      expect(logs.join("\n")).toContain("verifier-self-check OK");
      await handle.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("TC-1b: enforce + no stack identity → REFUSES TO BOOT (fail fast)", async () => {
    // The TC-1b boot gate: a stack serving SIGNED traffic under `enforce` must
    // have a self-verifiable signing identity. With none wired, startCortex
    // must throw rather than silently serve unverifiable traffic.
    const runtime = createRecordingRuntime();
    const cfg = minimalConfig({
      signing: "enforce",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    });
    await expect(
      startCortex(cfg, {
        ...COMMON_OPTS,
        inlineAgents: [enforceAgentFixture()],
        injectRuntime: runtime,
      }),
    ).rejects.toThrow(/REFUSING TO BOOT/i);
  });
});

// ---------------------------------------------------------------------------
// bootOrDie — the ENTRYPOINT-layer fatal-exit guarantee.
//
// The library `startCortex` rejecting (above) is NECESSARY but not SUFFICIENT:
// the `start` action is an async commander action invoked by synchronous
// `program.parse()`, which does not await it, so the rejection used to land in
// the "non-fatal" unhandledRejection handler and the daemon lingered half-
// booted. These tests pin that a boot-phase rejection now EXITS the process
// non-zero and removes the PID file (so launchd can't see a "healthy" daemon).
// ---------------------------------------------------------------------------
describe("bootOrDie — boot-phase failure is fatal (cortex#632 review BLOCK)", () => {
  function tmpPid(): string {
    return join(
      tmpdir(),
      `cortex-bootordie-${process.pid}-${Math.random().toString(36).slice(2)}.pid`,
    );
  }

  test("a boot throw (REFUSING TO BOOT) exits non-zero and removes the PID file", async () => {
    const pidFile = tmpPid();
    writeFileSync(pidFile, String(process.pid)); // simulate the singleton PID write

    // Mock process.exit to HALT (throw) like the real thing, so we can assert
    // the code without killing the test runner.
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number) => {
        throw new Error(`__exit__:${code}`);
      },
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        bootOrDie(async () => {
          throw new Error(
            "verifier-self-check: REFUSING TO BOOT — stack identity unverifiable under signing: enforce",
          );
        }, pidFile),
      ).rejects.toThrow("__exit__:1");

      expect(exitSpy).toHaveBeenCalledWith(1);
      // The PID file MUST be gone — launchd must not see a healthy daemon.
      expect(existsSync(pidFile)).toBe(false);
      // The fatal reason is surfaced, not swallowed as "non-fatal".
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes("FATAL")),
      ).toBe(true);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      if (existsSync(pidFile)) unlinkSync(pidFile);
    }
  });

  test("a successful boot returns the handle and leaves the PID file intact", async () => {
    const pidFile = tmpPid();
    writeFileSync(pidFile, String(process.pid));
    try {
      const sentinel = { ok: true };
      const handle = await bootOrDie(async () => sentinel, pidFile);
      expect(handle).toBe(sentinel);
      expect(existsSync(pidFile)).toBe(true); // healthy boot keeps its PID file
    } finally {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    }
  });
});
