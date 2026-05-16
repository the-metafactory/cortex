/**
 * F-slack: Slack client wrapper.
 *
 * Thin abstraction over `@slack/socket-mode` (inbound events) and
 * `@slack/web-api` (outbound message posting + auth check). The goal is to
 * keep `SlackAdapter` free of direct SDK imports so unit tests can inject a
 * mock client without monkey-patching globals.
 *
 * The interface is intentionally tiny — exactly the operations the adapter
 * uses today:
 *
 *   - `start({ onMessage })`            — open Socket Mode, deliver events
 *   - `stop()`                          — close the websocket cleanly
 *   - `postMessage(channel, text, thread_ts?)`
 *   - `getBotUserId()`                  — `auth.test` once, cached
 *
 * Future extensions (file uploads, reactions, conversations.history for
 * context fetch) get bolted onto this interface without touching the
 * adapter's outer surface.
 */

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

/**
 * Subset of the Slack `message` / `app_mention` event shape we actually
 * consume. The Slack SDK types these as wide unions across many subtypes;
 * we narrow to the fields cortex's `InboundMessage` mapping needs and let
 * the rest flow through `_native`.
 */
export interface SlackInboundEvent {
  /** Slack event type — `message` or `app_mention`. */
  type: string;
  /** Slack user id of the author, `U...`. May be undefined for bot/system messages. */
  user?: string;
  /** Slack bot id (`B...`) when the author is a bot. */
  bot_id?: string;
  /** Workspace id, `T...`. */
  team?: string;
  /** Channel id where the message was posted. */
  channel: string;
  /** Message text. */
  text?: string;
  /** Slack timestamp (`1234567890.123456`) — used both as message id and reply target. */
  ts: string;
  /** When set, the message is in a thread. The root message's `ts`. */
  thread_ts?: string;
  /** Message subtype (`bot_message`, `channel_join`, etc.) — used to filter system noise. */
  subtype?: string;
  /** File attachments, if any. */
  files?: {
    url_private?: string;
    name?: string;
    mimetype?: string;
    size?: number;
  }[];
}

/**
 * Bot identity resolved via `auth.test`. Slack messages identify the bot
 * via either the user id (`U…`, on normal messages) or the bot id (`B…`,
 * on `bot_message` subtype events) — the self-loop guard has to know
 * both. See Echo cortex#233 round-2 N1.
 */
export interface SlackBotIdentity {
  /** Slack user id of the bot (`U…`). */
  userId: string;
  /** Slack bot id (`B…`). May be undefined on older app installs. */
  botId?: string;
}

/**
 * Pluggable Slack client surface. The real implementation wraps
 * `SocketModeClient` + `WebClient`; tests pass a mock.
 */
export interface SlackClient {
  start(opts: { onEvent: (event: SlackInboundEvent) => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts?: string }>;
  /** Convenience accessor for `userId`. Kept for adapter call-site brevity. */
  getBotUserId(): Promise<string>;
  /** Full identity (both `userId` and `botId`). Used by the self-loop guard. */
  getBotIdentity(): Promise<SlackBotIdentity>;
}

export interface RealSlackClientOptions {
  botToken: string;
  appToken: string;
  /** Tag for log-prefixing. Defaults to `slack`. */
  instanceId?: string;
}

/**
 * Default Slack client: opens a Socket Mode connection, surfaces `message`
 * + `app_mention` events to the adapter, and routes outbound posts through
 * a `WebClient`. The `botToken` (xoxb-) authorises Web API calls; the
 * `appToken` (xapp-) authorises the Socket Mode session.
 *
 * Acknowledgement: Slack's Socket Mode requires every inbound event to be
 * `ack()`'d so the server stops redelivering. We `ack()` as the first
 * action inside the event listener — well before invoking `onEvent` — so
 * a slow downstream handler can never trigger a redelivery storm.
 */
export class RealSlackClient implements SlackClient {
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private readonly instanceId: string;
  private cachedIdentity: SlackBotIdentity | null = null;

  constructor(opts: RealSlackClientOptions) {
    this.instanceId = opts.instanceId ?? "slack";
    this.socket = new SocketModeClient({ appToken: opts.appToken });
    this.web = new WebClient(opts.botToken);
  }

