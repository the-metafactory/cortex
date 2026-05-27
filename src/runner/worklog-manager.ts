/**
 * G-200: Worklog Manager
 * Routes agent events to Discord threads in the #worklog channel.
 *
 * Each agent task (identified by session_id) gets its own thread.
 * The channel feed stays clean — only thread creation and completion
 * messages appear at the channel level.
 */

import type { Client, TextChannel, ThreadChannel } from "discord.js";
import type { PublishedEvent } from "../taps/cc-events/hooks/lib/event-types";
import {
  formatEventForThread,
  formatThreadName,
  formatCompletionSummary,
  formatChannelStart,
  formatChannelCompletion,
  formatDispatchEnvelopeForThread,
  isSubAgentEvent,
  extractTaskDescription,
} from "./worklog-formatter";
import { detectProject, extractGitHubIssue } from "./event-utils";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../bus/surface-router";

export class WorklogManager {
  private client: Client;
  private worklogChannelId: string;
  private sessionThreads = new Map<string, string>(); // session_id → thread_id
  private sessionDescriptions = new Map<string, string>(); // session_id → clean description from start event
  private channel: TextChannel | null = null;
  // Tracks when each session last received an event, for stale cleanup
  private sessionLastSeen = new Map<string, number>(); // session_id → epoch ms

  constructor(client: Client, worklogChannelId: string) {
    this.client = client;
    this.worklogChannelId = worklogChannelId;
  }

  /**
   * Clean up stale session→thread mappings for sessions that never completed.
   * Call periodically (e.g. every 5 minutes). Removes entries older than maxAgeMs.
   *
   * Default: 6h. Long-running CC tasks (research sweeps, multi-step builds)
   * routinely exceed the previous 30-minute floor, and the consequence of
   * eviction-during-progress is "terminal envelope arrives, can't find its
   * thread, channel-level summary still posts but per-thread summary is
   * lost" — graceful degradation, but avoidable. 6h covers nearly every
   * realistic in-process task without making the maps unbounded; longer
   * runs should pick a custom value (per Echo round-1 s4).
   */
  cleanupStaleSessions(maxAgeMs = 6 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [sessionId, lastSeen] of this.sessionLastSeen) {
      if (now - lastSeen > maxAgeMs) {
        this.sessionThreads.delete(sessionId);
        this.sessionDescriptions.delete(sessionId);
        this.sessionLastSeen.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Handle a published event — route to the correct worklog thread.
   * Creates a thread if this is the first event for a session.
   * Sub-agent events are routed to parent thread only (not channel-level).
   */
  async handleEvent(event: PublishedEvent): Promise<void> {
    const sessionId = event.session_id;
    if (!sessionId) return;

    this.sessionLastSeen.set(sessionId, Date.now());

    // Sub-agent events (moderator, participant prompts) — skip channel-level posts.
    // They'll still appear inside their parent's thread as progress events.
    if (isSubAgentEvent(event)) {
      if (event.event_type === "agent.task.started" || event.event_type === "agent.task.completed" || event.event_type === "agent.task.failed") {
        return; // Don't create threads or post start/complete for sub-agents
      }
      // Progress events from sub-agents can still go to parent thread
      await this.handleProgressEvent(event);
      return;
    }

    const channel = await this.getWorklogChannel();
    if (!channel) return;

    if (event.event_type === "agent.task.started") {
      await this.handleTaskStarted(channel, event);
    } else if (event.event_type === "agent.task.completed" || event.event_type === "agent.task.failed") {
      await this.handleTaskCompleted(channel, event);
    } else {
      await this.handleProgressEvent(event);
    }
  }

  private async handleTaskStarted(channel: TextChannel, event: PublishedEvent): Promise<void> {
    const threadName = formatThreadName(event);
    const channelMsg = formatChannelStart(event);

    try {
      // Post clean start message to channel, then create thread from it
      const startMsg = await channel.send(channelMsg);
      const thread = await startMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440, // 24 hours
      });

      this.sessionThreads.set(event.session_id, thread.id);

      // Remember the clean description so completion can reuse it
      this.sessionDescriptions.set(event.session_id, extractTaskDescription(event));

      // Post opening message inside the thread with rich context
      const description =
        asString(event.payload.prompt_preview) ||
        asString(event.payload.description) ||
        "Task started";

      const ghIssue = extractGitHubIssue(description);
      const project = asString(event.payload.project) || detectProject(description);
      const context = buildContextLinks(description, project);

      const parts = [
        `**Prompt:** ${description}`,
        ghIssue ? `**Issue:** ${ghIssue}` : null,
        project ? `**Project:** ${project}` : null,
        context ? `**Context:** ${context}` : null,
        `**Time:** <t:${Math.floor(new Date(event.timestamp).getTime() / 1000)}:t>`,
      ].filter(Boolean);

      await thread.send(parts.join("\n"));
    } catch (err) {
      console.error("worklog: failed to create thread:", err instanceof Error ? err.message : err);
    }
  }

