/**
 * Streaming-transcript event log for the drill-down.
 *
 * Renders rows produced by `lib/event-rows.ts:eventsToRows()` per the
 * Decision 11 rendering rules. Lazy-expand for thinking blocks +
 * tool_use+tool_result pairs; markdown for assistant text and
 * principal input.
 */

import { useMemo, useState } from "react";
import "../components/drill-down.css";
import { eventsToRows, type LogRow, type ToolResultRow, type ToolUseRow } from "../lib/event-rows";
export type { LogRow } from "../lib/event-rows";
import { renderMarkdown } from "../lib/markdown";
import { formatBytes, trimToBytes, byteSize } from "../lib/drill-input";
import { ImageLightbox } from "./image-lightbox";
import type { McEvent } from "../../types";

export interface DrillLogProps {
  events: McEvent[];
  loaded: boolean;
  hasMore: boolean;
  error: string | null;
  onLoadOlder: () => void;
}

export function DrillLog({ events, loaded, hasMore, error, onLoadOlder }: DrillLogProps) {
  const rows = useMemo(() => eventsToRows(events), [events]);

  return (
    <DrillRowList
      rows={rows}
      loaded={loaded}
      hasMore={hasMore}
      error={error}
      onLoadOlder={onLoadOlder}
      emptyText="No events yet."
      isInitiallyEmpty={events.length === 0}
    />
  );
}

export interface DrillRowListProps {
  /** Already-expanded render rows (from `eventsToRows` or `timelineToRows`). */
  rows: LogRow[];
  loaded: boolean;
  hasMore: boolean;
  error: string | null;
  onLoadOlder?: () => void;
  /** Copy for the loaded-but-empty state. */
  emptyText?: string;
  /** Whether the underlying source is still empty (drives the "Loading…" state). */
  isInitiallyEmpty: boolean;
  /**
   * U1.1 — an optional honest banner above the rows (e.g. "preview-grade — full
   * interior on this session's home stack"). Rendered when present.
   */
  fidelityBanner?: string | null;
}

/**
 * Shared row-list renderer — the SAME components + CSS for the controlled,
 * observed, and sideband sources (U1.1). Owns the expand/lightbox state so the
 * sideband-source lazy chunk reuses it rather than duplicating the row grammar.
 */
export function DrillRowList({
  rows, loaded, hasMore, error, onLoadOlder, emptyText, isInitiallyEmpty, fidelityBanner,
}: DrillRowListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="drill-log-wrap" role="log" aria-live="polite">
      {fidelityBanner && <div className="drill-log-fidelity">◷ {fidelityBanner}</div>}
      {hasMore && onLoadOlder && (
        <button type="button" className="drill-log-load-older" onClick={onLoadOlder}>
          Load older events
        </button>
      )}
      {error && <div className="drill-log-error">⚠ {error}</div>}
      {!loaded && isInitiallyEmpty && (
        <div className="drill-log-empty">Loading…</div>
      )}
      {loaded && rows.length === 0 && !error && (
        <div className="drill-log-empty">{emptyText ?? "No events yet."}</div>
      )}
      {rows.map((row) => (
        <DrillRow
          key={row.id}
          row={row}
          isExpanded={expanded.has(row.id)}
          onToggle={() => toggle(row.id)}
          onOpenImage={(src, alt) => setLightbox({ src, alt })}
        />
      ))}
      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}

interface DrillRowProps {
  row: LogRow;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenImage: (src: string, alt: string) => void;
}

function DrillRow({ row, isExpanded, onToggle, onOpenImage }: DrillRowProps) {
  const cls = `drill-row ${row.weight} ${row.color !== "none" ? row.color : ""}`.trim();
  const ts = shortTime(row.ts);
  return (
    <div className={cls}>
      <div className="ts tnum">{ts}</div>
      <div className="gut">
        <span className={`dot${row.color !== "none" ? ` ${row.color}` : ""}`} />
      </div>
      <div className="body">
        <RowBody row={row} isExpanded={isExpanded} onToggle={onToggle} onOpenImage={onOpenImage} />
      </div>
    </div>
  );
}

