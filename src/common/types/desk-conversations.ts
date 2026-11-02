import { z } from "zod/v4";

export const PI_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_SOMA_TOOLS = ["soma_context"] as const;
export const PI_READ_TOOLS = [...PI_FILE_TOOLS, ...PI_SOMA_TOOLS] as const;
export type PiReadTool = (typeof PI_READ_TOOLS)[number];
export const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
    bin: z.string().default(""),
    extensions: z.array(z.string().min(1)).max(10).optional(),
    tools: z.array(z.enum(PI_READ_TOOLS)).max(PI_READ_TOOLS.length).default([...PI_READ_TOOLS]),
    timeoutSeconds: z.number().int().min(10).max(1800).default(300),
  }).strict().default({ bin: "", tools: [...PI_READ_TOOLS], timeoutSeconds: 300 }),
}).strict();
export type DeskConversations = z.infer<typeof DeskConversationsSchema>;
