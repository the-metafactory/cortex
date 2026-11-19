import { preserveStudioDrafts, validateSnapshotWrite } from "./draft-snapshots";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireStudioLock, studioLockOwnerIsAlive } from "./write-lock";
import type { StudioOptions } from "../types";
import { isRefusal, planAct, type ActContext, type ActRefusal, type ActPlan, type StudioAct } from "./acts";
import { parseCaptureFile, parseThreadFile } from "./format";
import { commitPaths, findRequest, REQUEST_TRAILER, restorePaths, spawnGit, treeProblem, type GitRunner } from "./git";
import { readStudioFiles } from "./read";
import { buildStudioView, type StudioArea, type StudioFile, type StudioFiles, type StudioView } from "./view";

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
  | ({ ok: false } & ActRefusal);

export interface StudioWriteInput {
  options: StudioOptions;
  areas: readonly StudioArea[];
  requestId: string;
  assistantName: string;
  act: StudioAct;
  now?: Date;
  git?: GitRunner;
  lock?: StudioWriteLock;
  wait?: boolean;
}

const fail = (status: number, error: string, extra: Omit<ActRefusal, "status" | "error"> = {}): ActResult => ({ ok: false, status, error, ...extra });
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
  return { files, view: buildStudioView(files, input.options, input.areas, problems, input.assistantName) };
}

async function applyPlan(git: GitRunner, dir: string, plan: ActPlan, requestId: string): Promise<{ sha: string } | { error: string }> {
  const all = [...plan.writes.map((w) => w.path), ...plan.removes];
  const originals = new Map<string, Buffer>();
  for (const path of all) if (await exists(join(dir, path))) originals.set(path, await readFile(join(dir, path)));
  const created = all.filter((p) => !originals.has(p));
  const undo = async (): Promise<void> => {
    try {
      await restorePaths(git, dir, all, originals);
    } finally {
      await Promise.all(created.map((p) => rm(join(dir, p), { force: true })));
    }
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

type TransactionInput = Omit<StudioWriteInput, "act">;
type MakePlan = (ctx: ActContext) => ActPlan | ActRefusal | Promise<ActPlan | ActRefusal>;
type WriteFailure = Extract<ActResult, { ok: false }>;
type TransactionResult = Omit<Extract<ActResult, { ok: true }>, "studio"> | WriteFailure;
type FileValidator = (file: StudioFile) => string | null;

async function acquireWithDeadline(dir: string, deadline: number, wait: boolean): Promise<(() => Promise<void>) | null> {
  for (;;) {
    const release = await acquireStudioLock(dir);
    if (release) return release;
    if (Date.now() >= deadline && (!wait || !await studioLockOwnerIsAlive(dir))) return acquireStudioLock(dir);
    await Bun.sleep(25);
  }
}

export async function withStudioLock<T>(input: Pick<TransactionInput, "options" | "lock" | "git">, work: () => Promise<T>, wait = false): Promise<T | WriteFailure> {
  const { dir } = input.options;
  const git = input.git ?? spawnGit;
  const lock = input.lock ?? studioWriteLock;
  const deadline = Date.now() + (wait ? 5000 : 0);
  while (!lock.claim(dir)) {
    if (!wait) return { ok: false, status: 409, error: "Another Studio change is being written. Try again in a moment." };
    await Bun.sleep(10);
  }
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireWithDeadline(dir, deadline, wait);
    if (!release) {
      const problem = await treeProblem(git, dir);
      return { ok: false, status: wait ? 503 : 409, error: problem?.kind === "not-git" ? problem.error : "Another Studio process holds the write lock. Inspect .git/studio-write.lock/owner.json if its process stopped." };
    }
    return await work();
  } finally {
    try {
      await release?.();
    } finally {
      lock.release(dir);
    }
  }
}

async function recordStudioTransaction(input: TransactionInput, makePlan: () => ReturnType<MakePlan>, validateWrite: FileValidator): Promise<TransactionResult> {
  const { dir } = input.options;
  const git = input.git ?? spawnGit;
  const problem = await treeProblem(git, dir);
  if (problem?.kind === "not-git") return fail(409, problem.error);
  const done = await findRequest(git, dir, input.requestId);
  if (done) return { ok: true, message: `Already recorded: ${done.subject}.`, commit: done.sha, replayed: true };
  if (problem) return fail(409, problem.error);

  const base = await git(["rev-parse", "--verify", "HEAD"], dir);
  const plan = await makePlan();
  if (isRefusal(plan)) return { ok: false, ...plan };
  for (const w of plan.writes) {
    const error = validateWrite(w);
    if (error) return fail(500, error);
  }

  const changed = await treeProblem(git, dir);
  if (changed) return fail(409, changed.error);
  const head = await git(["rev-parse", "--verify", "HEAD"], dir);
  if (head.code !== base.code || head.stdout !== base.stdout) return fail(409, "The Studio changed while the request was being prepared. Try again; nothing was written.");
  const committed = await applyPlan(git, dir, plan, input.requestId);
  if ("error" in committed) return fail(500, committed.error);
  return { ok: true, message: plan.message, commit: committed.sha, replayed: false };
}

export function writeStudioTransaction<T>(input: TransactionInput, makePlan: () => ReturnType<MakePlan>, options: { wait: boolean; validateWrite: FileValidator; project: (result: TransactionResult) => Promise<T> }): Promise<T | WriteFailure> {
  return withStudioLock(input, async () => {
    const result = await recordStudioTransaction(input, makePlan, options.validateWrite);
    return options.project(result);
  }, options.wait);
}

// glossary-ignore: run
export function runStudioTransaction(input: TransactionInput, makePlan: MakePlan): Promise<ActResult> {
  return writeStudioTransaction(input, async () => {
    const { files, view } = await readView(input);
    const ctx = { files, view, now: input.now ?? new Date(), assistantName: input.assistantName };
    return preserveStudioDrafts(input, ctx, await makePlan(ctx));
  }, {
    wait: input.wait ?? false,
    validateWrite: file => {
      if (file.path.startsWith("draft-snapshots/")) return validateSnapshotWrite(file);
      const parsed = file.path.startsWith("inbox/") ? parseCaptureFile(file.path, file.text) : parseThreadFile(file.path, file.text, input.assistantName);
      return parsed.ok ? null : `The change would leave ${file.path} unreadable (${parsed.reason}); nothing was written.`;
    },
    project: async result => result.ok ? { ...result, studio: (await readView(input)).view } : result,
  });
}

export function runStudioAct(input: StudioWriteInput): Promise<ActResult> {
  return runStudioTransaction(input, (ctx) => planAct(ctx, input.act));
}
