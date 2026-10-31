import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin, type WriterRunner } from "../desk/create";
import { findListedMail, isMailAction, markUnimportant, trashMail } from "../desk/mail-actions";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });

export interface DeskMailDeps {
  run?: WriterRunner;
  now?: () => number;
}

/**
 * POST {action: "trash" | "unimportant", key}: acts on one mail the Desk lists. The rebind and identity gates in
 * handleApi run before this handler; there is no step-up. The account and Message-ID come from the mail source's
 * last reading, never from the page, and a mail already moved or still moving is refused.
 */
export async function handleDeskMail(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskMailDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const body = (await req.json().catch(() => null)) as { action?: unknown; key?: unknown } | null;
  if (!isMailAction(body?.action) || typeof body.key !== "string") return fail(400, "An action and an item key are required.");
  const mail = findListedMail(runtime.sourceCache?.cached() ?? [], body.key);
  if (!mail) return fail(409, "The Desk no longer lists this mail.");
  const now = (deps.now ?? Date.now)();
  const result = body.action === "trash"
    ? await trashMail(mail, { config: runtime.options.mailActions, ledger: runtime.ledger, run: deps.run ?? spawnWithStdin, now })
    : markUnimportant(db, mail, now);
  if (!result.ok) return fail(result.status, result.error);
  return Response.json({ ok: true, message: result.message }, { headers: noStore });
}
