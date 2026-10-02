import { describe, test, expect } from "bun:test";
import { buildClaudeArgs } from "../claude-invoker";

describe("buildClaudeArgs", () => {
  test("one-shot mode uses --print and keeps the prompt OUT of argv (it rides stdin)", () => {
    const args = buildClaudeArgs({ prompt: "hello", channel: "ivy" });
    expect(args).toContain("--print");
    expect(args).not.toContain("hello");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--resume");
  });

  test("resume mode includes --resume with session ID", () => {
    const args = buildClaudeArgs({
      prompt: "follow up",
      channel: "ivy",
      resumeSessionId: "abc-123",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("abc-123");
    expect(args).toContain("--print");
    expect(args).not.toContain("follow up");
  });

  test("includes additional args", () => {
    const args = buildClaudeArgs({
      prompt: "hello",
      channel: "ivy",
      additionalArgs: ["--verbose"],
    });
    expect(args).toContain("--verbose");
  });

  test("a prompt over the Linux per-argument limit never reaches argv", () => {
    const prompt = "x".repeat(200_000);
    const args = buildClaudeArgs({ prompt, channel: "ivy", allowedDirs: ["/tmp"] });
    expect(args.every((a) => a.length < 131_072)).toBe(true);
    expect(args.join("").includes(prompt)).toBe(false);
  });
});
