import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import type { ToolSurface, TurnRequest } from "../model";

const Call = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(64), input: z.unknown() }).strict();
const MAX_INPUT_BYTES = 64_000;
export function piToolBridge(surface: ToolSurface, signal: AbortSignal, halt: (reason: string) => void, started?: TurnRequest["started"]): { env: Record<string, string>; called: Set<string>; close: () => Promise<void> } {
  const token = randomBytes(32).toString("hex");
  const called = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_INPUT_BYTES,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}` || request.headers.has("origin")) return new Response(null, { status: 403 });
      const path = new URL(request.url).pathname;
      try {
        if (signal.aborted) return new Response(null, { status: 410 });
        if (request.method === "GET" && path === "/catalog") { await surface.validate(); return Response.json(surface.specs); }
        if (request.method === "GET" && path === "/check") { await surface.validate(); return Response.json({ allowed: true }); }
        if (request.method !== "POST" || path !== "/call") return new Response(null, { status: 404 });
        const raw = await request.text();
        if (raw.length > MAX_INPUT_BYTES) return new Response(null, { status: 413 });
        const parsed = Call.safeParse(JSON.parse(raw));
        if (!parsed.success) return new Response(null, { status: 400 });
        const { id, name, input } = parsed.data;
        if (called.has(id)) return new Response(null, { status: 409 });
        called.add(id);
        if (surface.specs.some(spec => spec.name === name)) await started?.(id, name);
        const call = surface.call(id, name, input, signal);
        pending.add(call);
        try { return Response.json(await call); }
        finally { pending.delete(call); }
      } catch {
        halt("Conversation tool authority could not be verified; the turn was stopped");
        return new Response(null, { status: 403 });
      }
    },
  });
  return { env: { CORTEX_TOOL_ENDPOINT: `http://127.0.0.1:${server.port}`, CORTEX_TOOL_TOKEN: token }, called, close: async () => { await server.stop(true); await Promise.allSettled([...pending]); } };
}
