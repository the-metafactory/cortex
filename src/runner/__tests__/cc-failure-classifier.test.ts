import { describe, test, expect } from "bun:test";
import {
  classifyCcFailure,
  classifyCcSpawnError,
  isTransientFailure,
  isCcAuthFailure,
  CC_AUTH_FAILURE_MESSAGE,
} from "../cc-failure-classifier";
import type { CCSessionResult } from "../cc-session";

/**
 * cortex#360 — Unit tests for the shared CC failure classifier.
 *
 * The classifier is the lifted-and-shared form of the four-way nak
 * mapping that previously lived inline in `review-pipeline.ts:244-298`.
 * Both the review-consumer path (JetStream pull) and the chat dispatch
 * path (Discord/Mattermost adapter) now consume it; tests here pin the
 * mapping table from `review-pipeline.ts`'s file header so any future
 * change to the taxonomy fails loudly at this seam rather than silently
 * diverging across the two paths.
 */

function successResult(overrides: Partial<CCSessionResult> = {}): CCSessionResult {
  return {
    success: true,
    response: "verdict body",
    exitCode: 0,
    durationMs: 1000,
    ...overrides,
  };
}

describe("classifyCcFailure", () => {
  test("clean success returns null (no classification needed)", () => {
    const result = successResult();
    expect(classifyCcFailure(result)).toBeNull();
  });

  test("aborted (inactivity timeout) maps to not_now", () => {
    const result: CCSessionResult = {
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 5_000,
      aborted: true,
      abortReason: "timeout",
    };
    const reason = classifyCcFailure(result);
    expect(reason).not.toBeNull();
    expect(reason?.kind).toBe("not_now");
    if (reason?.kind === "not_now") {
      expect(reason.detail).toContain("aborted");
      expect(reason.detail).toContain("timeout");
      expect(reason.retry_after_ms).toBe(0);
    }
  });

  test("aborted without explicit abortReason still maps to not_now with default reason", () => {
    const result: CCSessionResult = {
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 5_000,
      aborted: true,
    };
    const reason = classifyCcFailure(result);
    expect(reason?.kind).toBe("not_now");
    if (reason?.kind === "not_now") {
      expect(reason.detail).toContain("aborted");
    }
  });

  test("non-zero exit with no response maps to not_now", () => {
    const result: CCSessionResult = {
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 5_000,
    };
    const reason = classifyCcFailure(result);
    expect(reason?.kind).toBe("not_now");
    if (reason?.kind === "not_now") {
      expect(reason.detail).toContain("exited 1");
      expect(reason.detail).toContain("no output");
      expect(reason.retry_after_ms).toBe(0);
    }
  });

  test("non-zero exit with response treated as clean (classifier returns null)", () => {
    // Skill emitted a verdict block then crashed late; review-pipeline §4.5
    // treats this as a parseable-verdict path, so the classifier should not
    // claim a substrate failure. The downstream caller decides what to do
    // with the body.
    const result: CCSessionResult = {
      success: false,
      response: "some text",
      exitCode: 1,
      durationMs: 5_000,
    };
    expect(classifyCcFailure(result)).toBeNull();
  });

  test("aborted takes precedence over success flag", () => {
    // Defensive: success=true + aborted=true would be a CCSession bug, but
    // the classifier should still detect the abort.
    const result: CCSessionResult = {
      success: true,
      response: "",
      exitCode: 0,
      durationMs: 5_000,
      aborted: true,
      abortReason: "timeout",
    };
    const reason = classifyCcFailure(result);
    expect(reason?.kind).toBe("not_now");
  });
});

describe("classifyCcSpawnError", () => {
  test("Error instance maps to not_now with message in detail", () => {
    const reason = classifyCcSpawnError(new Error("CC binary not found"));
    expect(reason.kind).toBe("not_now");
    if (reason.kind === "not_now") {
      expect(reason.detail).toContain("cc session error");
      expect(reason.detail).toContain("CC binary not found");
      expect(reason.retry_after_ms).toBe(0);
    }
  });

  test("non-Error throwable stringified into detail", () => {
    const reason = classifyCcSpawnError("oops");
    expect(reason.kind).toBe("not_now");
    if (reason.kind === "not_now") {
      expect(reason.detail).toContain("oops");
    }
  });
});

