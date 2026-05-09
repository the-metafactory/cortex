import { describe, test, expect } from "bun:test";
import { buildClaudeArgs } from "../claude-invoker";

describe("buildClaudeArgs", () => {
  test("one-shot mode uses --print with prompt as positional", () => {
    const args = buildClaudeArgs({ prompt: "hello", groveChannel: "ivy" });
    expect(args).toContain("--print");
    expect(args[args.length - 1]).toBe("hello");
    expect(args).not.toContain("--resume");
  });

  test("resume mode includes --resume with session ID", () => {
    const args = buildClaudeArgs({
      prompt: "follow up",
      groveChannel: "ivy",
      resumeSessionId: "abc-123",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("abc-123");
    expect(args).toContain("--print");
    expect(args[args.length - 1]).toBe("follow up");
  });

  test("includes additional args", () => {
    const args = buildClaudeArgs({
      prompt: "hello",
      groveChannel: "ivy",
      additionalArgs: ["--verbose"],
    });
    expect(args).toContain("--verbose");
  });
});
