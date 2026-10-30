import type { DeskRuntime } from "../desk/compose";
import { isRangerAction, oneLine, planRangerAction, spawnRanger, type RangerRunner } from "../desk/actions";
import { readRangerState, type RangerFetch } from "../desk/sources/ranger";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });

export interface DeskActionDeps {
  run?: RangerRunner;
  fetchImpl?: RangerFetch;
  now?: () => number;
}

/**
 * POST {action, key}: runs one Ranger action for a Desk item. The rebind and identity gates in handleApi
 * run before this handler; there is no step-up. The call is built from a fresh read of Ranger's state, and an
 * action already sent or still running for the same node version is refused, so Ranger gets it once.
 */
export async function handleDeskAction(req: Request, runtime: DeskRuntime | undefined, deps: DeskActionDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  const ledger = runtime?.ledger;
  const cli = desk?.rangerCli;
  if (!ledger || !desk?.enabled || !desk.rangerUrl || !cli?.bin) return fail(409, "Ranger actions are not set up on this stack.");
  const body = (await req.json().catch(() => null)) as { action?: unknown; key?: unknown } | null;
  if (!isRangerAction(body?.action) || typeof body.key !== "string") return fail(400, "An action and an item key are required.");

  let plan;
  try {
    plan = planRangerAction(await readRangerState(desk.rangerUrl, deps.fetchImpl), body.action, body.key, cli);
  } catch (err) {
    return fail(502, `Could not read Ranger: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof plan === "string") return fail(409, plan);
  if (plan.handledKey !== null && ledger.has(plan.handledKey)) return fail(409, "This was already sent to Ranger.");
  if (!ledger.claim(plan.claimKey)) return fail(409, "This is already on its way to Ranger.");
  try {
    const result = await (deps.run ?? spawnRanger)(plan.argv);
    if (result.code !== 0) return fail(502, `Ranger refused: ${oneLine(result.stderr || result.stdout, `exit code ${result.code}`)}`);
    if (plan.handledKey !== null) ledger.add(plan.handledKey, (deps.now ?? Date.now)());
    return Response.json({ ok: true, message: plan.done }, { headers: noStore });
  } catch (err) {
    return fail(502, `Could not run Ranger: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    ledger.release(plan.claimKey);
  }
}
