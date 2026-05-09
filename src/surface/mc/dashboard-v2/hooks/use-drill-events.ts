/**
 * F-7 drill-down events hook (MIG-3 port).
 *
 * Fetches `GET /api/assignments/:id/events?limit=50&before=<oldest>` and
 * merges live `event` WS frames whose `sessionId` matches the resolved
 * session. Pages older events on demand via `loadOlder()`.
 *
 * Race guard (carried from F-7 PR #11 → PR #21 sweep): the initial fetch
 * resolves async; live events arriving before that resolves are buffered
 * and drained once `sessionId` is known. AbortController cancels in-flight
 * fetches on unmount or assignment switch (MIG-2 sweep pattern).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, getJson } from "../lib/api";
import type { WsClient, WsMessage } from "./use-websocket";
import type { McEvent } from "../../types";

const PAGE_LIMIT = 50;
const MAX_EVENTS_IN_MEMORY = 500;

interface ListEventsResponse {
  events: McEvent[];
  hasMore: boolean;
  sessionId: string | null;
}

export interface DrillEventsState {
  events: McEvent[];
  sessionId: string | null;
  hasMore: boolean;
  loaded: boolean;
  error: string | null;
  loadOlder: () => void;
}

export function useDrillEvents(ws: WsClient, assignmentId: string | null): DrillEventsState {
  const [events, setEvents] = useState<McEvent[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);
  const aliveRef = useRef(true);
  const pendingLiveRef = useRef<McEvent[]>([]);
  const initialDoneRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  // Reset on assignment change.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!assignmentId) {
      setEvents([]);
      setSessionId(null);
      setHasMore(false);
      setLoaded(false);
      setError(null);
      pendingLiveRef.current = [];
      initialDoneRef.current = false;
      sessionIdRef.current = null;
      return;
    }

    const myGen = ++genRef.current;
    const ac = new AbortController();
    setLoaded(false);
    setError(null);
    setEvents([]);
    setSessionId(null);
    setHasMore(false);
    pendingLiveRef.current = [];
    initialDoneRef.current = false;
    sessionIdRef.current = null;

    (async () => {
      try {
        const body = await getJson<ListEventsResponse>(
          `/api/assignments/${encodeURIComponent(assignmentId)}/events?limit=${PAGE_LIMIT}`,
          { signal: ac.signal }
        );
        if (!aliveRef.current || genRef.current !== myGen) return;
        sessionIdRef.current = body.sessionId;
        setSessionId(body.sessionId);
        // Drain pending live events whose session matches.
        const buffered = pendingLiveRef.current;
        pendingLiveRef.current = [];
        const merged = [...(body.events ?? [])];
        for (const ev of buffered) {
          if (body.sessionId && ev.session_id === body.sessionId) {
            merged.push(ev);
          }
        }
        setEvents(merged.slice(-MAX_EVENTS_IN_MEMORY));
        setHasMore(body.hasMore ?? false);
        initialDoneRef.current = true;
      } catch (e) {
        if (!aliveRef.current || genRef.current !== myGen) return;
        if ((e as { name?: string })?.name === "AbortError") return;
        const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
        setError(msg);
      } finally {
        if (aliveRef.current && genRef.current === myGen) setLoaded(true);
      }
    })();

    return () => { ac.abort(); };
  }, [assignmentId]);

  // WS subscription — append live events if session matches, else buffer
  // until the initial fetch resolves the sessionId.
  useEffect(() => {
    if (!assignmentId) return;
    function onEvent(msg: WsMessage) {
      const ev = msg["event"] as McEvent | undefined;
      if (!ev || typeof ev !== "object" || !ev.session_id) return;
      if (!initialDoneRef.current) {
        pendingLiveRef.current.push(ev);
        return;
      }
      if (sessionIdRef.current && ev.session_id === sessionIdRef.current) {
        setEvents((prev) => {
          const next = [...prev, ev];
          return next.slice(-MAX_EVENTS_IN_MEMORY);
        });
      }
    }
    const unsub = ws.subscribe("event", onEvent);
    return unsub;
  }, [ws.subscribe, assignmentId]);

  const loadOlder = useCallback(async () => {
    if (!assignmentId || !hasMore || events.length === 0) return;
    const myGen = genRef.current;
    const oldest = events[0];
    if (!oldest) return;
    try {
      const body = await getJson<ListEventsResponse>(
        `/api/assignments/${encodeURIComponent(assignmentId)}/events?limit=${PAGE_LIMIT}&before=${encodeURIComponent(oldest.id)}`
      );
      if (!aliveRef.current || genRef.current !== myGen) return;
      setEvents((prev) => {
        const next = [...(body.events ?? []), ...prev];
        return next.slice(-MAX_EVENTS_IN_MEMORY);
      });
      setHasMore(body.hasMore ?? false);
    } catch (e) {
      if (!aliveRef.current || genRef.current !== myGen) return;
      const msg = e instanceof ApiFailure ? e.info.message : (e instanceof Error ? e.message : String(e));
      setError(msg);
    }
  }, [assignmentId, hasMore, events]);

  return { events, sessionId, hasMore, loaded, error, loadOlder };
}
