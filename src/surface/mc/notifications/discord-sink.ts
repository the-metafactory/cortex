/**
 * Grove Mission Control v2 — F-11 Discord notification sink.
 *
 * Owns the dedup + coalesce buffers (Decision 7 of
 * `docs/design-mc-f11-discord-notifications.md`) and the call into a
 * `DiscordNotifier` (the existing `DiscordAdapter` from grove-bot, behind
 * an interface so this module is testable without spinning up Discord).
 *
 * Three buffers, all in-memory (Decision 7 is explicit about durability):
 *   1. Per-assignment 5 s dedup window.
 *   2. Per-principal 3 s coalesce window — N ≥ 2 collapses to one summary DM.
 *   3. Per-channel 10 s throttle — collapses bursts into one summary post.
 *
 * Hot path: `maybeNotifyDiscord(deps, ctx)` is called from both
 * `applyTransition` call sites (handlers.ts:354, stdout-dispatcher.ts:174).
 * When `deps.config.enabled === false`, every call returns immediately.
 *
 * Error policy: any failure in the Discord-API call is logged via
 * `process.stderr.write` and an optional `onSystemError` callback (which
 * the caller wires to `insertEvent({type: 'system.error'})`). The state
 * machine and the dashboard are unaffected — push is best-effort.
 */
import type { BlockReason } from "../types";
import {
  shouldNotify,
  type NotificationIntent,
} from "./should-notify";
import {
  renderDM,
  renderChannel,
  renderCoalescedDM,
  renderCoalescedChannel,
  type RenderContext,
  type CoalesceContext,
  type CoalesceItem,
} from "./render";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * Adapter over the actual Discord client. The grove-bot's `DiscordAdapter`
 * (src/bot/lib/adapters/discord.ts) implements this trivially via
 * `client.users.createDM` and `client.channels.fetch` — F-11 does not
 * spawn a second bot or token (Decision 9).
 */
export interface DiscordNotifier {
  /** Send a plain-text DM to a user id. */
  sendDM(userId: string, text: string): Promise<void>;
  /** Send a plain-text message to a channel/thread id. */
  sendChannelMessage(channelId: string, text: string): Promise<void>;
}

/** F-11 configuration block (subset of bot.yaml schema). */
export interface DiscordSinkConfig {
  /** `grove.notifications.discord` — master toggle. Default false. */
  enabled: boolean;
  /** `grove.baseUrl` — used to build deep links. Empty string = unset. */
  baseUrl: string;
  /**
   * `agent.operatorDiscordId` — recipient of DM-class notifications.
   * Unset = DM-class notifications fall through to channel post (Decision 5).
   */
  operatorDiscordId?: string;
  /**
   * `discord.operatorRoleId` — when set, channel posts marked
   * `severity = 'ping'` render `<@&{id}>` in the body. Unset = plain post.
   */
  operatorRoleId?: string;
  /**
   * Default fallback channel id when a per-task thread can't be resolved.
   * Wired from `discord[0].worklogChannelId ?? discord[0].agentChannelId`.
   */
  fallbackChannelId?: string;
  /**
   * Optional per-`source_url` override. Decision 5 stays narrow: when a
   * task carries `source_url = github.com/<owner>/<repo>/...` and the
   * caller can resolve the per-repo thread, it passes that here. F-11
   * does not own the resolver — the bot adapter does, and we accept its
   * answer.
   */
  resolveThreadId?: (sourceUrl: string | null) => string | undefined;
}

/**
 * Per-call inputs the notification path needs from the DB. The caller
 * (which already has `applyTransition`'s result + the assignment + task
 * rows in hand) builds this once and hands it to the sink.
 */
export interface NotificationContext {
  /** `agent_task_assignment.id`. */
  assignmentId: string;
  agentName: string;
  taskId: string;
  taskRef: string;
  taskTitle: string;
  /** `tasks.priority`. */
  priority: number;
  /** `tasks.source_url`. May be null for `internal` tasks. */
  taskSourceUrl: string | null;
  /** `tasks.principal_id`. Coalescing keys off this. */
  principalId: string;
  /**
   * Cycle / dispatch count for this assignment. Optional — the renderer
   * omits the line if absent.
   */
  cycle?: number;
  /**
   * Most-recent assistant message text, used as the line-5 fallback when
   * `block_reason.context` is absent. Optional — caller passes when easy
   * to fetch, omits otherwise (renderer handles either case).
   */
  recentAssistantMessage?: string;
  /**
   * Wall-clock time at which the transition was observed. Used to render
   * the relative "observed Ns ago" line. Defaults to `Date.now()`.
   */
  observedAtMs?: number;
}

