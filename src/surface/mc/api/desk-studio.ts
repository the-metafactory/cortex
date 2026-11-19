import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import type { RangerRunner } from "../desk/actions";
import { withThinking } from "../desk/studio/thinking";
import { readStudioFiles } from "../desk/studio/read";
import { buildStudioView } from "../desk/studio/view";
import { assistantNameOf } from "../desk/assistant-name";
import { buildMaterialSourceIndex, buildThreadFacts } from "../desk/studio/thread-facts";
import { buildBoardFacts } from "../desk/studio/board";
import { readStudioLook } from "../desk/studio/look";
import type { StudioThreadView } from "../desk/studio/view";
import { typedJson } from "../desk/typed-response";
import type { DeskApiRouteTypes, DeskStudioThread, TypedResponse } from "../../../desk-api";

const noStore = { "Cache-Control": "no-store" };

export async function handleGetDeskStudio(runtime: DeskRuntime | undefined, run?: RangerRunner, deps: { db?: Database; now?: () => number } = {}): Promise<TypedResponse<DeskApiRouteTypes["GET /api/desk/studio"]["response"]>> {
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return typedJson({ studio: null }, { headers: noStore });
  const now = deps.now?.() ?? Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const lastLook = deps.db && desk.routineScope ? readStudioLook(deps.db, desk.routineScope) : null;
  const { files, problems } = await readStudioFiles(desk.studio.dir);
  const studio = await withThinking(buildStudioView(files, desk.studio, desk.areas, problems, assistantNameOf(desk)), desk.studio.dir, desk.rangerCli, run);
  const alsoFor = buildMaterialSourceIndex(studio);
  const each = (threads: StudioThreadView[]): DeskStudioThread[] => threads.map(thread => {
    const { derived, material } = buildThreadFacts(studio, thread, alsoFor);
    return { ...thread, derived, material };
  });
  const board = buildBoardFacts(studio, { now, startOfToday: today.getTime(), lastLook });
  return typedJson({ directory: desk.studio.dir, studio: { ...studio, board, active: each(studio.active), parked: each(studio.parked), closed: each(studio.closed) }, materialText: "untrusted" as const }, { headers: noStore });
}
