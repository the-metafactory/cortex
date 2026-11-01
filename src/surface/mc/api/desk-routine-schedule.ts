import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { inspectRoutineSchedule, previewRoutineSchedule } from "../desk/routine-schedule-editor";
import { SchedulePreviewRequestSchema } from "../desk/routine-schedule-contract";
import { handleRoutineRead } from "./desk-routine-read";

export function handleDeskRoutineSchedule(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  return handleRoutineRead(req, runtime, { request: SchedulePreviewRequestSchema, id: SchedulePreviewRequestSchema.shape.id,
    description: "Provide the installed revision, schedule expression and stored timezone.",
    inspect: (options, id) => inspectRoutineSchedule(options, id, run), preview: (options, input) => previewRoutineSchedule(options, input, run),
  });
}
