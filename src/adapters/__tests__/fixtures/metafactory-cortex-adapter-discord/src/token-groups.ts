/**
 * cortex#1797 (S12, ADR-0024 D5 extraction lane) — relocated verbatim from
 * cortex's `src/gateway/discord-token-groups.ts`. Discord delivers every
 * guild event for a bot token over ONE gateway session — bindings are
 * token-keyed, not guild-keyed (`gateway-adapters.ts` GW.a.3b.2b module doc)
 * — so this is the only in-tree-turned-plugin adapter with non-default
 * `AdapterPlugin.groupBindings`.
 *
 * The pre-extraction version typed `entries` against `Surfaces["discord"]`
 * (cortex's `common/types/surfaces.ts`) purely for field access
 * (`.binding.token`, `.binding.guildId`, `.stack`) — it never needed the
 * FULL cortex-internal `Surfaces` type. Retyped here against
 * `SurfaceBindingEntry` (`surface-sdk`'s generic `{agent, stack?, binding}`
 * shape, already exported for exactly this purpose), so no cross-boundary
 * import survives. Behavior is byte-identical.
 */

import { createHash } from "node:crypto";
import type { SurfaceBindingEntry, BindingGroup } from "@the-metafactory/cortex/surface-sdk";

/** Safely coerce a raw binding field to a string without risking the
 *  `[object Object]` stringification trap `@typescript-eslint/no-base-to-string`
 *  guards against. */
function toStringField(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function discordTokenInstanceId(token: string, stack: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ token, stack: stack ?? null }))
    .digest("hex")
    .slice(0, 12);
  return `discord:token:${digest}`;
}

export function groupDiscordBindingsByToken(
  entries: readonly SurfaceBindingEntry[],
): BindingGroup[] {
  const groups = new Map<string, SurfaceBindingEntry[]>();
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
    const token = typeof firstEntry?.binding.token === "string" ? firstEntry.binding.token : "";
    const stack = firstEntry?.stack;
    const guildIds = groupedEntries.map((entry) => toStringField(entry.binding.guildId));
    const firstGuildId = guildIds[0];
    const instanceId =
      guildIds.length === 1 && firstGuildId !== undefined
        ? `discord:${firstGuildId}`
        : discordTokenInstanceId(token, stack);

    return { entries: groupedEntries, instanceId };
  });
}
