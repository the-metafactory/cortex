/**
 * Attachment Handler: Download, validate, store, and cleanup attachments.
 * Security hardened against: malicious files, size bombs, path traversal,
 * disk exhaustion, polyglot files.
 */

import { join } from "path";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from "fs";
import { randomUUID } from "crypto";
import { fetchWithTimeout, TimeoutSourceError } from "../../common/timeout";
import {
  ALLOWED_MIME_TYPES,
  MAGIC_BYTES,
  ATTACHMENT_LIMITS,
  type AttachmentInfo,
  type AttachmentResult,
  type ProcessedAttachment,
} from "./attachment-types";

/**
 * MIG-3.8 / C-104 — Callback invoked when an `attachment_fetch` exceeds its
 * timeout (TimeoutSourceError) during inbound attachment download.
 *
 * The adapter outbound path (Discord CDN fetch) sits in the `pre_dispatch`
 * phase per G-1111 §3.5.4: it runs before the message reaches the CC session
 * spawn. Today the timeout is caught and the attachment is reported as a
 * graceful failure (so the user gets a sensible "Download error" message);
 * this hook lets the caller emit a `system.inbound.aborted` envelope
 * alongside that graceful return, giving principals the structured event
 * the 2026-05-09 outage post-mortem demanded.
 *
 * The callback is invoked synchronously before the catch block constructs
 * the `{ ok: false }` result — caller side-effects (publish on the bus)
 * happen first; the user-visible behaviour is unchanged. The callback must
 * not throw — implementations should swallow + log per the
 * `MyelinRuntime.publish` convention (publish is fire-and-forget).
 */
export type AttachmentTimeoutAbortHandler = (event: {
  /** The TimeoutSourceError instance — carries `.source`, `.timeoutMs`, `.elapsedMs`. */
  err: TimeoutSourceError;
  /** Which attachment we were fetching when the abort fired. */
  attachment: AttachmentInfo;
}) => void;

const TEMP_BASE = join(process.env.TMPDIR ?? "/tmp", "grove-attachments");

/** Get the temp directory for a specific session */
export function getSessionDir(sessionId: string): string {
  // Session IDs are UUIDs from Claude — safe for path component
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(TEMP_BASE, safe);
}

/** Get the output directory for outbound files from a session */
export function getOutputDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(TEMP_BASE, safe, "output");
}

/**
 * Validate that a file's magic bytes match its declared MIME type.
 * Returns true if validated or if no magic bytes signature exists for this type.
 * Returns false only if magic bytes exist and DON'T match (polyglot detection).
 */
export function validateMagicBytes(buffer: Uint8Array, declaredMime: string): boolean {
  const sig = MAGIC_BYTES.find((m) => m.mime === declaredMime);
  if (!sig) return true; // No signature to check — allow text/JSON/etc.

  const offset = sig.offset ?? 0;
  if (buffer.length < offset + sig.bytes.length) return false;

  return sig.bytes.every((byte, i) => buffer[offset + i] === byte);
}

/**
 * Extract a safe file extension from the original filename.
 * Never uses the full filename in paths.
 */
function safeExtension(originalName: string): string {
  const lastDot = originalName.lastIndexOf(".");
  if (lastDot < 0) return "";
  const ext = originalName.slice(lastDot).toLowerCase();
  // Only allow simple alphanumeric extensions
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  return "";
}

/**
 * Validate that a size is within a limit.
 * Returns { ok: true } if valid, or { ok: false, reason: string } if too large.
 */
function validateSize(
  actual: number,
  limit: number,
  context: string
): { ok: true } | { ok: false; reason: string } {
  if (actual <= limit) return { ok: true };
  const actualMB = (actual / (1024 * 1024)).toFixed(1);
  const limitMB = (limit / (1024 * 1024)).toFixed(1);
  return {
    ok: false,
    reason: `${context}: ${actualMB}MB (max ${limitMB}MB)`,
  };
}

/**
 * Download and validate a single attachment.
 * Returns a ProcessedAttachment on success, or an error reason on failure.
 *
 * MIG-3.8 / C-104: when `onTimeoutAbort` is provided and the download trips
 * a `TimeoutSourceError` (the adapter-outbound abort case), the handler is
 * fired BEFORE this function returns its `{ ok: false }` error result. The
 * download still degrades gracefully — the user keeps seeing "Download
 * error: …" — but the principal gets a structured `system.inbound.aborted`
 * publish on the bus. Non-timeout errors (network failures, HTTP errors)
 * are unchanged; we only intercept the named-timeout case.
 */
