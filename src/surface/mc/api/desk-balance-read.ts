import { z } from "zod";
import { ObjectReferenceSchema } from "../../../conversations/domain-adapters/types";
import type { BalanceConnection } from "../desk/balance-connection";
import { fail, notAllowed, reply } from "./conversations";
import { stackPrincipalOf } from "./desk-connections";
import type { MutationGuardContext } from "./mutation-guard";

export const DESK_BALANCE_READ_PATH = "/api/desk/balance/read";
export type BalanceConnectionAccess = () => BalanceConnection | null;
const Read = z.object({
  conversationId: z.uuid(), connectionId: z.uuid(), capabilityId: z.enum(["balance.destinations", "balance.task.read"]), input: z.json(),
  destinations: z.array(ObjectReferenceSchema).min(1).max(64),
}).strict();

export async function handleDeskBalanceRead(req: Request, guard: MutationGuardContext, access?: BalanceConnectionAccess): Promise<Response> {
  const principal = await stackPrincipalOf(req, guard, "Only this stack's principal can read its Balance connection.");
  if (principal instanceof Response) return principal;
  if (req.method !== "POST") return notAllowed("POST");
  const parsed = Read.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "The Balance read request is not valid.");
  const connection = access?.();
  if (!connection) return fail(503, "Balance connection reads are unavailable on this stack.");
  try {
    const read = await connection.read(principal, parsed.data, req.signal);
    if (!read || read.result.status === "denied") return fail(403, "The current connection and destination scope do not permit this Balance read.");
    return reply(200, { ok: true, ...read });
  } catch (error) {
    process.stderr.write(`[desk-balance-read] ${error instanceof Error ? error.name : "UnexpectedError"}\n`);
    return fail(503, "The Balance read is unavailable. Reload the connection settings and retry.");
  }
}
