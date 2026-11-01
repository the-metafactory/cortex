import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { composeRawConfig, loadConfig } from "../loader";

let dir: string;
const base = {
  agent: { name: "voice-test", displayName: "Voice test" },
  claude: { timeoutMs: 120000 },
  mc: {
    enabled: true,
    desk: {
      topN: 4,
      voice: {
        enabled: true,
        input: "browser",
        output: "elevenlabs",
        elevenlabs: { voiceId: "syntheticVoice123", apiKeyEnv: "TEST_VOICE_KEY", sttModel: "scribe_v1" },
      },
    },
  },
};
const write = (path: string, value: unknown): void => writeFileSync(path, stringify(value), { mode: 0o600 });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "desk-file-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("desk.yaml configuration", () => {
  test("overrides only explicit Desk settings and inherits ElevenLabs options", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    write(join(dir, "desk.yaml"), { voice: { input: "elevenlabs" } });
    const loaded = loadConfig(path);
    expect(loaded.mc.desk.voice.input).toBe("elevenlabs");
    expect(loaded.mc.desk.voice.output).toBe("elevenlabs");
    expect(loaded.mc.desk.voice.elevenlabs?.voiceId).toBe("syntheticVoice123");
    expect(loaded.mc.desk.topN).toBe(4);
    expect(loaded.agent.name).toBe("voice-test");
  });

  test("overrides directory stack settings with the same precedence", () => {
    mkdirSync(join(dir, "system"));
    mkdirSync(join(dir, "stacks"));
    write(join(dir, "system/system.yaml"), { agent: base.agent, claude: base.claude });
    write(join(dir, "stacks/default.yaml"), { mc: base.mc });
    write(join(dir, "desk.yaml"), { voice: { input: "elevenlabs" } });
    expect(loadConfig(join(dir, "default.yaml")).mc.desk.voice.input).toBe("elevenlabs");
  });

  test("absence and an empty Desk file preserve existing configuration", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    expect(composeRawConfig(path)).toEqual(base);
    write(join(dir, "desk.yaml"), {});
    expect(composeRawConfig(path)).toEqual(base);
  });

  test("a main configuration named desk.yaml is not treated as its own overlay", () => {
    const path = join(dir, "desk.yaml");
    write(path, base);
    expect(composeRawConfig(path)).toEqual(base);
  });

  test("rejects a misplaced root wrapper rather than silently ignoring it", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    write(join(dir, "desk.yaml"), { mc: { desk: { voice: { input: "elevenlabs" } } } });
    expect(() => composeRawConfig(path)).toThrow("desk.yaml");
  });

  test("rejects invalid merged voice configuration", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    write(join(dir, "desk.yaml"), { voice: { input: "unsupported-provider" } });
    expect(() => loadConfig(path)).toThrow();
  });

  test("rejects malformed YAML and nonmapping overlays", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    write(join(dir, "desk.yaml"), ["voice"]);
    expect(() => composeRawConfig(path)).toThrow("YAML mapping");
    writeFileSync(join(dir, "desk.yaml"), "voice: [\n", { mode: 0o600 });
    expect(() => composeRawConfig(path)).toThrow("failed to parse");
  });

  test("retains the configuration layer size limit", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    writeFileSync(join(dir, "desk.yaml"), " ".repeat(1_048_577), { mode: 0o600 });
    expect(() => composeRawConfig(path)).toThrow("exceeds");
  });

  test.skipIf(process.platform === "win32")("requires a private Desk configuration file", () => {
    const path = join(dir, "cortex.yaml");
    write(path, base);
    const desk = join(dir, "desk.yaml");
    write(desk, { voice: { input: "elevenlabs" } });
    chmodSync(desk, 0o644);
    expect(() => composeRawConfig(path)).toThrow("chmod 600");
  });
});
