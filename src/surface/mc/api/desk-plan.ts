import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  composeDesk,
  type DeskRuntime,
  type DeskVigilSource,
} from "../desk/compose";
import { sourceIdentity } from "../desk/my-day";
import { proposeBalanceParent } from "../desk/balance-parent";
import { spawnWithStdin } from "../desk/create";
import type { ParserRunner } from "../desk/ask";

const InputSchema = z.object({
  key: z.string().min(1).max(300),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function handleDeskPlan(
  req: Request,
  db: Database,
  runtime: DeskRuntime | undefined,
  vigil?: DeskVigilSource,
  now = Date.now(),
  run?: ParserRunner,
): Promise<Response> {
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (!runtime?.options?.enabled)
    return Response.json({ error: "The Desk is turned off." }, { status: 409 });
  const input = InputSchema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return Response.json(
      { error: "Choose a current source item." },
      { status: 400 },
    );
  const desk = runtime.options;
  const composed = await composeDesk(db, desk, vigil, {
    waitingTasks: runtime.waitingTasks,
    handled: runtime.ledger,
    sourceCache: runtime.sourceCache,
    now,
  });
  const source = composed.items.find((i) => i.key === input.data.key);
  if (!source || sourceIdentity(source) !== input.data.fingerprint)
    return Response.json(
      {
        error:
          "The source changed or is no longer on the Desk. Refresh before planning.",
      },
      { status: 409 },
    );
  const day = composed.myDay;
  if (!day)
    return Response.json(
      { error: "The Balance owner is unavailable. Retry after refreshing." },
      { status: 503 },
    );
  const proposal = await proposeBalanceParent({
    desk,
    day,
    source,
    run:
      run ??
      (async (argv, stdin, timeout) => {
        const out = await spawnWithStdin(argv, stdin, timeout);
        if (out.code !== 0) throw new Error("Parser unavailable");
        return out.stdout;
      }),
  });
  return Response.json(proposal, { headers: { "Cache-Control": "no-store" } });
}
