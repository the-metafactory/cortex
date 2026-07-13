/**
 * cortex#1795 (S10) — FIXTURE STAND-IN, not a byte-identical copy of the
 * real bundle's `src/client.ts` (unlike `index.ts`/`plugin.ts`/`schema.ts`
 * in this same fixture directory, which ARE byte-identical).
 *
 * The real `client.ts` imports `@slack/socket-mode` + `@slack/web-api` at
 * the top level (real npm packages, required for `RealSlackClient`'s
 * constructor to run — `new SocketModeClient(...)` / `new WebClient(...)`).
 * cortex#1795 (S10 MOVE) removed both packages from cortex's OWN
 * `package.json` (they moved to the bundle's `package.json` — a REAL
 * `arc install` gives the bundle its own `node_modules` with them present,
 * resolved via normal upward node_modules search from the bundle's install
 * path). This fixture, however, lives INSIDE cortex's own `src/` tree with
 * no separate `node_modules` of its own — dynamically `import()`-ing a
 * `client.ts` that top-level-imports `@slack/socket-mode`/`@slack/web-api`
 * would only resolve here by accident (stale/orphaned packages left over
 * from before the S10 move, absent from `bun.lock`) and WOULD break on a
 * genuinely clean install (fresh clone + `bun install`, e.g. CI).
 *
 * This stand-in keeps the EXACT same exported type/class surface
 * `index.ts` imports (`RealSlackClient`, `SlackClient`, `SlackInboundEvent`,
 * `SlackBotIdentity`) — so `index.ts`/`plugin.ts` compile and import
 * unchanged — but `RealSlackClient`'s methods throw rather than opening a
 * real Socket Mode connection. This is safe: every test in
 * `loader.slack-bundle.test.ts` either injects its own fake `SlackClient`
 * via `infra.client` (never reaching this class) or only exercises
 * construct-only / registry-pass / demux behaviour that never calls
 * `start()`/`postMessage()` at all — mirroring how the web bundle's
 * equivalent E2E test never opens a live connection either.
 */

export interface SlackInboundEvent {
  type: string;
  user?: string;
  bot_id?: string;
  team?: string;
  channel: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  files?: {
    url_private?: string;
    name?: string;
    mimetype?: string;
    size?: number;
  }[];
}

export interface SlackBotIdentity {
  userId: string;
  botId?: string;
}

export interface SlackDisconnectInfo {
  wasClean?: boolean;
  closeReason?: string;
}

export interface SlackClient {
  start(opts: {
    onEvent: (event: SlackInboundEvent) => Promise<void>;
    onConnected?: () => void;
    onDisconnected?: (info: SlackDisconnectInfo) => void;
  }): Promise<void>;
  stop(): Promise<void>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts?: string }>;
  getBotUserId(): Promise<string>;
  getBotIdentity(): Promise<SlackBotIdentity>;
}

export interface RealSlackClientOptions {
  botToken: string;
  appToken: string;
  instanceId?: string;
}

/**
 * Fixture stand-in — see module doc. Never opens a real Socket Mode
 * connection; every method throws if actually invoked (no test in this
 * fixture's consuming suite calls one — see module doc).
 */
export class RealSlackClient implements SlackClient {
  // Parameter property (assigns `this.opts = opts`) rather than a bare
  // `constructor(_opts: RealSlackClientOptions) {}` — the latter trips
  // @typescript-eslint/no-useless-constructor (an empty body that does
  // nothing with its param), while still needing to accept the SAME
  // `RealSlackClientOptions` shape `index.ts`'s `new RealSlackClient({...})`
  // call site passes. `opts` itself is never read (every method throws
  // unconditionally — see module doc); it exists purely to keep the
  // constructor's signature real.
  constructor(private readonly opts: RealSlackClientOptions) {}

  async start(): Promise<void> {
    throw new Error(
      "RealSlackClient (fixture stand-in) — this test fixture never opens a real connection; inject a fake via infra.client instead",
    );
  }

  async stop(): Promise<void> {
    throw new Error("RealSlackClient (fixture stand-in) — stop() not implemented");
  }

  async postMessage(): Promise<{ ts?: string }> {
    throw new Error("RealSlackClient (fixture stand-in) — postMessage() not implemented");
  }

  async getBotUserId(): Promise<string> {
    throw new Error("RealSlackClient (fixture stand-in) — getBotUserId() not implemented");
  }

  async getBotIdentity(): Promise<SlackBotIdentity> {
    throw new Error("RealSlackClient (fixture stand-in) — getBotIdentity() not implemented");
  }
}
