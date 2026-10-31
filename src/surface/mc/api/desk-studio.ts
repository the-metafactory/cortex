import type { DeskRuntime } from "../desk/compose";
import { readStudioFiles } from "../desk/studio/read";
import { buildStudioView } from "../desk/studio/view";

const noStore = { "Cache-Control": "no-store" };

export async function handleGetDeskStudio(runtime: DeskRuntime | undefined): Promise<Response> {
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return Response.json({ studio: null }, { headers: noStore });
  const { files, problems } = await readStudioFiles(desk.studio.dir);
  return Response.json({ directory: desk.studio.dir, studio: buildStudioView(files, desk.studio, desk.areas, problems) }, { headers: noStore });
}
