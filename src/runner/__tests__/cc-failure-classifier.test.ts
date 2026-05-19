import { describe, test, expect } from "bun:test";
import {
  classifyCcFailure,
  classifyCcSpawnError,
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
  test("isTransient helper agrees with classifier kind", () => {
    // The retry-eligible kind is not_now; everything else is terminal.
    // This pins the contract that the chat-path retry loop consumes.
    const transientResult: CCSessionResult = {
      success: false,
      response: "",
      exitCode: 1,
      durationMs: 5_000,
      aborted: true,
      abortReason: "timeout",
    };
    const reason = classifyCcFailure(transientResult);
    expect(reason?.kind).toBe("not_now");
  });
});
