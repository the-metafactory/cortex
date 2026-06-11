/**
 * U1.1 item 2 — sideband-timeline → LogRow mapping + span pairing.
 *
 * The sideband (`/api/observability/traces/{id}/timeline`) returns a sorted
 * union of spans and log records (signal `docs/contract/cortex-sideband.md`
 * §2.3). We pair `tool.X` + `tool.X.result` spans on `parentSpanId` into ONE
 * tool_use row (name, arg_preview/output_preview when present, duration_ms,
 * ok/fail), interleaved with log entries — same row components, same CSS.
 */

import { describe, it, expect } from "bun:test";
import {
  timelineToRows,
  type SidebandTimeline,
  type SidebandSpan,
  type SidebandTimelineEntry,
} from "../lib/sideband-timeline";
import type { ToolUseRow, ToolResultRow } from "../lib/event-rows";

function span(over: Partial<SidebandSpan> & { spanId: string }): SidebandTimelineEntry {
  const s: SidebandSpan = {
    traceId: "t1",
    spanId: over.spanId,
    parentSpanId: over.parentSpanId ?? "",
    name: over.name ?? "tool.read",
    kind: 1,
    startTimeUnixNano: over.startTimeUnixNano ?? "1000000000",
    endTimeUnixNano: over.endTimeUnixNano ?? "2000000000",
    attributes: over.attributes ?? {},
    statusCode: over.statusCode ?? 1,
    statusMessage: over.statusMessage ?? "",
  };
  return { kind: "span", timeUnixNano: s.startTimeUnixNano, span: s };
}

function log(body: string, timeUnixNano = "1500000000"): SidebandTimelineEntry {
  return {
    kind: "log",
    timeUnixNano,
    log: { timeUnixNano, body, severityText: "INFO", attributes: {} },
  };
}

describe("timelineToRows — span pairing on parentSpanId", () => {
  it("pairs a tool span + its result child span into ONE tool_use row", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [
        span({
          spanId: "s1",
          name: "tool.bash",
          attributes: {
            "tool.name": "Bash",
            "tool.arg_preview": "bun test",
            "tool.duration_ms": 1234,
          },
        }),
        span({
          spanId: "s1r",
          parentSpanId: "s1",
          name: "tool.bash.result",
          attributes: { "tool.output_preview": "42 pass" },
        }),
      ],
    };
    const rows = timelineToRows(tl);
    expect(rows).toHaveLength(1);
    const tu = rows[0] as ToolUseRow;
    expect(tu.kind).toBe("tool_use");
    expect(tu.name).toBe("Bash");
    expect(tu.durationMs).toBe(1234);
    expect(tu.fidelity).toBe("sideband");
    expect((tu.result as ToolResultRow).text).toContain("42 pass");
  });

  it("renders one row per tool when there is no result child (output absent)", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [
        span({ spanId: "s1", name: "tool.read", attributes: { "tool.name": "Read", "tool.arg_preview": "/x" } }),
      ],
    };
    const rows = timelineToRows(tl);
    expect(rows).toHaveLength(1);
    const tu = rows[0] as ToolUseRow;
    expect(tu.name).toBe("Read");
    expect(tu.result).toBeUndefined();
  });

  it("marks a failed span (statusCode 2) so the renderer can show fail", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [
        span({ spanId: "s1", name: "tool.bash", statusCode: 2, statusMessage: "boom", attributes: { "tool.name": "Bash" } }),
      ],
    };
    const tu = timelineToRows(tl)[0] as ToolUseRow & { failed?: boolean };
    expect(tu.failed).toBe(true);
  });

  it("interleaves log entries with tool rows in timeline order", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [
        span({ spanId: "s1", name: "tool.read", startTimeUnixNano: "1000", attributes: { "tool.name": "Read" } }),
        log("dispatch.task.received", "1200"),
        span({ spanId: "s2", name: "tool.bash", startTimeUnixNano: "1400", attributes: { "tool.name": "Bash" } }),
      ],
    };
    const rows = timelineToRows(tl);
    // 2 tool rows + 1 log row, in order.
    expect(rows.map((r) => r.kind)).toEqual(["tool_use", "raw", "tool_use"]);
  });

  it("does NOT emit a standalone row for a paired result span (it's nested)", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [
        span({ spanId: "s1", name: "tool.bash", attributes: { "tool.name": "Bash" } }),
        span({ spanId: "s1r", parentSpanId: "s1", name: "tool.bash.result", attributes: { "tool.output_preview": "ok" } }),
      ],
    };
    const rows = timelineToRows(tl);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool_use");
  });

  it("every tool row carries fidelity 'sideband' (honest preview-grade)", () => {
    const tl: SidebandTimeline = {
      correlation_id: "abc",
      backend: "victoria",
      entries: [span({ spanId: "s1", name: "tool.read", attributes: { "tool.name": "Read" } })],
    };
    expect((timelineToRows(tl)[0] as ToolUseRow).fidelity).toBe("sideband");
  });
});
