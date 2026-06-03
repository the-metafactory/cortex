/**
 * Unit tests for the pure DashboardSocket protocol helpers (no workerd runtime).
 * The DO class glue (upgrade, hibernation, alarm) is verified end-to-end via a
 * real wss client at deploy.
 */
import { describe, it, expect } from "bun:test";
import {
  WS_PROTOCOL_VERSION,
  connectedMessage,
  clientReply,
  eventMessage,
  toDashboardEvent,
  fanout,
  type SocketSink,
} from "../dashboard-socket-protocol";

/** A mock socket recording sends, optionally throwing on send (dead client). */
function mockSocket(opts: { throwOnSend?: boolean } = {}) {
  const sent: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  const sink: SocketSink = {
    send(data: string) {
      if (opts.throwOnSend) throw new Error("socket closed");
      sent.push(data);
    },
    close(code: number, reason: string) {
      closed = { code, reason };
    },
  };
  return { sink, sent, get closed() { return closed; } };
}

describe("connectedMessage", () => {
  it("emits the connected handshake with the protocol version (matches server.ts)", () => {
    const msg = JSON.parse(connectedMessage("abc"));
    expect(msg.type).toBe("connected");
    expect(msg.clientId).toBe("abc");
    expect(msg.protocolVersion).toBe(WS_PROTOCOL_VERSION);
    expect(WS_PROTOCOL_VERSION).toBe(2); // pinned to ws/types.ts
  });
});

describe("clientReply", () => {
  it("replies pong to a client ping", () => {
    expect(clientReply(JSON.stringify({ type: "ping" }))).toBe(JSON.stringify({ type: "pong" }));
  });
  it("does not reply to pong (liveness only)", () => {
    expect(clientReply(JSON.stringify({ type: "pong" }))).toBeNull();
  });
  it("ignores other typed messages", () => {
    expect(clientReply(JSON.stringify({ type: "subscribe", channel: "x" }))).toBeNull();
  });
  it("ignores non-JSON frames", () => {
    expect(clientReply("not json")).toBeNull();
  });
});

describe("toDashboardEvent", () => {
  it("maps the ingest wire shape to the McEvent shape the renderer expects", () => {
    const ingest = {
      event_id: "e1",
      event_type: "tool.bash",
      session_id: "s1",
      payload: { cmd: "ls" },
      timestamp: "2026-06-04T00:00:00Z",
    };
    expect(toDashboardEvent(ingest)).toEqual({
      id: "e1", // event_id → id (renderer keys on .id)
      session_id: "s1",
      type: "tool.bash", // event_type → type (renderer switches on .type)
      payload: { cmd: "ls" },
      timestamp: "2026-06-04T00:00:00Z",
    });
  });
});

describe("eventMessage", () => {
  it("wraps a DashboardEvent (McEvent shape) in the {type:event,sessionId,event} envelope", () => {
    const ev = { id: "e1", session_id: "s1", type: "tool.bash", payload: {}, timestamp: "t" };
    const msg = eventMessage("s1", ev);
    expect(msg).toEqual({ type: "event", sessionId: "s1", event: ev });
    // The body the frontend casts as McEvent must carry id + type, not event_id/event_type.
    expect(msg.event.id).toBe("e1");
    expect(msg.event.type).toBe("tool.bash");
  });
});

describe("fanout", () => {
  it("sends one message to every live socket and counts them", () => {
    const a = mockSocket();
    const b = mockSocket();
    const sent = fanout([a.sink, b.sink], { type: "ping" });
    expect(sent).toBe(2);
    expect(a.sent).toEqual([JSON.stringify({ type: "ping" })]);
    expect(b.sent).toEqual([JSON.stringify({ type: "ping" })]);
  });

  it("prunes a dead socket (send throws) and excludes it from the count", () => {
    const ok = mockSocket();
    const dead = mockSocket({ throwOnSend: true });
    const sent = fanout([ok.sink, dead.sink], { type: "event", sessionId: "s", event: {} });
    expect(sent).toBe(1);
    expect(ok.sent).toHaveLength(1);
    expect(dead.closed).toEqual({ code: 1011, reason: "send failed" });
  });

  it("serializes the message once as JSON", () => {
    const a = mockSocket();
    fanout([a.sink], { type: "event", sessionId: "s1", event: { n: 1 } });
    expect(JSON.parse(a.sent[0]!)).toEqual({ type: "event", sessionId: "s1", event: { n: 1 } });
  });
});
