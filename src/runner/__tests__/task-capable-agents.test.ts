import { expect, test } from "bun:test";
import { AgentSchema, type Agent } from "../../common/types/cortex-config";
import { taskCapableAgents } from "../task-capable-agents";

const isExecBrain = (agent: Agent): boolean => agent.runtime?.brain?.kind === "exec";
const agent = (id: string, runtime?: unknown): Agent => AgentSchema.parse({
  id, displayName: id, persona: `/fixtures/${id}.md`, trust: [], presence: {}, runtime,
});

test("headless Claude and legacy agents remain task receivers without a surface", () => {
  const legacy = agent("legacy-worker");
  const headless = agent("headless-worker", { substrate: "claude-code", mode: "in-process" });
  expect(taskCapableAgents([legacy], isExecBrain)).toEqual([legacy]);
  expect(taskCapableAgents([headless], isExecBrain)).toEqual([headless]);
});

test("headless API receivers coexist with builtins without acquiring a surface", () => {
  const api = agent("local-worker", { substrate: "api-agent", mode: "in-process", capabilities: ["chat.local"] });
  const builtin = agent("review-worker", { substrate: "claude-code", mode: "in-process" });
  expect(taskCapableAgents([builtin, api], isExecBrain)).toEqual([builtin, api]);
  expect(api.presence).toEqual({});
});

test("standalone and exec brains keep ownership of their own consumers", () => {
  const standalone = agent("standalone-worker", { substrate: "api-agent", mode: "standalone", capabilities: ["chat.local"] });
  const exec = agent("exec-worker", { mode: "in-process", brain: { kind: "exec", run: "fixture-brain" } });
  const builtin = agent("builtin");
  expect(taskCapableAgents([standalone, builtin, exec], isExecBrain)).toEqual([builtin]);
  expect(taskCapableAgents([], isExecBrain)).toEqual([]);
});