  private async handleTaskCompleted(channel: TextChannel, event: PublishedEvent): Promise<void> {
    const threadId = this.sessionThreads.get(event.session_id);

    // Carry forward the description from the start event (completion events lack prompt_preview)
    const savedDesc = this.sessionDescriptions.get(event.session_id);
    if (savedDesc && !event.payload.prompt_preview) {
      event.payload.prompt_preview = savedDesc;
    }

    // Post summary to thread if it exists
    if (threadId) {
      try {
        const thread = await this.client.channels.fetch(threadId) as ThreadChannel | null;
        if (thread) {
          const summary = formatCompletionSummary(event);
          await thread.send(summary);

          // Archive the thread (preserves history)
          await thread.setArchived(true);
        }
      } catch (err) {
        console.error("worklog: failed to post completion to thread:", err instanceof Error ? err.message : err);
      }
    }

    // Post clean completion line to channel
    const completionMsg = formatChannelCompletion(event);
    await channel.send(completionMsg).catch(() => {
      // best-effort completion post; ignore Discord API errors
    });

    // Clean up mappings
    this.sessionThreads.delete(event.session_id);
    this.sessionDescriptions.delete(event.session_id);
    this.sessionLastSeen.delete(event.session_id);
  }

  private async handleProgressEvent(event: PublishedEvent): Promise<void> {
    let threadId = this.sessionThreads.get(event.session_id);

    // Late join: create thread on first event if none exists
    if (!threadId) {
      const channel = await this.getWorklogChannel();
      if (!channel) return;

      const threadName = formatThreadName(event);
      try {
        const startMsg = await channel.send(`\u{1F3C3} ${threadName} (joined in progress)`);
        const thread = await startMsg.startThread({
          name: threadName,
          autoArchiveDuration: 1440,
        });
        threadId = thread.id;
        this.sessionThreads.set(event.session_id, threadId);
      } catch (err) {
        console.error("worklog: failed to create late-join thread:", err instanceof Error ? err.message : err);
        return;
      }
    }

    const formatted = formatEventForThread(event);
    if (!formatted) return;

    try {
      const thread = await this.client.channels.fetch(threadId) as ThreadChannel | null;
      if (thread) {
        await thread.send(formatted);
      }
    } catch (err) {
      console.error("worklog: failed to post to thread:", err instanceof Error ? err.message : err);
    }
  }

