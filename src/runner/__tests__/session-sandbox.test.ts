/**
 * EBH-2 (cortex#2344) — unit tests for the `SessionSandbox` choke point:
 * the `none` backend's pass-through + once-per-instance event, and the
 * boot capability probe's memoization + resolution.
 *
 * EBH-3a (cortex#2345) updates the resolution tests: the HARD HOLD is
 * LIFTED for macOS specifically (`resolveSandboxBackend` now resolves
 * `"macos-sbpl"` on a Darwin probe with `sandboxExecAvailable: true`) and
 * REMAINS for every other platform/container case (EBH-3b territory). See
 * `resolveSandboxBackend`'s doc comment in `session-sandbox.ts`.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  NoneSandbox,
  createSessionSandbox,
  getSandboxCapabilityProbe,
  resetSandboxCapabilityProbeForTests,
  resolveSandboxBackend,
  type SandboxProfile,
  type SandboxCapabilityProbe,
  type SandboxUnavailableEvent,
} from "../session-sandbox";

const BASE_PROFILE: SandboxProfile = {
  readWrite: ["/work"],
  readOnly: ["/ro"],
  execAllow: ["claude"],
  egressAllow: ["api.anthropic.com"],
  mode: "off",
  posture: "guarded",
  internalReadOnly: [],
};

afterEach(() => {
  resetSandboxCapabilityProbeForTests();
});

describe("NoneSandbox — the EBH-2 pass-through backend", () => {
  test("backend id is 'none'", () => {
    expect(new NoneSandbox().backend).toBe("none");
  });

  test("spawn() is behaviour-identical to a bare Bun.spawn — same exit code", async () => {
    const sandbox = new NoneSandbox();
    const proc = sandbox.spawn(["true"], BASE_PROFILE, {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });

  test("emits the unavailable event exactly ONCE across multiple spawn() calls on the same instance", async () => {
    const events: SandboxUnavailableEvent[] = [];
    const sandbox = new NoneSandbox((event) => events.push(event));

    const first = sandbox.spawn(["true"], BASE_PROFILE, { env: {}, stdout: "pipe", stderr: "pipe" });
    await first.exited;
    const second = sandbox.spawn(["true"], BASE_PROFILE, { env: {}, stdout: "pipe", stderr: "pipe" });
    await second.exited;
    const third = sandbox.spawn(["true"], BASE_PROFILE, { env: {}, stdout: "pipe", stderr: "pipe" });
    await third.exited;

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "system.security.sandbox-unavailable",
      backend: "none",
      mode: "off",
      timestamp: events[0]!.timestamp,
    });
  });

  test("a FRESH instance emits again — 'once per session', not once per process", async () => {
    const events: SandboxUnavailableEvent[] = [];
    const onUnavailable = (event: SandboxUnavailableEvent): void => {
      events.push(event);
    };

    const sessionA = new NoneSandbox(onUnavailable);
    await sessionA.spawn(["true"], BASE_PROFILE, { env: {}, stdout: "pipe", stderr: "pipe" }).exited;

    const sessionB = new NoneSandbox(onUnavailable);
    await sessionB.spawn(["true"], BASE_PROFILE, { env: {}, stdout: "pipe", stderr: "pipe" }).exited;

    expect(events).toHaveLength(2);
  });

  test("denials() never yields — the none backend enforces nothing", async () => {
    const sandbox = new NoneSandbox();
    const denials: unknown[] = [];
    for await (const denial of sandbox.denials()) {
      denials.push(denial);
    }
    expect(denials).toHaveLength(0);
  });

  test("createSessionSandbox() returns a 'none' backend in this build", () => {
    expect(createSessionSandbox().backend).toBe("none");
  });
});

describe("resolveSandboxBackend — EBH-3a: macOS HARD HOLD lifted, Linux/container held", () => {
  const baseProbe: SandboxCapabilityProbe = {
    platform: "darwin",
    sandboxExecAvailable: false,
    bwrapAvailable: false,
    bwrapUnshareWorks: false,
    landlockAvailable: false,
    inContainer: false,
    resolvedBackend: "none",
    probedAt: new Date().toISOString(),
  };

  test("darwin + sandboxExecAvailable → resolves 'macos-sbpl'", () => {
    expect(resolveSandboxBackend({ ...baseProbe, sandboxExecAvailable: true })).toBe(
      "macos-sbpl",
    );
  });

  test("darwin WITHOUT sandboxExecAvailable → resolves 'none' (E1 not proven viable)", () => {
    expect(resolveSandboxBackend({ ...baseProbe, sandboxExecAvailable: false })).toBe("none");
  });

  test("darwin resolution ignores bwrap/landlock fields entirely", () => {
    expect(
      resolveSandboxBackend({
        ...baseProbe,
        sandboxExecAvailable: true,
        bwrapAvailable: true,
        bwrapUnshareWorks: true,
        landlockAvailable: true,
      }),
    ).toBe("macos-sbpl");
  });

  test("linux HARD HOLD still stands — 'none' even when bwrap fully viable (EBH-3b territory)", () => {
    expect(
      resolveSandboxBackend({
        ...baseProbe,
        platform: "linux",
        sandboxExecAvailable: false,
        bwrapAvailable: true,
        bwrapUnshareWorks: true,
        landlockAvailable: true,
      }),
    ).toBe("none");
  });

  test("in-container HARD HOLD still stands — 'none' regardless of mount scoping (DD-8, EBH-3b)", () => {
    expect(
      resolveSandboxBackend({ ...baseProbe, platform: "linux", inContainer: true }),
    ).toBe("none");
  });

  test("every capability unavailable on any platform → 'none'", () => {
    expect(resolveSandboxBackend(baseProbe)).toBe("none");
    expect(resolveSandboxBackend({ ...baseProbe, platform: "linux" })).toBe("none");
  });
});

describe("getSandboxCapabilityProbe — DD-7 boot probe caching", () => {
  test("memoizes: concurrent callers get the SAME resolved object (not merely equal)", async () => {
    const [a, b] = await Promise.all([getSandboxCapabilityProbe(), getSandboxCapabilityProbe()]);
    expect(a).toBe(b);
  });

  test("memoizes across sequential calls too — one probe per process lifetime, not per session", async () => {
    const first = await getSandboxCapabilityProbe();
    const second = await getSandboxCapabilityProbe();
    const third = await getSandboxCapabilityProbe();
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("resetSandboxCapabilityProbeForTests() forces a fresh probe on the next call", async () => {
    const first = await getSandboxCapabilityProbe();
    resetSandboxCapabilityProbeForTests();
    const second = await getSandboxCapabilityProbe();
    // Different object identity post-reset (content may coincidentally
    // match on a stable host — identity is the property under test).
    expect(first).not.toBe(second);
  });

  test("resolvedBackend on the live probe matches resolveSandboxBackend(probe) — no drift between boot and the pure resolver", async () => {
    const probe = await getSandboxCapabilityProbe();
    // EBH-3a: on a real macOS host with a working sandbox-exec (this repo's
    // dev/CI-adjacent machines), the live probe now legitimately resolves
    // "macos-sbpl" — the OLD hardcoded 'none' assertion no longer reflects
    // reality. What must ALWAYS hold, on every platform this runs on, is
    // that the probe's own resolution never drifts from the pure resolver.
    expect(probe.resolvedBackend).toBe(resolveSandboxBackend(probe));
    if (probe.platform !== "darwin" || !probe.sandboxExecAvailable) {
      expect(probe.resolvedBackend).toBe("none");
    }
  });

  test("probe never throws and always returns booleans, on whatever platform CI runs", async () => {
    const probe = await getSandboxCapabilityProbe();
    expect(typeof probe.sandboxExecAvailable).toBe("boolean");
    expect(typeof probe.bwrapAvailable).toBe("boolean");
    expect(typeof probe.bwrapUnshareWorks).toBe("boolean");
    expect(typeof probe.landlockAvailable).toBe("boolean");
    expect(typeof probe.inContainer).toBe("boolean");
    expect(typeof probe.probedAt).toBe("string");
  });
});
