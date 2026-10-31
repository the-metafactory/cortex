import type { DeskRuntime } from "../desk/compose";
import { StudioActSchema } from "../desk/studio/acts";
import type { GitRunner } from "../desk/studio/git";
import { runStudioAct, STUDIO_REQUEST_ID, type StudioWriteLock } from "../desk/studio/writer";

const answer = (status: number, body: Record<string, unknown>): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => answer(status, { ok: false, error, ...extra });

export interface DeskStudioActDeps {
  git?: GitRunner;
  lock?: StudioWriteLock;
  now?: () => Date;
}

export async function handleDeskStudioAct(req: Request, runtime: DeskRuntime | undefined, deps: DeskStudioActDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return fail(409, "The Studio is not set up on this stack.");
  const body = (await req.json().catch(() => null)) as { requestId?: unknown } | null;
  if (typeof body?.requestId !== "string" || !STUDIO_REQUEST_ID.test(body.requestId)) return fail(400, "A request id is required.");
  const parsed = StudioActSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(400, issue ? `${issue.path.join(".") || "The request"} ${issue.message}` : "The request is not a Studio act.");
  }
  const result = await runStudioAct({
    options: desk.studio,
    areas: desk.areas,
    requestId: body.requestId,
    act: parsed.data,
    ...(deps.now ? { now: deps.now() } : {}),
    ...(deps.git ? { git: deps.git } : {}),
    ...(deps.lock ? { lock: deps.lock } : {}),
  });
  if (!result.ok) return fail(result.status, result.error, result.needsPark ? { needsPark: true } : {});
  return answer(200, result);
}
