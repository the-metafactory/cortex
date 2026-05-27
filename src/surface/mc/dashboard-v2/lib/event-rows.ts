/**
 * Pure renderer: McEvent → array of `LogRow` per the migration addendum's
 * Decision 11 rendering rules table.
 *
 * One McEvent can expand into multiple rows (e.g. a `stream-json.assistant`
 * with mixed content blocks → one row per block). The drill-log component
 * then renders each row with the appropriate visual weight + colour +
 * expandability.
 *
 * Stays a pure function so it's unit-testable without a DOM.
 */

import type { McEvent } from "../../types";

export type RowColor = "d" | "a" | "h" | "none";
export type RowWeight = "primary" | "secondary" | "tertiary";

export type LogRow =
  | TextRow
  | ThinkingRow
  | ToolUseRow
  | ToolResultRow
  | PrincipalInputRow
  | PermissionRow
  | StateTransitionRow
  | ResultRow
  | SystemRow
  | RawRow;

interface RowBase {
  id: string;
  ts: string;
  color: RowColor;
  weight: RowWeight;
}

export interface TextRow extends RowBase {
  kind: "assistant.text";
  text: string;
}

export interface ThinkingRow extends RowBase {
  kind: "assistant.thinking";
  text: string;
}

export interface ToolUseRow extends RowBase {
  kind: "tool_use";
  name: string;
  input: unknown;
  /** Server-assigned id used to pair with a later tool_result row. */
  toolUseId?: string;
  /** Paired tool_result, if found (same event chain). */
  result?: ToolResultRow;
}

export interface ToolResultRow extends RowBase {
  kind: "tool_result";
  /** The originating tool_use_id, if present. */
  toolUseId?: string;
  /** Flat text content (concatenated from string-or-blocks). */
  text: string;
  byteSize: number;
}

export interface PrincipalInputRow extends RowBase {
  kind: "principal.input";
  text: string;
  images?: Array<{ media_type: string; data: string }>;
}

export interface PermissionRow extends RowBase {
  kind: "permission.request";
  action: string;
  target?: string;
  context?: string;
  riskHint?: string;
}

export interface StateTransitionRow extends RowBase {
  kind: "state.transition";
  blocking: boolean;
  from: string;
  to: string;
  /** One-line block-reason summary when `blocking`. */
  blockReasonOneLiner?: string;
  /** Full block-reason payload; rendered on expand. */
  blockReason?: unknown;
}

export interface ResultRow extends RowBase {
  kind: "stream-json.result";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  subtype?: string;
}

export interface SystemRow extends RowBase {
  kind: "stream-json.system";
  subtype?: string;
}

export interface RawRow extends RowBase {
  kind: "raw";
  type: string;
  /** JSON-stringified preview, capped. */
  preview: string;
}

const PREVIEW_BYTES = 10 * 1024;

/**
 * Expand a single McEvent into zero or more rendered rows.
 * Pure — no DOM, no React — testable in isolation.
 */
export function eventToRows(ev: McEvent): LogRow[] {
  switch (ev.type) {
    case "stream-json.assistant":
      return assistantToRows(ev);
    case "stream-json.user":
      return userToRows(ev);
    case "principal.input":
      return [principalInputRow(ev)];
    case "permission.request":
      return [permissionRow(ev)];
    case "state.transition":
      return [stateTransitionRow(ev)];
    case "stream-json.result":
      return [resultRow(ev)];
    case "stream-json.system":
      return [systemRow(ev)];
    default:
      return [rawRow(ev)];
  }
}

/**
 * Convert a list of events into rows AND pair tool_result rows back to
 * their tool_use rows (so the renderer shows them together). Pairing
 * uses `tool_use_id` when present, falls back to nearest-preceding
 * `tool_use` row otherwise.
 */
