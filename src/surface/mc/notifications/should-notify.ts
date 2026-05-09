/**
 * Grove Mission Control v2 — F-11 should-notify policy (pure function).
 *
 * Implements the Decision 1 + Decision 3 transition matrix from
 * `docs/design-mc-f11-discord-notifications.md`.
 *
 * Given a transition (`from`, `to`, optional `blockReason`) plus the task's
 * priority, returns a `NotificationIntent | null`:
 *
 *   - `null` — silent. The transition is not notification-worthy.
 *   - `{ audience, severity, urgencyTag, rolePing }` — emit notification(s)
 *     to the named audience(s). Coalescing/dedup is the sink's job.
 *
 * No I/O, no logging, no database, no clock — testable from truth-table
 * inputs alone. This is the file the addendum's matrix is encoded into.
 */
import type { AssignmentState, BlockReason } from "../types";

/**
 * Audience for a single notification.
 *
 * `dm`      — operator's Discord DM (1:1, action-required surface).
 * `channel` — repo thread / log channel (broadcast surface).
 *
 * The matrix never schedules `both` for the *same* event content — when a
 * high-priority block fans out (Decision 2), it is explicitly modelled as
 * one DM (the actionable copy) plus one channel post (the role-ping cue
 * with shorter context). Each sink-call carries a single audience.
 */
export type NotificationAudience = "dm" | "channel";

export type NotificationSeverity = "ping" | "silent";

/**
 * Result of `shouldNotify`. `null` means "no notification — discard".
 */
export interface NotificationIntent {
  /**
   * Set of audiences to notify. The vast majority of cells are 1-element
   * sets; the high-priority `blocked` rows fan out to both DM and channel
   * (Decision 2). Encoded as a sorted-tuple-typed array for ergonomics
   * (sinks iterate it directly).
   */
  audiences: NotificationAudience[];
  /**
   * `ping` — channel posts use `<@&{operatorRoleId}>` if the role id is
   * configured (Decision 5). DMs always render without mention markup
   * (Decision 2's "no direct-mention in DMs" rule).
   *
   * `silent` — render the notification without escalation markup. DMs
   * still ping by default (operator inbox is the operator's choice); the
   * flag governs channel-side mention-ping behaviour only.
   */
  severity: NotificationSeverity;
  /**
   * Human-readable urgency prefix to splice into the rendered subject line
   * (Decision 3 column "DM urgency heuristic").
   *
   * Examples: `"P0-HIGH"`, `"P0-ERR"`, `"P1"`, `"HIGH"`, `"INPUT"`. May be
   * `null` for low-priority cells where the design table reads "(no prefix)".
   */
  urgencyTag: string | null;
}

export interface ShouldNotifyInput {
  from: AssignmentState;
  to: AssignmentState;
  /** `tasks.priority`. `0` is the highest (P0). */
  priority: number;
  /** Present iff `to === 'blocked'`. */
  blockReason: BlockReason | null;
}

/**
 * Decide whether a state transition should produce a Discord notification.
 *
 * Returns `null` for transitions outside the notification-worthy set
 * (Decision 1's matrix). The non-null branch encodes audience + severity +
 * urgency-tag per the Decision 3 priority × attention-type table.
 */