function RowBody({ row, isExpanded, onToggle, onOpenImage }: DrillRowProps) {
  switch (row.kind) {
    case "assistant.text":
      return <div className="text">{renderMarkdown(row.text)}</div>;

    case "assistant.thinking": {
      const preview = firstLine(row.text, 80);
      return (
        <>
          <div className="kind">thinking</div>
          {!isExpanded ? (
            <button type="button" className="toggle" onClick={onToggle} aria-expanded="false">
              ▸ {preview || "(empty)"}
            </button>
          ) : (
            <>
              <button type="button" className="toggle" onClick={onToggle} aria-expanded="true">
                ▾ collapse
              </button>
              <div className="text" style={{ fontStyle: "italic" }}>{row.text}</div>
            </>
          )}
        </>
      );
    }

    case "tool_use":
      return <ToolUseBlock row={row} isExpanded={isExpanded} onToggle={onToggle} />;

    case "tool_result": {
      // Standalone tool_result — usually paired into a tool_use; this
      // branch handles orphans (no preceding tool_use within the page).
      return (
        <>
          <div className="kind">tool_result</div>
          <div className="text">{firstLine(row.text, 100)}</div>
          {row.byteSize > 100 && (
            <button type="button" className="toggle" onClick={onToggle}>
              {isExpanded ? "▾ collapse" : `▸ expand (${formatBytes(row.byteSize)})`}
            </button>
          )}
          {isExpanded && <pre className="md-code-block"><code>{row.text}</code></pre>}
        </>
      );
    }

    case "principal.input":
      return (
        <>
          <div className="kind">principal.input</div>
          {row.text && <div className="text">{renderMarkdown(row.text)}</div>}
          {row.images && row.images.length > 0 && (
            <div className="images-row">
              {row.images.map((img, i) => {
                const src = `data:${img.media_type};base64,${img.data}`;
                return (
                  <img
                    key={i}
                    src={src}
                    alt={`principal attachment ${i + 1}`}
                    onClick={() => onOpenImage(src, `principal attachment ${i + 1}`)}
                  />
                );
              })}
            </div>
          )}
        </>
      );

    case "permission.request":
      return (
        <>
          <div className="kind">permission.request</div>
          <div className="perm-row">
            <span className="k">action</span><span className="v">{row.action}</span>
            {row.target && <><span className="k">target</span><span className="v">{row.target}</span></>}
            {row.context && <><span className="k">context</span><span className="v">{row.context}</span></>}
            {row.riskHint && <><span className="k">risk</span><span className="v">{row.riskHint}</span></>}
          </div>
          <div className="perm-actions">
            <button type="button" disabled title="Disabled until CC stream-json permission protocol verification (F-7 Decision 6)">Approve</button>
            <button type="button" disabled title="Disabled until CC stream-json permission protocol verification (F-7 Decision 6)">Deny</button>
          </div>
        </>
      );

    case "state.transition":
      if (row.blocking) {
        return (
          <>
            <div className="kind">state → blocked</div>
            <div className="text">{row.blockReasonOneLiner ?? `${row.from} → ${row.to}`}</div>
            {row.blockReason && (
              <button type="button" className="toggle" onClick={onToggle}>
                {isExpanded ? "▾ collapse" : "▸ block_reason"}
              </button>
            )}
            {isExpanded && row.blockReason && (
              <pre className="md-code-block"><code>{JSON.stringify(row.blockReason, null, 2)}</code></pre>
            )}
          </>
        );
      }
      return (
        <div className="kind">{row.from} → {row.to}</div>
      );

    case "stream-json.result":
      return (
        <div className="kind">
          turn complete
          {row.durationMs != null && ` · ${(row.durationMs / 1000).toFixed(1)}s`}
          {row.inputTokens != null && row.outputTokens != null &&
            ` · ${row.inputTokens.toLocaleString()} in / ${row.outputTokens.toLocaleString()} out tokens`}
        </div>
      );

    case "stream-json.system":
      return <div className="kind">system{row.subtype ? ` · ${row.subtype}` : ""}</div>;

    case "raw":
      return (
        <>
          <div className="kind">{row.type}</div>
          <div className="text" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{row.preview}</div>
        </>
      );
  }
}

function ToolUseBlock({ row, isExpanded, onToggle }: { row: ToolUseRow; isExpanded: boolean; onToggle: () => void }) {
  const argSummary = useMemo(() => summariseToolArgs(row.input), [row.input]);
  return (
    <div className="tool-pair">
      <div>
        <span className="tool-pair-name">{row.name}</span>
        {argSummary && <span style={{ color: "var(--fg-faint)" }}> · {argSummary}</span>}
        {row.durationMs != null && (
          <span style={{ color: "var(--fg-faint)" }}> · {(row.durationMs / 1000).toFixed(1)}s</span>
        )}
        {row.fidelity && (
          <span
            className="tool-pair-fidelity"
            title={
              row.fidelity === "observed"
                ? "Reconstructed from observed hook events — full interior on this session's home stack"
                : "Preview-grade — full interior on this session's home stack"
            }
            style={{ color: "var(--fg-faint)", marginLeft: 6, fontSize: 10 }}
          >
            ◷ preview
          </span>
        )}
        {(row.input || row.result) && (
          <button
            type="button"
            className="toggle"
            onClick={onToggle}
            style={{ marginLeft: 8 }}
          >
            {isExpanded ? "▾ collapse" : "▸ expand"}
          </button>
        )}
      </div>
      {isExpanded && (
        <>
          {row.input != null && (
            <div className="tool-pair-args">
              <div style={{ color: "var(--fg-faint)", fontSize: 10.5 }}>args</div>
              <pre style={{ margin: 0 }}><code>{safeJsonStringify(row.input)}</code></pre>
            </div>
          )}
          {row.result && <ToolResultBlock result={row.result} />}
        </>
      )}
    </div>
  );
}

function ToolResultBlock({ result }: { result: ToolResultRow }) {
  const TRUNCATE_AT = 10 * 1024;
  // Truncate by UTF-8 bytes to match the byte-denominated meta string —
  // `string.length` counts UTF-16 code units, which would mislabel
  // multi-byte text and surrogate pairs.
  const truncated = byteSize(result.text) > TRUNCATE_AT;
  const shown = truncated
    ? trimToBytes(result.text, TRUNCATE_AT) + "\n\n…[truncated]"
    : result.text;
  return (
    <div className="tool-pair-result">
      <div className="tool-pair-meta">result · {formatBytes(result.byteSize)}{truncated ? " · truncated to 10 KB" : ""}</div>
      <pre style={{ margin: 0 }}><code>{shown}</code></pre>
    </div>
  );
}

// --- helpers ---

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??:??";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function firstLine(s: string, max: number): string {
  if (!s) return "";
  const nl = s.indexOf("\n");
  const first = nl < 0 ? s : s.slice(0, nl);
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

function safeJsonStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function summariseToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // Common tool-arg fields worth surfacing in the one-liner preview.
  const interestingKeys = ["command", "file_path", "path", "url", "pattern", "name", "query", "description"];
  for (const k of interestingKeys) {
    if (typeof o[k] === "string") {
      const v = o[k] as string;
      return v.length > 80 ? v.slice(0, 79) + "…" : v;
    }
  }
  return "";
}
