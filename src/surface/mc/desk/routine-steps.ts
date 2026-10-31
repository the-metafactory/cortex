import type { PipelineStep } from "pulse";

const words = (name: string): string => name.replace(/^A_/, "").replaceAll(/[_-]/g, " ").toLowerCase();
const together = (steps: PipelineStep[]): string => routineStepLabels(steps).join(", then ");

export function routineStepLabels(steps: PipelineStep[]): string[] {
  return steps.map((step): string => {
    if (typeof step === "string") return words(step);
    if ("agent" in step) return `Ask an agent to ${words(step.agent.name)}`;
    if ("tribunal" in step) return `Ask reviewers to ${words(step.tribunal.name)}`;
    if ("map" in step) return `For each ${words(step.map.over)}: ${together(step.map.actions)}`;
    if ("filter" in step) return `Choose matching ${words(step.filter.over)}: ${together(step.filter.actions)}`;
    if ("reduce" in step) return `Combine ${words(step.reduce.over)}: ${together(step.reduce.actions)}`;
    if ("parallel" in step) return `In parallel: ${Object.entries(step.parallel.branches).map(([name, branch]) => `${words(name)} — ${together(branch.actions)}`).join("; ")}`;
    if ("retry" in step) return `Try up to ${step.retry.attempts} times: ${together(step.retry.actions)}`;
    if ("governed" in step) return `Check the policy for ${words(step.governed.name)}`;
    if ("gate" in step) return "Ask you to review the next step";
    if ("research" in step) return `Research ${words(step.research.name)}`;
    const exhaustive: never = step;
    throw new Error(`Unsupported routine step: ${String(exhaustive)}`);
  });
}
