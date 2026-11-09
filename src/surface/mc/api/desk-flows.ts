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

const read = async (options: { pulse: readonly string[] }, args: string[], run: WriterRunner): Promise<{ code: number; reply: unknown }> => {
  const result = await run([...options.pulse, ...args], "", 5_000);
  return { code: result.code, reply: JSON.parse(result.stdout) };
};

async function readSavedFlow(name: string, options: { pulse: readonly string[] }, run: WriterRunner): Promise<Response> {
  const { code, reply } = await read(options, ["flow", "show", name, "--json"], run);
  if (code === 1 && NotFound.safeParse(reply).success) return fail(404, "This saved flow was not found.");
  const found = Found.safeParse(reply);
  if (code !== 0 || !found.success || found.data.name !== name) return unreadable();
  if (found.data.source !== "saved") return fail(404, "This saved flow was not found.");
  return Response.json(SavedFlowDefinitionSchema.parse(found.data), { headers });
}

async function listSavedFlows(options: { pulse: readonly string[] }, routines: { target: string; timeZone: string } | undefined, run: WriterRunner): Promise<Response> {
  const { code, reply } = await read(options, ["flow", "list", "--saved", "--json"], run);
  const listed = Listed.safeParse(reply);
  if (code !== 0 || !listed.success) return unreadable();
  const flows = listed.data.flows.flatMap((flow) => flow.source === "saved" ? [{ name: flow.name, sha256: flow.sha256, savedAt: flow.provenance.saved_at, origin: flow.provenance.origin, conversationId: flow.provenance.conversation }] : []);
  flows.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  return Response.json(SavedFlowsSchema.parse({ flows, ...(routines ? { routine: { target: routines.target, timeZone: routines.timeZone } } : {}) }), { headers });
}

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
  try { return name ? await readSavedFlow(name, options, run) : await listSavedFlows(options, runtime?.options?.routines, run); }
  catch { return unreadable(); }
}
