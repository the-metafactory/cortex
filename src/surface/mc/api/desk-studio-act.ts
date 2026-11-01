import type { Database } from "bun:sqlite";
import { readStudioMyDay } from "../desk/studio-my-day";
import type { RangerRunner } from "../desk/actions";
import { readStudioFiles } from "../desk/studio/read";
import { buildStudioView } from "../desk/studio/view";
import { enqueueSparring, withThinking } from "../desk/studio/thinking";
import type { DeskRuntime } from "../desk/compose";
import { StudioActSchema } from "../desk/studio/acts";
import type { GitRunner } from "../desk/studio/git";
import { runStudioAct, STUDIO_REQUEST_ID, type StudioWriteLock } from "../desk/studio/writer";

const answer = (status: number, body: Record<string, unknown>): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response => answer(status, { ok: false, error, ...extra });

export interface DeskStudioActDeps {
  db?: Database;
  run?: RangerRunner;
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
  if (parsed.data.act === "spar") {
    const { files, problems } = await readStudioFiles(desk.studio.dir);
    const studio = buildStudioView(files, desk.studio, desk.areas, problems);
    const result = await enqueueSparring({ studio, dir: desk.studio.dir, cli: desk.rangerCli, act: parsed.data, requestId: body.requestId, ...(deps.run ? { run: deps.run } : {}) });
    if (!result.ok) return fail(result.status, result.error);
    return answer(200, { ...result, studio: await withThinking(studio, desk.studio.dir, desk.rangerCli, deps.run) });
  }
  try {
    if (deps.db) await readStudioMyDay(deps.db, desk, deps.now?.().getTime() ?? Date.now(), true);
  } catch {
    return fail(409, "Studio is busy or unreadable. Nothing was written; retry when its files are ready.");
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
  try {
    if (deps.db) await readStudioMyDay(deps.db, desk, deps.now?.().getTime() ?? Date.now());
  } catch {
    return answer(200, { ...result, projection: "pending", studio: result.studio });
  }
  return answer(200, { ...result, studio: await withThinking(result.studio, desk.studio.dir, desk.rangerCli, deps.run) });
}