export function shouldNotify(input: ShouldNotifyInput): NotificationIntent | null {
  const { to, priority, blockReason } = input;

  // Mechanical / operator-driven / self-healed transitions — never notify.
  // Decision 1 matrix rows: queued→dispatched, dispatched→running,
  // *→cancelled, blocked→running, blocked→{completed,failed}.
  if (
    to === "queued" ||
    to === "dispatched" ||
    to === "running" ||
    to === "cancelled"
  ) {
    return null;
  }

  if (to === "completed") {
    // P0 completion gets a low-weight channel post; P1+ is silent
    // (dashboard handles those; push would be noise).
    if (priority === 0) {
      return {
        audiences: ["channel"],
        severity: "silent",
        urgencyTag: null,
      };
    }
    return null;
  }

  if (to === "failed") {
    // P0 failures: channel post + role ping. P1: channel post, no ping.
    // P2/P3: channel post, no ping. Always channel-only — failures land in
    // the repo thread for post-mortem context, not in the operator's DM.
    if (priority <= 0) {
      return {
        audiences: ["channel"],
        severity: "ping",
        urgencyTag: "P0-ERR",
      };
    }
    if (priority === 1) {
      return {
        audiences: ["channel"],
        severity: "silent",
        urgencyTag: "P1-ERR",
      };
    }
    return {
      audiences: ["channel"],
      severity: "silent",
      urgencyTag: null,
    };
  }

  if (to === "blocked") {
    // The blocked-row matrix branches on (priority, kind, risk). The
    // schema's `risk_hint` is optional and free-form on the agent side; we
    // narrow it to the three documented buckets ("high"/"medium"/"low")
    // and treat anything else (including `undefined`) as "medium".
    if (!blockReason) {
      // Schema invariant: state=blocked ↔ block_reason non-null. If we get
      // here, the caller violated that invariant — fail safe by emitting a
      // generic DM rather than crashing the hot path.
      return {
        audiences: ["dm"],
        severity: "silent",
        urgencyTag: priorityPrefix(priority),
      };
    }

    if (blockReason.kind === "permission.request") {
      const risk = normaliseRisk(blockReason.payload.risk_hint);
      const isHigh = risk === "high";

      if (priority <= 0 /* P0 */) {
        if (isHigh) {
          return {
            audiences: ["dm", "channel"],
            severity: "ping",
            urgencyTag: "P0-HIGH",
          };
        }
        return {
          audiences: ["dm"],
          severity: "silent",
          urgencyTag: "P0",
        };
      }

      if (priority === 1) {
        if (isHigh) {
          return {
            audiences: ["dm", "channel"],
            severity: "ping",
            urgencyTag: "P1-HIGH",
          };
        }
        return {
          audiences: ["dm"],
          severity: "silent",
          urgencyTag: "P1",
        };
      }

      // P2 / P3 — DM only, no ping. High-risk gets a "[HIGH]" tag.
      return {
        audiences: ["dm"],
        severity: "silent",
        urgencyTag: isHigh ? "HIGH" : null,
      };
    }

    if (blockReason.kind === "tool.error") {
      if (priority <= 0) {
        return {
          audiences: ["dm", "channel"],
          severity: "ping",
          urgencyTag: "P0-ERR",
        };
      }
      if (priority === 1) {
        return {
          audiences: ["dm"],
          severity: "silent",
          urgencyTag: "P1-ERR",
        };
      }
      return {
        audiences: ["dm"],
        severity: "silent",
        urgencyTag: null,
      };
    }

    if (blockReason.kind === "review.checkpoint") {
      // review.checkpoint is "agent asked for human sign-off". DM, no ping
      // even at P0 — the operator already opted in by configuring agents
      // that emit checkpoints.
      return {
        audiences: ["dm"],
        severity: "silent",
        urgencyTag: priorityPrefix(priority),
      };
    }
  }

  // Defensive fall-through: unknown future states or block-reason kinds.
  // Returning null is the safe default — push surfaces are best-effort.
  return null;
}

// `operator.input.requested` is contemplated by Decision 1 (last row of
// the matrix) but the event is not yet emitted by Mission Control v2 (no
// caller writes the `operator.input.requested` event type). When the
// emitter lands in a follow-up F-1?, restore `maybeNotifyInputRequested`
// in `discord-sink.ts` and a matching `shouldNotifyInputRequested` here,
// wired from the new emitter call site. Removed for now to keep this PR
// free of dead exports (W2 in PR #23 review).

// ----- helpers ---------------------------------------------------------

function priorityPrefix(priority: number): string | null {
  if (priority <= 0) return "P0";
  if (priority === 1) return "P1";
  return null;
}

function normaliseRisk(hint: string | undefined): "high" | "medium" | "low" {
  if (hint === "high" || hint === "medium" || hint === "low") return hint;
  return "medium";
}
