import { createHash } from "node:crypto";

import type { Surfaces } from "../common/types/surfaces";

type DiscordSurfaceBinding = NonNullable<Surfaces["discord"]>[number];

export interface DiscordTokenGroup {
  token: string;
  entries: DiscordSurfaceBinding[];
  guildIds: string[];
  instanceId: string;
}

export function discordTokenInstanceId(token: string): string {
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `discord:token:${digest}`;
}

export function groupDiscordBindingsByToken(
  entries: readonly DiscordSurfaceBinding[],
): DiscordTokenGroup[] {
  const groups = new Map<string, DiscordSurfaceBinding[]>();
  for (const entry of entries) {
    const token = entry.binding.token;
    const group = groups.get(token);
    if (group) {
      group.push(entry);
    } else {
      groups.set(token, [entry]);
    }
  }

  return [...groups].map(([token, groupedEntries]) => {
    const guildIds = groupedEntries.map((entry) => entry.binding.guildId);
    const firstGuildId = guildIds[0];
    const instanceId =
      guildIds.length === 1 && firstGuildId !== undefined
        ? `discord:${firstGuildId}`
        : discordTokenInstanceId(token);

    return { token, entries: groupedEntries, guildIds, instanceId };
  });
}