export function eventsToRows(events: McEvent[]): LogRow[] {
  const rows: LogRow[] = [];
  const pendingByToolUseId = new Map<string, ToolUseRow>();
  for (const ev of events) {
    for (const row of eventToRows(ev)) {
      if (row.kind === "tool_use") {
        if (row.toolUseId) pendingByToolUseId.set(row.toolUseId, row);
        rows.push(row);
      } else if (row.kind === "tool_result") {
        const id = row.toolUseId;
        if (id && pendingByToolUseId.has(id)) {
          const tu = pendingByToolUseId.get(id)!;
          tu.result = row;
          pendingByToolUseId.delete(id);
          // Don't add the tool_result as a standalone row; rendered nested.
          continue;
        }
        rows.push(row);
      } else {
        rows.push(row);
      }
    }
  }
  return rows;
}

// --- per-event-type expansions ---

function assistantToRows(ev: McEvent): LogRow[] {
  const message = (ev.payload as { message?: { content?: unknown } })?.message;
  if (!message || !Array.isArray(message.content)) {
    return [{ ...baseRow(ev), kind: "raw", color: "none", weight: "tertiary",
              type: ev.type, preview: jsonPreview(ev.payload) }];
  }
  const out: LogRow[] = [];
  let blockIdx = 0;
  for (const block of message.content as Array<Record<string, unknown>>) {
    const rowId = `${ev.id}:${blockIdx++}`;
    if (!block || typeof block !== "object") continue;
    const t = block["type"];
    if (t === "text") {
      const text = typeof block["text"] === "string" ? (block["text"] as string) : "";
      if (text.length === 0) continue;
      out.push({
        id: rowId, ts: ev.timestamp, color: "a", weight: "primary",
        kind: "assistant.text", text,
      });
    } else if (t === "thinking") {
      const text = typeof block["thinking"] === "string"
        ? (block["thinking"] as string)
        : (typeof block["text"] === "string" ? (block["text"] as string) : "");
      out.push({
        id: rowId, ts: ev.timestamp, color: "a", weight: "tertiary",
        kind: "assistant.thinking", text,
      });
    } else if (t === "tool_use") {
      const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
      const input = block["input"];
      const tuRow: ToolUseRow = {
        id: rowId, ts: ev.timestamp, color: "d", weight: "secondary",
        kind: "tool_use", name, input,
      };
      if (typeof block["id"] === "string") tuRow.toolUseId = block["id"] as string;
      out.push(tuRow);
    }
  }
  return out;
}

function userToRows(ev: McEvent): LogRow[] {
  const message = (ev.payload as { message?: { content?: unknown } })?.message;
  if (!message || !Array.isArray(message.content)) return [];
  const out: LogRow[] = [];
  let blockIdx = 0;
  for (const block of message.content as Array<Record<string, unknown>>) {
    const rowId = `${ev.id}:${blockIdx++}`;
    if (!block || typeof block !== "object") continue;
    const t = block["type"];
    if (t === "tool_result") {
      const text = flattenToolResultContent(block["content"]);
      const byteSize = byteLength(text);
      const toolUseId = typeof block["tool_use_id"] === "string" ? (block["tool_use_id"] as string) : undefined;
      const row: ToolResultRow = {
        id: rowId, ts: ev.timestamp, color: "d", weight: "secondary",
        kind: "tool_result", text: text.slice(0, PREVIEW_BYTES * 4), byteSize,
      };
      if (toolUseId !== undefined) row.toolUseId = toolUseId;
      out.push(row);
    }
    // text blocks on user messages are SUPPRESSED per Decision 11
    // (principal.input is the authoritative H-source).
  }
  return out;
}

function principalInputRow(ev: McEvent): PrincipalInputRow {
  const text = typeof (ev.payload as { text?: string })?.text === "string"
    ? (ev.payload as { text: string }).text : "";
  const imagesRaw = (ev.payload as { images?: unknown }).images;
  const images = Array.isArray(imagesRaw)
    ? (imagesRaw as Array<{ media_type: string; data: string }>)
    : undefined;
  const row: PrincipalInputRow = {
    id: ev.id, ts: ev.timestamp, color: "h", weight: "primary",
    kind: "principal.input", text,
  };
  if (images) row.images = images;
  return row;
}

