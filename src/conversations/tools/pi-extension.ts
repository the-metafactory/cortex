interface Spec { name: string; description: string; schema: object }
interface Reply { outcome: string; text: string }
interface PiExtension {
  registerTool(tool: { name: string; label: string; description: string; parameters: object; execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: { type: "text"; text: string }[]; details: Reply }> }): void;
  on(event: "before_provider_request", handler: () => Promise<void>): void;
}

export default async function conversationTools(pi: PiExtension): Promise<void> {
  const endpoint = process.env.CORTEX_TOOL_ENDPOINT;
  const token = process.env.CORTEX_TOOL_TOKEN;
  if (!endpoint || !token) process.exit(77);
  const call = async <T>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
    try {
      const response = await fetch(`${endpoint}/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
      if (!response.ok) process.exit(77);
      return await response.json() as T;
    } catch {
      process.exit(77);
    }
  };
  const specs = await call<Spec[]>("catalog");
  pi.on("before_provider_request", async () => { await call("check"); });
  for (const spec of specs) pi.registerTool({
    name: spec.name, label: spec.name, description: spec.description, parameters: spec.schema,
    execute: async (id, input, signal) => {
      const result = await call<Reply>("call", { id, name: spec.name, input }, signal);
      return { content: [{ type: "text", text: result.text }], details: result };
    },
  });
}
