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

import { readFile } from "fs/promises";
import {
  connect as natsConnect,
  credsAuthenticator,
  Events,
  type ConnectionOptions,
  type NatsConnection,
} from "nats";
import { enforceChmod600 } from "../../common/config/file-permissions";
import { expandTilde } from "../../common/config/loader";

export interface NatsLinkOptions {
  /** NATS server URL (e.g. nats://localhost:4222). */
  url: string;
  /** Bearer token for the connect-time auth. Optional. */
  token?: string;
  /**
   * Path to a NATS user `.creds` file for operator-mode auth (cortex#86).
   * The loader expands a leading `~/` to `$HOME`, enforces chmod 600 on
   * POSIX (file MUST NOT be group- or world-readable — `.creds` carries
   * an NKey seed + signed JWT), reads the bytes, and passes them to
   * `credsAuthenticator(...)` as `ConnectionOptions.authenticator`.
   * When both `token` and `credsPath` are set, `credsPath` wins and a
   * warn log explains the precedence so operators notice a duplicated
   * config rather than silently picking one.
   */
  credsPath?: string;
  /** Connection name surfaced on the server's `varz` endpoint. */
  name?: string;
  /** Override the underlying nats `connect` function (test seam). */
  connectImpl?: (opts: ConnectionOptions) => Promise<NatsConnection>;
}

/**
 * Read a NATS user `.creds` file from disk and return its bytes for
 * `credsAuthenticator(...)`. `.creds` files carry the user's NKey seed
 * and a signed JWT — both sensitive enough to refuse loading from a
 * group- or world-readable file.
 *
 * Uses the canonical `expandTilde` from `common/config/loader.ts` (so
 * the no-`$HOME` failure surfaces consistently with cortex.yaml load)
 * and the shared `enforceChmod600` permission gate from
 * `common/config/file-permissions.ts` (same policy as the operator
 * account signing-key loader — Echo cortex#87 round-1 extraction).
 *
 * Throws with an operator-readable message when:
 *   - `expandTilde` rejects (no `$HOME` set).
 *   - The file is missing / unreadable (ENOENT / EACCES propagate).
 *   - The file mode is not exactly `0o600` on POSIX.
 */
async function loadCredsBytes(rawPath: string): Promise<Uint8Array> {
  const path = expandTilde(rawPath);
  // `enforceChmod600` is sync (statSync) — that's intentional in the
  // sibling loader to keep the stat-then-read TOCTOU window minimal.
  // The subsequent async `readFile` widens that window slightly, but
  // the daemon owns `~/.config/nats/` entirely so the practical risk
  // is near zero — an attacker who can swap files in the daemon's
  // home has already won.
  enforceChmod600(path);
  const buf = await readFile(path);
  return new Uint8Array(buf);
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

    // Build base connect options. We branch on auth mode separately so that
    // an operator-mode `.creds` connection never leaks a bearer token into
    // the wire — `credsAuthenticator` and `token` are mutually exclusive
    // server-side, and the warn log calls out the precedence explicitly.
    const connectOpts: ConnectionOptions = {
      servers: [opts.url],
      name,
      // Defer reconnect to the underlying client; we just log status.
      reconnect: true,
    };

    if (opts.credsPath) {
      if (opts.token) {
        console.warn(
          `nats-connection: "${name}" — both 'token' and 'credsPath' set; ` +
            `'credsPath' takes precedence (operator-mode auth wins).`,
        );
      }
      const credsBytes = await loadCredsBytes(opts.credsPath);
      connectOpts.authenticator = credsAuthenticator(credsBytes);
    } else if (opts.token) {
      connectOpts.token = opts.token;
    }

    const raw = await connectImpl(connectOpts);

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
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`drain timed out after ${drainTimeoutMs}ms`));
          }, drainTimeoutMs);
        }),
      ]);
    } catch (err) {
      // Drain can fail if already closed by the server, or hit our timeout.
      // Log and proceed — caller wants close() to resolve.
      console.error(
        `nats-connection: "${this.name}" drain error:`,
        err instanceof Error ? err.message : String(err),
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
              `nats-connection: "${this.name}" disconnected from ${stringifyStatusData(status.data)}`,
            );
            break;
          case Events.Reconnect:
            console.info(
              `nats-connection: "${this.name}" reconnected to ${stringifyStatusData(status.data)}`,
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

/** NATS status events carry a `data` payload that the client lib types
 *  loosely as `unknown` even though Disconnect/Reconnect are strings.
 *  Branch on shape so the lint rule doesn't fire on Object's default
 *  stringification. */
function stringifyStatusData(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  return JSON.stringify(data) ?? "(unknown)";
}
