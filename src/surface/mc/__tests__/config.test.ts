import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, detectLocalPrincipalDrift, DEFAULT_CONFIG } from "../config";
import { DEFAULT_LOCAL_PRINCIPAL } from "../api/networks-admission";
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

  // ── FND-6 posture A — governance.local_principal parsing + drift warning ──

  it("parses governance.local_principal from YAML", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(
      configPath,
      "governance:\n  principals:\n    - andreas@x.io\n  local_principal: andreas@x.io\n",
    );
    const config = loadConfig(configPath, { onWarning: () => {} });
    expect(config.governance?.localPrincipal).toBe("andreas@x.io");
    expect(config.governance?.principals).toEqual(["andreas@x.io"]);
  });

  it("throws when governance.local_principal is an empty string", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "governance:\n  principals: []\n  local_principal: ''\n");
    expect(() => loadConfig(configPath)).toThrow(/local_principal must be a non-empty string/);
  });

  it("throws when governance.local_principal is whitespace-only", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "governance:\n  principals: []\n  local_principal: '   '\n");
    expect(() => loadConfig(configPath)).toThrow(/local_principal must be a non-empty string/);
  });

  it("throws when governance.local_principal is a number", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "governance:\n  principals: []\n  local_principal: 42\n");
    expect(() => loadConfig(configPath)).toThrow(/local_principal must be a non-empty string/);
  });

  it("throws when governance.local_principal is an array", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "governance:\n  principals: []\n  local_principal:\n    - a@b.io\n");
    expect(() => loadConfig(configPath)).toThrow(/local_principal must be a non-empty string/);
  });

  it("WARNS (via onWarning) when principals is set but local_principal is unset", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(configPath, "governance:\n  principals:\n    - andreas@x.io\n");
    const warnings: string[] = [];
    loadConfig(configPath, { onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mc.governance");
    expect(warnings[0]).toContain("local_principal is unset");
    expect(warnings[0]).toContain("403");
  });

  it("does NOT warn when principals is set and local_principal is a listed value", () => {
    const configPath = join(tmpDir, "mc.yaml");
    writeFileSync(
      configPath,
      "governance:\n  principals:\n    - andreas@x.io\n  local_principal: andreas@x.io\n",
    );
    const warnings: string[] = [];
    loadConfig(configPath, { onWarning: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });
});

describe("detectLocalPrincipalDrift (FND-6 posture A, pure)", () => {
  it("returns null when governance is undefined", () => {
    expect(detectLocalPrincipalDrift(undefined)).toBeNull();
  });

  it("returns null when principals is empty (permissive-on-loopback path)", () => {
    expect(detectLocalPrincipalDrift({ principals: [] })).toBeNull();
    expect(detectLocalPrincipalDrift({ principals: [], localPrincipal: "x@y.io" })).toBeNull();
  });

  it("warns when principals set + local_principal unset (would 403 the sentinel)", () => {
    const msg = detectLocalPrincipalDrift({ principals: ["andreas@x.io"] });
    expect(msg).toContain("unset");
    expect(msg).toContain("403");
    // The sentinel the headerless caller would resolve to is not in the allowlist.
    expect(DEFAULT_LOCAL_PRINCIPAL).not.toBe("andreas@x.io");
  });

  it("warns when local_principal is set but NOT in principals", () => {
    const msg = detectLocalPrincipalDrift({
      principals: ["andreas@x.io"],
      localPrincipal: "someone@else.io",
    });
    expect(msg).toContain("not one of the listed principals");
  });

  it("is case-insensitive when matching local_principal against principals", () => {
    expect(
      detectLocalPrincipalDrift({
        principals: ["Andreas@X.io"],
        localPrincipal: "andreas@x.io",
      }),
    ).toBeNull();
  });

  it("returns null when local_principal IS a listed principal", () => {
    expect(
      detectLocalPrincipalDrift({
        principals: ["a@b.io", "andreas@x.io"],
        localPrincipal: "andreas@x.io",
      }),
    ).toBeNull();
  });
});
