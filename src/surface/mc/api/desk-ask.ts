import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { ASK_KINDS, KIND_LABEL, parseByRules, parseWithCommand, toProposal, validateCard, type ParserRunner } from "../desk/ask";
import { createFromCard, spawnWithStdin, writableKinds, type WriterRunner } from "../desk/create";
import { closeNote } from "../desk/notes";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });
const MAX_TEXT = 1000;

export interface DeskAskDeps {
  runParser?: ParserRunner;
  runWriter?: WriterRunner;
  now?: () => number;
  timeZone?: string;
}

const parserFrom = (run: WriterRunner): ParserRunner => async (argv, stdin, timeoutMs) => {
  const result = await run(argv, stdin, timeoutMs);
  if (result.code !== 0) throw new Error(`parser exited ${result.code}`);
  return result.stdout;
};

export async function handleDeskAsk(req: Request, runtime: DeskRuntime | undefined, deps: DeskAskDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return fail(400, "Type what you want first.");
  if (text.length > MAX_TEXT) return fail(400, `That is longer than ${MAX_TEXT} characters.`);

  const now = (deps.now ?? Date.now)();
  const ask = desk.ask;
  const maps = ask?.taskMaps ?? [];
  const writable = writableKinds(ask?.writers ?? {});
  let result = null;
  let via: "parser" | "rules" = "rules";
  if (ask?.parser.length) {
    const request = { text, now: new Date(now).toISOString(), timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, kinds: [...ASK_KINDS], maps };
    result = await parseWithCommand(ask.parser, request, deps.runParser ?? parserFrom(spawnWithStdin), ask.timeoutSeconds * 1000);
    if (result) via = "parser";
  }
  result ??= parseByRules(text, { now, maps });
  if (result.kind === "none") return fail(422, result.reason);
  return Response.json({ ok: true, proposal: toProposal(result.kind, result.fields, writable, via) }, { headers: noStore });
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
  if (card.kind === "task" && (desk.ask?.taskMaps.length ?? 0) > 0 && !desk.ask?.taskMaps.some((m) => m.ref === card.fields.map)) {
    return fail(400, "Tasks can only go on the maps set up for the Desk.");
  }
  if (!writableKinds(desk.ask?.writers ?? {}).has(card.kind)) return fail(409, `${KIND_LABEL[card.kind]}s are not set up on this stack.`);

  const key = `ask:${requestId}`;
  if (runtime.ledger.has(key)) return fail(409, "This was already created.");
  if (!runtime.ledger.claim(key)) return fail(409, "This is already being created.");
  try {
    const now = (deps.now ?? Date.now)();
    const created = await createFromCard(card, {
      requestId,
      db,
      writers: desk.ask?.writers ?? {},
      run: deps.runWriter ?? spawnWithStdin,
      now,
      timeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000,
    });
    if (!created.ok) return fail(502, created.error);
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
