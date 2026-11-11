import { DESK_ADAPTER_FRAMES_PATH, OpenFrameSchema } from "../desk/adapter-frame-contract";
import { DESK_UI_MAX_MESSAGE_BYTES } from "../desk/adapter-frame-protocol";
import type { AdapterFrameHost } from "../desk/adapter-frame-host";
import { fail, notAllowed, reply } from "./conversations";
import { stackPrincipalOf } from "./desk-connections";
import type { MutationGuardContext } from "./mutation-guard";

export type AdapterFrameAccess = () => AdapterFrameHost | null;

export async function handleDeskAdapterFrames(req: Request, url: URL, guard: MutationGuardContext, access?: AdapterFrameAccess): Promise<Response> {
  const principal = await stackPrincipalOf(req, guard);
  if (principal instanceof Response) return principal;
  const service = access?.();
  if (!service) return fail(503, "Adapter views are unavailable on this stack.");
  if (url.search) return fail(400, "Adapter view routes take no query string.");
  const audience = guard.isLoopback ? "local" : "cloud";
  const instance = /^\/api\/desk\/adapters\/frames\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
  try {
    if (instance && req.method === "DELETE") { service.close(principal, instance); return reply(200, { ok: true }); }
    if (instance && req.method === "GET") return reply(200, await service.exchange(principal, audience, instance));
    if (req.method !== "POST") return notAllowed(instance ? "GET, POST, DELETE" : "POST");
    const reader = req.body?.getReader();
    if (!reader) return fail(400, "A view request is required.");
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > DESK_UI_MAX_MESSAGE_BYTES) {
          await reader.cancel();
          if (instance) service.close(principal, instance);
          return fail(413, "The view request is too large.");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const body: unknown = JSON.parse(text);
    if (url.pathname === DESK_ADAPTER_FRAMES_PATH) {
      const parsed = OpenFrameSchema.safeParse(body);
      if (!parsed.success) return fail(400, "The view identity is invalid.");
      return reply(200, await service.open(principal, audience, parsed.data.mountId, parsed.data.instance));
    }
    return instance ? reply(200, await service.exchange(principal, audience, instance, body)) : fail(404, "Unknown adapter view route.");
  } catch (error) {
    if (instance) service.close(principal, instance);
    process.stderr.write(`desk adapter frame: ${error instanceof SyntaxError ? "invalid_json" : "view_unavailable"}\n`);
    return fail(409, "The adapter view is unavailable. Safe host status and history are retained.");
  }
}
