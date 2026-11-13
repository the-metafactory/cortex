import { z } from "zod";

export const DISPATCH_POLICIES = ["local", "cloud"] as const;
export type DispatchPolicy = (typeof DISPATCH_POLICIES)[number];

const DispatchAgentSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "mc.desk.dispatch.agents[].id must be an agent id (lowercase letters, digits and hyphens, starting with a letter)"),
  policy: z.enum(DISPATCH_POLICIES),
});

/** `mc.desk.dispatch`: the agents a Desk user can hand a Balance task to over the local bus, and how long the Desk waits. */
export const DeskDispatchSchema = z.strictObject({
  agents: z.array(DispatchAgentSchema).min(1).max(10).refine((agents) => new Set(agents.map((a) => a.id)).size === agents.length, "mc.desk.dispatch.agents names an agent twice"),
  startTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  runTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
});
export type DeskDispatchConfig = z.infer<typeof DeskDispatchSchema>;


const ParsedMcDispatch = z.object({ desk: z.object({ dispatch: DeskDispatchSchema }) });

/** The ids under `mc.desk.dispatch.agents` that name no agent in the stack's `agents` list. A block that failed its own parse reports nothing here. */
export function unknownDispatchAgents(mc: unknown, agentIds: ReadonlySet<string>): { index: number; id: string }[] {
  const parsed = ParsedMcDispatch.safeParse(mc);
  return parsed.success ? parsed.data.desk.dispatch.agents.flatMap((agent, index) => (agentIds.has(agent.id) ? [] : [{ index, id: agent.id }])) : [];
}
