import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { inspectRoutineSchedule, previewRoutineSchedule } from "../desk/routine-schedule-editor";
import { SchedulePreviewRequestSchema } from "../desk/routine-schedule-contract";

const headers = { "Cache-Control": "no-store" };
export async function handleDeskRoutineSchedule(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  const options = runtime?.options?.enabled ? runtime.options.routines : undefined;
  if (!options) return Response.json({ error: "Routines are not set up on this stack." }, { status: 409, headers });
  try {
    if (req.method === "GET") {
      const input = z.object({ id: SchedulePreviewRequestSchema.shape.id }).strict().safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!input.success) return Response.json({ error: "Choose an exact installed routine." }, { status: 400, headers });
      return Response.json(await inspectRoutineSchedule(options, input.data.id, run), { headers });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
    const input = SchedulePreviewRequestSchema.safeParse(await req.json().catch(() => null));
    if (!input.success) return Response.json({ error: "Provide the installed revision, schedule expression and stored timezone." }, { status: 400, headers });
    return Response.json(await previewRoutineSchedule(options, input.data, run), { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "The routine owner could not confirm this schedule." }, { status: 409, headers }); }
}
