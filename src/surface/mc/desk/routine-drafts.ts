import { parse as parseYaml } from "yaml";
import { validateSteps } from "pulse";
import { z } from "zod";
import type { DeskProposal } from "./ask";
import { MissingCapabilitiesError, requireRoutineCapabilities, type RoutineCapabilities } from "./routine-providers";
import { routineSchedule, type RoutineSchedule } from "./routine-schedule";
import { routineStepLabels } from "./routine-steps";
import { routineConfigHash, type RoutineProposal } from "./routine-store";
import type { RoutineOptions } from "./routine-command";
import type { MissingCapability } from "./routine-capability-contract";

export const RoutineFlowDocument = z.object({ name: z.string().min(1), actions: z.array(z.unknown()).min(1), input: z.record(z.string(), z.unknown()).optional() });

export function routineProposalCard(proposal: RoutineProposal, clock: RoutineSchedule["clock"]): DeskProposal {
  return { kind: "routine", label: "Routine", fields: { proposalId: proposal.id, title: proposal.title, schedule: clock === "elapsed" ? proposal.words : `${proposal.words} (${proposal.timezone})`, steps: proposal.steps }, via: "rules" };
}

export function retryRoutineDraft(proposal: RoutineProposal, options: RoutineOptions, capabilities: RoutineCapabilities): { proposal?: DeskProposal; missing: MissingCapability[]; error?: string } {
  try {
    if (!proposal.draft) throw new Error("This routine draft is no longer available.");
    if (proposal.configHash !== routineConfigHash(options)) throw new Error("The Desk configuration changed. Ask for the routine again.");
    const steps = validateSteps(RoutineFlowDocument.parse(parseYaml(proposal.yaml)).actions);
    requireRoutineCapabilities(steps, capabilities);
    const schedule = routineSchedule(proposal.draft.text);
    if (typeof schedule === "string") throw new Error(schedule);
    return { proposal: routineProposalCard({ ...proposal, steps: routineStepLabels(steps) }, schedule.clock), missing: [] };
  } catch (error) {
    if (error instanceof MissingCapabilitiesError) return { missing: error.missing };
    return { missing: [], error: `The routine could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  }
}
