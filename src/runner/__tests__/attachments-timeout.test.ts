/**
 * MIG-3.8 / C-104: tests for the `onTimeoutAbort` hook plumbed into
 * `processAttachment` / `processInboundAttachments`.
 *
 * The hook fires when an attachment download trips `TimeoutSourceError`
 * (from `fetchWithTimeout("attachment_fetch", ...)`) so callers can emit a
 * `system.inbound.aborted` envelope BEFORE the existing graceful failure
 * path returns `{ ok: false }`. Non-timeout errors must not invoke the hook.
 *
 * We stub `globalThis.fetch` rather than spinning up a slow HTTP server so
 * the test stays in-process and wall-time-fast. The TimeoutSourceError
 * construction itself is already covered by `src/common/__tests__/timeout.test.ts`;
 * here we only assert hook-invocation semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { TimeoutSourceError } from "../../common/timeout";
import type { AttachmentInfo } from "../attachment-types";
import { processAttachment, processInboundAttachments } from "../attachments";

const origFetch = globalThis.fetch;

function makeInfo(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    originalName: "x.png",
    url: "https://example.invalid/x.png",
    contentType: "image/png",
    size: 1024,
    source: "discord",
    ...overrides,
  };
}

beforeEach(() => {
  // Each test starts with a real-fetch-deny default; tests that need an
  // outcome install a per-test stub.
  globalThis.fetch = (async () => {
    throw new Error("fetch not stubbed for this test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("processAttachment onTimeoutAbort hook", () => {
  test("fires hook when fetchWithTimeout throws TimeoutSourceError", async () => {
    // Make the underlying fetch hang past the AbortSignal.timeout — easiest
    // way is to await a never-resolving promise that the abort signal will
    // reject for us. The signal lives inside fetchWithTimeout; we surface
    // the abort by listening to it on the init.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // Mirror the bare AbortError shape that AbortSignal.timeout produces.
          const err = new Error("aborted") as Error & { name: string };
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const sessionDir = join(tmpdir(), `cortex-c104-${Date.now()}-${Math.random()}`);
    mkdirSync(sessionDir, { recursive: true });

    const calls: { source: string; attachmentName: string }[] = [];
    const info = makeInfo({ originalName: "hangs.png" });

    // The default attachment_fetch timeout is 30 s; that's too long for a
    // unit test. We can't change the timeout from outside, so we trigger
    // abort manually by relying on Bun's microtask scheduling — but the
    // cleanest way is to issue a short race against a fast aborter. Easier:
    // run with the default 30s but issue the manual abort to short-circuit.
    // Since we can't reach the signal, we instead simulate the error by
    // making the stubbed fetch throw an AbortError synchronously on first
    // resolution micro-tick.
    globalThis.fetch = (async () => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const result = await processAttachment(
      info,
      sessionDir,
      undefined,
      ({ err, attachment }) => {
        calls.push({ source: err.source, attachmentName: attachment.originalName });
      },
    );

    // Hook fired with the source name from TimeoutSourceError + the original
    // AttachmentInfo so consumers (DispatchHandler) can stamp adapter_id.
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ source: "attachment_fetch", attachmentName: "hangs.png" });
    // Existing graceful-failure path still degrades the attachment so the
    // user sees a "Download error" — the hook is additive observability.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.startsWith("Download error:")).toBe(true);
    }
  });

  test("does NOT fire hook on non-timeout fetch failures", async () => {
    globalThis.fetch = (async () => {
      throw new Error("DNS resolution failed");
    }) as unknown as typeof fetch;

    const sessionDir = join(tmpdir(), `cortex-c104-${Date.now()}-${Math.random()}`);
    mkdirSync(sessionDir, { recursive: true });

    let hookCalled = false;
    const info = makeInfo();

    const result = await processAttachment(
      info,
      sessionDir,
      undefined,
      () => {
        hookCalled = true;
      },
    );

    expect(hookCalled).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("does NOT fire hook on HTTP error responses", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const sessionDir = join(tmpdir(), `cortex-c104-${Date.now()}-${Math.random()}`);
    mkdirSync(sessionDir, { recursive: true });

    let hookCalled = false;

    const result = await processAttachment(
      makeInfo(),
      sessionDir,
      undefined,
      () => {
        hookCalled = true;
      },
    );

    expect(hookCalled).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("hook errors do not break the attachment pipeline", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const sessionDir = join(tmpdir(), `cortex-c104-${Date.now()}-${Math.random()}`);
    mkdirSync(sessionDir, { recursive: true });

    // Suppress the "hook threw" diagnostic so it doesn't pollute test output.
    const origErr = console.error;
    console.error = () => {};
    try {
      const result = await processAttachment(
        makeInfo(),
        sessionDir,
        undefined,
        () => {
          throw new Error("publish failed");
        },
      );

      // We still get the graceful failure return — hook errors must not
      // propagate and break the attachment pipeline.
      expect(result.ok).toBe(false);
    } finally {
      console.error = origErr;
    }
  });
});

describe("processInboundAttachments forwards onTimeoutAbort", () => {
  test("passes hook through to per-attachment processing", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const calls: TimeoutSourceError[] = [];
    const result = await processInboundAttachments(
      undefined,
      [makeInfo({ originalName: "a.png" }), makeInfo({ originalName: "b.png" })],
      true, // enabled
      undefined,
      ({ err }) => {
        calls.push(err);
      },
    );

    // Hook fires once per attachment that timed out. The function still
    // returns a (degraded) result — no thrown error escapes.
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c instanceof TimeoutSourceError)).toBe(true);
    expect(calls.every((c) => c.source === "attachment_fetch")).toBe(true);
    // No attachments processed because every fetch aborted; dirs/prompt empty.
    expect(result.dirs).toEqual([]);
    expect(result.prompt).toBe("");
  });

  test("does not fire when attachments are disabled (short-circuit)", async () => {
    // Even if fetch would have aborted, we never reach the call because
    // `enabled: false` skips the processing branch entirely.
    let hookCalled = false;
    await processInboundAttachments(
      undefined,
      [makeInfo()],
      false, // disabled
      undefined,
      () => {
        hookCalled = true;
      },
    );
    expect(hookCalled).toBe(false);
  });
});