  private async getWorklogChannel(): Promise<TextChannel | null> {
    if (this.channel) return this.channel;

    try {
      const ch = await this.client.channels.fetch(this.worklogChannelId);
      if (ch && "send" in ch) {
        this.channel = ch as TextChannel;
        return this.channel;
      }
    } catch (err) {
      console.error(`worklog: could not fetch channel ${this.worklogChannelId}:`, err instanceof Error ? err.message : err);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // MIG-4.7: Bus-driven sibling-consumer entry point.
  //
  // Per G-1111 §3.4, the worklog-manager can ALSO subscribe to
  // `dispatch.task.*` envelopes via the surface-router — alongside its
  // existing direct-call API. Adding this is purely additive: the existing
  // `handleEvent(PublishedEvent)` path stays intact for backwards
  // compatibility with the in-process CC-hook event pipeline. The new path
  // lets a future producer (a remote runner, a parallel agent fleet) emit
  // lifecycle events on the bus and have them rendered to the worklog
  // thread without going through the direct call.
  //
  // Thread keying: the bus path keys threads by `payload.task_id` (envelope
  // correlation_id). The direct-call path keys by `event.session_id`. Both
  // share the `sessionThreads` map because the keys are distinct UUIDs —
  // a session_id from CC will never collide with a task_id from a
  // dispatch envelope. (If they ever did, the consequence is benign: a
  // thread shared across two unrelated tasks. The probability is
  // 2^-64 per bot lifetime — vanishingly small and recoverable.)
  // ---------------------------------------------------------------------------

  /**
   * Surface adapter face — register this with `SurfaceRouter.register(...)`
   * to make worklog-manager a bus consumer of `dispatch.task.*` envelopes.
   *
   * Implementation note: returned as a getter (rather than a stored field)
   * so the closure captures `this` correctly. `render` is a fresh closure
   * per call to keep the surface contract obviously side-effect-free at
   * construction time.
   *
   * @param adapterId — defaults to `worklog-manager`. Configurable so a
   *   future multi-channel worklog (one channel per repo) can disambiguate.
   * @param principal — principal id segment. Worklog-manager doesn't store
   *   it (the manager is constructed with a Discord client + channel ID,
   *   not a bot config). Passing it explicitly keeps the dependency
   *   direction clean (no config import here).
   * @param stack — optional principal stack segment (IAW Phase A.5,
   *   cortex#268). When supplied, the manager subscribes on the 6-segment
   *   grammar `local.{principal}.{stack}.dispatch.task.>` matching sage's
   *   emit-side post-A.5. When omitted, falls through to the legacy
   *   5-segment form — bit-identical to pre-cortex#268.
   *
   * KNOWN LIMITATION (Echo round-1 s4): the bus path keys threads by
   * `task_id` and shares the `sessionThreads` map with the direct-call
   * path. `cleanupStaleSessions` now defaults to a 6-hour staleness
   * window (was 30 minutes — raised in C-108 sweep so long-running tasks
   * don't lose their thread mapping before the terminal envelope arrives).
   * Tasks that exceed even the 6h floor will still have their thread ID
   * evicted from the map, after which a late terminal envelope can no
   * longer find its thread. The bus path's fallback for "thread missing"
   * is to skip the per-thread post but still emit the channel-level
   * summary (graceful degradation, not data loss). Callers that need a
   * different window pass `maxAgeMs` explicitly.
   */
  surfaceConfig(opts: {
    principal: string;
    adapterId?: string;
    stack?: string;
  }): SurfaceAdapter {
    // cortex#268 — stack-aware subscription. When the caller supplies
    // `stack` (sourced from `deriveStackId(loadedConfig).stack` at boot),
    // emit the 6-segment subject grammar. Otherwise, fall through to the
    // legacy 5-segment form for backward compat with deployments that
    // haven't wired stack identity.
    const subject =
      opts.stack === undefined
        ? `local.${opts.principal}.dispatch.task.>`
        : `local.${opts.principal}.${opts.stack}.dispatch.task.>`;
    const subjects = [subject];
    return {
      id: opts.adapterId ?? "worklog-manager",
      subjects,
      // `signal` is accepted for contract symmetry; not forwarded into
      // discord.js calls (channel.send / thread.create) which don't take an
      // AbortSignal today. Future refinement when those call paths gain
      // signal support.
      render: (envelope: Envelope, _signal?: AbortSignal) =>
        this.renderDispatchEnvelope(envelope),
    };
  }

  /**
   * Render a `dispatch.task.*` envelope to the worklog thread. Mirrors the
   * direct-call path's three-stage logic: started → create thread; progress
   * (none on the bus path today, see §3.4); terminal (completed/failed/
   * aborted) → post summary, archive thread.
   *
   * Errors are caught and logged at the same granularity as the direct-call
   * path so a failing Discord API call can't poison the surface-router.
   */
  private async renderDispatchEnvelope(envelope: Envelope): Promise<void> {
    const payload = envelope.payload;
    const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
    if (!taskId) {
      console.error(
        `worklog: dispatch envelope ${envelope.id} missing task_id — skipping`,
      );
      return;
    }
    this.sessionLastSeen.set(taskId, Date.now());

    const channel = await this.getWorklogChannel();
    if (!channel) return;

    if (envelope.type === "dispatch.task.started") {
      await this.handleDispatchStarted(channel, envelope, taskId);
      return;
    }

    if (
      envelope.type === "dispatch.task.completed"
      || envelope.type === "dispatch.task.failed"
      || envelope.type === "dispatch.task.aborted"
    ) {
      await this.handleDispatchTerminal(channel, envelope, taskId);
      return;
    }

    // Unknown dispatch.task.* sub-type — log and ignore. Append-only spec
    // means new sub-types arrive over time; we tolerate them rather than
    // crashing. Warn rather than log because an unknown sub-type usually
    // means the worklog renderer is behind the producers and ought to be
    // updated — the principal should see this in stderr filters.
    console.warn(`worklog: ignoring unknown dispatch envelope type ${envelope.type}`);
  }

  private async handleDispatchStarted(
    channel: TextChannel,
    envelope: Envelope,
    taskId: string,
  ): Promise<void> {
    const payload = envelope.payload;
    const agentId = typeof payload.agent_id === "string" ? payload.agent_id : "agent";
    // Compact thread name — task_id prefix is enough to disambiguate for
    // principals eyeballing the channel feed.
    const threadName = `${agentId} — task ${taskId.slice(0, 8)}`;

    try {
      const startMsg = await channel.send(`\u{1F3C3} **${agentId}** started task \`${taskId.slice(0, 8)}\``);
      const thread = await startMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440, // 24h, matches the direct-call path
      });
      this.sessionThreads.set(taskId, thread.id);
      this.sessionDescriptions.set(taskId, threadName);

      // Opening message inside the thread carries the started envelope.
      const formatted = formatDispatchEnvelopeForThread(envelope.type, payload);
      if (formatted) await thread.send(formatted);
    } catch (err) {
      console.error(
        "worklog: failed to create dispatch thread:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async handleDispatchTerminal(
    channel: TextChannel,
    envelope: Envelope,
    taskId: string,
  ): Promise<void> {
    const payload = envelope.payload;
    const threadId = this.sessionThreads.get(taskId);
    const formatted = formatDispatchEnvelopeForThread(envelope.type, payload);

    // Post terminal line to the thread (if it exists)
    if (threadId) {
      try {
        const thread = await this.client.channels.fetch(threadId) as ThreadChannel | null;
        if (thread && formatted) {
          await thread.send(formatted);
          await thread.setArchived(true);
        }
      } catch (err) {
        console.error(
          "worklog: failed to post dispatch terminal to thread:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Channel-level summary — short, scannable.
    if (formatted) {
      // Use just the headline (first line) for the channel feed; details
      // stay in the thread.
      const head = formatted.split("\n", 1)[0] ?? formatted;
      await channel.send(head).catch(() => {
        // best-effort channel summary post; ignore Discord API errors
      });
    }

    // Clean up mappings so the maps don't grow unbounded.
    this.sessionThreads.delete(taskId);
    this.sessionDescriptions.delete(taskId);
    this.sessionLastSeen.delete(taskId);
  }
}

/**
 * Build context links — what iteration/design spec does this task relate to?
 * Returns a markdown string with links, or null if no context detected.
 *
 * TODO: Move link URLs to cortex.yaml config so they aren't hardcoded.
 * These point to specific branches/issues that will change over time.
 */
function buildContextLinks(description: string, _project: string | null): string | null {
  const links: string[] = [];

  // Match I-series (metafactory testing/CI)
  if (/\bI-4\d{2}\b/.test(description)) {
    links.push("[Iteration 4](https://github.com/the-metafactory/meta-factory/issues/25)");
    links.push("[Design](https://github.com/the-metafactory/meta-factory/blob/feat/iteration-2/design/testing-and-cicd.md)");
  }

  // Match G-series (Grove agent visibility)
  if (/\bG-2\d{2}\b/.test(description)) {
    links.push("[Agent Visibility](https://github.com/the-metafactory/grove/issues/35)");
    links.push("[Design](https://github.com/the-metafactory/grove/blob/feat/g-200-agent-visibility/docs/design-agent-visibility.md)");
  }

  // Match F-1xx (metafactory L1 trust)
  if (/\bF-1\d{2}\b/.test(description)) {
    links.push("[L1 Trust Foundation](https://github.com/the-metafactory/meta-factory/blob/main/design/l1-trust-foundation.md)");
  }

  return links.length > 0 ? links.join(" | ") : null;
}
