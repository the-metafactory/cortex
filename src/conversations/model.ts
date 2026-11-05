import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { cloudLanes, LEGACY_CLOUD_ID, type CloudConfig, type ConversationLane } from "../common/types/desk-conversations";
import { laneName, type ContinuationReason, type ModelRoute } from "./types";

export const CORTEX_PROVIDER = "cortex";
const API = "cortex-chat";
export const SESSION_PREFIX = "pi-session:";
export interface ChatTurn { role: "system" | "user" | "assistant"; content: string }
export type Lane = ConversationLane;
export interface Lanes { local?: Lane; cloud?: CloudConfig }
export interface RoutedLane { route: ModelRoute; lane: Lane }
export const cloudRoute = (id: string): ModelRoute => id === LEGACY_CLOUD_ID ? "cloud" : `cloud:${id}`;
export function routedLanes(lanes: Lanes): RoutedLane[] {
  const clouds = cloudLanes(lanes.cloud).map(({ id, ...lane }): RoutedLane => ({ route: cloudRoute(id), lane }));
  return [...(lanes.local ? [{ route: "local" as const, lane: lanes.local }] : []), ...clouds];
}
export const laneFor = (lanes: Lanes, route: ModelRoute): Lane | undefined => routedLanes(lanes).find(routed => routed.route === route)?.lane;
export type GateResult = { refused: string } | { conversationId: string; context: string | null };
export type RouteGate = (sessionId: string | undefined, route: ModelRoute) => Promise<GateResult>;

export interface ToolSource { id: string; revision: string; policy: "local" | "cloud"; registry?: string }
export interface ToolActivity { boundary?: "host"; source?: ToolSource; callId: string; tool: string; args: unknown; outcome: "done" | "error" | "refused" | "stopped"; result: string }
export type TurnEvent = { kind: "tool"; activity: ToolActivity } | { kind: "reconstructed"; route: ModelRoute; reason: Exclude<ContinuationReason, "lane-changed"> };
export interface ToolOutcome { source?: ToolSource; outcome: ToolActivity["outcome"]; text: string }
export interface ToolSpec { name: string; description: string; schema: object }
export interface ToolSurface { validate?: () => Promise<void>; specs: ToolSpec[]; call: (callId: string, name: string, input: unknown, signal: AbortSignal) => Promise<ToolOutcome> }
export type ToolSurfaceFor = (conversationId: string, route: ModelRoute, record: (activity: ToolActivity) => Promise<void>) => ToolSurface;
export interface TurnRequest {
  conversationId: string;
  route: ModelRoute;
  lane: Lane;
  instructions: string;
  prompt: string;
  linked: string | null;
  history: ChatTurn[];
  resume: string | null;
  session: string;
  signal: AbortSignal;
  activity: (activity: ToolActivity) => Promise<void>;
  tools?: ToolSurface;
}
export interface TurnReply { text: string; session: string; resumed: boolean }
export type TurnCall = (request: TurnRequest) => Promise<TurnReply>;
export type TurnRecorder = (conversationId: string, event: TurnEvent) => Promise<void>;

const textOf = (content: Message["content"]): string => typeof content === "string" ? content : content.map(part => {
  if (part.type === "text") return part.text;
  if (part.type === "toolCall") return `[tool call ${part.name}]`;
  return "";
}).filter(Boolean).join("\n");

export function chatTurns(messages: readonly Message[]): ChatTurn[] {
  return messages.flatMap((message): ChatTurn[] => {
    if (message.role === "toolResult") return [{ role: "user", content: `[tool result ${message.toolName}] ${textOf(message.content)}` }];
    const content = textOf(message.content);
    if (message.role === "system") {
      const sections = Object.values(message.sections ?? {}).filter((s): s is string => typeof s === "string");
      return [{ role: "system", content: [content, ...sections].filter(Boolean).join("\n\n") }];
    }
    return content ? [{ role: message.role, content }] : [];
  });
}

interface Plan { prompt: string; history: ChatTurn[]; resume: string | null; reason: ContinuationReason | null; answers: number }

