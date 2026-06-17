/**
 * GV-1 (cortex#1076) — cortex-status.sh config-path precedence.
 *
 * The statusline helper reads bot.yaml cortex-first with a grove fallback. We
 * drive the script with a controlled $HOME and a distinguishing `api.mode`
 * (cloud vs local) in each candidate bot.yaml, then assert which one the
 * rendered Mode/Network reflects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "cortex-status.sh");
let home: string;

function writeBotYaml(dir: "cortex" | "grove", mode: "cloud" | "local") {
  const d = join(home, ".config", dir);
  mkdirSync(d, { recursive: true });
  // `api.mode` drives the rendered Mode/Network — a clean, non-deprecated
  // discriminator for WHICH bot.yaml the script read.
  writeFileSync(join(d, "bot.yaml"), `api:\n  mode: ${mode}\n`);
}

/** Source the script in `normal` MODE with GROVE_CHANNEL set, capture stdout. */
async function runStatus(): Promise<string> {
  // Strip any GROVE_* inherited from the runner's shell — the render prefers
  // GROVE_AGENT_NAME over the bot.yaml operatorId, which would mask the field
  // we're using to detect WHICH bot.yaml was read.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GROVE_") && !k.startsWith("CORTEX_") && v !== undefined) env[k] = v;
  }
  env.HOME = home;
  env.GROVE_CHANNEL = "ch";
  env.MODE = "normal";
  const proc = Bun.spawn(["bash", "-c", `source "${SCRIPT}"`], {
    env,
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gv1-status-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("cortex-status.sh — cortex-first, grove-fallback", () => {
  test("reads grove bot.yaml when only grove exists (mode: cloud → Network: metafactory)", async () => {
    writeBotYaml("grove", "cloud");
    const out = await runStatus();
    expect(out).toContain("metafactory");
  });

  test("reads cortex bot.yaml when both exist — cortex-first (cortex: local, grove: cloud)", async () => {
    writeBotYaml("grove", "cloud"); // would render Network: metafactory if read
    writeBotYaml("cortex", "local"); // cortex wins → Network: local
    const out = await runStatus();
    expect(out).toContain("Network:");
    expect(out).toContain("local");
    expect(out).not.toContain("metafactory");
  });
});