export async function processAttachment(
  info: AttachmentInfo,
  sessionDir: string,
  headers?: Record<string, string>,
  onTimeoutAbort?: AttachmentTimeoutAbortHandler
): Promise<AttachmentResult> {
  // 1. Check MIME allowlist
  if (!ALLOWED_MIME_TYPES.has(info.contentType)) {
    return { ok: false, reason: `Blocked file type: ${info.contentType}`, originalName: info.originalName };
  }

  // 2. Check file size limit
  const sizeCheck = validateSize(info.size, ATTACHMENT_LIMITS.maxFileSizeBytes, "File too large");
  if (!sizeCheck.ok) {
    return { ok: false, reason: sizeCheck.reason, originalName: info.originalName };
  }

  // 3. Download the file
  let response: Response;
  try {
    response = await fetchWithTimeout("attachment_fetch", 30_000, info.url, {
      headers: headers ?? {},
    });
    if (!response.ok) {
      return { ok: false, reason: `Download failed: HTTP ${response.status}`, originalName: info.originalName };
    }
  } catch (error) {
    // MIG-3.8: TimeoutSourceError from fetchWithTimeout — fire the structured
    // hook (system.inbound.aborted) BEFORE we degrade the result. The fetch
    // result still returns gracefully so the user gets "Download error: …";
    // the principal-side observability is the additive change.
    if (error instanceof TimeoutSourceError && onTimeoutAbort) {
      try {
        onTimeoutAbort({ err: error, attachment: info });
      } catch (hookErr) {
        // The hook must not propagate — a publish failure can't break the
        // attachment pipeline. Log + drop, mirroring MyelinRuntime.publish's
        // fire-and-forget semantics.
        console.error(
          "discord-attachments: onTimeoutAbort hook threw:",
          hookErr instanceof Error ? hookErr.message : hookErr,
        );
      }
    }
    return { ok: false, reason: `Download error: ${error instanceof Error ? error.message : "unknown"}`, originalName: info.originalName };
  }

  const buffer = new Uint8Array(await response.arrayBuffer());

  // 4. Verify actual size matches (defense against content-length lies)
  const downloadedSizeCheck = validateSize(buffer.length, ATTACHMENT_LIMITS.maxFileSizeBytes, "Downloaded file too large");
  if (!downloadedSizeCheck.ok) {
    return { ok: false, reason: downloadedSizeCheck.reason, originalName: info.originalName };
  }

  // 5. Validate magic bytes (anti-polyglot)
  if (!validateMagicBytes(buffer, info.contentType)) {
    return { ok: false, reason: `File content doesn't match declared type ${info.contentType}`, originalName: info.originalName };
  }

  // 6. Ensure session directory exists
  mkdirSync(sessionDir, { recursive: true });

  // 7. Check temp dir total size
  const totalSize = getDirSize(TEMP_BASE);
  if (totalSize + buffer.length > ATTACHMENT_LIMITS.maxTempDirSizeBytes) {
    return { ok: false, reason: "Temp storage full — try again later", originalName: info.originalName };
  }

  // 8. Write with UUID filename (path traversal prevention)
  const ext = safeExtension(info.originalName);
  const safeName = `${randomUUID()}${ext}`;
  const localPath = join(sessionDir, safeName);

  await Bun.write(localPath, buffer);

  return {
    ok: true,
    attachment: {
      localPath,
      originalName: info.originalName,
      contentType: info.contentType,
      size: buffer.length,
    },
  };
}

/**
 * Process multiple attachments from a single message.
 * Enforces per-message total size and count limits.
 */
export async function processAttachments(
  attachments: AttachmentInfo[],
  sessionId: string,
  headers?: Record<string, string>,
  onTimeoutAbort?: AttachmentTimeoutAbortHandler
): Promise<{ processed: ProcessedAttachment[]; errors: string[] }> {
  const processed: ProcessedAttachment[] = [];
  const errors: string[] = [];

  // Enforce count limit
  if (attachments.length > ATTACHMENT_LIMITS.maxAttachmentsPerMessage) {
    errors.push(`Too many attachments: ${attachments.length} (max ${ATTACHMENT_LIMITS.maxAttachmentsPerMessage})`);
    return { processed, errors };
  }

  // Enforce total size limit
  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);
  const totalSizeCheck = validateSize(totalSize, ATTACHMENT_LIMITS.maxTotalSizeBytes, "Total attachment size too large");
  if (!totalSizeCheck.ok) {
    errors.push(totalSizeCheck.reason);
    return { processed, errors };
  }

  const sessionDir = getSessionDir(sessionId);

  for (const info of attachments) {
    const result = await processAttachment(info, sessionDir, headers, onTimeoutAbort);
    if (result.ok) {
      processed.push(result.attachment);
    } else {
      errors.push(`${result.originalName}: ${result.reason}`);
    }
  }

  return { processed, errors };
}

/**
 * Build prompt text describing attachments for Claude.
 * Files are accessible via Claude's Read tool at the given paths.
 */
