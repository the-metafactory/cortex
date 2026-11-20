import type { DeskRuntime } from "../desk/compose";
import { assistantNameOf } from "../desk/assistant-name";
import { STUDIO_SLUG } from "../desk/studio/format";
import type { DraftInput } from "../desk/studio/draft-read";

export function studioDraftInput(runtime: DeskRuntime | undefined, thread: string): DraftInput | { error: string; status: number } {
  if (!STUDIO_SLUG.test(thread) || /[\r\n]/.test(thread)) return { error: "Invalid Studio thread slug.", status: 400 };
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return { error: "The Studio is not set up on this stack.", status: 409 };
  return { options: desk.studio, areas: desk.areas, assistantName: assistantNameOf(desk), thread };
}
