/**
 * cortex#1797 (S12) — FIXTURE STAND-IN for the `discord.js` package, not a
 * byte-identical copy of anything in the real bundle (unlike `index.ts` /
 * `context-fetcher.ts` / `outbound-log.ts` / `response-poster.ts` /
 * `worklog-manager.ts` / `plugin.ts` / `schema.ts` / etc. in this same
 * fixture directory, which ARE byte-identical copies of the real,
 * already-pushed `metafactory-cortex-adapter-discord` bundle repo — see
 * `client.ts`'s own module doc for the one OTHER deliberate deviation).
 *
 * The real bundle files import several names (`Client`, `TextChannel`,
 * `ThreadChannel`, `DMChannel`, `Message`, `Collection`, `Snowflake`,
 * `ChannelType`) directly from the real `discord.js` npm package. cortex#1797
 * (S12 MOVE) removed `discord.js` (and its `@discordjs/*` transitive deps)
 * from cortex's OWN `package.json` — they moved to the bundle's
 * `package.json` (a REAL `arc install` gives the bundle its own
 * `node_modules` with `discord.js` present, resolved via normal upward
 * node_modules search from the bundle's install path). This fixture,
 * however, lives INSIDE cortex's own `src/` tree with no separate
 * `node_modules` of its own — a top-level `from "discord.js"` import would
 * only resolve here by accident (a stale/orphaned package left over from
 * before the S12 move, absent from `bun.lock`) and would break on a
 * genuinely clean install (fresh clone + `bun install`, e.g. CI) — the
 * exact class of accident `metafactory-cortex-adapter-slack`'s fixture
 * `client.ts` module doc already documents for `@slack/socket-mode`/
 * `@slack/web-api`.
 *
 * So every fixture file that would otherwise `import ... from "discord.js"`
 * imports the same names from this module instead — the ONE import-line
 * deviation from the real bundle those files otherwise carry byte-identical.
 *
 * The class-shaped types (`Client`/`TextChannel`/`ThreadChannel`/
 * `DMChannel`/`Message`) are loose structural shapes carrying just enough
 * REAL (non-`any`) member types for the copied files' control flow and
 * callback-parameter inference to type-check correctly, plus an `any`-typed
 * index signature for everything else those files don't touch. Two lessons
 * learned building this out (documented here so a future repin doesn't
 * relearn them):
 *
 *   1. An ALL-`any` stand-in is NOT strictly weaker than a partially-typed
 *      one — it can introduce NEW errors. TS's assignment-narrowing resets
 *      a wider-declared `let` back to its DECLARED type (not `any`) when an
 *      `any`-typed value flows in, so `threadId = thread.id;
 *      sessionThreads.set(id, threadId)` (`worklog-manager.ts`,
 *      `sessionThreads: Map<string, string>`) only type-checks if `.id` is a
 *      real `string`, not `any`. Hence `id: string` on every entity below.
 *   2. Passing a callback literal to a method whose OWN type resolves via
 *      an index signature (i.e. the method itself is `any`) loses all
 *      contextual parameter typing — `client.on("x", (a, b) => ...)` then
 *      reports `a`/`b` as implicit-`any` (TS7006) under `noImplicitAny`,
 *      and `Array.from(x.values()).map((a) => ...)` reports `a` as
 *      `unknown` (TS18046) rather than `any`, because `Array.from`'s
 *      generic inference over an `any` source lands on `unknown` in this
 *      TS/lib version. Hence real (non-index-signature) call signatures for
 *      `.on`, `Client.guilds.cache`, `.channels.cache`, and
 *      `Message.attachments` below — anything the copied files iterate or
 *      pass a callback to.
 *
 * This fixture directory sits under `__tests__/`, where cortex's ESLint
 * config turns off `no-explicit-any`/`no-unsafe-*` (test files intentionally
 * exercise edge cases), and no test in `loader.discord-bundle.test.ts`
 * constructs a real `discord.js` object anyway (every test is construct-only
 * or exercises pure demux/validation/policy logic — see that file's module
 * doc) — these types only need to make the COPIED SOURCE type-check, not
 * model discord.js accurately. `ChannelType`'s numeric values ARE the real
 * discord.js v14 enum values (stable, documented API surface), reproduced
 * here so any `ChannelType.X` comparison in the copied `index.ts` evaluates
 * exactly as it would against the real package.
 */

/** A discord.js attachment's fields, as read by `context-fetcher.ts` /
 *  `index.ts` (`.name`/`.url`/`.contentType`/`.size`). */
export interface DiscordAttachmentLike {
  name: string;
  url: string;
  contentType?: string | null;
  size: number;
}