export function planTurn(messages: readonly Message[], route: ModelRoute): Plan {
  const lastReply = messages.findLastIndex(m => m.role === "assistant" && m.stopReason !== "error");
  const asked = chatTurns(messages.slice(lastReply + 1).filter(m => m.role === "user")).map(t => t.content);
  const prompt = asked.filter((text, i) => asked.indexOf(text) === i).join("\n\n");
  const earlier = messages.slice(0, lastReply + 1).filter(m => m.role !== "system");
  const history = chatTurns(earlier);
  const answered = earlier.filter((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "error");
  const last = answered.at(-1);
  const previous = last?.responseId?.startsWith(SESSION_PREFIX) ? last.responseId.slice(SESSION_PREFIX.length) : null;
  let reason: ContinuationReason | null = null;
  if (!previous) reason = "engine-changed";
  else if (last?.model !== route) reason = "lane-changed";
  return { prompt, history, resume: last?.model === route ? previous : null, reason, answers: answered.length };
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function cortexModels(lanes: Lanes, gate: RouteGate, turn: TurnCall, record: TurnRecorder, instructions: string, tools?: ToolSurfaceFor): MutableModels {
  const routed = routedLanes(lanes);
  const models: Model<string>[] = routed.map(({ route, lane }) => ({ id: route, name: `${route} (${laneName(lane)})`, api: API, provider: CORTEX_PROVIDER, baseUrl: `pi:${lane.provider}`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 262_144, maxTokens: 32_768 }));
  const stream = (model: Model<string>, context: { messages: Message[] }, options?: { signal?: AbortSignal; sessionId?: string }) => {
    const out = createAssistantMessageEventStream();
    let base: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now() };
    void (async () => {
      try {
        const found = routed.find(candidate => candidate.route === model.id);
        if (!found) throw new Error(`no ${model.id} conversation model is configured`);
        const { route, lane } = found;
        base = { ...base, responseModel: laneName(lane) };
        const gated = await gate(options?.sessionId, route);
        if ("refused" in gated) throw new Error(gated.refused);
        const plan = planTurn(context.messages, route);
        if (!plan.prompt) throw new Error("the turn carries no new input");
        const surface = tools?.(gated.conversationId, route, activity => record(gated.conversationId, { kind: "tool", activity }));
        await surface?.validate?.();
        const reply = await turn({
          conversationId: gated.conversationId, route, lane, instructions, prompt: plan.prompt, linked: gated.context,
          history: plan.history, resume: surface ? null : plan.resume, session: `${gated.conversationId}.${route.replace(":", "-")}.${plan.answers}.${randomUUID().slice(0, 8)}`,
          signal: options?.signal ?? new AbortController().signal,
          activity: activity => record(gated.conversationId, { kind: "tool", activity }),
          ...(surface ? { tools: surface } : {}),
        });
        await surface?.validate?.();
        const released = await gate(options?.sessionId, route);
        if ("refused" in released) throw new Error(released.refused);
        const reason = reply.resumed || plan.history.length === 0 ? null : plan.reason ?? (surface ? "tool-policy" : "session-missing");
        if (reason && reason !== "lane-changed") await record(gated.conversationId, { kind: "reconstructed", route, reason });
        const message: AssistantMessage = { ...base, responseId: `${SESSION_PREFIX}${reply.session}`, content: [{ type: "text", text: reply.text }] };
        out.push({ type: "start", partial: { ...base } });
        out.push({ type: "done", reason: "stop", message });
        out.end(message);
      } catch (error) {
        const message: AssistantMessage = { ...base, stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
      }
    })();
    return out;
  };
  const registry = createModels();
  registry.setProvider(createProvider({
    id: CORTEX_PROVIDER,
    name: "Cortex conversation lanes",
    auth: { apiKey: { name: "pi provider configuration", resolve: () => Promise.resolve({ auth: {}, source: "mc.desk.conversations" }) } },
    models,
    api: { stream, streamSimple: stream },
  }));
  return registry;
}
