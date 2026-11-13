import type { Database } from "bun:sqlite";
import { composeCurrentDay, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { STUDIO_SLUG } from "../desk/studio/format";
import { findThread, proposedRelations } from "../desk/studio/page";
import { readStudioFiles } from "../desk/studio/read";
import { NO_CONTEXT, relatesContext, relatesTo, type RelatesContext, type RelatesDay } from "../desk/studio/relates";
import { buildStudioView } from "../desk/studio/view";

const noStore = { "Cache-Control": "no-store" };

export type RelationsContext = "complete" | "studio-only";

export interface StudioRelationsDeps {
  now?: number;
  composeDay?: () => Promise<RelatesDay>;
}

async function readDay(compose: () => Promise<RelatesDay>, now: number): Promise<{ ctx: RelatesContext; context: RelationsContext }> {
  try {
    return { ctx: relatesContext(await compose()), context: "complete" };
  } catch (err) {
    process.stderr.write(`[desk-studio-relations] serving Studio-only relations, the Desk could not be composed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { ctx: { ...NO_CONTEXT, now }, context: "studio-only" };
  }
}

export async function handleGetDeskStudioRelations(req: Request, db: Database, runtime: DeskRuntime | undefined, vigil: DeskVigilSource | undefined, deps: StudioRelationsDeps = {}): Promise<Response> {
  const desk = runtime?.options;
  if (!runtime || !desk?.enabled || !desk.studio) return Response.json({ relations: null }, { headers: noStore });
  const slug = new URL(req.url).searchParams.get("thread") ?? "";
  if (!STUDIO_SLUG.test(slug)) return Response.json({ error: "Name a Studio thread by its slug." }, { status: 400, headers: noStore });
  const { files, problems } = await readStudioFiles(desk.studio.dir);
  const studio = buildStudioView(files, desk.studio, desk.areas, problems);
  const thread = findThread(studio, slug);
  if (!thread) return Response.json({ error: "No Studio thread has this slug." }, { status: 404, headers: noStore });
  const now = deps.now ?? Date.now();
  const { ctx, context } = await readDay(deps.composeDay ?? (() => composeCurrentDay(db, runtime, desk, vigil, now)), now);
  return Response.json({
    thread: slug,
    generatedAt: ctx.now,
    relations: relatesTo(thread, studio, ctx),
    proposed: proposedRelations(thread),
    context,
  }, { headers: noStore });
}
