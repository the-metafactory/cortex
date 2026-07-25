/**
 * EBH-3a (cortex#2345) — REAL end-to-end acceptance test: "A real dispatched
 * session completes end-to-end under audit: streaming, --resume, hooks,
 * event pipeline, gh."
 *
 * This is deliberately NOT a mock. It spawns the real `claude` CLI (via the
 * real `CCSession`, the real `MacosSbplSandbox`, the real DD-9 canary, the
 * real v1 `guarded` SBPL profile) with `sandboxMode: "audit"`, and asserts
 * on the actual result — a genuine claude round-trip, then a genuine
 * `--resume` round-trip of the SAME session, both wrapped in
 * `sandbox-exec -f`.
 *
 * ## OQ-2 (design-session-sandbox-platforms.md §9) — honest status
 *
 * OQ-2 asks for an `fs_usage`/`strace`-level enumeration of every path a
 * real `claude --print --resume` session touches, to pin the compatibility
 * contract empirically rather than by assumption. `fs_usage` (and `dtruss`)
 * both require root; this environment has no passwordless `sudo` (confirmed:
 * `sudo -n true` fails with "a password is required"). **That enumeration
 * could NOT be produced here — this is a real, disclosed gap, not silently
 * assumed away.**
 *
 * What THIS test provides instead, which is real evidence for the actual
 * question that matters for `audit` mode's rollout gate (design doc §6):
 * "does the v1 `guarded` profile — a NARROW denylist of enumerated sensitive
 * paths, not a broad allowlist — break a real session?" Since v1 `guarded`
 * never tries to enumerate everything a session legitimately touches (that's
 * v2 `strict`'s job), the decisive signal is not "list every path" but
 * "does a real session run clean under the denylist, with ZERO
 * `system.security.sandbox-denial` events for legitimate activity". This
 * test asserts exactly that, on TWO real round-trips (a fresh session, then
 * a `--resume` of it) — which is the closest honest substitute for OQ-2's
 * `fs_usage` sweep that a non-root environment allows.
 */

import { afterEach, beforeEach, describe, expect } from "bun:test";
import { CCSession } from "../cc-session";
import {
  getSandboxCapabilityProbe,
  resetSandboxCapabilityProbeForTests,
  type SandboxDenialEvent,
} from "../session-sandbox";
import { hasClaude, testClaude } from "../../common/test-utils";

const isDarwin = process.platform === "darwin";

describe.skipIf(!isDarwin || !hasClaude)(
  "EBH-3a acceptance — real CCSession end-to-end under mode: 'audit' (macos-sbpl)",
  () => {
    beforeEach(async () => {
      resetSandboxCapabilityProbeForTests();
      // Warm the probe BEFORE constructing any CCSession — mirrors what
      // `startCortex` does at real boot. Without this, `createSessionSandbox`
      // falls back to `NoneSandbox` (the safe default for an un-warmed
      // probe) and this test would exercise nothing new.
      const probe = await getSandboxCapabilityProbe();
      expect(probe.resolvedBackend).toBe("macos-sbpl");
    });

    afterEach(() => {
      resetSandboxCapabilityProbeForTests();
    });

    testClaude(
      "fresh session + --resume of it BOTH complete successfully with ZERO sandbox-denial events",
      async () => {
        const denials: SandboxDenialEvent[] = [];

        const first = new CCSession({
          prompt: "Say just the word hi, nothing else",
          channel: "test",
          timeoutMs: 45_000,
          sandboxMode: "audit",
        });
        first.on("security-event", (event: unknown) => {
          const e = event as { type: string };
          if (e.type === "system.security.sandbox-denial") {
            denials.push(event as SandboxDenialEvent);
          }
        });

        const firstResult = await first.start().wait();
        expect(firstResult.success).toBe(true);
        expect(firstResult.exitCode).toBe(0);
        expect(firstResult.sessionId).toBeDefined();
        expect(firstResult.response.length).toBeGreaterThan(0);

        const second = new CCSession({
          prompt: "Say just the word bye, nothing else",
          channel: "test",
          timeoutMs: 45_000,
          sandboxMode: "audit",
          resumeSessionId: firstResult.sessionId,
        });
        second.on("security-event", (event: unknown) => {
          const e = event as { type: string };
          if (e.type === "system.security.sandbox-denial") {
            denials.push(event as SandboxDenialEvent);
          }
        });

        const secondResult = await second.start().wait();
        expect(secondResult.success).toBe(true);
        expect(secondResult.exitCode).toBe(0);
        expect(secondResult.response.length).toBeGreaterThan(0);

        // The decisive OQ-2 substitute (module doc): a real session,
        // including a real --resume continuity round-trip, produced ZERO
        // denials under the v1 guarded profile. Not proof the profile is
        // complete for a v2 strict allowlist — proof it does not break
        // legitimate traffic, which is what `audit` mode exists to show
        // before any `enforce` flip (design doc §6).
        expect(denials).toHaveLength(0);
      },
      60_000,
    );
  },
);