/** Loose structural stand-in for any discord.js snowflake-bearing class
 *  (`DMChannel`/`Message`'s `author`/etc.) — see module doc for why `id` is
 *  real and everything else is `any`. */
export interface DiscordEntityLike {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture stand-in, see module doc
  [key: string]: any;
}

/** A thread created via `TextChannel.send(...).startThread(...)`
 *  (`worklog-manager.ts`) — real `id` (assigned into `Map<string, string>`
 *  keys downstream, see module doc lesson #1) and `send`, `any` index
 *  signature for the rest. */
export interface DiscordThreadLike extends DiscordEntityLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture stand-in, see module doc
  send: (...args: any[]) => Promise<MessageLike>;
}

/** discord.js's `Collection<K, V>` extends `Map<K, V>` and adds
 *  convenience methods; only `.find()` is used on a collection below
 *  (`guild.channels.cache.find(...)`), so that's the one addition over the
 *  base `Map` surface. */
export interface CollectionLike<K, V> extends Map<K, V> {
  find: (predicate: (value: V, key: K) => boolean) => V | undefined;
}

/** discord.js's `TextChannel` — real `send()` (chained into `.startThread()`
 *  by `worklog-manager.ts`) and `messages.fetch()` (used by
 *  `context-fetcher.ts`), `any` index signature for the rest. Also stands in
 *  for a guild channel cache entry (`resolveChannelByName`/
 *  `resolveLogicalTarget`, `index.ts`) — discord.js's real `TextChannel`
 *  IS the guild-channel-cache entry type, so no separate shape is needed. */
export interface DiscordTextChannelLike extends DiscordEntityLike {
  name?: string;
  type: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture stand-in, see module doc
  send: (...args: any[]) => Promise<MessageLike>;
  messages: { fetch: (options: { limit: number }) => Promise<Map<string, MessageLike>> };
}

/** discord.js's `Message` — real `id`/`content`/`attachments`/`author`/
 *  `mentions`/`channel`/`createdAt`/`createdTimestamp`/`startThread`/`edit`
 *  (every field/method the copied files read off or call on a `Message`),
 *  `any` index signature for the rest. */
export interface MessageLike extends DiscordEntityLike {
  content: string;
  createdAt: Date;
  createdTimestamp: number;
  guildId?: string | null;
  author: DiscordEntityLike & { bot?: boolean; displayName: string };
  mentions: { has: (user: unknown) => boolean };
  attachments: Map<string, DiscordAttachmentLike>;
  channel: DiscordTextChannelLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture stand-in, see module doc
  startThread: (options: any) => Promise<DiscordThreadLike>;
  edit: (content: string) => Promise<MessageLike>;
}

/** discord.js's `Client` — real `user`/`on`/`guilds` (every member the
 *  copied files call directly on a `Client`), `any` index signature for the
 *  rest (`.destroy()`, `.login()`, etc. — never invoked in construct-only
 *  tests). `on`'s listener is typed `(...args: any[]) => void` (not
 *  `never[]`) so callback parameter positions land on `any`, not `never` —
 *  the copied `shardDisconnect`/`shardResume`/etc. listeners read real
 *  fields (`.code`, `.reason`) off their params. */
export interface ClientLike extends DiscordEntityLike {
  user: (DiscordEntityLike & { tag?: string }) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture stand-in, see module doc
  on: (event: string, listener: (...args: any[]) => void) => ClientLike;
  guilds: { cache: Map<string, { channels: { cache: CollectionLike<string, DiscordTextChannelLike> } }> };
}

export type Client = ClientLike;
export type TextChannel = DiscordTextChannelLike;
export type ThreadChannel = DiscordThreadLike;
export type DMChannel = DiscordEntityLike;
export type Message = MessageLike;
// discord.js's `Collection<K, V>` extends `Map<K, V>` and adds convenience
// methods (`.find()`, `.filter()`, ...) — no fixture code below needs any of
// those, only the base `Map` surface (`.values()`), so `Map` is a faithful
// enough stand-in without resorting to `any` here.
export type Collection<K, V> = Map<K, V>;
export type Snowflake = string;

/** Real discord.js v14 `ChannelType` enum values (stable API surface) — only
 *  the members `index.ts` actually references. */
export const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16,
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/** Stand-ins for `client.ts`'s `new Client({...})` construction args —
 *  never actually passed to a real discord.js Client in this fixture (see
 *  `client.ts`'s stand-in `createDiscordClient`, which throws rather than
 *  constructing one). Values are unused; they exist only so `client.ts`'s
 *  copied option-building code compiles unchanged. */
export const GatewayIntentBits = {
  Guilds: 1,
  GuildMessages: 2,
  MessageContent: 4,
  DirectMessages: 8,
} as const;
export const Partials = {
  Channel: 1,
} as const;
