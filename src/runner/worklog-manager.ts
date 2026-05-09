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
import { formatEventForThread, formatThreadName, formatCompletionSummary, formatChannelStart, formatChannelCompletion, isSubAgentEvent, extractTaskDescription } from "./worklog-formatter";
import { detectProject, extractGitHubIssue, formatDuration } from "./event-utils";

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
   */
  cleanupStaleSessions(maxAgeMs = 30 * 60 * 1000): number {
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
      const description = event.payload.prompt_preview
        ? String(event.payload.prompt_preview)
        : event.payload.description
          ? String(event.payload.description)
          : "Task started";

      const ghIssue = extractGitHubIssue(description);
      const project = event.payload.project ? String(event.payload.project) : detectProject(description);
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
    await channel.send(completionMsg).catch(() => {});

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
}

/**
 * Build context links — what iteration/design spec does this task relate to?
 * Returns a markdown string with links, or null if no context detected.
 *
 * TODO: Move link URLs to bot.yaml config so they aren't hardcoded.
 * These point to specific branches/issues that will change over time.
 */
function buildContextLinks(description: string, project: string | null): string | null {
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
