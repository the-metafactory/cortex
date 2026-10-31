import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireStudioLock } from "./write-lock";
import type { StudioOptions } from "../types";
import { isRefusal, planAct, type ActContext, type ActRefusal, type ActPlan, type StudioAct } from "./acts";
import { parseCaptureFile, parseThreadFile } from "./format";
import { commitPaths, findRequest, REQUEST_TRAILER, restorePaths, spawnGit, treeProblem, type GitRunner } from "./git";
import { readStudioFiles } from "./read";
import { buildStudioView, type StudioArea, type StudioFiles, type StudioView } from "./view";

export const STUDIO_REQUEST_ID = /^[\w-]{8,64}$/;

export class StudioWriteLock {
  private readonly busy = new Set<string>();

  claim(dir: string): boolean {
    if (this.busy.has(dir)) return false;
    this.busy.add(dir);
    return true;
  }

  release(dir: string): void {
    this.busy.delete(dir);
  }
}

export const studioWriteLock = new StudioWriteLock();

export type ActResult =
  | { ok: true; message: string; commit: string; replayed: boolean; studio: StudioView }
  | { ok: false; status: number; error: string; needsPark?: boolean };

export interface StudioWriteInput {
  options: StudioOptions;
  areas: readonly StudioArea[];
  requestId: string;
  act: StudioAct;
  now?: Date;
  git?: GitRunner;
  lock?: StudioWriteLock;
}

const fail = (status: number, error: string, extra: { needsPark?: boolean } = {}): ActResult => ({ ok: false, status, error, ...extra });
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readView(input: Omit<StudioWriteInput, "act">): Promise<{ files: StudioFiles; view: StudioView }> {
  const { files, problems } = await readStudioFiles(input.options.dir);
  return { files, view: buildStudioView(files, input.options, input.areas, problems) };
}

async function applyPlan(git: GitRunner, dir: string, plan: ActPlan, requestId: string): Promise<{ sha: string } | { error: string }> {
  const all = [...plan.writes.map((w) => w.path), ...plan.removes];
  const tracked: string[] = [];
  for (const path of all) if (await exists(join(dir, path))) tracked.push(path);
  const created = all.filter((p) => !tracked.includes(p));
  const undo = async (): Promise<void> => {
    await restorePaths(git, dir, all, tracked);
    await Promise.all(created.map((p) => rm(join(dir, p), { force: true })));
  };
  try {
    for (const w of plan.writes) {
      await mkdir(dirname(join(dir, w.path)), { recursive: true });
      await writeFile(join(dir, w.path), w.text, "utf8");
    }
    for (const path of plan.removes) await rm(join(dir, path), { force: true });
  } catch (err) {
    await undo();
    return { error: `Could not write the Studio files: ${reason(err)}. Nothing was committed.` };
  }
  const committed = await commitPaths(git, dir, all, `Studio: ${plan.subject}\n\n${REQUEST_TRAILER}: ${requestId}\n`);
  if ("error" in committed) {
    await undo();
    return { error: `${committed.error}. The files are back as they were.` };
  }
  return committed;
}

export async function runStudioTransaction(input: Omit<StudioWriteInput, "act">, makePlan: (ctx: ActContext) => ActPlan | ActRefusal | Promise<ActPlan | ActRefusal>): Promise<ActResult> {
  const { dir } = input.options;
  const git = input.git ?? spawnGit;
  const lock = input.lock ?? studioWriteLock;
  if (!lock.claim(dir)) return fail(409, "Another Studio change is being written. Try again in a moment.");
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireStudioLock(dir);
    if (!release) {
      const problem = await treeProblem(git, dir);
      return fail(409, problem?.kind === "not-git" ? problem.error : "Another Studio process holds the write lock. Inspect .git/studio-write.lock/owner.json if its process stopped.");
    }
    const problem = await treeProblem(git, dir);
    if (problem?.kind === "not-git") return fail(409, problem.error);
    const done = await findRequest(git, dir, input.requestId);
    if (done) return { ok: true, message: `Already recorded: ${done.subject}.`, commit: done.sha, replayed: true, studio: (await readView(input)).view };
    if (problem) return fail(409, problem.error);

    const base = await git(["rev-parse", "--verify", "HEAD"], dir);
    const { files, view } = await readView(input);
    const plan = await makePlan({ files, view, now: input.now ?? new Date() });
    if (isRefusal(plan)) return fail(plan.status, plan.error, plan.needsPark ? { needsPark: true } : {});
    for (const w of plan.writes) {
      const parsed = w.path.startsWith("inbox/") ? parseCaptureFile(w.path, w.text) : parseThreadFile(w.path, w.text);
      if (!parsed.ok) return fail(500, `The change would leave ${w.path} unreadable (${parsed.reason}); nothing was written.`);
    }

    const changed = await treeProblem(git, dir);
    if (changed) return fail(409, changed.error);
    const head = await git(["rev-parse", "--verify", "HEAD"], dir);
    if (head.code !== base.code || head.stdout !== base.stdout) return fail(409, "The Studio changed while the request was being prepared. Try again; nothing was written.");
    const committed = await applyPlan(git, dir, plan, input.requestId);
    if ("error" in committed) return fail(500, committed.error);
    return { ok: true, message: plan.message, commit: committed.sha, replayed: false, studio: (await readView(input)).view };
  } finally {
    try {
      await release?.();
    } finally {
      lock.release(dir);
    }
  }
}

export function runStudioAct(input: StudioWriteInput): Promise<ActResult> {
  return runStudioTransaction(input, (ctx) => planAct(ctx, input.act));
}
