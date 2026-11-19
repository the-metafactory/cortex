import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { writeStudioLook } from "../desk/studio/look";
import { typedJson } from "../desk/typed-response";
import type { StudioLookResponse } from "../../../desk-api";

const headers = { "Cache-Control": "no-store" };
const answer = (body: StudioLookResponse, status = 200): Response => typedJson(body, { status, headers });

export function handleDeskStudioLook(req: Request, db: Database, runtime: DeskRuntime | undefined, now: () => number = Date.now): Response {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "POST" } });
  const at = now();
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return answer({ ok: false, error: "The Studio is not set up on this stack." }, 409);
  const scope = desk.routineScope;
  if (!scope) return answer({ ok: false, error: "The principal and stack are not set up on this stack." }, 409);
  writeStudioLook(db, scope, at);
  return answer({ ok: true, at });
}
