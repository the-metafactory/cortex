import type { AgentSovereignty, PipelineStep, SeatSpec } from "pulse";
import type { AgentPresenceView } from "../api/agents";
import type { CapabilityStep, MissingCapability, StepSovereignty } from "./routine-capability-contract";
import { routineSeatLabel, routineStepLabels } from "./routine-steps";

export type RoutineCapabilities = () => ReadonlySet<string>;

const MAX_PROMPT = 4000;
const GATE_UNBUILDABLE = "A gate provider is configured on pulse-flow, not built per routine, so a build node cannot supply it.";

export class MissingCapabilitiesError extends Error {
  constructor(readonly missing: MissingCapability[]) {
    super(`No fresh online local agent provides ${missing.map((m) => m.capability).join(", ")}. This routine cannot run yet.`);
  }
}

export class UnbuildableRoutineError extends Error {}

export function localRoutineCapabilities(presence: AgentPresenceView | null, now = Date.now()): ReadonlySet<string> {
  return new Set(presence?.getAgents().filter((a) => a.origin === "local" && a.state === "online" && now - a.lastSeenAt <= 90_000 && a.lastSeenAt <= now).flatMap((a) => [...a.capabilities]) ?? []);
}

function sovereigntyOf(sovereignty: AgentSovereignty | undefined): StepSovereignty {
  return {
    ...(sovereignty?.model_class ? { model_class: sovereignty.model_class } : {}),
    ...(sovereignty?.frontier_ok !== undefined ? { frontier_ok: sovereignty.frontier_ok } : {}),
    ...(sovereignty?.data_residency ? { data_residency: sovereignty.data_residency } : {}),
  };
}

const stepDetail = (label: string, prompt: string, sovereignty: AgentSovereignty | undefined): CapabilityStep => ({
  label,
  prompt: prompt.length > MAX_PROMPT ? `${prompt.slice(0, MAX_PROMPT - 1)}…` : prompt,
  sovereignty: sovereigntyOf(sovereignty),
});

export function requireRoutineCapabilities(steps: PipelineStep[], capabilities: RoutineCapabilities = () => new Set()): string[] {
  const required = new Map<string, CapabilityStep[]>();
  const queue = [...steps];
  const need = (capability: string, detail: CapabilityStep): void => { required.set(capability, [...(required.get(capability) ?? []), detail]); };
  const seats = (tribunal: string, items: SeatSpec[], tiebreaker?: SeatSpec): void => {
    for (const seat of [...items, ...(tiebreaker ? [tiebreaker] : [])]) need(seat.capability, stepDetail(routineSeatLabel(tribunal, seat.name), seat.prompt, seat.sovereignty));
  };
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    if (typeof step === "string") continue;
    if ("agent" in step) {
      if (step.agent.federate || (step.agent.distribution_mode && step.agent.distribution_mode !== "offer")) throw new UnbuildableRoutineError("This routine needs a targeted or federated agent that the local presence check cannot verify. A targeted or federated agent is not a local capability, so a build node cannot supply it.");
      need(step.agent.capability, stepDetail(routineStepLabels([step])[0] ?? step.agent.name, step.agent.prompt, step.agent.sovereignty));
    }
    else if ("tribunal" in step) seats(step.tribunal.name, step.tribunal.seats, step.tribunal.tiebreaker);
    else if ("gate" in step || "research" in step) throw new UnbuildableRoutineError(`This routine needs a gate or research provider that pulse-flow does not have configured. ${GATE_UNBUILDABLE}`);
    else if ("governed" in step) {
      if (step.governed.gate) throw new UnbuildableRoutineError(`This routine needs a gate provider that pulse-flow does not have configured. ${GATE_UNBUILDABLE}`);
      if (step.governed.tribunal) seats(step.governed.name, step.governed.tribunal.seats, step.governed.tribunal.tiebreaker);
    } else if ("parallel" in step) queue.push(...Object.values(step.parallel.branches).flatMap((b) => b.actions));
    else if ("map" in step) queue.push(...step.map.actions);
    else if ("filter" in step) queue.push(...step.filter.actions);
    else if ("reduce" in step) queue.push(...step.reduce.actions);
    else if ("retry" in step) queue.push(...step.retry.actions);
    else { const exhaustive: never = step; throw new Error(`Unsupported routine step: ${String(exhaustive)}`); }
  }
  const available = capabilities();
  const missing = [...required].filter(([capability]) => !available.has(capability)).map(([capability, details]): MissingCapability => ({ capability, steps: details }));
  if (missing.length) throw new MissingCapabilitiesError(missing);
  return [...required.keys()];
}
