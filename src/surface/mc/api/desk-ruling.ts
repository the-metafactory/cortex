import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskRuntime } from "../desk/compose";
import { oneLine, planRangerAction, rangerActionsReady, spawnRanger, type RangerRunner } from "../desk/actions";
import { blockedEntry, MAX_RULING_LENGTH, ruleArgv } from "../desk/ruling";
import { rangerItemKey, readRangerState, type RangerFetch } from "../desk/sources/ranger";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ ok: false, error, ...extra }, { status, headers: noStore });
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const REQUEST_ID = /^[\w-]{8,64}$/;

export interface DeskRulingDeps {
  soma?: RangerRunner;
  ranger?: RangerRunner;
  fetchImpl?: RangerFetch;
  now?: () => number;
  tmpDir?: string;
}

async function recordRuling(run: RangerRunner, argvFor: (file: string) => string[] | string, text: string, base: string): Promise<string | null> {
  const dir = await mkdtemp(join(base, "desk-ruling-"));
  try {
    const file = join(dir, "ruling.md");
    await writeFile(file, text, { mode: 0o600 });
    const argv = argvFor(file);
    if (typeof argv === "string") return argv;
    const result = await run(argv);
    return result.code === 0 ? null : oneLine(result.stderr || result.stdout, `exit code ${result.code}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * POST {key, text, requestId}: records the person's ruling in the node with `soma graph rule`, then resumes
 * the node through `ranger resume-node`. The rebind and identity gates in handleApi run before this handler;
 * there is no step-up. Both calls are built from fresh reads of Ranger's state, never from the page. A ruling
 * is recorded once per request id, so a second Confirm after a refused resume only retries the resume.
 */
export async function handleDeskRuling(req: Request, runtime: DeskRuntime | undefined, deps: DeskRulingDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  const rulings = runtime?.rulings;
  if (!runtime || !rulings || !rangerActionsReady(desk) || !desk.somaBin) return fail(409, "Rulings are not set up on this stack.");
  const body = (await req.json().catch(() => null)) as { key?: unknown; text?: unknown; requestId?: unknown } | null;
  if (typeof body?.key !== "string" || typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) return fail(400, "An item key and a request id are required.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return fail(400, "Write your ruling first.");
  if (text.length > MAX_RULING_LENGTH) return fail(400, `A ruling can be at most ${MAX_RULING_LENGTH} characters.`);
  const { key, requestId } = body;
  const somaBin = desk.somaBin;
  const read = () => readRangerState(desk.rangerUrl, deps.fetchImpl);
  const now = deps.now ?? Date.now;

  if (!rulings.claim(requestId)) return fail(409, "This ruling is already on its way.");
  try {
    let recorded = rulings.recordedFor(requestId, key);
    if (!recorded) {
      let entry;
      try {
        entry = blockedEntry(await read(), key);
      } catch (err) {
        return fail(502, `Could not read Ranger: ${reason(err)}`);
      }
      if (typeof entry === "string") return fail(409, entry);
      const blocked = entry;
      let refused: string | null;
      try {
        refused = await recordRuling(deps.soma ?? spawnRanger, (file) => ruleArgv(somaBin, blocked, file), text, deps.tmpDir ?? tmpdir());
      } catch (err) {
        refused = reason(err);
      }
      if (refused !== null) return fail(502, `Your ruling was not recorded: ${refused}`);
      rulings.add(requestId, key, now());
      recorded = true;
    }

    const notResumed = (why: string): Response => fail(502, `Your ruling is recorded; Ranger did not resume: ${why}`, { recorded });
    let state;
    try {
      state = await read();
    } catch (err) {
      return notResumed(`could not read Ranger: ${reason(err)}`);
    }
    const plan = planRangerAction(state, "ranger.retry", key, desk.rangerCli);
    if (typeof plan === "string") return notResumed(plan);
    if (plan.handledKey !== null && runtime.ledger.has(plan.handledKey)) return notResumed("it was already sent to Ranger.");
    if (!runtime.ledger.claim(plan.claimKey)) return notResumed("a resume is already on its way to Ranger.");
    try {
      const result = await (deps.ranger ?? spawnRanger)(plan.argv);
      if (result.code !== 0) return notResumed(oneLine(result.stderr || result.stdout, `exit code ${result.code}`));
      if (plan.handledKey !== null) runtime.ledger.add(plan.handledKey, now());
    } catch (err) {
      return notResumed(reason(err));
    } finally {
      runtime.ledger.release(plan.claimKey);
    }
    const title = state.needsYou.find((n) => rangerItemKey(`${n.repo}#${n.nodeId}`) === key)?.title ?? "the node";
    return Response.json({ ok: true, message: `Recorded your ruling and resumed "${title}".` }, { headers: noStore });
  } finally {
    rulings.release(requestId);
  }
}
