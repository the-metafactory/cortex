import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { assistantNameOf } from "../desk/assistant-name";
import { loadBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";
import { checkAsk, laneFor, locateRow, outlineAskModel, OutlineAskRequestSchema, readAnswer, type OutlineAskModel } from "../desk/outline-ask";

export const DESK_OUTLINE_ASK_PATH = "/api/desk/outline/ask";
const BODY_MAX = 32_000;
const REMEMBERED = 256;

interface Outcome { status: number; body: object }
const answer = ({ status, body }: Outcome): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string): Outcome => ({ status, body: { ok: false, error } });
const asked = new WeakMap<Database, Map<string, { fingerprint: string; outcome: Promise<Outcome> }>>();

export interface OutlineAskDeps { model?: OutlineAskModel }

export async function handleDeskOutlineAsk(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: OutlineAskDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return answer(refuse(409, "The Desk is turned off."));
  const raw = await req.text().catch(() => "");
  if (raw.length > BODY_MAX) return answer(refuse(400, "The request is too large. Shorten the question or the passage."));
  const parsed = OutlineAskRequestSchema.safeParse((() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })());
  if (!parsed.success) return answer(refuse(400, "Send a request id, a row id and the kind of ask: answer or shorten."));
  const request = parsed.data;
  const checked = checkAsk(request);
  if ("error" in checked) return answer(refuse(checked.status, checked.error));
  const { question, passage } = checked;

  let remembered = asked.get(db);
  if (!remembered) { remembered = new Map(); asked.set(db, remembered); }
  const fingerprint = createHash("sha256").update(JSON.stringify([request.row, request.kind, question, passage])).digest("hex");
  const prior = remembered.get(request.requestId);
  if (prior) return prior.fingerprint === fingerprint ? answer(await prior.outcome) : answer(refuse(409, "That request id already belongs to another question. Send a new request id."));

  const outcome = (async (): Promise<Outcome> => {
    let state;
    try { state = loadBalanceState(db); } catch { return refuse(409, "The outline cannot be read right now. Nothing was sent."); }
    const found = state ? locateRow(state.outline, request.row) : null;
    if (!found) return refuse(404, "That row is not in the outline.");
    const lane = laneFor(desk, found.area);
    if ("error" in lane) return refuse(lane.status, lane.error);
    const prompt = { kind: request.kind, question, passage, row: { title: found.node.title, note: found.node.note ?? "", above: found.above.map(n => n.title) } };
    const name = assistantNameOf(desk);
    let reply;
    try { reply = readAnswer(request.kind, passage, await (deps.model ?? outlineAskModel)(lane.config, prompt, lane.content, name)); }
    catch { reply = null; }
    if (!reply) return refuse(502, `${name} could not answer. Nothing was stored; ask again.`);
    return { status: 200, body: { ok: true, ...reply } };
  })();
  remembered.set(request.requestId, { fingerprint, outcome });
  const result = await outcome;
  if (result.status !== 200) {
    if (remembered.get(request.requestId)?.outcome === outcome) remembered.delete(request.requestId);
  } else {
    for (const key of remembered.keys()) { if (remembered.size <= REMEMBERED) break; remembered.delete(key); }
  }
  return answer(result);
}
