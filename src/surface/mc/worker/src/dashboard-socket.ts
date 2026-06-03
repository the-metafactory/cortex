/**
 * DashboardSocket — Durable Object backing the cloud-mode dashboard WebSocket (`/ws`).
 *
 * CF Workers are stateless, so server-push across connections needs a DO to hold
 * the sockets and fan out. A single global instance (idFromName("global")) holds
 * every connected dashboard for the stack; the worker forwards `GET /ws` upgrades
 * here and POSTs `/broadcast` after ingest. Uses the WebSocket Hibernation API so
 * idle connections don't pin the DO in memory.
 *
 * Protocol/message helpers live in `dashboard-socket-protocol.ts` (unit-tested);
 * this class is the runtime glue, verified end-to-end via a real wss client at deploy.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { connectedMessage, clientReply, fanout, type SocketSink } from "./dashboard-socket-protocol";

/** Server-initiated ping cadence — keeps connections warm + drives idle detection. */
const PING_INTERVAL_MS = 30_000;

export class DashboardSocket extends DurableObject<Env> {
  /** Routes the two inbound shapes: `/broadcast` (internal POST) and the `/ws` upgrade. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const clientId = crypto.randomUUID();
    try {
      server.send(connectedMessage(clientId));
    } catch (_err) {
      // Socket closed before the handshake landed; acceptWebSocket already
      // registered it, so the close handler will clean up. Nothing to do here.
    }
    await this.ensurePingAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Internal: the worker POSTs `{messages:[...]}` (batch, preferred — one DO
   * round-trip per ingest) or `{message}` (single) here so all clients get it.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    let payload: { message?: unknown; messages?: unknown[] };
    try {
      payload = (await request.json()) as { message?: unknown; messages?: unknown[] };
    } catch (_err) {
      return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }
    const batch: unknown[] = Array.isArray(payload.messages)
      ? payload.messages
      : typeof payload.message !== "undefined"
        ? [payload.message]
        : [];
    if (batch.length === 0) {
      return Response.json({ ok: false, error: "message or messages required" }, { status: 400 });
    }
    // Fetch the socket set once and reuse across the batch (fanout prunes dead ones).
    const sockets = this.ctx.getWebSockets() as unknown as SocketSink[];
    let sent = 0;
    for (const message of batch) {
      sent += fanout(sockets, message);
    }
    return Response.json({ ok: true, sent });
  }

  /** Hibernation handler — client frames. Reply to ping with pong; else liveness only. */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const reply = clientReply(text);
    if (reply !== null) {
      try {
        ws.send(reply);
      } catch (_err) {
        // Client vanished mid-reply; the close handler will prune it.
      }
    }
  }

  /** Complete the closing handshake when the client goes away. */
  override webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code, "client closed");
    } catch (_err) {
      // Already closed — nothing to do.
    }
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
    try {
      ws.close(1011, "socket error");
    } catch (_err) {
      // Already closed — nothing to do.
    }
  }

  /** Server-initiated ping loop. Stops scheduling once no clients remain. */
  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return; // no clients → let the ping loop go idle
    fanout(sockets as unknown as SocketSink[], { type: "ping" });
    await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }

  private async ensurePingAlarm(): Promise<void> {
    // Idempotent by design: a DO holds at most one pending alarm, so two
    // concurrent upgrades both observing null and both calling setAlarm just
    // overwrite to the same ~30s target — no duplicate alarms, no leak.
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
    }
  }
}