/**
 * Test seam for the coalesce / channel-throttle flush timers. Production
 * passes nothing (defaults to `setTimeout`/`clearTimeout`). Tests inject a
 * deterministic scheduler so they don't have to wait the full coalesce or
 * throttle window in real wall-clock time. See S4 in PR #23 review.
 */
export interface FlushScheduler {
  /** Schedule `cb` to run after `delayMs`. Returns a handle the sink can
   *  cancel via `cancel(handle)` if the buffer is flushed early. */
  schedule(cb: () => void, delayMs: number): unknown;
  /** Cancel a previously-scheduled callback. No-op if it already fired. */
  cancel(handle: unknown): void;
}

export interface MaybeNotifyDeps {
  config: DiscordSinkConfig;
  notifier: DiscordNotifier;
  /**
   * Wired to grove-mission-control's `events` insert + WS broadcast for
   * `system.error`. When omitted, errors only go to stderr.
   */
  onSystemError?: (message: string, ctx: { assignmentId: string }) => void;
  /**
   * Test seam — clock injection. Production passes nothing (defaults to
   * `Date.now`). Tests inject a controlled clock.
   */
  now?: () => number;
  /**
   * Test seam — coalesce / channel-throttle timer injection. Production
   * passes nothing (defaults to real `setTimeout`/`clearTimeout`). See S4
   * in PR #23 review for why this exists.
   */
  scheduler?: FlushScheduler;
}

export interface MaybeNotifyInput {
  from: import("../types").AssignmentState;
  to: import("../types").AssignmentState;
  blockReason: BlockReason | null;
  ctx: NotificationContext;
}

// ---------------------------------------------------------------------
// Module-level buffers (per-process, in-memory — Decision 7).
// ---------------------------------------------------------------------

/**
 * Per-assignment dedup key. Decision 7 prose ("If the same `assignment_id`
 * transitions `A → blocked` twice within 5 s, only the first produces a
 * notification") keys on (assignment, target-state, block-reason kind):
 * a `blocked` followed by a `failed` 3 s later for the same assignment is
 * a *different* notification-worthy event and must not be silenced. See S2
 * in PR #23 review.
 */
type DedupKey = string;
function makeDedupKey(
  assignmentId: string,
  toState: import("../types").AssignmentState,
  blockReason: BlockReason | null
): DedupKey {
  const kind = blockReason?.kind ?? "none";
  return `${assignmentId}|${toState}|${kind}`;
}

/** Per-(assignment, toState, kind) dedup window: key → lastSentAtMs. */
const dedupWindow = new Map<DedupKey, number>();

/**
 * Pre-rendered payloads + the buffer-level metadata needed to emit a
 * single-event or coalesced notification at flush time. Note: the
 * single-event payload is rendered eagerly because the renderer is pure
 * and cheap, but each entry only carries the small `CoalesceItem` —
 * buffer-level state (notifier, onSystemError, deepLink, etc.) lives on
 * the per-key buffer envelope below (N2 in PR #23 review).
 */
interface PendingCoalesceEntry {
  bufferedAt: number;
  /** Per-item summary line for `renderCoalescedDM`/`renderCoalescedChannel`. */
  item: CoalesceItem;
  /** Render context kept around so we can defer single-event payload
   *  rendering to flush time (N1 in PR #23 review). */
  renderCtx: RenderContext;
  /** The intent that produced this entry — drives role-ping decoration on
   *  the channel single-event flush. */
  intent: NotificationIntent;
  /** Deep-link to this specific assignment (used at flush time when this
   *  is the top-priority entry). */
  deepLink: string;
  /** Priority of the underlying assignment — `topPriority` of the buffer
   *  is the min across all entries. */
  priority: number;
  /** Assignment id — surfaced in onSystemError callbacks. */
  assignmentId: string;
}

/**
 * Per-key buffer envelope. `notifier`, `onSystemError`, `targetId`, and the
 * armed timer handle live here — they're invariant across all entries
 * within a single coalesce window (N2 in PR #23 review).
 */
