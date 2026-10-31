import type { PipelineStep, SeatSpec } from "pulse";
import type { AgentPresenceView } from "../api/agents";

export type RoutineCapabilities = () => ReadonlySet<string>;

export function localRoutineCapabilities(presence: AgentPresenceView | null, now = Date.now()): ReadonlySet<string> {
  return new Set(presence?.getAgents().filter((a) => a.origin === "local" && a.state === "online" && now - a.lastSeenAt <= 90_000 && a.lastSeenAt <= now).flatMap((a) => [...a.capabilities]) ?? []);
}

export function requireRoutineCapabilities(steps: PipelineStep[], capabilities: RoutineCapabilities = () => new Set()): string[] {
  const required = new Set<string>();
  const queue = [...steps];
  const seats = (items: SeatSpec[], tiebreaker?: SeatSpec): void => { for (const seat of [...items, ...(tiebreaker ? [tiebreaker] : [])]) required.add(seat.capability); };
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    if (typeof step === "string") continue;
    if ("agent" in step) {
      if (step.agent.federate || (step.agent.distribution_mode && step.agent.distribution_mode !== "offer")) throw new Error("This routine needs a targeted or federated agent that the local presence check cannot verify.");
      required.add(step.agent.capability);
    }
    else if ("tribunal" in step) seats(step.tribunal.seats, step.tribunal.tiebreaker);
    else if ("gate" in step || "research" in step) throw new Error("This routine needs a gate or research provider that pulse-flow does not have configured.");
    else if ("governed" in step) {
      if (step.governed.gate) throw new Error("This routine needs a gate provider that pulse-flow does not have configured.");
      if (step.governed.tribunal) seats(step.governed.tribunal.seats, step.governed.tribunal.tiebreaker);
    } else if ("parallel" in step) queue.push(...Object.values(step.parallel.branches).flatMap((b) => b.actions));
    else if ("map" in step) queue.push(...step.map.actions);
    else if ("filter" in step) queue.push(...step.filter.actions);
    else if ("reduce" in step) queue.push(...step.reduce.actions);
    else if ("retry" in step) queue.push(...step.retry.actions);
    else { const exhaustive: never = step; throw new Error(`Unsupported routine step: ${String(exhaustive)}`); }
  }
  const available = capabilities();
  const missing = [...required].filter((c) => !available.has(c));
  if (missing.length) throw new Error(`No fresh online local agent provides ${missing.join(", ")}. This routine cannot run yet.`);
  return [...required];
}
