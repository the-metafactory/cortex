import { spawnRanger, type RangerRunResult } from "../actions";

export type GitResult = RangerRunResult;

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const spawnGit: GitRunner = (args, cwd) => spawnRanger(["git", "-C", cwd, ...args]);

export const REQUEST_TRAILER = "Desk-Request";

const firstLine = (r: GitResult): string => (r.stderr || r.stdout).trim().split("\n")[0] ?? `exit code ${r.code}`;

export interface TreeProblem {
  kind: "not-git" | "status-failed" | "dirty";
  error: string;
}

export async function treeProblem(run: GitRunner, dir: string): Promise<TreeProblem | null> {
  const inside = await run(["rev-parse", "--is-inside-work-tree"], dir);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { kind: "not-git", error: "The Studio directory is not a git working tree, so the Studio cannot record changes. Run git init there first." };
  const status = await run(["status", "--porcelain", "--untracked-files=all"], dir);
  if (status.code !== 0) return { kind: "status-failed", error: `git status failed in the Studio directory: ${firstLine(status)}` };
  const dirty = status.stdout.split("\n").filter((l) => l.trim() !== "");
  if (dirty.length === 0) return null;
  const names = dirty.slice(0, 3).map((l) => l.slice(3).trim());
  return { kind: "dirty", error: `The Studio directory has uncommitted changes (${names.join(", ")}${dirty.length > 3 ? ", …" : ""}). Commit or discard them first; nothing was written.` };
}

export async function findRequest(run: GitRunner, dir: string, requestId: string): Promise<{ sha: string; subject: string } | null> {
  const r = await run(["log", "-n", "1", `--grep=^${REQUEST_TRAILER}: ${requestId}$`, "--format=%H%x09%s"], dir);
  if (r.code !== 0) return null;
  const [sha, ...subject] = r.stdout.trim().split("\t");
  return sha ? { sha, subject: subject.join("\t") } : null;
}

export async function commitPaths(run: GitRunner, dir: string, paths: string[], message: string): Promise<{ sha: string } | { error: string }> {
  const add = await run(["add", "-A", "--", ...paths], dir);
  if (add.code !== 0) return { error: `git add failed: ${firstLine(add)}` };
  const commit = await run(["commit", "-q", "-m", message], dir);
  if (commit.code !== 0) return { error: `git commit failed: ${firstLine(commit)}` };
  const head = await run(["rev-parse", "HEAD"], dir);
  return head.code === 0 ? { sha: head.stdout.trim() } : { error: `git rev-parse failed: ${firstLine(head)}` };
}

export async function restorePaths(run: GitRunner, dir: string, all: string[], tracked: string[]): Promise<void> {
  await run(["reset", "-q", "--", ...all], dir);
  if (tracked.length) await run(["checkout", "HEAD", "--", ...tracked], dir);
}
