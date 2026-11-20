import type { DeskRuntime } from "../desk/compose";
import { studioDraftInput } from "./desk-studio-draft-input";
import { readStudioSnapshots, STUDIO_SNAPSHOT_ID } from "../desk/studio/draft-snapshots";
import { withStudioLock } from "../desk/studio/writer";
import type { DeskStudioDraftSnapshotResponse, DeskStudioDraftSnapshotsResponse, TypedResponse } from "../../../desk-api";
import { typedJson } from "../desk/typed-response";

type SnapshotResponse = DeskStudioDraftSnapshotResponse | DeskStudioDraftSnapshotsResponse;
const answer = (body: SnapshotResponse, status = 200): TypedResponse<SnapshotResponse> => typedJson(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleDeskStudioDraftSnapshots(req: Request, runtime: DeskRuntime | undefined, thread: string, snapshot?: string): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (snapshot !== undefined && !STUDIO_SNAPSHOT_ID.test(snapshot)) return answer({ error: "Invalid Studio thread or snapshot id." }, 400);
  const input = studioDraftInput(runtime, thread);
  if ("error" in input) return answer({ error: input.error }, input.status);
  try {
    const result = await withStudioLock(input, () => readStudioSnapshots(input, snapshot), true);
    return result.ok ? answer(result.body) : answer({ error: result.error }, result.status);
  } catch (error) {
    process.stderr.write(`[desk-studio-snapshots] ${error instanceof Error ? error.message : String(error)}\n`);
    return answer({ error: "The Studio snapshots could not be read. Retry when their files are ready." }, 500);
  }
}
