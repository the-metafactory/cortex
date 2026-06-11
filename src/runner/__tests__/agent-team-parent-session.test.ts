import { describe, expect, test } from "bun:test";
import {
  AgentTeamHarness,
  type AgentTeamFactory,
  type AgentTeamOpts,
} from "../agent-team";
import type { DispatchRequest } from "../../common/substrates/types";
import type { DispatchEventSource } from "../../bus/dispatch-events";

/**
 * ST-P1 (cortex#964, refs #952) — the AgentTeamHarness threads the
 * dispatch-level parent session id (`req.runtime.parentSessionId`) into the
 * AgentTeamOpts so the team's moderator session is stamped as a child of the
 * dispatch parent. Participants/synthesis are then parented to the MODERATOR's
 * live session id (covered in the AgentTeam spawn-flow, not here).
 */
const SOURCE: DispatchEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

function collectFactory(result: string): {
  factory: AgentTeamFactory;
  opts: AgentTeamOpts[];
} {
  const opts: AgentTeamOpts[] = [];
  return {
    opts,
    factory: (teamOpts) => {
      opts.push(teamOpts);
      return {
        start() {
          return undefined;
        },
        async wait() {
          return result;
        },
        on() {
          return undefined;
        },
        getTraceContext() {
          return { traceId: "trace-test", teamId: "team-test" };
        },
      };
    },
  };
}

function requestWithParent(parentSessionId?: string): DispatchRequest {
  return {
    prompt: "Coordinate the team",
    tools: { allow: ["Read"] },
    context: [],
    agent: { id: "cortex", displayName: "Cortex" },
    requestId: "22222222-2222-4222-8222-222222222222",
    timeoutMs: 60_000,
    runtime: {
      ...(parentSessionId !== undefined && { parentSessionId }),
    },
  };
}

describe("AgentTeamHarness — ST-P1 parentSessionId threading", () => {
  test("maps req.runtime.parentSessionId into AgentTeamOpts.parentSessionId", async () => {
    const captured = collectFactory("done");
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: captured.factory,
    });

    for await (const _env of harness.dispatch(requestWithParent("dispatch-parent-session"))) {
      // drain
    }

    expect(captured.opts).toHaveLength(1);
    expect(captured.opts[0]?.parentSessionId).toBe("dispatch-parent-session");
  });

  test("leaves parentSessionId undefined when the request carries none", async () => {
    const captured = collectFactory("done");
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: captured.factory,
    });

    for await (const _env of harness.dispatch(requestWithParent(undefined))) {
      // drain
    }

    expect(captured.opts).toHaveLength(1);
    expect(captured.opts[0]?.parentSessionId).toBeUndefined();
  });
});
