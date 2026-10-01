import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCSession } from "../cc-session";

/**
 * The prompt travels on the child's STDIN, never in argv.
 *
 * Linux caps a SINGLE argv element at MAX_ARG_STRLEN = 32 pages = 131,072
 * bytes (131,071 + NUL), independent of ARG_MAX (2,097,152). A prompt passed
 * as `-p <prompt>` above that size fails `execve` with E2BIG before `claude`
 * ever runs — the session dies with no stream output at all. `claude --print`
 * reads its prompt from stdin when no positional prompt is given, so the
 * prompt is written there instead and argv stays small whatever the prompt
 * size.
 *
 * A fake `claude` on PATH records its argv and its stdin, then emits one
 * stream-json `result` line so the session completes normally. No model call,
 * no auth.
 */

const PROMPT_BYTES = 200_000;

let binDir = "";
let originalPath: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "cc-session-prompt-stdin-"));
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${binDir}/argv"`,
    `cat > "${binDir}/stdin"`,
    `echo '{"type":"result","subtype":"success","result":"ok","session_id":"stdin-test"}'`,
    "",
  ].join("\n");
  const claude = join(binDir, "claude");
  writeFileSync(claude, script);
  chmodSync(claude, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

function bigPrompt(): string {
  // Distinct head and tail markers so truncation anywhere is visible.
  const head = "PROMPT-HEAD\n";
  const tail = "\nPROMPT-TAIL";
  return head + "x".repeat(PROMPT_BYTES - head.length - tail.length) + tail;
}

describe("CCSession — prompt on stdin, not argv", () => {
  test("a 200,000-byte prompt spawns, succeeds, and arrives whole on stdin", async () => {
    const prompt = bigPrompt();
    expect(Buffer.byteLength(prompt)).toBe(PROMPT_BYTES);

    const result = await new CCSession({ prompt, channel: "test", timeoutMs: 10_000 })
      .start()
      .wait();

    expect(result.success).toBe(true);
    expect(result.response).toBe("ok");
    const received = readFileSync(join(binDir, "stdin"), "utf8");
    expect(Buffer.byteLength(received)).toBe(PROMPT_BYTES);
    expect(received).toBe(prompt);
  });

  test("argv carries no prompt — only flags", async () => {
    const prompt = "UNIQUE-PROMPT-MARKER please answer";
    const result = await new CCSession({
      prompt,
      channel: "test",
      timeoutMs: 10_000,
      resumeSessionId: "prior-session",
      allowedDirs: ["/tmp"],
    })
      .start()
      .wait();

    expect(result.success).toBe(true);
    const argv = readFileSync(join(binDir, "argv"), "utf8").split("\n");
    expect(argv.some((a) => a.includes("UNIQUE-PROMPT-MARKER"))).toBe(false);
    expect(argv).toContain("--print");
    expect(argv).not.toContain("-p");
    expect(readFileSync(join(binDir, "stdin"), "utf8")).toBe(prompt);
  });

  test("a multibyte prompt round-trips byte-exact", async () => {
    const prompt = "café — ✓ 漢字 ".repeat(5_000);
    const result = await new CCSession({ prompt, channel: "test", timeoutMs: 10_000 })
      .start()
      .wait();
    expect(result.success).toBe(true);
    expect(readFileSync(join(binDir, "stdin"), "utf8")).toBe(prompt);
  });
});
