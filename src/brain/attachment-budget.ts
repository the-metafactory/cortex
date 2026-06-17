/**
 * Per-task attachment budget (Bot Packs B-2; `docs/design-bot-packs.md` §12.5).
 *
 * §12.5 (JC decision, 2026-06-11): **4 MiB total per task** — cumulative
 * inline-base64 (`post.attachment.b64`) PLUS scratch-path uploads
 * (`post.attachment.path`) combined. Over budget → `effect_rejected` with
 * `wont_do` (PERMANENT for that task — the brain must summarise or link instead
 * of re-trying the same payload).
 *
 * This is the HOST-side cap (§8 "Resource caps are host-side manifest fields"),
 * SEPARATE from and STRICTER-in-aggregate than the per-attachment 256 KiB inline
 * cap (`protocol.ts` `MAX_ATTACHMENT_B64_BYTES`): a brain can stay under 256 KiB
 * per `post` yet blow the per-TASK ceiling across many posts. The inline cap is
 * a single-message shape limit enforced at PARSE time; this budget is a running
 * TASK total enforced after parse, at the host effect boundary.
 *
 * ## Why a shared module
 *
 * BOTH lifecycles enforce it: the per-task `exec-brain-runner` (one budget per
 * spawned task) and the daemon `daemon-brain-host` (one budget per multiplexed
 * task_id). Sharing the accounting keeps the rule in one place — a brain that
 * posts 20 × 250 KiB attachments hits the same `wont_do` whether it is per-task
 * or daemon-hosted.
 *
 * ## Sizing rule
 *
 *   - **inline** — the budget charges the DECODED byte length of the base64
 *     payload (`Buffer.byteLength(b64, "base64")`), i.e. what the upload will
 *     actually weigh on the surface, NOT the ~33%-larger base64 envelope. A
 *     brain that base64s a 250 KiB PNG is charged ~250 KiB, not ~333 KiB.
 *   - **scratch path** — the on-disk size of the referenced file
 *     (`statSync(...).size`). The runner has ALREADY confined the path to the
 *     task's scratch dir before this is called, so the stat is on a host-owned,
 *     in-bounds file. A vanished/unreadable file is charged 0 (the post will
 *     fail downstream at upload; the budget does not punish a stat miss).
 */

import { statSync } from "fs";
import type { PostAttachment } from "./protocol";

/**
 * The per-task attachment ceiling — 4 MiB (`docs/design-bot-packs.md` §12.5).
 * Cumulative inline + scratch bytes; exported so the host/runner share ONE
 * constant and tests assert against it directly.
 */
export const MAX_TASK_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** What {@link AttachmentBudget.charge} returns. */
export type AttachmentChargeResult =
  | { ok: true; chargedBytes: number; totalBytes: number }
  | { ok: false; detail: string; attemptedBytes: number; totalBytes: number };

/**
 * Compute the byte weight an attachment adds to a task's running total.
 *
 * Exported (not just used by {@link AttachmentBudget}) so a host can probe an
 * attachment's size without mutating a budget — e.g. for a log line. The
 * `confinedPath` argument lets the caller pass the HOST-RESOLVED, confined path
 * (the runner resolves `attachment.path` against the realpath'd scratch dir);
 * when omitted, the attachment's own `path` is stat'd as-is (the daemon host
 * passes the resolved path explicitly).
 */
export function attachmentByteSize(
  attachment: PostAttachment,
  confinedPath?: string,
): number {
  if (attachment.b64 !== undefined) {
    // Charge the DECODED size — what the surface upload actually weighs.
    return Buffer.byteLength(attachment.b64, "base64");
  }
  // Scratch-path reference. The caller has already confined the path; stat the
  // host-owned file. A stat failure (vanished/unreadable) charges 0 — the post
  // fails downstream at upload, not here.
  const pathToStat = confinedPath ?? attachment.path;
  if (pathToStat === undefined) return 0;
  try {
    return statSync(pathToStat).size;
  } catch (err) {
    // Non-fatal: a missing/unreadable scratch file is charged 0 (the post will
    // fail at upload). Logged so a silently-dropped charge is observable.
    process.stderr.write(
      `attachment-budget: could not stat scratch attachment "${pathToStat}" ` +
        `(charging 0 bytes): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 0;
  }
}

/**
 * A per-task running attachment-byte accumulator. One instance per task (the
 * runner makes one per spawned task; the daemon host makes one per task_id and
 * disposes it when the task closes). NOT thread-safe across tasks by design —
 * each task has its OWN budget; that is the §12.5 semantics ("4 MiB total per
 * task").
 *
 * The budget is CONSUMED on a successful charge: once 4 MiB is spent, every
 * subsequent attachment over the remainder is rejected `wont_do`. A rejected
 * charge does NOT consume budget (the attachment was refused, so its bytes never
 * counted) — the brain may still post a SMALLER attachment that fits the
 * remainder, or post text without an attachment.
 */
export class AttachmentBudget {
  private spent = 0;

  constructor(private readonly cap: number = MAX_TASK_ATTACHMENT_BYTES) {}

  /** Bytes already charged against this task. */
  get totalBytes(): number {
    return this.spent;
  }

  /** Remaining budget before the cap (never negative). */
  get remainingBytes(): number {
    return Math.max(0, this.cap - this.spent);
  }

  /**
   * Charge an attachment against the budget.
   *
   *   - WITHIN budget → consume the bytes, return `{ ok: true, chargedBytes,
   *     totalBytes }`.
   *   - OVER budget → consume NOTHING, return `{ ok: false, detail, … }` with a
   *     legible reason the caller turns into an `effect_rejected` (`wont_do`).
   *
   * `confinedPath` is the host-resolved, confined scratch path for a
   * path-attachment (the runner/host has already validated it stays inside the
   * task scratch dir). For an inline attachment it is ignored.
   */
  charge(
    attachment: PostAttachment,
    confinedPath?: string,
  ): AttachmentChargeResult {
    const bytes = attachmentByteSize(attachment, confinedPath);
    if (this.spent + bytes > this.cap) {
      return {
        ok: false,
        detail:
          `per-task attachment budget exceeded: this attachment is ${bytes} bytes, ` +
          `${this.spent} already used of ${this.cap} (${MAX_TASK_ATTACHMENT_BYTES / (1024 * 1024)} MiB) — ` +
          `summarise or link instead of attaching`,
        attemptedBytes: bytes,
        totalBytes: this.spent,
      };
    }
    this.spent += bytes;
    return { ok: true, chargedBytes: bytes, totalBytes: this.spent };
  }
}