describe("classification stability", () => {
  test("isTransientFailure helper agrees with classifier kind", () => {
    // The retry-eligible kind is not_now; everything else is terminal.
    // This pins the contract that the chat-path retry loop consumes.
    // Echo r3 review on cortex#360: the previous shape of this test
    // asserted only the classifier output and never actually called
    // `isTransientFailure`, which left the helper-classifier coupling
    // untested. We now call BOTH so a future divergence between the
    // classifier and the helper (e.g. adding a new transient kind to
    // one but not the other) fails here loudly.
    const transientResult: CCSessionResult = {
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 5_000,
      aborted: true,
      abortReason: "timeout",
    };
    const reason = classifyCcFailure(transientResult);
    expect(reason).not.toBeNull();
    expect(reason?.kind).toBe("not_now");
    // Helper agrees: transient classification → retryable.
    if (reason !== null) {
      expect(isTransientFailure(reason)).toBe(true);
    }
  });

  test("isTransientFailure returns false for terminal kinds", () => {
    // Pins the inverse direction: every non-`not_now` kind is terminal.
    // Mirrors the four-way nak taxonomy from `architecture.md` §7.3.
    expect(isTransientFailure({ kind: "cant_do", detail: "skill misbehaved" })).toBe(false);
    expect(isTransientFailure({ kind: "wont_do", detail: "policy refused" })).toBe(false);
    expect(isTransientFailure({ kind: "compliance_block", detail: "attestation forbidden" })).toBe(false);
    expect(isTransientFailure({ kind: "policy_denied", deny: { reason: "unknown_principal" } })).toBe(false);
  });

  test("isTransientFailure returns true for spawn-error classifications", () => {
    // classifyCcSpawnError always returns not_now → the helper agrees.
    const reason = classifyCcSpawnError(new Error("CC binary missing"));
    expect(isTransientFailure(reason)).toBe(true);
  });
});

// =============================================================================
// cortex#2055 — auth-failure detection (isCcAuthFailure)
// =============================================================================
// An expired host login exits non-zero with the auth error on stderr and no
// stdout response. Without detection the generic classifier buckets it as
// not_now → 3 futile retries → opaque "exit code: 1". isCcAuthFailure lets the
// chat path treat it as terminal and surface an actionable re-login message.
describe("isCcAuthFailure", () => {
  function failed(overrides: Partial<CCSessionResult> = {}): CCSessionResult {
    return { success: false, response: "", exitCode: 1, durationMs: 800, ...overrides };
  }

  test("detects authentication_failed on stderr (the canonical signal)", () => {
    expect(isCcAuthFailure(failed({ stderr: '{"type":"result","error":"authentication_failed"}' }))).toBe(true);
  });

  test("detects common auth wordings (expired OAuth / invalid key / re-login)", () => {
    expect(isCcAuthFailure(failed({ stderr: "Error: OAuth token has expired" }))).toBe(true);
    expect(isCcAuthFailure(failed({ stderr: "Invalid API key provided" }))).toBe(true);
    expect(isCcAuthFailure(failed({ stderr: "Please run `claude login` to authenticate" }))).toBe(true);
    expect(isCcAuthFailure(failed({ response: "You are not logged in." }))).toBe(true);
  });

  test("does NOT fire on a clean success", () => {
    expect(isCcAuthFailure(successResult())).toBe(false);
  });

  test("does NOT fire on an ordinary non-auth failure (no false positives)", () => {
    expect(isCcAuthFailure(failed({ stderr: "TypeError: cannot read property 'x' of undefined" }))).toBe(false);
    expect(isCcAuthFailure(failed({ stderr: "" }))).toBe(false);
    expect(isCcAuthFailure(failed({ response: "partial answer then crash" }))).toBe(false);
  });

  test("CC_AUTH_FAILURE_MESSAGE is actionable (names the fix: run claude to re-login)", () => {
    expect(CC_AUTH_FAILURE_MESSAGE).toMatch(/claude/i);
    expect(CC_AUTH_FAILURE_MESSAGE).toMatch(/log ?in|login/i);
  });
});
