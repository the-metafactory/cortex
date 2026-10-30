import type { DeskOptions } from "../desk/compose";
import { isRangerAction, oneLine, planRangerAction, spawnRanger, type HandledLedger, type RangerRunner } from "../desk/actions";
import { readRangerState, type RangerFetch } from "../desk/sources/ranger";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });

export interface DeskActionDeps {
  ledger: HandledLedger;
  run?: RangerRunner;
  fetchImpl?: RangerFetch;
  now?: () => number;
}

/**
 * POST {action, key}: runs one Ranger action for a Desk item. Step-up MFA is enforced before this
 * handler (STEP_UP_CONTROL_ROUTES). The call is built from a fresh read of Ranger's state, and an
 * action already sent or still running for the same node version is refused, so Ranger gets it once.
 */
export async function handleDeskAction(req: Request, desk: DeskOptions | undefined, deps: DeskActionDeps): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const cli = desk?.rangerCli;
  if (!desk?.enabled || !desk.rangerUrl || !cli?.bin) return fail(409, "Ranger actions are not set up on this stack.");
  const body = (await req.json().catch(() => null)) as { action?: unknown; key?: unknown } | null;
  if (!isRangerAction(body?.action) || typeof body.key !== "string") return fail(400, "An action and an item key are required.");

  let plan;
  try {
    plan = planRangerAction(await readRangerState(desk.rangerUrl, deps.fetchImpl), body.action, body.key, cli);
  } catch (err) {
    return fail(502, `Could not read Ranger: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof plan === "string") return fail(409, plan);
  if (deps.ledger.has(plan.handledKey)) return fail(409, "This was already sent to Ranger.");
  if (!deps.ledger.claim(plan.handledKey)) return fail(409, "This is already on its way to Ranger.");
  try {
    const result = await (deps.run ?? spawnRanger)(plan.argv);
    if (result.code !== 0) return fail(502, `Ranger refused: ${oneLine(result.stderr || result.stdout, `exit code ${result.code}`)}`);
    deps.ledger.add(plan.handledKey, (deps.now ?? Date.now)());
    return Response.json({ ok: true, message: plan.done }, { headers: noStore });
  } catch (err) {
    return fail(502, `Could not run Ranger: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    deps.ledger.release(plan.handledKey);
  }
}
