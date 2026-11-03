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

export const DeskConversationsSchema = z.object({
  local: LaneSchema.optional(),
  cloud: LaneSchema.optional(),
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
