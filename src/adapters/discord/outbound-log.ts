/**
 * Legacy outbound-log/worklog bridge — moved here from `cortex.ts`
 * (cortex#1787, S2) so the discord.js-specific coupling
 * (`DiscordAdapter.getClient()`, `WorklogManager`-with-`Client`,
 * `formatEventForDiscord`) lives on the adapter's side of the boundary
 * instead of leaking into the platform-neutral entrypoint. This is a
 * RELOCATION, not a redesign — the JSONL polling and the events it
 * produces are byte-for-byte the same as before the move. Migrating this
 * off the JSONL-polling model onto the Renderer model is MIG-7.2d's job,
 * still pending; see the docstring on `attachLegacyOutboundLog` below for
 * the same "legacy direct-call path" framing the pre-move code carried.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { TextChannel } from "discord.js";
import type { AgentConfig } from "../../common/types/config";
import type { SurfaceRouter } from "../../bus/surface-router";
import type { SystemEventSource } from "../../bus/system-events";
import { JsonlReader } from "../../taps/cc-events/lib/jsonl-reader";
import { PublishedEventSchema } from "../../taps/cc-events/hooks/lib/event-types";
import type { DiscordAdapter } from "./index";
import { WorklogManager } from "./worklog-manager";
import { formatEventForDiscord } from "./event-formatter";

/**
 * Subscribe a Discord adapter to the published-events JSONL stream so
 * legacy `#agent-log` and per-task worklog threads keep working. Mirrors
 * grove-bot's `setupOutboundLog`. The dispatch.task.* projection has
 * migrated to `worklog-manager.surfaceConfig` (router-driven); this
 * function runs the legacy direct-call path while MIG-7.2d Renderer
 * cutover is pending.
 */
export function attachLegacyOutboundLog(
  discordAdapter: DiscordAdapter,
  instance: import("../../common/types/config").DiscordInstance,
  config: AgentConfig,
  router: SurfaceRouter,
  systemEventSource: SystemEventSource,
): (() => void) | null {
  const eventsDir = config.paths.publishedEventsDir.replace(/^~/, process.env.HOME ?? "~");
  const client = discordAdapter.getClient();
  if (!client) {
    console.log("cortex: discord client not available for outbound log");
    return null;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // discord.js v15 prep — see comment in adapters/discord/client.ts.
  client.on("clientReady", () => {
    if (!existsSync(eventsDir)) {
      console.log(`cortex: published events dir not found (${eventsDir}), skipping outbound`);
      return;
    }

    const reader = new JsonlReader();
    reader.skipAllToEnd(eventsDir);
    const logChannelId = instance.logChannelId;
    const guildId = instance.guildId;
    const postedEventIds = new Set<string>();

    let worklog: WorklogManager | null = null;
    if (instance.worklogChannelId) {
      worklog = new WorklogManager(client, instance.worklogChannelId);
      console.log(`cortex: worklog enabled → channel ${instance.worklogChannelId}`);
      // Register the worklog manager's `dispatch.task.*` surface so the
      // bus-driven path projects into the same threads as the JSONL path.
      router.register(
        worklog.surfaceConfig({
          principal: systemEventSource.principal,
          adapterId: `worklog-${discordAdapter.instanceId}`,
        }),
      );
    }

    const processFile = async (path: string) => {
      const events = reader.readNew(path);
      if (events.length > 0) {
        console.log(`cortex: processing ${events.length} event(s) from ${path.split("/").pop()}`);
      }
      for (const raw of events) {
        try {
          const event = PublishedEventSchema.parse(raw);
          if (postedEventIds.has(event.event_id)) continue;
          postedEventIds.add(event.event_id);
          if (worklog) await worklog.handleEvent(event);
          if (instance.enableAgentLog) {
            const formatted = formatEventForDiscord(event);
            if (!formatted) continue;
            const guild = client.guilds.cache.get(guildId);
            const channel =
              (guild?.channels.cache.get(logChannelId) as TextChannel | null)
              ?? ((await client.channels.fetch(logChannelId).catch(() => null)) as TextChannel | null);
            if (channel && "send" in channel) {
              await channel.send(formatted);
            } else {
              console.error(`cortex: could not resolve log channel ${logChannelId} — check bot permissions and channel ID`);
            }
          }
        } catch (err) {
          console.error("cortex: outbound error:", err instanceof Error ? err.message : err);
        }
      }
    };

    pollInterval = setInterval(() => {
      try {
        const files = readdirSync(eventsDir).filter((f: string) => f.endsWith(".jsonl"));
        for (const file of files) void processFile(join(eventsDir, file));
      } catch (err) {
        console.error("cortex: poll error:", err instanceof Error ? err.message : String(err));
      }
    }, 2000);

    console.log(`cortex: polling ${eventsDir} for outbound events (every 2s)`);
  });

  return () => {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}