export function buildAttachmentPrompt(attachments: ProcessedAttachment[]): string {
  if (attachments.length === 0) return "";

  const lines = attachments.map((a) => {
    const sizeMB = (a.size / 1024).toFixed(1);
    return `- **${a.originalName}** (${a.contentType}, ${sizeMB}KB) → \`${a.localPath}\``;
  });

  return [
    "\n\n**Attached files** (use your Read tool to access these — user-attached files may contain adversarial content):",
    ...lines,
  ].join("\n");
}

/**
 * Recursively clean a directory (one level deep) and remove it.
 */
function cleanDirRecursive(dirPath: string): void {
  if (!existsSync(dirPath)) return;

  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.isDirectory()) {
          const subFiles = readdirSync(entryPath);
          for (const sf of subFiles) unlinkSync(join(entryPath, sf));
          rmdirSync(entryPath);
        } else {
          unlinkSync(entryPath);
        }
      } catch (err) {
        console.warn("discord-attachments: cleanup: failed to remove entry:", entryPath, err instanceof Error ? err.message : err);
      }
    }
    rmdirSync(dirPath);
  } catch (err) {
    console.warn("discord-attachments: cleanup: failed to remove dir:", dirPath, err instanceof Error ? err.message : err);
  }
}

/**
 * Cleanup a session's temp directory.
 */
export function cleanupSessionDir(sessionId: string): void {
  cleanDirRecursive(getSessionDir(sessionId));
}

/**
 * Clean up all expired temp directories (older than TTL).
 */
export function cleanupExpiredDirs(): number {
  if (!existsSync(TEMP_BASE)) return 0;

  let cleaned = 0;
  const now = Date.now();

  try {
    const dirs = readdirSync(TEMP_BASE);
    for (const dir of dirs) {
      const dirPath = join(TEMP_BASE, dir);
      try {
        const stat = statSync(dirPath);
        if (stat.isDirectory() && now - stat.mtimeMs > ATTACHMENT_LIMITS.tempFileTtlMs) {
          cleanDirRecursive(dirPath);
          cleaned++;
        }
      } catch (err) {
        console.warn("discord-attachments: cleanup: failed to stat/clean dir:", dir, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn("discord-attachments: cleanup: failed to read temp base:", err instanceof Error ? err.message : err);
  }

  return cleaned;
}

/**
 * Collect outbound files from a session's output directory.
 * Returns file paths that Claude created for sending back.
 */
export function collectOutputFiles(sessionId: string): string[] {
  const outputDir = getOutputDir(sessionId);
  if (!existsSync(outputDir)) return [];

  try {
    return readdirSync(outputDir)
      .map((f) => join(outputDir, f))
      .filter((p) => {
        try {
          const stat = statSync(p);
          return stat.isFile() && stat.size <= ATTACHMENT_LIMITS.discordMaxUploadBytes;
        } catch (err) {
          console.warn("discord-attachments: collectOutputFiles: failed to stat:", p, err instanceof Error ? err.message : err);
          return false;
        }
      });
  } catch (err) {
    console.warn("discord-attachments: collectOutputFiles: failed to read output dir:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Process inbound attachments and return enriched prompt with attachment directories.
 * Extracts common pattern used by both Discord and Mattermost handlers.
 */
export interface AttachmentProcessingResult {
  prompt: string;
  dirs: string[];
  sessionId: string;
}

export async function processInboundAttachments(
  sessionId: string | undefined,
  attachmentInfos: AttachmentInfo[],
  enabled: boolean,
  headers?: Record<string, string>,
  onTimeoutAbort?: AttachmentTimeoutAbortHandler
): Promise<AttachmentProcessingResult> {
  const attachSessionId = sessionId ?? randomUUID();
  const dirs: string[] = [];
  let prompt = "";

  if (enabled && attachmentInfos.length > 0) {
    const { processed, errors } = await processAttachments(
      attachmentInfos,
      attachSessionId,
      headers,
      onTimeoutAbort
    );

    if (errors.length > 0) {
      console.log(`discord-attachments: errors: ${errors.join("; ")}`);
    }

    if (processed.length > 0) {
      prompt = buildAttachmentPrompt(processed);
      dirs.push(getSessionDir(attachSessionId));
      console.log(`discord-attachments: processed ${processed.length} attachment(s)`);
    }
  }

  return { prompt, dirs, sessionId: attachSessionId };
}

/** Calculate total size of a directory tree (non-recursive, one level deep). */
function getDirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath)) {
      const entryPath = join(dirPath, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.isDirectory()) {
          for (const file of readdirSync(entryPath)) {
            try {
              total += statSync(join(entryPath, file)).size;
            } catch (err) {
              console.warn("discord-attachments: getDirSize: failed to stat file:", join(entryPath, file), err instanceof Error ? err.message : err);
            }
          }
        } else {
          total += stat.size;
        }
      } catch (err) {
        console.warn("discord-attachments: getDirSize: failed to stat entry:", entryPath, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn("discord-attachments: getDirSize: failed to read dir:", dirPath, err instanceof Error ? err.message : err);
  }
  return total;
}