interface CoalesceBuffer {
  /** "dm" buffers DM payloads, "channel" buffers channel-throttle posts. */
  audience: "dm" | "channel";
  entries: PendingCoalesceEntry[];
  notifier: DiscordNotifier;
  onSystemError?: MaybeNotifyDeps["onSystemError"];
  /**
   * For `audience === "dm"` this is the principal's Discord user id; for
   * `audience === "channel"` it's the channel/thread id. Empty string is
   * never valid (caller checks before enqueueing).
   */
  targetId: string;
  /** For DMs only: role-ping config carries through to the channel-burst
   *  fanout case. Unused for channel buffers. */
  config: DiscordSinkConfig;
  /** Scheduler handle for the armed flush timer. Null until flushed. */
  timer: unknown;
  /** Concrete scheduler captured at arm-time (test seam). */
  scheduler: FlushScheduler;
}

/** Per-principal coalesce buffer: `principal_id → buffer`. */
const dmBuffers = new Map<string, CoalesceBuffer>();
/** Per-channel coalesce buffer: `channel_id → buffer`. */
const channelBuffers = new Map<string, CoalesceBuffer>();

const DEDUP_WINDOW_MS = 5_000;
const COALESCE_WINDOW_MS = 3_000;
const CHANNEL_THROTTLE_WINDOW_MS = 10_000;

