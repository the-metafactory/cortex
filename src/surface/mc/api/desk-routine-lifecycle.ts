import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { inspectRoutineLifecycle, previewRoutineLifecycle } from "../desk/routine-lifecycle";
import { LifecyclePreviewRequestSchema } from "../desk/routine-lifecycle-contract";
import { handleRoutineRead } from "./desk-routine-read";

export function handleDeskRoutineLifecycle(req: Request, runtime: DeskRuntime | undefined, run?: RoutineRunner): Promise<Response> {
  return handleRoutineRead(req, runtime, { request: LifecyclePreviewRequestSchema, id: LifecyclePreviewRequestSchema.shape.id,
    description: "Provide the installed revision and paused state.",
    inspect: (options, id) => inspectRoutineLifecycle(options, id, run), preview: (options, input) => previewRoutineLifecycle(options, input, run),
  });
}
