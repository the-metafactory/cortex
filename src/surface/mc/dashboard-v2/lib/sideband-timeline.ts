/**
 * U1.1 item 2 — sideband-timeline source for fleet / remote / historical
 * sessions.
 *
 * Pure mapper: the sideband's combined timeline (signal
 * `docs/contract/cortex-sideband.md` §2.3 — a sorted union of OTLP-shaped
 * spans and log records) → the SAME `LogRow[]` grammar controlled + observed
 * sessions render through. Tool spans pair with their `*.result` child span on
 * `parentSpanId` into ONE `tool_use` row (name, `tool.arg_preview` /
 * `tool.output_preview` when present, `tool.duration_ms`, ok/fail); log records
 * interleave as `raw` rows in timeline order. Every reconstructed row carries
 * `fidelity: "sideband"` so the renderer badges it honestly as preview-grade.
 *
 * Stays a pure function (no DOM, no fetch) so the span-pairing logic is
 * unit-testable in isolation. The fetch + lazy-chunk wrapper lives in the
 * sideband-source component (so this module's cost lands in the split chunk).
 */

import type { LogRow, ToolUseRow, ToolResultRow, RawRow } from "./event-rows";

/** A span subset mirroring the contract's `SidebandSpan` (§2.1). */
export interface SidebandSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  statusCode: number;
  statusMessage: string;
}

/** A log record subset mirroring the contract's `SidebandLogRecord` (§2.2). */
export interface SidebandLogRecord {
  timeUnixNano: string;
  body: string;
  severityText: string;
  attributes: Record<string, unknown>;
}

/** One entry in the combined timeline (§2.3) — discriminated on `kind`. */
export type SidebandTimelineEntry =
  | { kind: "span"; timeUnixNano: string; endTimeUnixNano?: string; span: SidebandSpan }
  | { kind: "log"; timeUnixNano: string; log: SidebandLogRecord };

/** The `/traces/{id}/timeline` response shape (§2.3). */
export interface SidebandTimeline {
  correlation_id: string;
  backend: string;
  entries: SidebandTimelineEntry[];
}

const PREVIEW_BYTES = 10 * 1024;

/**
 * Map a sideband timeline to render rows. Pairs `tool.X` spans with their
 * `*.result` child span (keyed by `parentSpanId` → parent's `spanId`),
 * preserving timeline order for the parent rows; result spans are folded into
 * the parent and never emitted standalone.
 */
export function timelineToRows(tl: SidebandTimeline): LogRow[] {
  const entries = tl.entries ?? [];

  // First pass: index result spans by their parentSpanId so the parent tool
  // span can fold its output in. A "result" span is any span whose parent is a
  // tool span in this trace (we detect via the `parentSpanId` edge); we also
  // accept the `.result` name convention as a hint.
  const resultByParent = new Map<string, SidebandSpan>();
  const spanIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === "span") spanIds.add(e.span.spanId);
  }
  for (const e of entries) {
    if (e.kind !== "span") continue;
    const sp = e.span;
    if (sp.parentSpanId && spanIds.has(sp.parentSpanId) && isResultSpan(sp)) {
      // Last-writer-wins on the rare double-result; tool calls pair 1:1.
      resultByParent.set(sp.parentSpanId, sp);
    }
  }

  const rows: LogRow[] = [];
  for (const e of entries) {
    if (e.kind === "log") {
      rows.push(logRow(e.log));
      continue;
    }
    const sp = e.span;
    // Skip result spans — they're folded into their parent tool row.
    if (sp.parentSpanId && resultByParent.get(sp.parentSpanId) === sp) continue;
    if (isResultSpan(sp) && sp.parentSpanId && spanIds.has(sp.parentSpanId)) continue;
    rows.push(toolRow(sp, resultByParent.get(sp.spanId)));
  }
  return rows;
}

/** A span is a result/child of a tool call when its name ends `.result`. */
function isResultSpan(sp: SidebandSpan): boolean {
  return sp.name.endsWith(".result") || sp.name.endsWith("/result");
}

function toolRow(sp: SidebandSpan, result?: SidebandSpan): ToolUseRow {
  const attrs = sp.attributes ?? {};
  const name = pickString(attrs["tool.name"]) ?? toolNameFromSpanName(sp.name);
  const argPreview = pickString(attrs["tool.arg_preview"]);
  const ts = nanosToIso(sp.startTimeUnixNano);
  const row: ToolUseRow = {
    id: sp.spanId,
    ts,
    color: "d",
    weight: "secondary",
    kind: "tool_use",
    name,
    // The sideband gives PREVIEWS, not full args — surface the arg_preview as
    // the input so the one-liner + expand show what's available, honestly.
    input: argPreview != null ? { preview: argPreview } : null,
    fidelity: "sideband",
  };
  const durationMs = pickNumber(attrs["tool.duration_ms"]) ?? durationFromSpan(sp);
  if (durationMs != null) row.durationMs = durationMs;
  if (sp.statusCode === 2) row.failed = true;

  const outputPreview =
    pickString((result?.attributes ?? {})["tool.output_preview"]) ??
    pickString(attrs["tool.output_preview"]);
  if (outputPreview != null) {
    const text = outputPreview.slice(0, PREVIEW_BYTES * 4);
    const r: ToolResultRow = {
      id: `${sp.spanId}:result`,
      ts,
      color: "d",
      weight: "secondary",
      kind: "tool_result",
      text,
      byteSize: byteLength(text),
    };
    row.result = r;
  }
  return row;
}

function logRow(log: SidebandLogRecord): RawRow {
  const attrs = log.attributes ?? {};
  // Build a compact label from the envelope_* attributes when present (the
  // sideband's "Envelope flow" records), else fall back to the raw body.
  const cls = pickString(attrs["envelope_class"]);
  const entity = pickString(attrs["envelope_entity"]);
  const action = pickString(attrs["envelope_action"]);
  const type = cls && entity && action ? `${cls}.${entity}.${action}` : "log";
  const preview = (log.body ?? "").slice(0, 240);
  return {
    id: `log:${log.timeUnixNano}`,
    ts: nanosToIso(log.timeUnixNano),
    color: "none",
    weight: "tertiary",
    kind: "raw",
    type,
    preview,
  };
}

// --- helpers ---

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // VictoriaTraces v0.8.2 stringifies numeric attributes (contract §5.2 known
  // limitation) — accept a numeric string too.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function toolNameFromSpanName(spanName: string): string {
  // "tool.bash" → "Bash"; "tool.read" → "Read".
  const segs = spanName.split(".");
  const seg = segs[segs.length - 1] ?? "tool";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function durationFromSpan(sp: SidebandSpan): number | undefined {
  const start = BigIntSafe(sp.startTimeUnixNano);
  const end = BigIntSafe(sp.endTimeUnixNano);
  if (start === null || end === null || end <= start) return undefined;
  // nanos → ms.
  return Number((end - start) / 1_000_000n);
}

function BigIntSafe(s: string): bigint | null {
  try {
    if (!/^\d+$/.test(s)) return null;
    return BigInt(s);
  } catch {
    // Non-numeric nanos string — can't compute a duration; skip it. The row
    // simply renders without a duration badge.
    return null;
  }
}

function nanosToIso(nanos: string): string {
  const n = BigIntSafe(nanos);
  if (n === null) return new Date(0).toISOString();
  const ms = Number(n / 1_000_000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function byteLength(s: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
  return new TextEncoder().encode(s).length;
}
