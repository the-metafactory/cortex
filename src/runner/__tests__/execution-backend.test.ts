import { describe, test, expect } from "bun:test";
import {
  LocalBackend,
  BackendRegistry,
  type ExecutionBackend,
} from "../execution-backend";
import { CCSession } from "../cc-session";

describe("LocalBackend", () => {
  test("has name 'local'", () => {
    const backend = new LocalBackend();
    expect(backend.name).toBe("local");
  });

  test("spawns a CCSession", () => {
    const backend = new LocalBackend();
    const session = backend.spawn({
      prompt: "test",
      channel: "test",
    });
    expect(session).toBeInstanceOf(CCSession);
  });
});

describe("BackendRegistry", () => {
  test("defaults to local backend", () => {
    const registry = new BackendRegistry();
    const backend = registry.default();
    expect(backend.name).toBe("local");
  });

  test("gets backend by name", () => {
    const registry = new BackendRegistry();
    const backend = registry.get("local");
    expect(backend.name).toBe("local");
  });

  test("throws for unknown backend", () => {
    const registry = new BackendRegistry();
    expect(() => registry.get("cloudflare")).toThrow(/not registered/);
  });

  test("lists registered backends", () => {
    const registry = new BackendRegistry();
    expect(registry.list()).toEqual(["local"]);
  });

  test("registers custom backends", () => {
    const registry = new BackendRegistry();

    const custom: ExecutionBackend = {
      name: "test-remote",
      spawn: (opts) => new CCSession(opts),
    };

    registry.register(custom);
    expect(registry.list()).toContain("test-remote");
    expect(registry.get("test-remote").name).toBe("test-remote");
  });

  test("supports custom default", () => {
    const registry = new BackendRegistry("custom");

    const custom: ExecutionBackend = {
      name: "custom",
      spawn: (opts) => new CCSession(opts),
    };
    registry.register(custom);

    expect(registry.default().name).toBe("custom");
  });
});
