import { describe, test, expect } from "bun:test";
import {
  AgentTeam,
  type AgentTeamOpts,
  type BusPeerHandle,
  type BusPeerHandleConfig,
} from "../agent-team";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { TrustResolver } from "../../common/agents/trust-resolver";
import type { DispatchEventSource } from "../../bus/dispatch-events";
import { testClaude } from "../../common/test-utils";

// =============================================================================
// Bus-peer test fixtures (IAW Phase B.2b)
// =============================================================================

/**
 * Minimal fake bus deps for AgentTeam's bus-peer path. The handle
 * factory below captures the config and exposes a `triggerResult`
 * hook so tests can inject the peer's terminal envelope synchronously.
 */
function fakeBusPeerDeps(): NonNullable<AgentTeamOpts["busPeer"]> {

  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };

  // The bus-peer factory in tests doesn't actually consume the
  // resolver (it's just threaded into BusPeerHarness). An empty
  // object satisfies the structural shape via cast — declared
  // narrowly so the cast is the only weak point.
  const resolver = {} as TrustResolver;
  const source: DispatchEventSource = {
    principal: "metafactory",
    agent: "cortex",
    instance: "local",
  };
  return {
    runtime,
    resolver,
    receivingAgentId: "luna",
    principalId: "test-principal",
    source,
  };
}

interface CapturedHandle {
  config: BusPeerHandleConfig;
  triggerResult: (summary: string) => void;
  triggerError: (err: Error) => void;
}

function fakeBusPeerHandleFactory(captures: CapturedHandle[]) {
  return (config: BusPeerHandleConfig): BusPeerHandle => {
    captures.push({
      config,
      triggerResult: (summary: string) => config.onResult(summary),
      triggerError: (err: Error) => config.onError(err),
    });
    return {
      start: () => {
        /* noop in fake — production iterates BusPeerHarness.dispatch() */
      },
      abort: () => {
        /* noop in fake — production wires BusPeerHarness.dispatch() abort */
      },
    };
  };
}

