/**
 * U1.1 item 3 — source-merge policy + honest fidelity labeling.
 *
 * ONE transcript panel, best-available source per session:
 *   controlled    → stream-json (full fidelity, the existing path)
 *   local-observed → hook events (item 1; ~80% CC feel)
 *   else (remote/historical) → sideband timeline (item 2; preview-grade)
 *
 * Plus: honest fidelity labels — and on a sideband `backend_unavailable`, an
 * honest "interior capture not available" message, NOT a crash.
 */

import { describe, it, expect } from "bun:test";
import {
  selectTranscriptSource,
  fidelityLabel,
  type TranscriptSessionMeta,
} from "../lib/source-merge";

function meta(over: Partial<TranscriptSessionMeta> = {}): TranscriptSessionMeta {
  return {
    sessionId: "s1",
    origin: "local",
    dispatchOrigin: "controlled",
    correlationId: null,
    ...over,
  };
}

describe("selectTranscriptSource — best-available per session", () => {
  it("controlled local session → stream-json source (full)", () => {
    const src = selectTranscriptSource(meta({ dispatchOrigin: "controlled" }));
    expect(src.kind).toBe("stream-json");
    if (src.kind === "stream-json") expect(src.fidelity).toBe("full");
  });

  it("local observed session → hook-events source (observed)", () => {
    const src = selectTranscriptSource(meta({ dispatchOrigin: "observed" }));
    expect(src.kind).toBe("hook-events");
    if (src.kind === "hook-events") expect(src.fidelity).toBe("observed");
  });

  it("remote/foreign session WITH a correlationId → sideband source (preview)", () => {
    const src = selectTranscriptSource(meta({
      origin: { principal: "jc", stack: "research" },
      dispatchOrigin: "observed",
      correlationId: "0123abcd",
    }));
    expect(src.kind).toBe("sideband");
    if (src.kind === "sideband") {
      expect(src.fidelity).toBe("preview");
      expect(src.correlationId).toBe("0123abcd");
    }
  });

  it("falls back to sideband for a local session that is neither controlled nor observed, when a correlationId exists", () => {
    const src = selectTranscriptSource(meta({
      dispatchOrigin: "historical",
      correlationId: "deadbeef",
    }));
    expect(src.kind).toBe("sideband");
  });

  it("returns an 'unavailable' source when no interior path exists (no observed, no correlationId)", () => {
    const src = selectTranscriptSource(meta({
      origin: { principal: "jc", stack: "research" },
      dispatchOrigin: "historical",
      correlationId: null,
    }));
    expect(src.kind).toBe("unavailable");
  });

  it("NEVER picks stream-json or hook-events for a FOREIGN origin (ADR-0007 local-pane only)", () => {
    // A foreign peer's interior never lands locally; the only path is the
    // (local) sideband when a correlationId is known, else unavailable.
    const observed = selectTranscriptSource(meta({
      origin: { principal: "jc", stack: "research" },
      dispatchOrigin: "controlled",
      correlationId: "abc",
    }));
    expect(observed.kind).toBe("sideband");
    const none = selectTranscriptSource(meta({
      origin: { principal: "jc", stack: "research" },
      dispatchOrigin: "controlled",
      correlationId: null,
    }));
    expect(none.kind).toBe("unavailable");
  });
});

describe("fidelityLabel — honest labeling", () => {
  it("full fidelity → no label (controlled is the real thing)", () => {
    expect(fidelityLabel("full")).toBeNull();
  });

  it("observed → an honest 'reconstructed from observed hook events' note", () => {
    const label = fidelityLabel("observed");
    expect(label).not.toBeNull();
    expect(label!.toLowerCase()).toContain("observed");
  });

  it("preview → 'preview-grade — full interior on this session's home stack'", () => {
    const label = fidelityLabel("preview");
    expect(label).not.toBeNull();
    expect(label!.toLowerCase()).toContain("preview-grade");
    expect(label!.toLowerCase()).toContain("home stack");
  });
});

describe("sidebandErrorLabel — backend_unavailable is honest, not a crash", () => {
  it("backend_unavailable → 'interior capture not available for this session'", async () => {
    const { sidebandErrorLabel } = await import("../lib/source-merge");
    const label = sidebandErrorLabel({ code: "backend_unavailable", message: "down" });
    expect(label.toLowerCase()).toContain("interior capture not available");
    expect(label.toLowerCase()).not.toContain("undefined");
  });

  it("backend_timeout → an honest retry-flavoured message", async () => {
    const { sidebandErrorLabel } = await import("../lib/source-merge");
    const label = sidebandErrorLabel({ code: "backend_timeout", message: "slow", retry_after_seconds: 5 });
    expect(label.toLowerCase()).toContain("timed out");
  });

  it("never throws on a malformed error body", async () => {
    const { sidebandErrorLabel } = await import("../lib/source-merge");
    // @ts-expect-error — deliberately malformed (missing `code`)
    expect(() => sidebandErrorLabel({})).not.toThrow();
    expect(() => sidebandErrorLabel(null)).not.toThrow();
    expect(() => sidebandErrorLabel(undefined)).not.toThrow();
  });
});
