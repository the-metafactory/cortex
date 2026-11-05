import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PiSettings } from "../../pi";

export interface ProviderRequest { model: string; tools?: { function: { name: string } }[]; messages: unknown[] }
export type ProviderStep = string | { id: string; name: string; input: object }[];
export async function toolProvider(dir: string, bin: string) {
  const requests: ProviderRequest[] = [];
  const steps: ProviderStep[] = [];
  const chunk = (delta: object, finish: string | null): string => `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "synthetic", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json() as ProviderRequest);
      const step = steps.shift() ?? "No further synthetic steps.";
      const delta = typeof step === "string" ? { role: "assistant", content: step } : { role: "assistant", tool_calls: step.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) };
      return new Response(`${chunk(delta, null)}${chunk({}, typeof step === "string" ? "stop" : "tool_calls")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const agent = join(dir, "agent");
  await mkdir(agent, { recursive: true });
  const model = (id: string) => ({ id, reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { synthetic: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "synthetic-unused", models: [model("local"), model("cloud")] } } }));
  const settings: PiSettings = { bin, extensions: [], tools: ["read", "grep", "find", "ls"], timeoutSeconds: 20, sessionDir: join(dir, "sessions"), cwd: dir, passEnv: [], env: { PI_CODING_AGENT_DIR: agent } };
  return { settings, requests, steps, close: () => server.stop(true) };
}
