import type { DeskRuntime } from "../desk/compose";
import { oneLine } from "../desk/actions";
import { goalCheckFor, isGoalAction, SOMA_GOAL_ID, spawnGoalCommand, type GoalRunner, type GoalRunResult } from "../desk/goals";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });
const ok = (message: string): Response => Response.json({ ok: true, message }, { headers: noStore });
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const failure = (result: GoalRunResult): string => oneLine(result.stderr || result.stdout, `exit code ${result.code}`);

export interface DeskGoalDeps {
  run?: GoalRunner;
  now?: () => number;
}

/**
 * POST {action, goal}: "goal.check" runs the goal's configured check once; "goal.pause" pauses the goal in Soma.
 * The rebind and identity gates in handleApi run before this handler; there is no step-up. The command comes
 * from the stack config, never from the page, and a check is refused while the same goal's check is still running.
 */
export async function handleDeskGoal(req: Request, runtime: DeskRuntime | undefined, deps: DeskGoalDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const desk = runtime.options;
  const body = (await req.json().catch(() => null)) as { action?: unknown; goal?: unknown } | null;
  if (!isGoalAction(body?.action) || typeof body.goal !== "string" || body.goal === "") return fail(400, "An action and a goal are required.");
  const goal = body.goal;
  const run = deps.run ?? spawnGoalCommand;
  const now = deps.now ?? Date.now;

  if (body.action === "goal.check") {
    const check = goalCheckFor(desk.goals, goal);
    const checks = runtime.goalChecks;
    if (!check || !checks) return fail(409, "No check is set up for this goal.");
    if (!checks.start(goal, now())) return fail(409, "A check for this goal is still running.");
    try {
      const result = await run(check.command, check.env, check.timeoutSeconds * 1000);
      if (result.code !== 0) {
        checks.cancel(goal);
        return fail(502, `The check failed: ${failure(result)}`);
      }
      return ok("The check is running. The Desk shows the new reading when it arrives.");
    } catch (err) {
      checks.cancel(goal);
      return fail(502, `Could not run the check: ${reason(err)}`);
    }
  }

  const somaBin = desk.goals?.somaBin ?? "";
  if (!somaBin) return fail(409, "Pausing goals is not set up on this stack.");
  if (!SOMA_GOAL_ID.test(goal)) return fail(400, "Soma cannot pause this goal.");
  try {
    const result = await run([somaBin, "goal", "set-status", goal, "paused"], {}, 30_000);
    if (result.code !== 0) return fail(502, `Soma did not pause the goal: ${failure(result)}`);
  } catch (err) {
    return fail(502, `Could not run Soma: ${reason(err)}`);
  }
  runtime.goalStatuses?.mark(goal, "paused");
  return ok("The goal is paused. The Desk will not list it until it is active again.");
}
