import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { studioDraftInput } from "./desk-studio-draft-input";
import { getStudioDraft, saveStudioDraft, type DraftResult } from "../desk/studio/draft";
import { STUDIO_DRAFT_MAX_BYTES } from "../desk/studio/draft-format";
import { STUDIO_REQUEST_ID } from "../desk/studio/writer";
import type { DeskStudioDraftResponse, DeskStudioDraftWrite, TypedResponse } from "../../../desk-api";
import { typedJson } from "../desk/typed-response";

const WriteSchema = z.object({ text: z.string(), revision: z.string().min(1).max(256), requestId: z.string().regex(STUDIO_REQUEST_ID) }).strict();
void (true satisfies (z.infer<typeof WriteSchema> extends DeskStudioDraftWrite ? true : false));
const answer = (body: DeskStudioDraftResponse, status = 200): TypedResponse<DeskStudioDraftResponse> => typedJson(body, { status, headers: { "Cache-Control": "no-store" } });
const response = (result: DraftResult): TypedResponse<DeskStudioDraftResponse> => result.ok ? answer(result.draft) : answer(result, result.status);

export async function handleDeskStudioDraft(req: Request, runtime: DeskRuntime | undefined, thread: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } });
  const input = studioDraftInput(runtime, thread);
  if ("error" in input) return answer({ error: input.error }, input.status);
  try {
    if (req.method === "GET") return response(await getStudioDraft(input));
    const body: unknown = await req.json().catch(() => null);
    const parsed = WriteSchema.safeParse(body);
    if (!parsed.success) return answer({ error: "A text, revision and valid requestId are required." }, 400);
    if (Buffer.byteLength(parsed.data.text, "utf8") > STUDIO_DRAFT_MAX_BYTES) return answer({ error: "The Studio draft exceeds 1,048,576 UTF-8 bytes." }, 413);
    if (Buffer.from(parsed.data.text, "utf8").toString("utf8") !== parsed.data.text) return answer({ error: "Draft text must be valid Unicode." }, 400);
    return response(await saveStudioDraft({ ...input, ...parsed.data }));
  } catch (error) {
    process.stderr.write(`[desk-studio-draft] ${error instanceof Error ? error.message : String(error)}\n`);
    return answer({ error: "The Studio draft could not be read or written. Retry when its files are ready." }, 500);
  }
}
