/**
 * Pure WebSocket-protocol helpers for the DashboardSocket Durable Object.
 *
 * These functions carry ZERO Cloudflare-runtime dependency (no `cloudflare:workers`,
 * no WebSocketPair, no DO state) so they are unit-testable under `bun test`. The
 * DO class (`dashboard-socket.ts`) is thin glue over these; its runtime wiring
 * (upgrade, hibernation, alarm) is verified at deploy via a real wss client.
 *
 * The message vocabulary mirrors the local bot's `src/surface/mc/notifications.ts`
 * and the `connected`/`ping`/`pong` handshake in `src/surface/mc/server.ts`, so the
 * existing frontend client (`dashboard-v2/hooks/use-websocket.ts`) needs no changes.
 */

/** Protocol version — must match `src/surface/mc/ws/types.ts` WS_PROTOCOL_VERSION. */
export const WS_PROTOCOL_VERSION = 2;

/** The `connected` handshake the client reads on open (mirrors server.ts open()). */
export function connectedMessage(clientId: string): string {
  return JSON.stringify({
    type: "connected",
    clientId,
    serverVersion: "cloud",
    protocolVersion: WS_PROTOCOL_VERSION,
  });
}

/**
 * Compute the server's reply to an inbound client frame.
 * - client `{type:"ping"}`  → `{type:"pong"}` (string)
 * - `pong` / any other type → null (liveness only, no reply)
 * - non-JSON / no type field → null (ignored)
 */
export function clientReply(raw: string): string | null {
  let parsed: { type?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw) as { type?: unknown };
  } catch (_err) {
    // Non-JSON frame — ignore. Inbound traffic still counts as liveness upstream.
    return null;
  }
  if (parsed && parsed.type === "ping") {
    return JSON.stringify({ type: "pong" });
  }
  return null;
}

/** The live `event` push shape — mirrors notifications.ts broadcastEvent. */
export function eventMessage(sessionId: string, event: unknown): { type: "event"; sessionId: string; event: unknown } {
  return { type: "event", sessionId, event };
}

/** A socket sink — the subset of WebSocket the fanout needs. */
export interface SocketSink {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Fan a message to every socket. Returns the count delivered. A socket whose
 * `send` throws (already closing) is closed and excluded from the count, so a
 * dead client never blocks delivery to the rest.
 */
export function fanout(sockets: Iterable<SocketSink>, message: unknown): number {
  const json = JSON.stringify(message);
  let sent = 0;
  for (const ws of sockets) {
    try {
      ws.send(json);
      sent += 1;
    } catch (_err) {
      // Socket is already closing/closed — prune it so it stops receiving.
      try {
        ws.close(1011, "send failed");
      } catch (_closeErr) {
        // Already closed; nothing to do.
      }
    }
  }
  return sent;
}
