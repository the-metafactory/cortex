import { describe, it, expect } from "bun:test";
import { WebSocket as WsWebSocket } from "ws";
import { installWsTransport } from "../ws-transport";

describe("installWsTransport", () => {
  const makeTarget = (existing?: unknown) =>
    ({ WebSocket: existing }) as Record<string, unknown>;

  it("forces the `ws` WebSocket on Bun and preserves the native impl", () => {
    const native = function NativeWS() {};
    const target = makeTarget(native);
    const logs: string[] = [];

    const r = installWsTransport(target, { isBun: true, nativeOptOut: false, log: (m) => logs.push(m) });

    expect(r.applied).toBe(true);
    expect(r.reason).toBe("applied:ws");
    expect(target.WebSocket).toBe(WsWebSocket as unknown);
    expect(target.__cortexNativeWebSocket).toBe(native);
    expect(logs.join("")).toContain("forcing @discordjs/ws onto the `ws` package");
  });

  it("is a no-op on Node (native path already uses `ws`)", () => {
    const native = function NativeWS() {};
    const target = makeTarget(native);
    const r = installWsTransport(target, { isBun: false, log: () => {} });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("not-bun");
    expect(target.WebSocket).toBe(native); // untouched
  });

  it("respects the CORTEX_WS_NATIVE opt-out", () => {
    const native = function NativeWS() {};
    const target = makeTarget(native);
    const r = installWsTransport(target, { isBun: true, nativeOptOut: true, log: () => {} });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("opt-out:CORTEX_WS_NATIVE");
    expect(target.WebSocket).toBe(native); // untouched
  });

  it("is idempotent — a second apply no-ops", () => {
    const target = makeTarget(function NativeWS() {});
    installWsTransport(target, { isBun: true, log: () => {} });
    const second = installWsTransport(target, { isBun: true, log: () => {} });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already-applied");
    expect(target.WebSocket).toBe(WsWebSocket as unknown);
  });
});