describe("AgentTeam", () => {
  test("constructs with required opts", () => {
    const team = new AgentTeam({
      prompt: "Research quantum computing",
      channel: "test",
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

  testClaude("emits progress and synthesis events for a real team run", async () => {
    const team = new AgentTeam({
      prompt: "What are the key benefits and risks of nuclear fusion energy? Give a brief answer.",
      channel: "test",
      participants: [
        { name: "analyst", prompt: "Analyze the scientific and engineering feasibility" },
        { name: "critic", prompt: "Identify the main risks and challenges" },
      ],
      disallowedTools: ["Bash", "Write", "Edit"],
      timeoutMs: 120_000,
    });

    const progressMessages: { member: string; text: string }[] = [];

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
      channel: "test",
      participants: [{ name: "a", prompt: "test" }],
    });
    const team2 = new AgentTeam({
      prompt: "test",
      channel: "test",
      participants: [{ name: "a", prompt: "test" }],
    });
    expect(team1.getTraceContext().traceId).not.toBe(team2.getTraceContext().traceId);
    expect(team1.getTraceContext().teamId).not.toBe(team2.getTraceContext().teamId);
  });
});

// =============================================================================
// IAW Phase B.2b — bus-peer participant routing
// =============================================================================

describe("AgentTeam — bus-peer participant (B.2b)", () => {
  test("constructor throws when bus-peer participant is declared without opts.busPeer", () => {
    expect(
      () =>
        new AgentTeam({
          prompt: "Research quantum computing",
          participants: [
            {
              name: "remote-analyst",
              prompt: "Analytical perspective",
              kind: "bus-peer",
              peerAgentId: "alpha",
            },
          ],
        }),
    ).toThrow(/opts\.busPeer is missing/);
  });

  test("constructor throws when bus-peer participant is missing peerAgentId", () => {
    expect(
      () =>
        new AgentTeam({
          prompt: "Research quantum computing",
          participants: [
            {
              name: "remote-analyst",
              prompt: "Analytical perspective",
              kind: "bus-peer",
              // peerAgentId omitted
            },
          ],
          busPeer: fakeBusPeerDeps(),
        }),
    ).toThrow(/missing peerAgentId/);
  });

  testClaude("bus-peer participant routes via factory + delivers result to synthesis path", async () => {
    const captures: CapturedHandle[] = [];
    const team = new AgentTeam({
      prompt: "Research the team task",
      participants: [
        {
          name: "remote-analyst",
          prompt: "Analytical perspective",
          kind: "bus-peer",
          peerAgentId: "alpha",
        },
      ],
      busPeer: fakeBusPeerDeps(),
      busPeerHandleFactory: fakeBusPeerHandleFactory(captures),
    });

    // Simulate the moderator emitting an @remote-analyst mention by
    // invoking the spawn path directly via the public surface — we
    // can't drive a real moderator in this unit test. Instead, call
    // the private spawnParticipant indirectly by reaching through
    // the same `handleModeratorResponse` codepath. The factory
    // captures the handle config; triggerResult delivers the peer's
    // terminal envelope's `result_summary`.
    //
    // Use the team's `handleModeratorResponse` via the moderator's
    // event surface. For test isolation, we directly invoke the
    // private spawnParticipant via index-access casting — the only
    // realistic alternative is to construct a fake moderator, which
    // is more fragile than the cast.
    const teamAny = team as unknown as {
      spawnParticipant(name: string): void;
      pendingParticipants: Set<string>;
    };
    teamAny.pendingParticipants.add("remote-analyst");
    teamAny.spawnParticipant("remote-analyst");

    expect(captures).toHaveLength(1);
    const capture = captures[0];
    expect(capture).toBeDefined();
    if (!capture) return;

    expect(capture.config.peerAgentId).toBe("alpha");
    expect(capture.config.participantName).toBe("remote-analyst");
    expect(capture.config.prompt).toContain("Analytical perspective");
    expect(capture.config.prompt).toContain("Research the team task");

    // Listen for synthesis (single-participant team — synthesis fires
    // on the moderator's CCSession via the synthesis prompt; the
    // moderator's result emits as "synthesis"). For a single-
    // participant test the synthesis path needs the moderator to
    // produce a result. We can't easily drive a real moderator, so
    // assert the lower-level invariant: the result flowed through
    // the team's member record.
    capture.triggerResult("Remote analysis: quantum computing is hard.");

    // The team's private member map now holds the result.
    const membersMap = (
      team as unknown as { members: Map<string, { result?: string }> }
    ).members;
    expect(membersMap.get("remote-analyst")?.result).toBe(
      "Remote analysis: quantum computing is hard.",
    );
  });

  testClaude("bus-peer participant — onError marks member failed and decrements pending", () => {
    const captures: CapturedHandle[] = [];
    const team = new AgentTeam({
      prompt: "Research the team task",
      participants: [
        {
          name: "remote-analyst",
          prompt: "Analytical perspective",
          kind: "bus-peer",
          peerAgentId: "alpha",
        },
      ],
      busPeer: fakeBusPeerDeps(),
      busPeerHandleFactory: fakeBusPeerHandleFactory(captures),
    });

    const teamAny = team as unknown as {
      spawnParticipant(name: string): void;
      pendingParticipants: Set<string>;
    };
    teamAny.pendingParticipants.add("remote-analyst");
    teamAny.spawnParticipant("remote-analyst");

    const capture = captures[0];
    if (!capture) throw new Error("test: capture missing");

    capture.triggerError(new Error("peer rejected: untrusted signer"));

    const membersMap = (
      team as unknown as { members: Map<string, { result?: string }> }
    ).members;
    expect(membersMap.get("remote-analyst")?.result).toContain(
      "Error: peer rejected: untrusted signer",
    );
    expect(teamAny.pendingParticipants.size).toBe(0);
  });
});
