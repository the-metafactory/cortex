import { z } from "zod";

export const DISPATCH_POLICIES = ["local", "cloud"] as const;
export type DispatchPolicy = (typeof DISPATCH_POLICIES)[number];

const DispatchAgentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "mc.desk.dispatch.agents[].id must be an agent id (lowercase letters, digits and hyphens, starting with a letter)"),
  policy: z.enum(DISPATCH_POLICIES),
});

/** `mc.desk.dispatch`: the agents the principal can hand a Balance task to over the local bus, and how long the Desk waits. */
export const DeskDispatchSchema = z.strictObject({
  agents: z.array(DispatchAgentSchema).min(1).max(10).refine((agents) => new Set(agents.map((a) => a.id)).size === agents.length, "mc.desk.dispatch.agents names an agent twice"),
  startTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  runTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
});
export type DeskDispatchConfig = z.infer<typeof DeskDispatchSchema>;


const ParsedMcDispatch = z.object({ desk: z.object({ dispatch: DeskDispatchSchema }) });

/**
 * The ids under `mc.desk.dispatch.agents` that name no agent of the stack. `agentIds` must be the merged list, inline `agents[]` plus the
 * agents.d fragments: the schema parse sees only the inline list, so this check runs after the merge, not as a schema refinement (cortex#1770).
 * A block that failed its own parse reports nothing here.
 */
export function unknownDispatchAgents(mc: unknown, agentIds: ReadonlySet<string>): { index: number; id: string }[] {
  const parsed = ParsedMcDispatch.safeParse(mc);
  return parsed.success ? parsed.data.desk.dispatch.agents.flatMap((agent, index) => (agentIds.has(agent.id) ? [] : [{ index, id: agent.id }])) : [];
}

/** The validate error for one unknown hand-off target, in the field-pathed shape `cortex config validate` prints. */
export function unknownDispatchAgentError({ index, id }: { index: number; id: string }): string {
  return `mc.desk.dispatch.agents.${index}.id: names "${id}", but no agent with that id is declared in agents[] or agents.d`;
}
