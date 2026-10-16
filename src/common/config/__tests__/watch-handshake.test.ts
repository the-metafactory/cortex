import { describe, expect, test } from "bun:test";
import { awaitWatchHandshake } from "../watch-handshake";

describe("watch readiness handshake", () => {
  test("releases the event hook synchronously so the next event is not consumed", async () => {
    const hooks: { current: (() => void) | null } = { current: null };
    await awaitWatchHandshake({
      setHook: (hook) => { hooks.current = hook; },
      probe: () => {
        expect(hooks.current).not.toBeNull();
        hooks.current?.();
        // Some backends deliver several events in one callback batch.
        expect(hooks.current).toBeNull();
      },
      isStopped: () => false,
      timeoutMs: 1_000,
      label: "test watcher",
    });
    expect(hooks.current).toBeNull();
  });

  test("a failed probe rejects and removes its hook", async () => {
    const hooks: { current: (() => void) | null } = { current: null };
    const error = new Error("probe write denied");
    await expect(awaitWatchHandshake({
      setHook: (hook) => { hooks.current = hook; },
      probe: () => { throw error; },
      isStopped: () => false,
      timeoutMs: 1_000,
      label: "test watcher",
    })).rejects.toBe(error);
    expect(hooks.current).toBeNull();
  });

  test("silence rejects with a bounded, labelled timeout and removes its hook", async () => {
    const hooks: { current: (() => void) | null } = { current: null };
    await expect(awaitWatchHandshake({
      setHook: (hook) => { hooks.current = hook; },
      probe: () => {},
      isStopped: () => false,
      timeoutMs: 10,
      label: "test watcher",
    })).rejects.toThrow("test watcher reported no event within 10ms");
    expect(hooks.current).toBeNull();
  });

  test("a stopped watcher neither installs a hook nor writes a probe", async () => {
    let calls = 0;
    await awaitWatchHandshake({
      setHook: () => { calls++; },
      probe: () => { calls++; },
      isStopped: () => true,
      timeoutMs: 10,
      label: "test watcher",
    });
    expect(calls).toBe(0);
  });
});
