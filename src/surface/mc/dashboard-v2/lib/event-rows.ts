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
  /**
   * Wall-clock duration in ms, when the source carries it. Controlled
   * stream-json doesn't (it's on `stream-json.result`), but observed hook
   * events (`duration_ms`) and sideband spans (`tool.duration_ms`) do —
   * U1.1 surfaces it inline on the tool row.
   */
  durationMs?: number;
  /**
   * U1.1 — when the row was reconstructed from a lower-fidelity source than
   * controlled stream-json (observed hook event, or sideband span), the
   * renderer can badge it honestly. `undefined` ⇒ full-fidelity controlled.
   */
  fidelity?: RowFidelity;
  /**
   * U1.1 — sideband spans carry an OTel `statusCode`; a `2` (ERROR) marks the
   * tool call as failed so the renderer can show an ok/fail affordance.
   */
  failed?: boolean;
}

/**
 * U1.1 fidelity provenance for a reconstructed row. Drives the honest
 * "preview-grade" badge — full-fidelity controlled rows carry no badge.
 */
export type RowFidelity = "observed" | "sideband";

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
    // --- U1.1 item 1: observed-session hook events → the SAME row grammar ---
    // These come off the cc-events tap (EventLogger.hook.ts) for sessions cortex
    // OBSERVES but did not dispatch. The data (tool_input, tool_output,
    // duration_ms, prompt_preview) is already in the events table; we just need
    // to render it into tool_use / principal.input rows instead of RawRow crumbs.
    case "agent.task.started":
      return [observedTaskStartedRow(ev)];
    default:
      if (isObservedToolEvent(ev.type)) {
        return [observedToolRow(ev)];
      }
      return [rawRow(ev)];
  }
}

/**
 * True for the cc-events observed-tool taxonomy — `tool.bash.executed`,
 * `tool.file.changed`, `tool.file.read`, `tool.agent.spawned`,
 * `tool.todo.updated`, and the generic `tool.{name}.used` fallthrough. Kept as
 * a prefix/suffix test (not an enum) so a new `tool.*` event type renders as a
 * tool row automatically rather than regressing to a RawRow.
 */
function isObservedToolEvent(type: string): boolean {
  if (!type.startsWith("tool.")) return false;
  return (
    type === "tool.bash.executed" ||
    type === "tool.bash.blocked" ||
    type === "tool.file.changed" ||
    type === "tool.file.read" ||
    type === "tool.agent.spawned" ||
    type === "tool.todo.updated" ||
    type.endsWith(".used")
  );
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

/**
 * U1.1 — map an observed tool hook event to a `tool_use` row identical in
 * shape to the controlled stream-json path, so the renderer treats them the
 * same (name + expandable args + paired output + duration). The hook's
 * `tool_output`, when present, is folded into a nested tool_result so the
 * expand-toggle shows input AND output, matching the controlled feel.
 */
function observedToolRow(ev: McEvent): ToolUseRow {
  const p = ev.payload as Record<string, unknown>;
  const name = observedToolName(ev.type, p);
  // Prefer the structured tool_input; fall back to the preview crumbs so a
  // bash event with only `command_preview` still renders its command in args.
  let input: unknown = p["tool_input"];
  if (input === undefined || input === null) {
    const synth: Record<string, unknown> = {};
    if (typeof p["command_preview"] === "string") synth["command"] = p["command_preview"];
    if (typeof p["path"] === "string") synth["file_path"] = p["path"];
    if (typeof p["agent_description"] === "string") synth["description"] = p["agent_description"];
    input = Object.keys(synth).length > 0 ? synth : undefined;
  }
  const row: ToolUseRow = {
    id: ev.id, ts: ev.timestamp, color: "d", weight: "secondary",
    kind: "tool_use", name,
    input: input ?? null,
    fidelity: "observed",
  };
  if (typeof p["duration_ms"] === "number") row.durationMs = p["duration_ms"] as number;
  const output = observedToolOutput(p);
  if (output !== null) {
    const text = output.slice(0, PREVIEW_BYTES * 4);
    row.result = {
      id: `${ev.id}:result`, ts: ev.timestamp, color: "d", weight: "secondary",
      kind: "tool_result", text, byteSize: byteLength(text),
    };
  }
  return row;
}

/** Resolve a display tool name for an observed event. */
function observedToolName(type: string, p: Record<string, unknown>): string {
  if (typeof p["tool_name"] === "string" && p["tool_name"]) return p["tool_name"] as string;
  // tool.{name}.used / tool.{name}.executed / tool.file.{changed,read} →
  // pull the middle segment (e.g. "grep", "bash", "file").
  const segs = type.split(".");
  const seg = segs[1] ?? "tool";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/** Flatten an observed event's `tool_output` to text, or null when absent. */
function observedToolOutput(p: Record<string, unknown>): string | null {
  const out = p["tool_output"];
  if (typeof out === "string") return out;
  if (out !== undefined && out !== null) {
    try { return JSON.stringify(out, null, 2); } catch { return String(out); }
  }
  // `summary` is the Stop-hook completion text — surface it as output when
  // there's no tool_output (e.g. a task-completion observed event).
  if (typeof p["summary"] === "string") return p["summary"] as string;
  return null;
}

/**
 * U1.1 — an observed `agent.task.started` is the user's prompt for that turn.
 * Render it as a principal.input row (the same H-source row controlled
 * sessions use) so the observed transcript opens with the prompt, not a crumb.
 */
function observedTaskStartedRow(ev: McEvent): LogRow {
  const p = ev.payload as Record<string, unknown>;
  const text = typeof p["prompt_preview"] === "string"
    ? (p["prompt_preview"] as string)
    : (typeof p["summary"] === "string" ? (p["summary"] as string) : "");
  if (!text) return rawRow(ev);
  return {
    id: ev.id, ts: ev.timestamp, color: "h", weight: "primary",
    kind: "principal.input", text,
  };
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
