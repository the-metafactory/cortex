/**
 * Grove Mission Control v2 — WebSocket client registry.
 *
 * Tracks connected WebSocket clients and provides broadcast.
 */

import type { ServerWebSocket } from "bun";
import type { WsData, WsServerMessage } from "./types";

export class WsClientRegistry {
  private readonly clients = new Map<string, ServerWebSocket<WsData>>();

  get size(): number {
    return this.clients.size;
  }

  add(ws: ServerWebSocket<WsData>): void {
    this.clients.set(ws.data.clientId, ws);
  }

  remove(ws: ServerWebSocket<WsData>): void {
    this.clients.delete(ws.data.clientId);
  }

  get(clientId: string): ServerWebSocket<WsData> | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Send a message to all connected clients.
   * Dead clients (send throws) are removed from the registry and logged
   * to stderr — the previous empty catch was flagged as a no-silent-catch
   * violation that leaked dead connections (F-5 review finding #3).
   */
  broadcast(message: WsServerMessage): void {
    const payload = JSON.stringify(message);
    const dead: string[] = [];

    for (const [id, ws] of this.clients) {
      try {
        ws.send(payload);
      } catch (err) {
        dead.push(id);
        process.stderr.write(
          `[ws-registry] broadcast: removing dead client '${id}': ${(err as Error).message}\n`
        );
      }
    }

    for (const id of dead) {
      this.clients.delete(id);
    }
  }

  /**
   * Send a message to a specific client.
   */
  send(clientId: string, message: WsServerMessage): void {
    const ws = this.clients.get(clientId);
    if (ws) {
      ws.send(JSON.stringify(message));
    }
  }
}
