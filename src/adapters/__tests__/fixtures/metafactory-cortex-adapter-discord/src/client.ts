/**
 * cortex#1797 (S12) — FIXTURE STAND-IN, not a byte-identical copy of the
 * real bundle's `src/client.ts` (unlike `index.ts`/`plugin.ts`/`schema.ts`/
 * etc. in this same fixture directory, which ARE byte-identical, modulo the
 * `discordjs-stub` import-line swap — see that module's doc).
 *
 * The real `client.ts` imports `Client`/`GatewayIntentBits`/`Partials` from
 * `discord.js` at the top level and calls `new Client({...})` inside
 * `createDiscordClient` — a REAL npm package with a REAL gateway
 * connection. cortex#1797 (S12 MOVE) removed `discord.js` from cortex's OWN
 * `package.json` (it moved to the bundle's `package.json`). This fixture
 * lives INSIDE cortex's own `src/` tree with no separate `node_modules` of
 * its own — constructing a real discord.js `Client` here would only work by
 * accident (a stale/orphaned package, absent from `bun.lock`) and break on
 * a genuinely clean install (CI). Mirrors
 * `metafactory-cortex-adapter-slack`'s fixture `client.ts` stand-in for
 * `RealSlackClient` exactly.
 *
 * This stand-in keeps the EXACT same exported type/function surface
 * `index.ts` imports (`createDiscordClient`, `isMentionForBot`,
 * `extractContent`, `ConnectionHealth`) — so `index.ts` compiles and imports
 * unchanged — but `createDiscordClient` throws rather than opening a real
 * gateway connection. This is safe: `DiscordAdapter.start()` is the ONLY
 * call site (see the real bundle's `index.ts`), and no test in
 * `loader.discord-bundle.test.ts` calls `.start()` — every test is
 * construct-only or exercises pure demux/validation/policy logic that never
 * reaches it (mirrors how the slack/mattermost bundles' equivalent E2E
 * tests never open a live connection either).
 *
 * `isMentionForBot`/`extractContent` ARE reproduced faithfully (byte-
 * identical to the real bundle's versions) — they're pure functions that
 * never touch a live `Client`, so there is no reason to stub them.
 */

import type { Client, Message } from "./discordjs-stub";

export interface ConnectionHealth {
  reconnectCount: number;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  currentlyConnected: boolean;
  degraded: boolean;
  degradedSince: Date | null;
}

export interface DiscordClientOptions {
  instanceId?: string;
  degradedThresholdMs?: number;
  onDegraded?: (info: { instanceId: string; thresholdMs: number; since: Date }) => void;
  onRecovered?: (info: { instanceId: string; degradedForMs: number }) => void;
}

export interface DiscordClientResult {
  client: Client;
  health: ConnectionHealth;
}

export interface DiscordClientDisplayInfo {
  displayName: string;
  guildId: string;
}

/**
 * Fixture stand-in — see module doc. Never opens a real gateway connection;
 * throws unconditionally (no test in this fixture's consuming suite calls
 * it — only `DiscordAdapter.start()` does, which no test exercises).
 */
export function createDiscordClient(
  _info: DiscordClientDisplayInfo,
  _options: DiscordClientOptions = {},
): DiscordClientResult {
  throw new Error(
    "createDiscordClient (fixture stand-in) — this test fixture never opens a real gateway connection; construct-only tests never call DiscordAdapter.start()",
  );
}

/**
 * Byte-identical logic to the real bundle's `isMentionForBot` — a pure
 * function, safe to reproduce faithfully (see module doc).
 */
export function isMentionForBot(
  message: Message,
  client: Client,
  trustedBotIds?: ReadonlySet<string>,
): boolean {
  if (!client.user) return false;
  if (message.author.id === client.user.id) return false;
  if (message.author.bot && !trustedBotIds?.has(message.author.id)) return false;
  return message.mentions.has(client.user);
}

/**
 * Byte-identical logic to the real bundle's `extractContent` — a pure
 * function, safe to reproduce faithfully (see module doc).
 */
export function extractContent(message: Message, client: Client): string {
  if (!client.user) return message.content;
  return message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();
}
