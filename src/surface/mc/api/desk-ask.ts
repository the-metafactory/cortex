import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { ASK_KINDS, notSetUp, parseByRules, parseWithCommand, taskMapAllowed, toProposal, validateCard, type ParserRunner } from "../desk/ask";
import { createFromCard, spawnWithStdin, writableKinds, type WriterRunner } from "../desk/create";
import { ParserPermissionsSchema } from "../../../common/types/desk-parser";
import { parserRoutingNotice } from "../desk/parser-routing";
import { effectivePolicy } from "../desk/studio/view";
import { listGrants } from "../desk/autonomy";
import { fileStudioCapture, undoStudioCapture, type CaptureModel } from "../desk/studio/capture";
import { STUDIO_REQUEST_ID } from "../desk/studio/writer";
import { closeNote } from "../desk/notes";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });
const MAX_TEXT = 1000;
const AskInputSchema = z.object({ text: z.string(), area: z.string().min(1).optional(), routing: ParserPermissionsSchema.optional() });
const CaptureUndoSchema = z.object({ id: z.string().regex(/^capture-[a-f0-9]{32}$/), requestId: z.string().regex(STUDIO_REQUEST_ID) });

export interface DeskAskDeps {
  runParser?: ParserRunner;
  runWriter?: WriterRunner;
  captureModel?: CaptureModel;
  now?: () => number;
  timeZone?: string;
}

const parserFrom = (run: WriterRunner): ParserRunner => async (argv, stdin, timeoutMs) => {
  const result = await run(argv, stdin, timeoutMs);
  if (result.code !== 0) throw new Error(`parser exited ${result.code}`);
  return result.stdout;
};

export async function handleDeskAsk(req: Request, runtime: DeskRuntime | undefined, deps: DeskAskDeps = {}, db?: Database): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const input = AskInputSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return fail(400, "Provide text and a valid area or provider restriction.");
  const body = input.data;
  const text = body.text.trim();
  if (!text) return fail(400, "Type what you want first.");
  if (text.length > MAX_TEXT) return fail(400, `That is longer than ${MAX_TEXT} characters.`);

  const now = (deps.now ?? Date.now)();
  const ask = desk.ask;
  const maps = ask?.taskMaps ?? [];
  const policy = effectivePolicy(body.area ? [body.area] : [], desk.areas);
  if (policy.unknown.length) return fail(400, "Choose an area configured on this Desk.");
  if ((body.routing || policy.policy === "local") && !ask?.routing) return fail(503, "This request needs provider restrictions. Ask the stack operator to set up routed parsing first.");
  const permitted = ask?.routing?.permitted.filter((p) => (!body.routing || body.routing.permitted.includes(p)) && (policy.policy !== "local" || p === "pi"));
  const routing = permitted ? { permitted } : undefined;
  const writable = writableKinds(ask?.writers ?? {}, Boolean(desk.studio));
  let result = null;
  let via: "parser" | "rules" = "rules";
  if (ask?.parser.length) {
    const request = { text, now: new Date(now).toISOString(), timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, kinds: [...ASK_KINDS], maps, ...(routing ? { routing } : {}) };
    result = await parseWithCommand(ask.parser, request, deps.runParser ?? parserFrom(spawnWithStdin), ask.timeoutSeconds * 1000);
    if (result) via = "parser";
  }
  if (routing && !ask?.parser.length) return fail(503, "Routed parsing has no parser command. Ask the stack operator to configure it.");
  result ??= parseByRules(text, { now, maps });
  const selected = "routing" in result ? result.routing : undefined;
  if (result.kind === "none") return Response.json({ ok: false, error: selected?.kind === "unavailable" ? parserRoutingNotice(selected) : selected ? `${parserRoutingNotice(selected)} ${result.reason}` : result.reason, ...(selected ? { routing: selected } : {}) }, { status: selected?.kind === "unavailable" ? 503 : 422, headers: noStore });
  const proposal = toProposal(result.kind, result.fields, writable, via);
  if (selected?.kind === "selected") proposal.routing = selected;
  if (!selected && result.kind === "capture" && db && listGrants(db).has("studio.capture")) proposal.automatic = true;
  return Response.json({ ok: true, proposal }, { headers: noStore });
}

export async function handleDeskCreate(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskAskDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled || !runtime) return fail(409, "The Desk is turned off on this stack.");
  const body = (await req.json().catch(() => null)) as { requestId?: unknown; kind?: unknown; fields?: unknown } | null;
  const requestId = typeof body?.requestId === "string" && /^[\w-]{8,64}$/.test(body.requestId) ? body.requestId : null;
  if (!requestId) return fail(400, "A request id is required.");
  const card = validateCard(body?.kind, body?.fields);
  if (typeof card === "string") return fail(400, card);
  if (!taskMapAllowed(card, desk.ask?.taskMaps ?? [])) {
    return fail(400, "Tasks can only go on the maps set up for the Desk.");
  }
  if (!writableKinds(desk.ask?.writers ?? {}, Boolean(desk.studio)).has(card.kind)) return fail(409, notSetUp(card.kind));

  const key = `ask:${requestId}`;
  if (runtime.ledger.has(key)) return fail(409, "This was already created.");
  if (!runtime.ledger.claim(key)) return fail(409, "This is already being created.");
  try {
    const now = (deps.now ?? Date.now)();
    if (card.kind === "capture" && desk.studio) {
      const filed = await fileStudioCapture({ options: desk.studio, areas: desk.areas, requestId, text: card.fields.text, db, now: new Date(now), ...(deps.captureModel ? { model: deps.captureModel } : {}) });
      return Response.json(filed, { status: filed.ok ? 200 : filed.status, headers: noStore });
    }
    const created = await createFromCard(card, {
      requestId,
      db,
      writers: desk.ask?.writers ?? {},
      run: deps.runWriter ?? spawnWithStdin,
      now,
      timeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000,
    });
    if (!created.ok) {
      if (created.uncertain) runtime.ledger.add(key, now);
      return Response.json({ ok: false, error: created.error, ...(created.uncertain ? { uncertain: true } : {}) }, { status: 502, headers: noStore });
    }
    runtime.ledger.add(key, now);
    if (created.event) runtime.recentWrites?.add(created.event, now);
    return Response.json({ ok: true, message: created.message, ...(created.url ? { url: created.url } : {}) }, { headers: noStore });
  } finally {
    runtime.ledger.release(key);
  }
}

export async function handleDeskNoteDone(req: Request, db: Database, now: number = Date.now()): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "number" ? body.id : typeof body?.id === "string" ? Number(body.id) : NaN;
  if (!Number.isInteger(id) || id < 1) return fail(400, "A note id is required.");
  if (!closeNote(db, id, now)) return fail(404, "That reminder or note is already gone.");
  return Response.json({ ok: true }, { headers: noStore });
}

export async function handleDeskCaptureUndo(req: Request, db: Database, runtime: DeskRuntime | undefined): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return fail(409, "The Studio is not set up on this stack.");
  const parsed = CaptureUndoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "A capture id and request id are required.");
  const result = await undoStudioCapture({ options: desk.studio, areas: desk.areas, requestId: parsed.data.requestId, id: parsed.data.id, db });
  return Response.json(result, { status: result.ok ? 200 : result.status, headers: noStore });
}
