import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { MockAdapter } from "../mock";
import { notifyWithResult } from "../notify-result";
import type { NotifyResult, PlatformAdapter } from "../types";

const warning = "adapter reports no delivery result; Vigil fallback cannot detect failures";
const warn = spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => { warn.mockClear(); });
afterAll(() => { warn.mockRestore(); });

function adapterWith(notifyPrincipal: PlatformAdapter["notifyPrincipal"]): PlatformAdapter {
  const adapter: PlatformAdapter = new MockAdapter();
  adapter.notifyPrincipal = notifyPrincipal;
  return adapter;
}

describe("notifyWithResult", () => {
  test("returns the mock result unchanged and disables buffering", async () => {
    const adapter = new MockAdapter();
    expect(await notifyWithResult(adapter, "hello")).toBe(adapter.notifyPrincipalResult);
    expect(adapter.notifyPrincipalResult).toEqual({ delivered: true, messageId: "mock" });
    expect(adapter.principalNotifications).toEqual(["hello"]);
    expect(adapter.principalNotificationCalls).toEqual([{ text: "hello", opts: { buffer: false } }]);
  });

  test.each<NotifyResult>([
    { delivered: true },
    { delivered: false, kind: "permanent", code: "blocked", detail: "DMs disabled" },
    { delivered: false, kind: "transient", code: "unavailable" },
  ])("passes a configured result through: %j", async (result) => {
    const adapter = new MockAdapter();
    adapter.notifyPrincipalResult = result;
    expect(await notifyWithResult(adapter, "hello")).toBe(result);
    expect(warn).not.toHaveBeenCalled();
  });

  test("treats legacy void as delivered and warns once per object, even with the same instanceId", async () => {
    const first = adapterWith(async () => {});
    const second = adapterWith(async () => {});
    expect(first.instanceId).toBe(second.instanceId);
    const results = await Promise.all([
      notifyWithResult(first, "one"), notifyWithResult(first, "two"),
      notifyWithResult(second, "three"), notifyWithResult(second, "four"),
    ]);
    for (const result of results) expect(result).toEqual({ delivered: true });
    expect(warn.mock.calls).toEqual([[warning], [warning]]);
  });

  test("normalizes rejected errors", async () => {
    const adapter = adapterWith(() => Promise.reject(new Error("offline")));
    expect(await notifyWithResult(adapter, "hello")).toEqual({
      delivered: false, kind: "transient", code: "exception", detail: "offline",
    });
  });

  test("uses a two second default and clears the timer after an immediate result", async () => {
    const schedule = spyOn(globalThis, "setTimeout");
    const cancel = spyOn(globalThis, "clearTimeout");
    try {
      await notifyWithResult(new MockAdapter(), "hello");
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2000);
      expect(cancel).toHaveBeenCalledWith(schedule.mock.results[0]!.value);
    } finally {
      schedule.mockRestore();
      cancel.mockRestore();
    }
  });

  test("normalizes synchronous and non-Error throws", async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a test deliberately throws a non-Error value to pin notifyWithResult's String(err) detail branch
    const adapter = adapterWith(() => { throw "offline"; });
    expect(await notifyWithResult(adapter, "hello")).toEqual({
      delivered: false, kind: "transient", code: "exception", detail: "offline",
    });
  });

  test("times out a send that never settles", async () => {
    const adapter = adapterWith(() => new Promise(() => {}));
    expect(await notifyWithResult(adapter, "hello", { timeoutMs: 10 })).toEqual({
      delivered: false, kind: "transient", code: "timeout",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("handles a late rejection after timeout", async () => {
    let reject!: (reason: Error) => void;
    const adapter = adapterWith(() => new Promise((_, fail) => { reject = fail; }));
    expect(await notifyWithResult(adapter, "hello", { timeoutMs: 10 })).toEqual({
      delivered: false, kind: "transient", code: "timeout",
    });
    reject(new Error("late failure"));
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });

  test("mock records omitted and explicit options and clears call history on reset", async () => {
    const adapter = new MockAdapter();
    await adapter.notifyPrincipal("buffered");
    await adapter.notifyPrincipal("explicit", { buffer: true });
    expect(adapter.principalNotificationCalls).toEqual([
      { text: "buffered", opts: undefined }, { text: "explicit", opts: { buffer: true } },
    ]);
    adapter.reset();
    expect(adapter.principalNotifications).toEqual([]);
    expect(adapter.principalNotificationCalls).toEqual([]);
  });
});
