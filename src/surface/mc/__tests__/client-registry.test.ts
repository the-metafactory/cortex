import { describe, it, expect } from "bun:test";
import { WsClientRegistry } from "../ws/client-registry";
import type { WsData, WsServerMessage } from "../ws/types";

// Minimal fake ServerWebSocket for unit testing
function fakeWs(clientId: string): { ws: any; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    data: { clientId } as WsData,
    send(msg: string) {
      sent.push(msg);
    },
  };
  return { ws, sent };
}

describe("WsClientRegistry", () => {
  it("starts empty", () => {
    const registry = new WsClientRegistry();
    expect(registry.size).toBe(0);
  });

  it("add + size tracks connections", () => {
    const registry = new WsClientRegistry();
    const { ws: ws1 } = fakeWs("c-1");
    const { ws: ws2 } = fakeWs("c-2");

    registry.add(ws1);
    expect(registry.size).toBe(1);

    registry.add(ws2);
    expect(registry.size).toBe(2);
  });

  it("remove decrements size", () => {
    const registry = new WsClientRegistry();
    const { ws } = fakeWs("c-1");

    registry.add(ws);
    registry.remove(ws);
    expect(registry.size).toBe(0);
  });

  it("get returns the WebSocket by clientId", () => {
    const registry = new WsClientRegistry();
    const { ws } = fakeWs("c-1");

    registry.add(ws);
    expect(registry.get("c-1")).toBe(ws);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("broadcast sends to all connected clients", () => {
    const registry = new WsClientRegistry();
    const { ws: ws1, sent: sent1 } = fakeWs("c-1");
    const { ws: ws2, sent: sent2 } = fakeWs("c-2");

    registry.add(ws1);
    registry.add(ws2);

    const msg: WsServerMessage = {
      type: "state.transition",
      assignmentId: "ata-1",
      from: "running",
      to: "blocked",
    };
    registry.broadcast(msg);

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(1);
    expect(JSON.parse(sent1[0]!)).toMatchObject({ type: "state.transition" });
    expect(JSON.parse(sent2[0]!)).toMatchObject({ type: "state.transition" });
  });

  it("broadcast skips removed clients", () => {
    const registry = new WsClientRegistry();
    const { ws: ws1, sent: sent1 } = fakeWs("c-1");
    const { ws: ws2, sent: sent2 } = fakeWs("c-2");

    registry.add(ws1);
    registry.add(ws2);
    registry.remove(ws1);

    registry.broadcast({ type: "error", message: "test" });

    expect(sent1).toHaveLength(0);
    expect(sent2).toHaveLength(1);
  });

  it("send targets a specific client", () => {
    const registry = new WsClientRegistry();
    const { ws: ws1, sent: sent1 } = fakeWs("c-1");
    const { ws: ws2, sent: sent2 } = fakeWs("c-2");

    registry.add(ws1);
    registry.add(ws2);

    registry.send("c-1", {
      type: "connected",
      clientId: "c-1",
      serverVersion: "0.1.0",
      protocolVersion: 1,
    });

    expect(sent1).toHaveLength(1);
    expect(sent2).toHaveLength(0);
  });

  it("broadcast removes dead clients that throw on send", () => {
    const registry = new WsClientRegistry();
    const errWs = {
      data: { clientId: "c-err" },
      send() {
        throw new Error("connection lost");
      },
    };
    const { ws: ws2, sent: sent2 } = fakeWs("c-2");

    registry.add(errWs as any);
    registry.add(ws2);

    expect(registry.size).toBe(2);

    // Should not throw even though c-err errors
    registry.broadcast({ type: "error", message: "test" });
    expect(sent2).toHaveLength(1);

    // Dead client should be removed from the registry
    expect(registry.size).toBe(1);
    expect(registry.get("c-err")).toBeUndefined();
    expect(registry.get("c-2")).toBeDefined();
  });
});
