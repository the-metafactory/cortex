import type { Database } from "bun:sqlite";
import { adapterRowRef, readAdapterAttention } from "../desk/adapter-items";
import { ADAPTER_CAPABILITY_ACTION } from "../desk/adapter-actions";
import type { DeskRuntime, DeskVigilSource } from "../desk/compose";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });

export async function handleDeskAdapterAction(req: Request, _db: Database, runtime: DeskRuntime | undefined, _vigil: DeskVigilSource | undefined, now = Date.now()): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled || !runtime.adapterAttention || !runtime.adapterCapability) return fail(409, "Changes on connected rows are not set up on this stack.");
  const body = (await req.json().catch(() => null)) as { key?: unknown; capability?: unknown } | null;
  if (typeof body?.key !== "string" || typeof body.capability !== "string") return fail(400, "A row and a capability are required.");
  const view = await readAdapterAttention(runtime.adapterAttention, now);
  const item = view.items.find(row => row.key === body.key && row.kind === "adapter");
  if (!item) return fail(409, "That row is no longer on the Desk.");
  if (!item.actions.some(action => action.id.startsWith(ADAPTER_CAPABILITY_ACTION) && action.target === body.capability)) return fail(409, "This row does not offer that change.");
  const ref = adapterRowRef(item.key);
  if (!ref || !item.destination) return fail(409, "That row has no canonical object and destination.");
  const admission = await runtime.adapterCapability({ adapterId: ref.adapterId, connectionId: ref.connectionId, capabilityId: body.capability, destinations: [item.destination] });
  if (admission.kind === "denied") return fail(403, "The host authority does not permit this change.");
  return fail(501, "The host admitted this change, and its owner operation is not set up on this stack yet.");
}
