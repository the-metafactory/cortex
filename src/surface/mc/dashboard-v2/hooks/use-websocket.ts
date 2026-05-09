/**
 * Single WebSocket client + pub/sub.
 *
 * MIG-1 scaffolds the connection lifecycle (connect, ping/pong, auto-
 * reconnect) and the typed pub/sub surface. Real subscribers (focus
 * area, working grid, drill-down) attach in MIG-2…MIG-3 via
 * `useWsEvent("state.transition", handler)`.
 *
 * Pattern: one socket per app instance, owned at the App boundary or
 * via DashboardContext. Hooks subscribe by `type` rather than
 * registering per-instance sockets — matches the migration addendum's
 * Decision 5.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type WsConnState = "connecting" | "online" | "offline" | "error";

export interface WsClient {
  /** Latest connection state for header pill rendering. */
  state: WsConnState;
  /** Send a JSON-encoded message to the server. No-op when offline. */
  send: (msg: unknown) => void;
  /**
   * Subscribe to incoming messages of a given `type`. Returns an
   * unsubscribe function. Pass type `"*"` to receive every message.
   */
  subscribe: (type: string, handler: (msg: WsMessage) => void) => () => void;
}

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

/** Server-emitted ping interval; reconnect baseline. Tuned to match the legacy monolith. */
const RECONNECT_DELAY_MS = 2000;

export function useWebSocket(url: string = "/ws"): WsClient {
  const [state, setState] = useState<WsConnState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  // Subscribers map type → set of handlers. "*" matches every message.
  const subsRef = useRef<Map<string, Set<(msg: WsMessage) => void>>>(new Map());

  useEffect(() => {
    let alive = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (!alive) return;
      setState("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}${url}`);
      wsRef.current = ws;

      ws.onopen = () => { if (alive) setState("online"); };
      ws.onerror = () => { if (alive) setState("error"); };
      ws.onclose = () => {
        if (!alive) return;
        setState("offline");
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      ws.onmessage = (ev) => {
        let parsed: WsMessage | null = null;
        try { parsed = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
        if (!parsed || typeof parsed.type !== "string") return;
        // Reply to server-initiated ping with a pong; matches the
        // legacy server-initiated dead-client detection (server keeps
        // a per-client idle timer that any inbound message resets).
        if (parsed.type === "ping") {
          try { ws.send(JSON.stringify({ type: "pong" })); } catch {
            // socket already closed; the onclose handler will reconnect.
          }
          return;
        }
        const subs = subsRef.current;
        const targeted = subs.get(parsed.type);
        targeted?.forEach((h) => { try { h(parsed!); } catch (e) { console.warn("ws handler threw:", e); } });
        const wildcard = subs.get("*");
        wildcard?.forEach((h) => { try { h(parsed!); } catch (e) { console.warn("ws handler threw:", e); } });
      };
    }

    connect();
    return () => {
      alive = false;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try { wsRef.current?.close(); } catch {
        // teardown — best-effort.
      }
      wsRef.current = null;
    };
  }, [url]);

  // `send` and `subscribe` close over refs only (`wsRef`, `subsRef`), which are
  // stable for the lifetime of the hook. Wrapping in `useCallback` with empty
  // deps gives MIG-2+ consumers stable references they can safely include in
  // `useEffect` deps without triggering resubscribe-every-render loops.
  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch (e) {
      console.warn("ws send failed:", e);
    }
  }, []);

  const subscribe = useCallback((type: string, handler: (msg: WsMessage) => void): (() => void) => {
    const subs = subsRef.current;
    let set = subs.get(type);
    if (!set) { set = new Set(); subs.set(type, set); }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) subs.delete(type);
    };
  }, []);

  return { state, send, subscribe };
}
