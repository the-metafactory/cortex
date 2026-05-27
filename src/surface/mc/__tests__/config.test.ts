import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULT_CONFIG } from "../config";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("mission-control config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when config file does not exist", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.yaml"));
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.db.path).toBe(DEFAULT_CONFIG.db.path);
    expect(config.log.level).toBe(DEFAULT_CONFIG.log.level);
  });

  it("merges partial config with defaults", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "port: 9999\n");
    const config = loadConfig(configPath);
    expect(config.port).toBe(9999);
    expect(config.db.path).toBe(DEFAULT_CONFIG.db.path);
    expect(config.log.level).toBe(DEFAULT_CONFIG.log.level);
  });

  it("overrides nested values", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "db:\n  path: /tmp/test.db\nlog:\n  level: debug\n");
    const config = loadConfig(configPath);
    expect(config.db.path).toBe("/tmp/test.db");
    expect(config.log.level).toBe("debug");
    expect(config.port).toBe(DEFAULT_CONFIG.port);
  });

  it("throws on malformed YAML with a clear message naming the file and parse error", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "port: [\ninvalid yaml\n");
    // Spec NFR: "exit with clear error message including the parse error".
    // The thrown message must contain both the filename (so the principal
    // knows WHICH config blew up) and parse-error context (so they can fix it).
    expect(() => loadConfig(configPath)).toThrow(/Malformed YAML/);
    expect(() => loadConfig(configPath)).toThrow(/mc\.yaml/);
  });

  it("returns a frozen config object", () => {
    const config = loadConfig(join(tmpDir, "nonexistent.yaml"));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("default port is 8767", () => {
    expect(DEFAULT_CONFIG.port).toBe(8767);
  });

  it("default db path includes mission-control.db", () => {
    expect(DEFAULT_CONFIG.db.path).toContain("mission-control.db");
  });

  it("default hooks config has rawEventsDir, cursorPath, pollInterval", () => {
    expect(DEFAULT_CONFIG.hooks.rawEventsDir).toContain("events/raw");
    expect(DEFAULT_CONFIG.hooks.cursorPath).toContain("mc-hook-cursor.json");
    expect(DEFAULT_CONFIG.hooks.pollInterval).toBe(2000);
  });

  it("overrides hooks config from YAML", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(
      configPath,
      "hooks:\n  rawEventsDir: /tmp/events\n  pollInterval: 5000\n"
    );
    const config = loadConfig(configPath);
    expect(config.hooks.rawEventsDir).toBe("/tmp/events");
    expect(config.hooks.pollInterval).toBe(5000);
    expect(config.hooks.cursorPath).toBe(DEFAULT_CONFIG.hooks.cursorPath);
  });

  it("default hostname is 127.0.0.1 (loopback only)", () => {
    expect(DEFAULT_CONFIG.hostname).toBe("127.0.0.1");
  });

  it("default ws config has sensible limits", () => {
    expect(DEFAULT_CONFIG.ws.maxPayloadLength).toBe(64 * 1024);
    expect(DEFAULT_CONFIG.ws.idleTimeoutSec).toBe(60);
    expect(DEFAULT_CONFIG.ws.maxClients).toBe(100);
  });

  it("overrides hostname and ws config from YAML", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(
      configPath,
      "hostname: '127.0.0.1'\nws:\n  maxClients: 50\n  idleTimeoutSec: 30\n"
    );
    const config = loadConfig(configPath);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.ws.maxClients).toBe(50);
    expect(config.ws.idleTimeoutSec).toBe(30);
    expect(config.ws.maxPayloadLength).toBe(DEFAULT_CONFIG.ws.maxPayloadLength);
  });
});