function permissionRow(ev: McEvent): PermissionRow {
  const p = ev.payload as Record<string, unknown>;
  const out: PermissionRow = {
    id: ev.id, ts: ev.timestamp, color: "h", weight: "primary",
    kind: "permission.request",
    action: typeof p["requested_action"] === "string" ? (p["requested_action"] as string) : "?",
  };
  if (typeof p["target"] === "string") out.target = p["target"] as string;
  if (typeof p["context"] === "string") out.context = p["context"] as string;
  if (typeof p["risk_hint"] === "string") out.riskHint = p["risk_hint"] as string;
  return out;
}

function stateTransitionRow(ev: McEvent): StateTransitionRow {
  const p = ev.payload as { from?: string; to?: string; block_reason?: unknown };
  const blocking = p.to === "blocked";
  const out: StateTransitionRow = {
    id: ev.id, ts: ev.timestamp,
    color: "d", weight: blocking ? "primary" : "tertiary",
    kind: "state.transition",
    blocking,
    from: p.from ?? "?",
    to: p.to ?? "?",
  };
  if (blocking && p.block_reason) {
    out.blockReason = p.block_reason;
    out.blockReasonOneLiner = blockReasonOneLine(p.block_reason);
  }
  return out;
}

function resultRow(ev: McEvent): ResultRow {
  const p = ev.payload as Record<string, unknown>;
  const usage = (p["usage"] as Record<string, unknown> | undefined) ?? {};
  const out: ResultRow = {
    id: ev.id, ts: ev.timestamp, color: "d", weight: "tertiary",
    kind: "stream-json.result",
  };
  if (typeof p["duration_ms"] === "number") out.durationMs = p["duration_ms"] as number;
  if (typeof usage["input_tokens"] === "number") out.inputTokens = usage["input_tokens"] as number;
  if (typeof usage["output_tokens"] === "number") out.outputTokens = usage["output_tokens"] as number;
  if (typeof p["subtype"] === "string") out.subtype = p["subtype"] as string;
  return out;
}

function systemRow(ev: McEvent): SystemRow {
  const out: SystemRow = {
    id: ev.id, ts: ev.timestamp, color: "none", weight: "tertiary",
    kind: "stream-json.system",
  };
  const subtype = (ev.payload as { subtype?: string })?.subtype;
  if (typeof subtype === "string") out.subtype = subtype;
  return out;
}

function rawRow(ev: McEvent): RawRow {
  return {
    id: ev.id, ts: ev.timestamp, color: "none", weight: "tertiary",
    kind: "raw",
    type: ev.type,
    preview: jsonPreview(ev.payload),
  };
}

// --- helpers ---

function baseRow(ev: McEvent): RowBase {
  return { id: ev.id, ts: ev.timestamp, color: "none", weight: "tertiary" };
}

function byteLength(s: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(s, "utf8");
  return new TextEncoder().encode(s).length;
}

function flattenToolResultContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const sub of c) {
      if (sub && typeof (sub as { text?: string }).text === "string") {
        parts.push((sub as { text: string }).text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function jsonPreview(payload: unknown): string {
  try {
    const s = JSON.stringify(payload, null, 2);
    return s.length > 240 ? s.slice(0, 237) + "…" : s;
  } catch {
    return String(payload);
  }
}

function blockReasonOneLine(br: unknown): string | undefined {
  if (!br || typeof br !== "object") return undefined;
  const r = br as { kind?: string; payload?: Record<string, unknown> };
  if (r.kind === "permission.request") {
    const action = r.payload?.["requested_action"] as string | undefined;
    return action ? `approve: ${action}` : "approve: ?";
  }
  if (r.kind === "tool.error") {
    const tool = r.payload?.["tool_name"] as string | undefined;
    return tool ? `error: ${tool}` : "error";
  }
  if (r.kind === "review.checkpoint") {
    const desc = r.payload?.["description"] as string | undefined;
    return desc ? `review: ${desc.length > 60 ? desc.slice(0, 59) + "…" : desc}` : "review checkpoint";
  }
  return r.kind ?? "blocked";
}