const DEFAULT_SCHEDULER: FlushScheduler = {
  schedule(cb, delayMs) {
    return setTimeout(cb, delayMs);
  },
  cancel(handle) {
    if (handle !== null && handle !== undefined) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

/**
 * Test-only: drop all in-memory buffers. Production code never calls
 * this; tests do, between describe/it blocks, to keep state isolated.
 */
export function __resetDiscordSinkState(): void {
  for (const buf of dmBuffers.values()) {
    if (buf.timer !== null) buf.scheduler.cancel(buf.timer);
  }
  for (const buf of channelBuffers.values()) {
    if (buf.timer !== null) buf.scheduler.cancel(buf.timer);
  }
  dedupWindow.clear();
  dmBuffers.clear();
  channelBuffers.clear();
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Decide whether `(from, to, blockReason)` is notification-worthy and, if
 * so, route the rendered payload through the sink. No-op when
 * `config.enabled === false`.
 *
 * Always returns a resolved promise — Discord errors are caught and
 * surfaced via `onSystemError` + stderr. The caller never has to
 * `try/catch` this.
 */
export async function maybeNotifyDiscord(
  deps: MaybeNotifyDeps,
  input: MaybeNotifyInput
): Promise<void> {
  if (!deps.config.enabled) return;

  const intent = shouldNotify({
    from: input.from,
    to: input.to,
    priority: input.ctx.priority,
    blockReason: input.blockReason,
  });
  if (!intent) return;

  await dispatchIntent(deps, intent, input);
}

// ---------------------------------------------------------------------
// Internal dispatch
// ---------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
async function dispatchIntent(
  deps: MaybeNotifyDeps,
  intent: NotificationIntent,
  input: MaybeNotifyInput
): Promise<void> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;

  // (1) Per-assignment dedup window — keyed on (assignment, toState,
  // blockReason.kind) per Decision 7's "same assignment_id transitions
  // A → blocked twice within 5 s" wording. A `blocked` followed by a
  // `failed` for the same assignment is a different notification-worthy
  // event and must NOT be silenced (S2 in PR #23 review).
  const dedupKey = makeDedupKey(
    input.ctx.assignmentId,
    input.to,
    input.blockReason
  );
  const lastSent = dedupWindow.get(dedupKey);
  if (lastSent !== undefined && nowMs - lastSent < DEDUP_WINDOW_MS) {
    return;
  }
  dedupWindow.set(dedupKey, nowMs);
  // Light periodic cleanup so the map doesn't grow unbounded — drop
  // entries older than the window every ~50 calls.
  if (dedupWindow.size > 50) sweepStale(dedupWindow, nowMs, DEDUP_WINDOW_MS);

  // Build the renderer ctx once — both DM and channel paths share it.
  const renderCtx = buildRenderContext(deps.config, intent, input, nowMs);

  // Resolve channel id (used by both single and coalesced paths).
  const channelId = resolveChannelId(deps.config, input.ctx);

  // (2) DM path with per-principal coalescing — DM-class notifications
  // accumulate within COALESCE_WINDOW_MS; the first event arms a timer,
  // subsequent events on the same principal within the window collapse
  // into one summary.
  if (intent.audiences.includes("dm")) {
    const operatorDiscordId = deps.config.operatorDiscordId;
    if (!operatorDiscordId) {
      // Decision 5 / Decision 6 degradation: DM-class notifications fall
      // through to channel with a one-line warning. We render and send
      // the channel payload via the channel-throttle path so a swarm of
      // misconfigured DMs still coalesces.
      if (channelId) {
        const fallback = renderChannel(renderCtx) +
          "\nNote: operatorDiscordId unset; routing DM-class notification to channel.";
        enqueueChannel(
          deps,
          channelId,
          fallback,
          intent,
          renderCtx,
          input.ctx,
          nowMs,
          scheduler,
          /* alreadyDecorated */ true
        );
      }
    } else {
      enqueueDM(
        deps,
        intent,
        input.ctx,
        renderCtx,
        operatorDiscordId,
        nowMs,
        scheduler
      );
    }
  }

  // (3) Channel-only audience path. When DM was already in the audiences
  // (e.g. P0-HIGH blocked rows fan out to both), the channel post here is
  // the role-ping companion — both go through the per-channel coalesce
  // buffer so a P0-burst collapses to one summary post per Decision 7.
  if (intent.audiences.includes("channel") && channelId) {
    enqueueChannel(
      deps,
      channelId,
      /* preDecoratedPayload */ undefined,
      intent,
      renderCtx,
      input.ctx,
      nowMs,
      scheduler,
      /* alreadyDecorated */ false
    );
  }
}

// ---------------------------------------------------------------------
// DM coalescing (per-principal, 3 s window)
// ---------------------------------------------------------------------

function enqueueDM(
  deps: MaybeNotifyDeps,
  intent: NotificationIntent,
  ctx: NotificationContext,
  renderCtx: RenderContext,
  operatorDiscordId: string,
  nowMs: number,
  scheduler: FlushScheduler
): void {
  const key = ctx.principalId;
  let buffer = dmBuffers.get(key);
  if (!buffer) {
    buffer = {
      audience: "dm",
      entries: [],
      notifier: deps.notifier,
      ...(deps.onSystemError !== undefined
        ? { onSystemError: deps.onSystemError }
        : {}),
      targetId: operatorDiscordId,
      config: deps.config,
      timer: null,
      scheduler,
    };
    dmBuffers.set(key, buffer);
  }

  const entry: PendingCoalesceEntry = {
    bufferedAt: nowMs,
    item: {
      urgencyTag: intent.urgencyTag,
      agentName: ctx.agentName,
      taskRef: ctx.taskRef,
      taskTitle: ctx.taskTitle,
      reasonLine: extractReasonLine(renderCtx),
    },
    renderCtx,
    intent,
    deepLink: renderCtx.deepLink,
    priority: ctx.priority,
    assignmentId: ctx.assignmentId,
  };
  buffer.entries.push(entry);

  // First event arms the flush timer; subsequent events ride the same one.
  if (buffer.entries.length === 1) {
    buffer.timer = scheduler.schedule(() => {
      void flushDMBuffer(key);
    }, COALESCE_WINDOW_MS);
  }
}

async function flushDMBuffer(key: string): Promise<void> {
  const buffer = dmBuffers.get(key);
  if (!buffer || buffer.entries.length === 0) return;
  dmBuffers.delete(key);
  if (buffer.timer !== null) buffer.scheduler.cancel(buffer.timer);

  if (buffer.entries.length === 1) {
    // N=1: render the original single-event DM body at flush time (N1 in
    // PR #23 review — defer rendering to flush so a coalesced burst never
    // pays for the per-entry render cost).
    const only = buffer.entries[0];
    if (!only) return;
    const payload = renderDM(only.renderCtx);
    await sendDMSafely(buffer, payload, only.assignmentId);
    return;
  }

  // N ≥ 2 — render a coalesced summary DM. Pick the top-priority entry's
  // deep link and the highest-severity urgency tag for the subject line.
  const top = buffer.entries.reduce((best, cur) =>
    cur.priority < best.priority ? cur : best
  );
  const summary: CoalesceContext = {
    count: buffer.entries.length,
    topUrgencyTag: top.item.urgencyTag,
    items: buffer.entries.map((e) => e.item),
    deepLink: top.deepLink,
    ...(top.renderCtx.baseUrlWarning ? { baseUrlWarning: true } : {}),
  };
  const payload = renderCoalescedDM(summary);
  await sendDMSafely(buffer, payload, "<coalesced>");
}

async function sendDMSafely(
  buffer: CoalesceBuffer,
  payload: string,
  assignmentId: string
): Promise<void> {
  try {
    await buffer.notifier.sendDM(buffer.targetId, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[discord-sink] sendDM failed for ${buffer.targetId}: ${msg}\n`
    );
    buffer.onSystemError?.(`discord-sink: sendDM failed: ${msg}`, {
      assignmentId,
    });
  }
}

// ---------------------------------------------------------------------
// Channel coalescing (per-channel, 10 s window — Decision 7)
// ---------------------------------------------------------------------

/**
 * Per-channel coalesce buffer. Mirrors the DM path: first event arms a
 * flush timer; subsequent events on the same channel within the
 * `CHANNEL_THROTTLE_WINDOW_MS` window collapse into one summary post per
 * Decision 7 ("if more than one lands in the same 10 s window per
 * destination channel, they coalesce into a single summary post"). Five
 * P0 failures within 10 s = one channel post, not five (W1 in PR #23
 * review).
 *
 * `preDecoratedPayload` is set only for the operatorDiscordId-unset
 * fallback path, where the caller has already appended the
 * "operatorDiscordId unset" warning. For the normal channel-audience
 * path, we render the channel payload (with role-ping decoration) at
 * flush time so coalesced bursts never pay the per-entry render cost.
 */
function enqueueChannel(
  deps: MaybeNotifyDeps,
  channelId: string,
  preDecoratedPayload: string | undefined,
  intent: NotificationIntent,
  renderCtx: RenderContext,
  ctx: NotificationContext,
  nowMs: number,
  scheduler: FlushScheduler,
  alreadyDecorated: boolean
): void {
  let buffer = channelBuffers.get(channelId);
  if (!buffer) {
    buffer = {
      audience: "channel",
      entries: [],
      notifier: deps.notifier,
      ...(deps.onSystemError !== undefined
        ? { onSystemError: deps.onSystemError }
        : {}),
      targetId: channelId,
      config: deps.config,
      timer: null,
      scheduler,
    };
    channelBuffers.set(channelId, buffer);
  }

  // We capture the pre-decorated fallback payload on the entry's renderCtx
  // by stashing it via a side-channel: a small extension type lets the
  // flush path tell "fallback override" from "render fresh at flush".
  const entry: PendingCoalesceEntry & {
    fallbackPayload?: string;
    alreadyDecorated?: boolean;
  } = {
    bufferedAt: nowMs,
    item: {
      urgencyTag: intent.urgencyTag,
      agentName: ctx.agentName,
      taskRef: ctx.taskRef,
      taskTitle: ctx.taskTitle,
      reasonLine: extractReasonLine(renderCtx),
    },
    renderCtx,
    intent,
    deepLink: renderCtx.deepLink,
    priority: ctx.priority,
    assignmentId: ctx.assignmentId,
    ...(preDecoratedPayload !== undefined
      ? { fallbackPayload: preDecoratedPayload }
      : {}),
    alreadyDecorated,
  };
  buffer.entries.push(entry);

  if (buffer.entries.length === 1) {
    buffer.timer = scheduler.schedule(() => {
      void flushChannelBuffer(channelId);
    }, CHANNEL_THROTTLE_WINDOW_MS);
  }
}

async function flushChannelBuffer(channelId: string): Promise<void> {
  const buffer = channelBuffers.get(channelId);
  if (!buffer || buffer.entries.length === 0) return;
  channelBuffers.delete(channelId);
  if (buffer.timer !== null) buffer.scheduler.cancel(buffer.timer);

  if (buffer.entries.length === 1) {
    const onlyEntry = buffer.entries[0];
    if (!onlyEntry) return;
    const only = onlyEntry as PendingCoalesceEntry & {
      fallbackPayload?: string;
      alreadyDecorated?: boolean;
    };
    let payload: string;
    if (only.fallbackPayload !== undefined) {
      payload = only.fallbackPayload;
    } else {
      const rendered = renderChannel(only.renderCtx);
      payload = only.alreadyDecorated
        ? rendered
        : decorateWithRolePing(rendered, only.intent, buffer.config);
    }
    await sendChannelSafely(buffer, payload, only.assignmentId);
    return;
  }

  // N ≥ 2 — render a coalesced summary channel post. Decision 7: same
  // shape as the DM summary. The summary itself is a single message; we
  // do NOT prepend a role-ping for the burst (the per-event mentions are
  // intentionally swallowed by coalescing — the principal who wanted the
  // ping can find every individual block on the dashboard).
  const top = buffer.entries.reduce((best, cur) =>
    cur.priority < best.priority ? cur : best
  );
  const summary: CoalesceContext = {
    count: buffer.entries.length,
    topUrgencyTag: top.item.urgencyTag,
    items: buffer.entries.map((e) => e.item),
    deepLink: top.deepLink,
    ...(top.renderCtx.baseUrlWarning ? { baseUrlWarning: true } : {}),
  };
  const payload = renderCoalescedChannel(summary);
  await sendChannelSafely(buffer, payload, "<coalesced>");
}

async function sendChannelSafely(
  buffer: CoalesceBuffer,
  payload: string,
  assignmentId: string
): Promise<void> {
  try {
    await buffer.notifier.sendChannelMessage(buffer.targetId, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[discord-sink] sendChannelMessage failed for ${buffer.targetId}: ${msg}\n`
    );
    buffer.onSystemError?.(
      `discord-sink: sendChannelMessage failed: ${msg}`,
      { assignmentId }
    );
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildRenderContext(
  config: DiscordSinkConfig,
  intent: NotificationIntent,
  input: MaybeNotifyInput,
  nowMs: number
): RenderContext {
  const observedAtMs = input.ctx.observedAtMs ?? nowMs;
  const ageSec = Math.max(0, Math.floor((nowMs - observedAtMs) / 1000));
  const observedAgo = ageSec < 60
    ? `${ageSec}s ago`
    : ageSec < 3600
    ? `${Math.floor(ageSec / 60)}m ago`
    : `${Math.floor(ageSec / 3600)}h ago`;

  const toState = input.to === "blocked" || input.to === "failed" || input.to === "completed"
    ? input.to
    : "blocked";

  const baseUrl = config.baseUrl.trim();
  const deepLink = baseUrl.length > 0
    ? `${baseUrl.replace(/\/+$/, "")}/?focus=assignment/${input.ctx.assignmentId}&from=${intent.audiences.includes("dm") ? "dm" : "channel"}`
    : `assignment/${input.ctx.assignmentId}`;

  return {
    intent,
    agentName: input.ctx.agentName,
    taskRef: input.ctx.taskRef,
    taskTitle: input.ctx.taskTitle,
    toState,
    blockReason: input.blockReason,
    ...(typeof input.ctx.cycle === "number" ? { cycle: input.ctx.cycle } : {}),
    observedAgo,
    ...(input.ctx.recentAssistantMessage !== undefined
      ? { recentAssistantMessage: input.ctx.recentAssistantMessage }
      : {}),
    deepLink,
    ...(baseUrl.length === 0 ? { baseUrlWarning: true } : {}),
  };
}

function resolveChannelId(
  config: DiscordSinkConfig,
  ctx: NotificationContext
): string | undefined {
  // (a) GitHub-sourced task with an injected resolver — try it first.
  if (ctx.taskSourceUrl && config.resolveThreadId) {
    const tid = config.resolveThreadId(ctx.taskSourceUrl);
    if (tid) return tid;
  }
  // (b) Internal task or unresolved thread — fall back to the instance
  // worklog/agent channel. Decision 5: F-11 is read-only on channel
  // topology; thread auto-creation is the v1 SOP's job.
  return config.fallbackChannelId;
}

function decorateWithRolePing(
  payload: string,
  intent: NotificationIntent,
  config: DiscordSinkConfig
): string {
  if (intent.severity !== "ping") return payload;
  if (!config.operatorRoleId) return payload;
  return `<@&${config.operatorRoleId}> ${payload}`;
}

function extractReasonLine(ctx: RenderContext): string {
  const r = ctx.blockReason;
  if (!r) return ctx.toState; // "failed" / "completed"
  if (r.kind === "permission.request") {
    return `permission.request: ${r.payload.requested_action}`;
  }
  if (r.kind === "tool.error") {
    return `tool.error: ${r.payload.tool_name}`;
  }
  return `review.checkpoint`;
}

function sweepStale(
  buffer: Map<string, number>,
  nowMs: number,
  windowMs: number
): void {
  for (const [key, t] of buffer) {
    if (nowMs - t >= windowMs) buffer.delete(key);
  }
}
