import { createHash } from "node:crypto";

import type { Surfaces } from "../common/types/surfaces";

type DiscordSurfaceBinding = NonNullable<Surfaces["discord"]>[number];

export interface DiscordTokenGroup {
  entries: DiscordSurfaceBinding[];
  instanceId: string;
}

export function discordTokenInstanceId(token: string, stack: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ token, stack: stack ?? null }))
    .digest("hex")
    .slice(0, 12);
  return `discord:token:${digest}`;
}

export function groupDiscordBindingsByToken(
  entries: readonly DiscordSurfaceBinding[],
): DiscordTokenGroup[] {
  const groups = new Map<string, DiscordSurfaceBinding[]>();
  for (const entry of entries) {
    const groupKey = JSON.stringify({
      token: entry.binding.token,
      stack: entry.stack ?? null,
    });
    const group = groups.get(groupKey);
    if (group) {
      group.push(entry);
    } else {
      groups.set(groupKey, [entry]);
    }
  }

  return [...groups.values()].map((groupedEntries) => {
    const firstEntry = groupedEntries[0];
    const token = firstEntry?.binding.token ?? "";
    const stack = firstEntry?.stack;
    const guildIds = groupedEntries.map((entry) => entry.binding.guildId);
    const firstGuildId = guildIds[0];
    const instanceId =
      guildIds.length === 1 && firstGuildId !== undefined
        ? `discord:${firstGuildId}`
        : discordTokenInstanceId(token, stack);

    return { entries: groupedEntries, instanceId };
  });
}
