import { z } from "zod/v4";
import { formatGraphNodeRef, formatGraphRepoRef, graphReadScope, parseGraphNodeRef, parseGraphRepoRef, permitsGraphRead } from "../graph-ref";

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
export const ProjectSchema = z.object({
  id: z.string().regex(new RegExp(`^${PROJECT_ID}$`), "mc.desk.conversations.tools project id must be lower-case letters, digits and dashes"),
  root: z.string().trim().min(1).max(1024).refine(root => root.startsWith("/") || root.startsWith("~/"), "project root must be absolute or home-relative"),
  forge: z.object({ kind: z.enum(["github", "gitlab"]), host: z.string().max(253).regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/).optional(), repo: z.string().max(300).regex(/^[\w.-]+(?:\/[\w.-]+)+$/).refine(repo => !repo.split("/").some(part => part === "." || part === ".."), "forge repository must identify a repository") }).strict().optional(),
  policy: z.enum(["local", "cloud"]).default("local"),
  operations: z.array(z.enum(TOOL_OPERATIONS)).max(TOOL_OPERATIONS.length).default([]),
  exclude: z.array(z.string().min(1).max(512).refine(path => !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => part === ".." || part === "." || part === "") && !path.includes("\0"), "excluded paths must be project-relative file or directory prefixes")).max(100).optional(),
}).strict();
export type ToolProject = z.infer<typeof ProjectSchema>;
export const WEB_LIMIT_DEFAULTS = { maxResults: 5, maxBytes: 1_000_000, maxRedirects: 5, timeoutSeconds: 15, maxChars: 12_000 };
const WebSchema = z.object({
  search: z.object({
    kind: z.enum(["searxng", "brave"]),
    url: z.string().max(500).refine(value => /^https?:\/\/[^\s/]+(?:\/\S*)?$/.test(value), "mc.desk.conversations.tools.web.search.url must be an http(s) URL"),
    policy: z.enum(["local", "cloud"]).default("cloud"),
    apiKeyEnv: z.string().regex(/^[A-Za-z_]\w*$/).max(100).optional(),
  }).strict().optional(),
  limits: z.object({
    maxResults: z.number().int().min(1).max(10).default(WEB_LIMIT_DEFAULTS.maxResults),
    maxBytes: z.number().int().min(10_000).max(5_000_000).default(WEB_LIMIT_DEFAULTS.maxBytes),
    maxRedirects: z.number().int().min(0).max(10).default(WEB_LIMIT_DEFAULTS.maxRedirects),
    timeoutSeconds: z.number().int().min(1).max(60).default(WEB_LIMIT_DEFAULTS.timeoutSeconds),
    maxChars: z.number().int().min(500).max(40_000).default(WEB_LIMIT_DEFAULTS.maxChars),
  }).strict().default(WEB_LIMIT_DEFAULTS),
}).strict();
export type WebConfig = z.infer<typeof WebSchema>;
const GraphRepoRefSchema = z.string().trim().min(5).max(300).transform((text, context) => {
  const repo = parseGraphRepoRef(text);
  if (!repo) { context.addIssue({ code: "custom", message: "graph read scopes must be qualified forge refs such as github:github.com/owner/name" }); return z.NEVER; }
  return formatGraphRepoRef(repo);
});
const GraphNamespaceSchema = z.string().trim().min(5).max(300).transform((text, context) => {
  const repo = parseGraphRepoRef(text);
  if (repo?.forge !== "gitlab") { context.addIssue({ code: "custom", message: "graph read namespaces must be qualified GitLab refs such as gitlab:gitlab.example.org/group" }); return z.NEVER; }
  return formatGraphRepoRef(repo);
});
const GraphMapSchema = z.object({
  id: z.string().regex(new RegExp(`^${PROJECT_ID}$`), "mc.desk.conversations.tools graph map id must be lower-case letters, digits and dashes"),
  ref: z.string().trim().min(5).max(300).transform((text, context) => {
    const ref = parseGraphNodeRef(text);
    if (!ref) { context.addIssue({ code: "custom", message: "graph map roots must be qualified node refs such as github:github.com/owner/name#12" }); return z.NEVER; }
    return formatGraphNodeRef(ref);
  }),
  label: z.string().trim().min(1).max(100).optional(),
}).strict();
const GraphReadSchema = z.object({
  repos: z.array(GraphRepoRefSchema).max(50).default([]),
  namespaces: z.array(GraphNamespaceSchema).max(50).default([]),
}).strict().refine(read => read.repos.length + read.namespaces.length > 0, "mc.desk.conversations.tools graphs read scope must permit at least one repository or namespace");
const GraphSchema = z.object({
  id: z.string().regex(new RegExp(`^${PROJECT_ID}$`), "mc.desk.conversations.tools graph id must be lower-case letters, digits and dashes"),
  policy: z.enum(["local", "cloud"]).default("local"),
  maps: z.array(GraphMapSchema).min(1).max(100).refine(maps => new Set(maps.map(map => map.id)).size === maps.length, "mc.desk.conversations.tools graph map ids must be unique").refine(maps => new Set(maps.map(map => map.ref.toLowerCase())).size === maps.length, "mc.desk.conversations.tools graph map roots must be unique"),
  read: GraphReadSchema,
}).strict().superRefine((graph, context) => {
  const scope = graphReadScope(graph.read);
  for (const map of graph.maps) {
    const ref = parseGraphNodeRef(map.ref);
    if (ref && !permitsGraphRead(scope, ref.repo)) context.addIssue({ code: "custom", path: ["maps"], message: `graph map ${map.id} is outside the configured read scope` });
  }
});
export type GraphMap = z.infer<typeof GraphMapSchema>;
export type GraphSource = z.infer<typeof GraphSchema>;
const ToolsSchema = z.object({
  web: WebSchema.optional(),
  projects: z.array(ProjectSchema).max(50).default([]).refine(projects => new Set(projects.map(project => project.id)).size === projects.length, "mc.desk.conversations.tools project ids must be unique"),
  graphs: z.array(GraphSchema).max(20).optional().refine(graphs => !graphs || new Set(graphs.map(graph => graph.id)).size === graphs.length, "mc.desk.conversations.tools graph ids must be unique"),
}).strict().refine(tools => !tools.graphs || new Set([...tools.projects.map(project => project.id), ...tools.graphs.map(graph => graph.id)]).size === tools.projects.length + tools.graphs.length, "mc.desk.conversations.tools project and graph ids must be unique across sources");
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
