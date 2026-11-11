import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin, type WriterRunner } from "../desk/create";
import { FLOW_CARD_PATH } from "../desk/flow-surface-schema";
import type { FlowSurfaceAccess, FlowSurfaceReader } from "../desk/flow-surfaces";
import { DESK_FLOWS_PATH, FlowHashSchema, SavedFlowDefinitionSchema, SavedFlowNameSchema, SavedFlowsSchema } from "../../../conversations/saved-flow-contract";

const headers = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ error }, { status, headers });
const unreadable = (): Response => fail(502, "Pulse could not read the saved flows.");
const withheld = (): Response => fail(403, "This saved flow cannot be read through this connection.");
const NotConfigured = (): Response => fail(404, "Saved flows are not configured on this stack.");
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

async function readSavedFlow(name: string, options: { pulse: readonly string[] } | undefined, run: WriterRunner, reader: FlowSurfaceReader | null): Promise<Response> {
  const surface = reader === null ? null : await reader.definition(name);
  if (surface !== null) {
    if (!surface.enabled) return options === undefined ? NotConfigured() : await readLegacyFlow(name, options, run);
    if (surface.state === "unavailable") return fail(404, "This saved flow was not found.");
    if (surface.state === "withheld") return withheld();
    return Response.json(SavedFlowDefinitionSchema.parse({ name: surface.name, sha256: surface.sha256, yaml: surface.yaml }), { headers });
  }
  return options === undefined ? NotConfigured() : await readLegacyFlow(name, options, run);
}

async function readLegacyFlow(name: string, options: { pulse: readonly string[] }, run: WriterRunner): Promise<Response> {
  const { code, reply } = await read(options, ["flow", "show", name, "--json"], run);
  if (code === 1 && NotFound.safeParse(reply).success) return fail(404, "This saved flow was not found.");
  const found = Found.safeParse(reply);
  if (code !== 0 || !found.success || found.data.name !== name) return unreadable();
  if (found.data.source !== "saved") return fail(404, "This saved flow was not found.");
  return Response.json(SavedFlowDefinitionSchema.parse(found.data), { headers });
}

const routineOf = (routines: { target: string; timeZone: string } | undefined): { routine?: { target: string; timeZone: string } } =>
  routines ? { routine: { target: routines.target, timeZone: routines.timeZone } } : {};

const legacyFlows = (listed: z.infer<typeof Listed>, routines: { target: string; timeZone: string } | undefined) => {
  const flows = listed.flows.flatMap((flow) => flow.source === "saved" ? [{ name: flow.name, sha256: flow.sha256, savedAt: flow.provenance.saved_at, origin: flow.provenance.origin, conversationId: flow.provenance.conversation }] : []);
  flows.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  return { flows, ...routineOf(routines) };
};

async function listSavedFlows(options: { pulse: readonly string[] } | undefined, routines: { target: string; timeZone: string } | undefined, run: WriterRunner, reader: FlowSurfaceReader | null): Promise<Response> {
  const surface = reader === null ? null : await reader.list();
  if (surface?.enabled) return Response.json(SavedFlowsSchema.parse({ flows: surface.flows, ...routineOf(routines) }), { headers });
  if (options === undefined) return NotConfigured();
  const { code, reply } = await read(options, ["flow", "list", "--saved", "--json"], run);
  const listed = Listed.safeParse(reply);
  if (code !== 0 || !listed.success) return unreadable();
  return Response.json(SavedFlowsSchema.parse(legacyFlows(listed.data, routines)), { headers });
}

async function readSavedFlowCard(url: URL, reader: FlowSurfaceReader | null): Promise<Response> {
  if (reader === null) return Response.json({ enabled: false }, { headers });
  const ref = url.searchParams.get("ref") ?? "";
  const operation = url.searchParams.get("operation") ?? "";
  if (!SavedFlowNameSchema.safeParse(ref).success || operation.trim().length === 0 || operation.length > 256) return fail(400, "Provide a saved flow name and the operation that saved it.");
  return Response.json(await reader.card(ref, operation), { headers });
}

export async function handleDeskFlows(req: Request, runtime: DeskRuntime | undefined, run: WriterRunner = spawnWithStdin, access?: FlowSurfaceAccess): Promise<Response> {
  const options = runtime?.options?.enabled ? runtime.options.flows : undefined;
  const reader = access?.() ?? null;
  if (!options && reader === null) return NotConfigured();
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === FLOW_CARD_PATH) {
    try { return await readSavedFlowCard(url, reader); }
    catch { return unreadable(); }
  }
  let name: string | undefined;
  if (path !== DESK_FLOWS_PATH) {
    try { name = decodeURIComponent(path.slice(DESK_FLOWS_PATH.length + 1)); }
    catch { return fail(400, "Provide a valid saved flow name."); }
    if (!SavedFlowNameSchema.safeParse(name).success) return fail(400, "Provide a valid saved flow name.");
  }
  try { return name ? await readSavedFlow(name, options, run, reader) : await listSavedFlows(options, runtime?.options?.routines, run, reader); }
  catch { return unreadable(); }
}
