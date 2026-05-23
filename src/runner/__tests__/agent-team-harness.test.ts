import { describe, expect, test } from "bun:test";
import {
  AgentTeamHarness,
  type AgentTeamFactory,
  type AgentTeamOpts,
} from "../agent-team";
import type { DispatchRequest } from "../../common/substrates/types";
import type { DispatchEventSource } from "../../bus/dispatch-events";

const SOURCE: DispatchEventSource = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

const REQUEST: DispatchRequest = {
  prompt: "Review the Direction A plan",
  tools: { allow: ["Read"], deny: ["Bash"] },
  context: [
    {
      kind: "env",
      data: {
        operator: "andreas",
        entity: "cortex#408",
        project: "cortex",
      },
    },
  ],
  agent: { id: "cortex", displayName: "Cortex" },
  requestId: "11111111-1111-4111-8111-111111111111",
  timeoutMs: 60_000,
  runtime: {
    groveChannel: "codex",
    groveNetwork: "direction-a",
    additionalArgs: ["--model", "sonnet"],
    allowedDirs: ["/tmp/work"],
  },
};

function collectFactory(result: string): {
  factory: AgentTeamFactory;
  opts: AgentTeamOpts[];
  starts: number;
} {
  const opts: AgentTeamOpts[] = [];
  const state = {
    starts: 0,
  };
  return {
    opts,
    get starts() {
      return state.starts;
    },
    factory: (teamOpts) => {
      opts.push(teamOpts);
      return {
        start() {
          state.starts += 1;
        },
        async wait() {
          return result;
        },
        on() {
          return undefined;
        },
        getTraceContext() {
          return {
            traceId: "trace-test",
            teamId: "team-test",
          };
        },
      };
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AgentTeamHarness", () => {
  test("implements SessionHarness identity", () => {
    const harness = new AgentTeamHarness({ source: SOURCE });
    expect(harness.id).toBe("agent-team");
    expect(harness.capabilities).toEqual([]);
  });

  test("yields started → completed and maps request into default team opts", async () => {
    const captured = collectFactory("Synthesized team answer");
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: captured.factory,
    });

    const envelopes = [];
    for await (const env of harness.dispatch(REQUEST)) {
      envelopes.push(env);
    }

    expect(envelopes.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.completed",
    ]);
    expect(envelopes.every((e) => e.correlation_id === REQUEST.requestId)).toBe(true);
    expect(envelopes.at(-1)?.payload.result_summary).toBe("Synthesized team answer");
    expect(captured.starts).toBe(1);
    expect(captured.opts).toHaveLength(1);

    const opts = captured.opts[0];
    expect(opts?.prompt).toBe(REQUEST.prompt);
    expect(opts?.participants.map((p) => p.name)).toEqual([
      "analyst",
      "creative",
      "critic",
    ]);
    expect(opts?.participants.length).toBeGreaterThanOrEqual(2);
    expect(opts?.allowedTools).toEqual(["Read"]);
    expect(opts?.disallowedTools).toEqual(["Bash"]);
    expect(opts?.allowedDirs).toEqual(["/tmp/work"]);
    expect(opts?.timeoutMs).toBe(60_000);
    expect(opts?.groveChannel).toBe("codex");
    expect(opts?.groveNetwork).toBe("direction-a");
    expect(opts?.additionalArgs).toEqual(["--model", "sonnet"]);
    expect(opts?.operator).toBe("andreas");
    expect(opts?.entity).toBe("cortex#408");
    expect(opts?.project).toBe("cortex");
  });

  test("truncates completed result_summary to the first line", async () => {
    const captured = collectFactory(`First line\n${"x".repeat(2_000)}`);
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: captured.factory,
    });

    const envelopes = [];
    for await (const env of harness.dispatch(REQUEST)) {
      envelopes.push(env);
    }

    expect(envelopes.at(-1)?.payload.result_summary).toBe("First line");
  });

  test("yields started → failed when the team factory throws", async () => {
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: () => {
        throw new Error("team unavailable");
      },
    });

    const envelopes = [];
    for await (const env of harness.dispatch(REQUEST)) {
      envelopes.push(env);
    }

    expect(envelopes.map((e) => e.type)).toEqual([
      "dispatch.task.started",
      "dispatch.task.failed",
    ]);
    expect(envelopes.at(-1)?.payload.error_summary).toBe("team unavailable");
  });

  test("hard shutdown aborts an active team", async () => {
    const wait = deferred<string>();
    let abortCalls = 0;
    const harness = new AgentTeamHarness({
      source: SOURCE,
      agentTeamFactory: () => ({
        start() {
          return undefined;
        },
        wait() {
          return wait.promise;
        },
        abort() {
          abortCalls += 1;
          wait.reject(new Error("aborted by shutdown"));
        },
        on() {
          return undefined;
        },
        getTraceContext() {
          return {
            traceId: "trace-test",
            teamId: "team-test",
          };
        },
      }),
    });

    const iterator = harness.dispatch(REQUEST)[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("dispatch.task.started");

    const terminal = iterator.next();
    await Promise.resolve();
    await harness.shutdown({ graceful: false });

    expect(abortCalls).toBe(1);
    const next = await terminal;
    expect(next.value.type).toBe("dispatch.task.failed");
    expect(next.value.payload.error_summary).toBe("aborted by shutdown");
  });
});
