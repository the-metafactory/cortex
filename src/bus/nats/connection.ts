/**
 * G-1100.A: NATS connection primitive.
 *
 * Thin wrapper around the `nats` package's connect/close lifecycle, with
 * structured logging on disconnect / reconnect / error events. Used by the
 * upcoming G-1100.C subscription primitive and the G-1100.D myelin
 * subscriber compose.
 *
 * Coupling rule (per docs/design-collaboration-surface.md §9):
 * Grove must stay installable without NATS configured. This module is
 * import-safe — instantiation is via the `NatsLink.connect()` factory and
 * only happens when grove-bot is started with a configured NATS URL
 * (G-1100.E wires that up).
 */

import {
  connect as natsConnect,
  Events,
  type ConnectionOptions,
  type NatsConnection,
} from "nats";

export interface NatsLinkOptions {
  /** NATS server URL (e.g. nats://localhost:4222). */
  url: string;
  /** Bearer token for the connect-time auth. Optional. */
  token?: string;
  /** Connection name surfaced on the server's `varz` endpoint. */
  name?: string;
  /** Override the underlying nats `connect` function (test seam). */
  connectImpl?: (opts: ConnectionOptions) => Promise<NatsConnection>;
}

/**
 * A live NATS connection plus a structured-logging adapter. The underlying
 * `NatsConnection` is exposed via `raw` for higher-level primitives
 * (subscriptions, JetStream) but lifecycle is owned here.
 */
export class NatsLink {
  /** Underlying nats.js connection. Use `.subscribe(...)` etc. via this. */
  readonly raw: NatsConnection;
  /** Connection name (surfaced in logs). */
  readonly name: string;

  private readonly statusLoop: Promise<void>;
  private closed = false;

  private constructor(raw: NatsConnection, name: string) {
    this.raw = raw;
    this.name = name;
    this.statusLoop = this.consumeStatusEvents();
  }

  /**
   * Open a NATS connection. Returns a `NatsLink` ready to use. Throws if the
   * server is unreachable or auth fails.
   */
  static async connect(opts: NatsLinkOptions): Promise<NatsLink> {
    if (!opts.url) {
      throw new Error("nats-connection: url is required");
    }

    const connectImpl = opts.connectImpl ?? natsConnect;
    const name = opts.name ?? "grove-bot";

    const raw = await connectImpl({
      servers: [opts.url],
      token: opts.token,
      name,
      // Defer reconnect to the underlying client; we just log status.
      reconnect: true,
    });

    return new NatsLink(raw, name);
  }

  /**
   * Publish a payload to a subject. Thin wrapper around the underlying
   * nats.js `connection.publish` so higher-level primitives don't need to
   * reach through `.raw`. Synchronous from the broker's perspective:
   * nats.js queues the publish on its outbound buffer and flushes
   * opportunistically — there is no per-publish ack on Core NATS. JetStream
   * publishes are a separate API (`jsm.publish`) and are not used here.
   *
   * Errors at publish time are exceedingly rare on Core NATS — typically
   * either "connection closed" (we're shutting down) or "subject too long".
   * The caller decides what to do with them; we don't catch here so the
   * `MyelinRuntime.publish` wrapper can apply its swallow-and-log policy
   * uniformly.
   */
  publish(subject: string, payload: string | Uint8Array): void {
    this.raw.publish(subject, payload);
  }

  /**
   * Close the connection cleanly. Drains in-flight subscriptions before
   * disconnecting (per nats.js convention). Idempotent. Drain is bounded
   * by `drainTimeoutMs` (default 5 s) so an unreachable server can't hang
   * process exit.
   */
  async close(drainTimeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await Promise.race([
        this.raw.drain(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`drain timed out after ${drainTimeoutMs}ms`)),
            drainTimeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      // Drain can fail if already closed by the server, or hit our timeout.
      // Log and proceed — caller wants close() to resolve.
      console.error(
        `nats-connection: "${this.name}" drain error:`,
        err instanceof Error ? err.message : err,
      );
    }
    // Wait for the status loop to drain so close() is deterministic.
    try {
      await this.statusLoop;
    } catch {
      // Status loop logs its own errors; close() shouldn't fail because of them.
    }
  }

  /** Async iterator over status events — logs each one with the connection name. */
  private async consumeStatusEvents(): Promise<void> {
    try {
      for await (const status of this.raw.status()) {
        if (this.closed) return;
        switch (status.type) {
          case Events.Disconnect:
            console.warn(
              `nats-connection: "${this.name}" disconnected from ${status.data}`,
            );
            break;
          case Events.Reconnect:
            console.info(
              `nats-connection: "${this.name}" reconnected to ${status.data}`,
            );
            break;
          case Events.Error:
            console.error(
              `nats-connection: "${this.name}" error:`,
              status.data,
            );
            break;
          // LDM, Update, etc. are quieter — log at debug level for now.
          default:
            console.debug(
              `nats-connection: "${this.name}" status:`,
              status.type,
              status.data,
            );
        }
      }
    } catch (err) {
      // Status iterator can throw on close — only log if we weren't expecting it.
      if (!this.closed) {
        console.error(
          `nats-connection: "${this.name}" status loop error:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
