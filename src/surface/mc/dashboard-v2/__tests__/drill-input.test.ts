/**
 * lib/drill-input unit tests — pure helpers for F-10 input.
 *
 * Covers byte sizing, paste-trim that respects multi-byte boundaries,
 * status-coded error copy fallback rules, and the assignment-mode
 * resolver (active / observed / ended / shadow / unknown).
 */

import { describe, it, expect } from "bun:test";
import {
  byteSize,
  trimToBytes,
  base64DecodedSize,
  formatBytes,
  mediaTypeExtension,
  resolveDrillInputMode,
  resolveErrorCopy,
  DRILL_INPUT_MAX_BYTES,
  DRILL_INPUT_ERROR_COPY,
} from "../lib/drill-input";

describe("lib/drill-input — byte helpers", () => {
  it("byteSize counts UTF-8 bytes (not code units)", () => {
    expect(byteSize("ascii")).toBe(5);
    expect(byteSize("café")).toBe(5);            // 'é' is 2 bytes in UTF-8
    expect(byteSize("漢字")).toBe(6);             // 3 bytes per char
    expect(byteSize("👋")).toBe(4);               // surrogate pair → 4 bytes
  });

  it("trimToBytes returns the input when already under the cap", () => {
    expect(trimToBytes("hello", 100)).toBe("hello");
  });

  it("trimToBytes never splits a multi-byte code-point", () => {
    // Each '漢' is 3 bytes. Cap at 4 → 1 char fits (3 bytes), 2 wouldn't (6).
    const result = trimToBytes("漢字漢字", 4);
    expect(result).toBe("漢");
    expect(byteSize(result)).toBeLessThanOrEqual(4);
  });

  it("trimToBytes handles emoji surrogate pairs cleanly", () => {
    // '👋' is 4 bytes. Cap at 5 → exactly one fits.
    const result = trimToBytes("👋👋", 5);
    expect(result).toBe("👋");
    expect(byteSize(result)).toBe(4);
  });

  it("base64DecodedSize matches the expected formula", () => {
    expect(base64DecodedSize("")).toBe(0);
    expect(base64DecodedSize("YQ==")).toBe(1);     // 'a'
    expect(base64DecodedSize("YWI=")).toBe(2);     // 'ab'
    expect(base64DecodedSize("YWJj")).toBe(3);     // 'abc'
  });

  it("formatBytes uses B / KB / MB units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("mediaTypeExtension maps allowlisted types", () => {
    expect(mediaTypeExtension("image/png")).toBe("png");
    expect(mediaTypeExtension("image/jpeg")).toBe("jpg");
    expect(mediaTypeExtension("image/webp")).toBe("webp");
    expect(mediaTypeExtension("image/gif")).toBe("gif");
    expect(mediaTypeExtension("image/something")).toBe("img");
  });
});

describe("lib/drill-input — error copy resolution", () => {
  it("404/409/410 ignore server messages and use canned copy", () => {
    expect(resolveErrorCopy(404, "real reason")).toBe(DRILL_INPUT_ERROR_COPY[404]!);
    expect(resolveErrorCopy(409, "real reason")).toBe(DRILL_INPUT_ERROR_COPY[409]!);
    expect(resolveErrorCopy(410, "real reason")).toBe(DRILL_INPUT_ERROR_COPY[410]!);
  });

  it("400/413 prefer the server message when present", () => {
    expect(resolveErrorCopy(400, "bad media_type: text/plain")).toBe("bad media_type: text/plain");
    expect(resolveErrorCopy(413, "limit exceeded")).toBe("limit exceeded");
  });

  it("400/413 fall back to canned copy when server omits the message", () => {
    expect(resolveErrorCopy(400, "")).toBe(DRILL_INPUT_ERROR_COPY[400]!);
    expect(resolveErrorCopy(413, "")).toBe(DRILL_INPUT_ERROR_COPY[413]!);
  });

  it("unknown statuses (0, 5xx) format a generic 'Send failed' message", () => {
    expect(resolveErrorCopy(0, "network down")).toBe("Send failed: network down");
    expect(resolveErrorCopy(503, "")).toBe("Send failed: HTTP 503");
  });
});

describe("lib/drill-input — resolveDrillInputMode", () => {
  it("returns 'unknown' when assignment is null", () => {
    expect(resolveDrillInputMode(null)).toBe("unknown");
  });

  it("returns 'shadow' for the mc-shadow-agent regardless of session state", () => {
    expect(resolveDrillInputMode({
      agent_id: "mc-shadow-agent",
      session: { endpoint_kind: "local.controlled", ended_at: null },
    })).toBe("shadow");
    expect(resolveDrillInputMode({
      agent_id: "mc-shadow-agent",
      session: null,
    })).toBe("shadow");
  });

  it("returns 'ended' when session is null or has ended_at", () => {
    expect(resolveDrillInputMode({
      agent_id: "real-agent", session: null,
    })).toBe("ended");
    expect(resolveDrillInputMode({
      agent_id: "real-agent",
      session: { endpoint_kind: "local.controlled", ended_at: "2026-04-24T00:00:00Z" },
    })).toBe("ended");
  });

  it("returns 'observed' for local.observed sessions", () => {
    expect(resolveDrillInputMode({
      agent_id: "real-agent",
      session: { endpoint_kind: "local.observed", ended_at: null },
    })).toBe("observed");
  });

  it("returns 'active' for live local.controlled sessions", () => {
    expect(resolveDrillInputMode({
      agent_id: "real-agent",
      session: { endpoint_kind: "local.controlled", ended_at: null },
    })).toBe("active");
  });
});

describe("lib/drill-input — DRILL_INPUT_MAX_BYTES", () => {
  it("matches the server-side 50 KB cap", () => {
    expect(DRILL_INPUT_MAX_BYTES).toBe(50 * 1024);
  });
});