  async start(opts: { onEvent: (event: SlackInboundEvent) => Promise<void> }): Promise<void> {
    // Slack's Socket Mode delivers `events_api` envelopes; the inner event
    // type (`message`, `app_mention`) is re-emitted by SocketModeClient as
    // a top-level event.
    //
    // Subscribe to BOTH `message` and `app_mention` because:
    //   - `message` covers DMs + posts in channels the bot is a member of
    //   - `app_mention` covers mentions in channels where the bot is NOT
    //     a member (Slack still delivers an app_mention there as a
    //     conversation-starter)
    // When the bot IS a member of the channel AND is mentioned, Slack
    // fires BOTH events for the same message — the dedup ring below
    // collapses them to a single dispatch keyed on `event.ts`.
    const handle = async (
      payload: { ack: () => Promise<void>; event: SlackInboundEvent },
    ): Promise<void> => {
      // Ack first — the Slack contract is "ack within 3 seconds" and our
      // downstream pipeline can run much longer. A delayed ack triggers
      // duplicate redelivery. Dedup of `message`/`app_mention`
      // double-dispatch lives in `SlackAdapter.translateEvent` (one
      // place to test, mock-friendly).
      try {
        await payload.ack();
      } catch (err) {
        // Echo cortex#233 r1#8: use `console.warn` consistently across
        // the Slack module to match Discord + Mattermost adapters.
        console.warn(
          `slack-client[${this.instanceId}]: ack failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        await opts.onEvent(payload.event);
      } catch (err) {
        // Adapters are expected to swallow per-message errors so the
        // event stream doesn't tear down on one bad message; log and
        // continue.
        console.warn(
          `slack-client[${this.instanceId}]: onEvent threw:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    // `socket.on` expects a void-returning listener. `handle` is async
    // (returns Promise<void>) because it has to await `payload.ack()` +
    // the user callback; wrap it in a fire-and-forget dispatcher so the
    // emitter contract is satisfied without losing async error logging.
    // Errors are caught inside `handle` itself; this `.catch` is a
    // belt-and-braces guard for truly unexpected throws (e.g. a synthetic
    // promise rejection in the listener wrapper).
    const dispatch = (payload: { ack: () => Promise<void>; event: SlackInboundEvent }): void => {
      handle(payload).catch((err: unknown) => {
        console.warn(
          `slack-client[${this.instanceId}]: dispatch threw:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };
    this.socket.on("message", dispatch);
    this.socket.on("app_mention", dispatch);
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts?: string }> {
    const res = await this.web.chat.postMessage({
      channel,
      text,
      ...(threadTs !== undefined && { thread_ts: threadTs }),
    });
    return { ts: res.ts };
  }

  /**
   * Fetch the full bot identity (userId + botId) via `auth.test` and
   * cache. The cortex `TrustResolver` (cortex#76) requires the platform
   * user id of every bot adapter so peer agents resolve cleanly across
   * processes; the adapter additionally needs the `bot_id` so the
   * self-loop guard catches `bot_message` subtype echoes (Echo
   * cortex#233 round-2 N1).
   *
   * Error path intentionally omits `JSON.stringify(res)`: the
   * `auth.test` response shape includes workspace metadata (`team`,
   * `team_id`, `enterprise_id`, `url`) that, while not credentials,
   * is operator-environment-identifying. Log only the missing-field
   * diagnosis (Echo cortex#233 round-1 r1#10, deferred but worth
   * fixing the new error path while we're here).
   */
  async getBotIdentity(): Promise<SlackBotIdentity> {
    if (this.cachedIdentity) return this.cachedIdentity;
    const res = await this.web.auth.test();
    const userId = typeof res.user_id === "string" ? res.user_id : "";
    if (!userId) {
      throw new Error(
        `slack-client[${this.instanceId}]: auth.test returned no user_id`,
      );
    }
    const identity: SlackBotIdentity = {
      userId,
      ...(typeof res.bot_id === "string" && res.bot_id.length > 0 && { botId: res.bot_id }),
    };
    this.cachedIdentity = identity;
    return identity;
  }

  async getBotUserId(): Promise<string> {
    return (await this.getBotIdentity()).userId;
  }
}
