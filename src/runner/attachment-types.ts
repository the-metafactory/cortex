/**
 * Attachment types, validation config, and MIME allowlists.
 * Security-first: only explicitly allowed file types pass through.
 */

/** Attachment metadata extracted from Discord or Mattermost */
export interface AttachmentInfo {
  /** Original filename from the platform */
  originalName: string;
  /** URL to download the file from */
  url: string;
  /** MIME type as reported by the platform */
  contentType: string;
  /** File size in bytes */
  size: number;
  /** Platform source */
  source: "discord" | "mattermost";
}

/** A downloaded and validated attachment ready for Claude */
export interface ProcessedAttachment {
  /** Safe local path (UUID-based filename) */
  localPath: string;
  /** Original filename (for display in prompt, NOT used in paths) */
  originalName: string;
  /** Validated MIME type */
  contentType: string;
  /** File size in bytes */
  size: number;
}

/** Outcome of processing a single attachment */
export type AttachmentResult =
  | { ok: true; attachment: ProcessedAttachment }
  | { ok: false; reason: string; originalName: string };

/**
 * MIME types we allow through. Anything not on this list gets rejected.
 * Organized by category for readability.
 */
export const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Text/code
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "text/xml",
  "text/x-python",
  "text/x-typescript",
  // Documents
  "application/pdf",
  "application/json",
  "application/xml",
  // Office documents — OOXML (ZIP containers) and legacy binary (OLE2).
  // Without these, a .docx dropped in chat is fetched then discarded with
  // "Blocked file type: application/vnd.openxmlformats-officedocument.wordprocessingml.document".
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
  // OpenDocument (ZIP containers) — included for completeness.
  "application/vnd.oasis.opendocument.text", // .odt
  "application/vnd.oasis.opendocument.spreadsheet", // .ods
  "application/vnd.oasis.opendocument.presentation", // .odp
  // Archives (read-only — Claude can't extract, but can note them)
  "application/zip",
]);

/**
 * Magic byte signatures for common file types.
 * Used to validate that declared MIME matches actual content (anti-polyglot).
 */
export const MAGIC_BYTES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF header
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  // Office OOXML + OpenDocument are ZIP containers → PK\x03\x04. Keying each
  // MIME to the ZIP signature only gates files DECLARED as that type; it admits
  // no content application/zip did not already admit, and rejects a file that
  // claims to be a document but isn't even a container (anti-polyglot). The
  // signature can't distinguish .docx from .xlsx (both ZIP) — magic bytes were
  // never a full content check, only a container guard.
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/vnd.oasis.opendocument.text", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/vnd.oasis.opendocument.spreadsheet", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/vnd.oasis.opendocument.presentation", bytes: [0x50, 0x4b, 0x03, 0x04] },
  // Legacy binary Office (.doc/.xls/.ppt) are OLE2 compound files → D0 CF 11 E0.
  // Same reasoning: verifies the container, not the specific application.
  { mime: "application/msword", bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { mime: "application/vnd.ms-excel", bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { mime: "application/vnd.ms-powerpoint", bytes: [0xd0, 0xcf, 0x11, 0xe0] },
];

/** Default limits */
export const ATTACHMENT_LIMITS = {
  /** Max size per individual file (10MB) */
  maxFileSizeBytes: 10 * 1024 * 1024,
  /** Max total size per message (25MB) */
  maxTotalSizeBytes: 25 * 1024 * 1024,
  /** Max number of attachments per message */
  maxAttachmentsPerMessage: 10,
  /** TTL for temp files before cleanup (10 minutes) */
  tempFileTtlMs: 10 * 60 * 1000,
  /** Max total temp directory size (100MB) */
  maxTempDirSizeBytes: 100 * 1024 * 1024,
  /**
   * cortex#2002 (C-1853) — HOST DEFAULT outbound single-file upload ceiling
   * (8 MB). Surface-neutral: renamed from the platform-named
   * `discordMaxUploadBytes` so platform-neutral core names no platform's
   * ceiling. `collectOutputFiles()` uses this ONLY as the fallback when the
   * target adapter does not declare its own `PlatformAdapter.maxUploadBytes`.
   * Held at the historical 8 MB so behaviour is UNCHANGED for any adapter
   * bundle that has not yet adopted the per-surface field.
   */
  defaultMaxUploadBytes: 8 * 1024 * 1024,
};
