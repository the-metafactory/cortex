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
 * Pluggable Slack client surface. The real implementation wraps
 * `SocketModeClient` + `WebClient`; tests pass a mock.
 */
export interface SlackClient {
  start(opts: { onEvent: (event: SlackInboundEvent) => Promise<void> }): Promise<void>;
  stop(): Promise<void>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts?: string }>;
  getBotUserId(): Promise<string>;
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
  private cachedBotUserId: string | null = null;

  constructor(opts: RealSlackClientOptions) {
    this.instanceId = opts.instanceId ?? "slack";
    this.socket = new SocketModeClient({ appToken: opts.appToken });
    this.web = new WebClient(opts.botToken);
  }

  async start(opts: { onEvent: (event: SlackInboundEvent) => Promise<void> }): Promise<void> {
    // Slack's Socket Mode delivers `events_api` envelopes; the inner event
    // type (`message`, `app_mention`) is re-emitted by SocketModeClient as
    // a top-level event. We listen for both since `app_mention` events
    // ALSO arrive as `message` events with a mention in the text — we want
    // to handle them once, via the `message` channel, with the
    // `app_mention` listener acting as a safety net for DMs/channels
    // where the bot is mentioned without being a member.
    const handle = async (
      payload: { ack: () => Promise<void>; event: SlackInboundEvent },
    ): Promise<void> => {
      // Ack first — the Slack contract is "ack within 3 seconds" and our
      // downstream pipeline can run much longer. A delayed ack triggers
      // duplicate redelivery.
      try {
        await payload.ack();
      } catch (err) {
        process.stderr.write(
          `slack-client[${this.instanceId}]: ack failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      try {
        await opts.onEvent(payload.event);
      } catch (err) {
        // Adapters are expected to swallow per-message errors so the
        // event stream doesn't tear down on one bad message; log and
        // continue.
        process.stderr.write(
          `slack-client[${this.instanceId}]: onEvent threw: ${err instanceof Error ? err.message : String(err)}\n`,
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
        process.stderr.write(
          `slack-client[${this.instanceId}]: dispatch threw: ${err instanceof Error ? err.message : String(err)}\n`,
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
   * Fetch the bot user id via `auth.test` and cache. The cortex
   * `TrustResolver` (cortex#76) requires the platform user id of every
   * bot adapter so peer agents resolve cleanly across processes.
   */
  async getBotUserId(): Promise<string> {
    if (this.cachedBotUserId) return this.cachedBotUserId;
    const res = await this.web.auth.test();
    const id = typeof res.user_id === "string" ? res.user_id : "";
    if (!id) {
      throw new Error(
        `slack-client[${this.instanceId}]: auth.test returned no user_id (response: ${JSON.stringify(res)})`,
      );
    }
    this.cachedBotUserId = id;
    return id;
  }
}
