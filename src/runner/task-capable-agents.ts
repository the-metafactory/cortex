import type { Agent } from "../common/types/cortex-config";

export function taskCapableAgents(
  agents: readonly Agent[],
  isExecBrain: (agent: Agent) => boolean,
): Agent[] {
  return agents.filter((agent) => !isExecBrain(agent) && agent.runtime?.mode !== "standalone");
}
