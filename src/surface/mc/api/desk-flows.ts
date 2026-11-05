import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin, type WriterRunner } from "../desk/create";
import { DESK_FLOWS_PATH, FlowHashSchema, SavedFlowDefinitionSchema, SavedFlowNameSchema, SavedFlowsSchema } from "../desk/saved-flow-contract";

const headers = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers });
const unreadable = (): Response => fail(502, "Pulse could not read the saved flows.");
const Listed = z.object({ status: z.literal("ok"), flows: z.array(z.discriminatedUnion("source", [
  z.object({ source: z.literal("saved"), name: SavedFlowNameSchema, sha256: FlowHashSchema, provenance: z.object({ origin: z.enum(["conversation", "cli"]), conversation: z.string().min(1).nullable(), saved_at: z.iso.datetime({ offset: true }) }) }),
  z.object({ source: z.literal("arc") }),
])) });
const Found = SavedFlowDefinitionSchema.extend({ source: z.enum(["saved", "arc"]) });
const NotFound = z.object({ status: z.literal("not-found") });

export async function handleDeskFlows(req: Request, runtime: DeskRuntime | undefined, run: WriterRunner = spawnWithStdin): Promise<Response> {
  const options = runtime?.options?.enabled ? runtime.options.flows : undefined;
  if (!options) return fail(404, "Saved flows are not configured on this stack.");
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  const path = new URL(req.url).pathname;
  let name: string | undefined;
  if (path !== DESK_FLOWS_PATH) {
    try { name = decodeURIComponent(path.slice(DESK_FLOWS_PATH.length + 1)); }
    catch { return fail(400, "Provide a valid saved flow name."); }
    if (!SavedFlowNameSchema.safeParse(name).success) return fail(400, "Provide a valid saved flow name.");
  }
  try {
    const args = name ? ["flow", "show", name, "--json"] : ["flow", "list", "--saved", "--json"];
    const result = await run([...options.pulse, ...args], "", 5_000);
    const reply: unknown = JSON.parse(result.stdout);
    if (name) {
      if (result.code === 1 && NotFound.safeParse(reply).success) return fail(404, "This saved flow was not found.");
      const found = Found.safeParse(reply);
      if (result.code !== 0 || !found.success || found.data.name !== name) return unreadable();
      if (found.data.source !== "saved") return fail(404, "This saved flow was not found.");
      return Response.json(SavedFlowDefinitionSchema.parse(found.data), { headers });
    }
    const listed = Listed.safeParse(reply);
    if (result.code !== 0 || !listed.success) return unreadable();
    const flows = listed.data.flows.flatMap((flow) => flow.source === "saved" ? [{ name: flow.name, sha256: flow.sha256, savedAt: flow.provenance.saved_at, origin: flow.provenance.origin, conversationId: flow.provenance.conversation }] : []);
    flows.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    return Response.json(SavedFlowsSchema.parse({ flows }), { headers });
  } catch { return unreadable(); }
}
