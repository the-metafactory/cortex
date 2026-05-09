/**
 * Pure helpers for the F-10 drill-input — byte sizing, trim-to-bytes,
 * media-type allowlist, status-coded error copy.
 *
 * Mirrors the legacy monolith logic from `src/mission-control/dashboard/
 * index.html` so stream-json, paste-trim, and per-status error wording
 * stay byte-for-byte identical to the v1 dashboard.
 */

/** 50 KB cap on a single text submission (server enforces; client mirrors). */
export const DRILL_INPUT_MAX_BYTES = 50 * 1024;

export const IMAGE_ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const IMAGE_MAX_COUNT_PER_MESSAGE = 8;
export const IMAGE_MAX_DECODED_BYTES = 5 * 1024 * 1024;

/** Status-code copy per F-10 Decision 8 + image-input Decision 9. */
export const DRILL_INPUT_ERROR_COPY: Record<number, string> = {
  400: "Attachment type not supported. Use PNG, JPEG, WebP, or GIF.",
  404: "No active session for this assignment. Start or dispatch a session first.",
  409: "This session is observed and cannot be written to.",
  410: "The session has ended. Reopen the assignment to start a new one.",
  413: "Attachments too large — total request body exceeds 25 MB.",
};

/**
 * Statuses where the server's specific message wins over the canned copy.
 * 404/409/410 are excluded — semantic, not diagnostic.
 */
export const DRILL_INPUT_SERVER_MSG_STATUSES = new Set([400, 413]);

export function resolveErrorCopy(status: number, serverMsg: string): string {
  const hasServerMsg = typeof serverMsg === "string" && serverMsg.length > 0;
  if (DRILL_INPUT_SERVER_MSG_STATUSES.has(status) && hasServerMsg) {
    return serverMsg;
  }
  const fallback = DRILL_INPUT_ERROR_COPY[status];
  if (fallback) return fallback;
  return `Send failed: ${serverMsg || `HTTP ${status}`}`;
}

/** UTF-8 byte size of a string — `Blob` is the fastest browser path. */
export const byteSize = (s: string): number => new Blob([s]).size;

/**
 * Trim `s` so its UTF-8 byte size is <= `maxBytes`. Avoids splitting a
 * multi-byte code-point mid-sequence by binary-searching on char-index.
 */
export function trimToBytes(s: string, maxBytes: number): string {
  if (byteSize(s) <= maxBytes) return s;
  let lo = 0;
  let hi = Math.min(s.length, maxBytes);
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (byteSize(s.slice(0, mid)) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return s.slice(0, lo);
}

/** Decoded byte count of a base64 string (no `data:` prefix). */
export function base64DecodedSize(b64: string): number {
  const n = b64.length;
  if (n === 0) return 0;
  let pad = 0;
  if (b64.charCodeAt(n - 1) === 0x3d) pad++;
  if (n > 1 && b64.charCodeAt(n - 2) === 0x3d) pad++;
  return Math.floor((n * 3) / 4) - pad;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaTypeExtension(mt: string): string {
  if (mt === "image/png") return "png";
  if (mt === "image/jpeg") return "jpg";
  if (mt === "image/webp") return "webp";
  if (mt === "image/gif") return "gif";
  return "img";
}

export function isoSlug(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Resolve the input mode for the open drill-down based on the assignment's
 * active session kind and state. Mirrors legacy `resolveDrillInputMode`.
 */
export type DrillInputMode = "active" | "observed" | "ended" | "shadow" | "unknown";

export interface AssignmentInputView {
  agent_id: string;
  session: { endpoint_kind: string; ended_at: string | null } | null;
}

export function resolveDrillInputMode(a: AssignmentInputView | null): DrillInputMode {
  if (!a) return "unknown";
  // F-12b Decision 7 — shadow assignments take precedence.
  // Kept in sync with `SHADOW_AGENT_ID` in `src/mission-control/db/sessions.ts`.
  if (a.agent_id === "mc-shadow-agent") return "shadow";
  if (!a.session) return "ended";
  if (a.session.ended_at) return "ended";
  if (a.session.endpoint_kind === "local.observed") return "observed";
  return "active";
}
