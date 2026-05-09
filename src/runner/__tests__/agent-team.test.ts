import { describe, test, expect } from "bun:test";
import { AgentTeam, type AgentTeamOpts } from "../agent-team";

describe("AgentTeam", () => {
  test("constructs with required opts", () => {
    const team = new AgentTeam({
      prompt: "Research quantum computing",
      groveChannel: "test",
      participants: [
        { name: "analyst", prompt: "Analytical perspective" },
        { name: "creative", prompt: "Creative perspective" },
      ],
    });
    expect(team).toBeInstanceOf(AgentTeam);
    const ctx = team.getTraceContext();
    expect(ctx.traceId).toBeTruthy();
    expect(ctx.teamId).toMatch(/^team-/);
  });

  test("emits progress and synthesis events for a real team run", async () => {
    const team = new AgentTeam({
      prompt: "What are the key benefits and risks of nuclear fusion energy? Give a brief answer.",
      groveChannel: "test",
      participants: [
        { name: "analyst", prompt: "Analyze the scientific and engineering feasibility" },
        { name: "critic", prompt: "Identify the main risks and challenges" },
      ],
      disallowedTools: ["Bash", "Write", "Edit"],
      timeoutMs: 120_000,
    });

    const progressMessages: Array<{ member: string; text: string }> = [];

    team.on("progress", (member: string, text: string) => {
      progressMessages.push({ member, text });
    });

    team.start();
    const synthesis = await team.wait();

    expect(typeof synthesis).toBe("string");
    expect(synthesis.length).toBeGreaterThan(0);
    // Should have at least moderator progress + participant progress
    expect(progressMessages.length).toBeGreaterThan(0);
  }, 300_000); // 5 minutes — team work takes time

  test("getTraceContext returns unique IDs", () => {
    const team1 = new AgentTeam({
      prompt: "test",
      groveChannel: "test",
      participants: [{ name: "a", prompt: "test" }],
    });
    const team2 = new AgentTeam({
      prompt: "test",
      groveChannel: "test",
      participants: [{ name: "a", prompt: "test" }],
    });
    expect(team1.getTraceContext().traceId).not.toBe(team2.getTraceContext().traceId);
    expect(team1.getTraceContext().teamId).not.toBe(team2.getTraceContext().teamId);
  });
});
