import { z } from "zod/v4";

export const PI_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_SOMA_TOOLS = ["soma_context"] as const;
export const PI_READ_TOOLS = [...PI_FILE_TOOLS, ...PI_SOMA_TOOLS] as const;
export type PiReadTool = (typeof PI_READ_TOOLS)[number];
export const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PI_DEFAULTS = { bin: "", tools: [...PI_READ_TOOLS], timeoutSeconds: 300, passEnv: [] as string[] };

const LaneSchema = z.object({
  provider: z.string().trim().min(1).max(100).regex(/^[\w.-]+$/, "mc.desk.conversations lane provider must be a pi provider name"),
  model: z.string().trim().min(1).max(200).regex(/^[\w.:/-]+$/, "mc.desk.conversations lane model must be a pi model id"),
  thinking: z.enum(PI_THINKING).optional(),
}).strict();
export type ConversationLane = z.infer<typeof LaneSchema>;
export const LEGACY_CLOUD_ID = "cloud";
export const CLOUD_LANE_ID = "[a-z][a-z0-9-]{0,31}";
export const CloudLaneIdSchema = z.string().regex(new RegExp(`^${CLOUD_LANE_ID}$`), "mc.desk.conversations cloud lane id must be lower-case letters, digits and dashes");
const CloudLaneSchema = z.object({
  id: CloudLaneIdSchema,
  ...LaneSchema.shape,
}).strict();
export type CloudLane = z.infer<typeof CloudLaneSchema>;
const CloudSchema = z.union([
  LaneSchema,
  z.array(CloudLaneSchema).min(1).max(8).refine(lanes => new Set(lanes.map(lane => lane.id)).size === lanes.length, "mc.desk.conversations cloud lane ids must be unique"),
]);
export type CloudConfig = z.infer<typeof CloudSchema>;
export const cloudLanes = (cloud: CloudConfig | undefined): CloudLane[] => {
  if (!cloud) return [];
  return Array.isArray(cloud) ? cloud : [{ id: LEGACY_CLOUD_ID, ...cloud }];
};

export const TOOL_OPERATIONS = ["repo.read", "forge.read", "graph.read", "web.read"] as const;
export type ToolOperation = (typeof TOOL_OPERATIONS)[number];
export const PROJECT_ID = "[a-z][a-z0-9-]{0,63}";
const ProjectSchema = z.object({
  id: z.string().regex(new RegExp(`^${PROJECT_ID}$`), "mc.desk.conversations.tools project id must be lower-case letters, digits and dashes"),
  root: z.string().trim().min(1).max(1024),
  forge: z.object({ kind: z.enum(["github", "gitlab"]), host: z.string().trim().min(1).max(253).optional(), repo: z.string().trim().min(1).max(300) }).strict().optional(),
  policy: z.enum(["local", "cloud"]).default("local"),
  operations: z.array(z.enum(TOOL_OPERATIONS)).max(TOOL_OPERATIONS.length).default([]),
}).strict();
export type ToolProject = z.infer<typeof ProjectSchema>;
const ToolsSchema = z.object({
  projects: z.array(ProjectSchema).max(50).default([]).refine(projects => new Set(projects.map(project => project.id)).size === projects.length, "mc.desk.conversations.tools project ids must be unique"),
}).strict();
export type ToolsConfig = z.infer<typeof ToolsSchema>;

export const DeskConversationsSchema = z.object({
  tools: ToolsSchema.optional(),
  local: LaneSchema.optional(),
  cloud: CloudSchema.optional(),
  pi: z.object({
    bin: z.string().default(PI_DEFAULTS.bin),
    extensions: z.array(z.string().min(1)).max(10).optional(),
    tools: z.array(z.enum(PI_READ_TOOLS)).max(PI_READ_TOOLS.length).default(PI_DEFAULTS.tools),
    timeoutSeconds: z.number().int().min(10).max(1800).default(PI_DEFAULTS.timeoutSeconds),
    passEnv: z.array(z.string().regex(/^[A-Za-z_]\w*$/)).max(20).default(PI_DEFAULTS.passEnv),
  }).strict().default(PI_DEFAULTS),
  discord: z.object({
    channelId: z.string().regex(/^\d{5,25}$/, "mc.desk.conversations.discord.channelId must be a Discord channel id"),
    guildId: z.string().regex(/^\d{5,25}$/, "mc.desk.conversations.discord.guildId must be a Discord guild id"),
    webUrl: z.url({ protocol: /^https?$/ }),
    instance: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
}).strict();
export type DeskConversationsDiscord = NonNullable<z.infer<typeof DeskConversationsSchema>["discord"]>;
export type DeskConversations = z.infer<typeof DeskConversationsSchema>;
