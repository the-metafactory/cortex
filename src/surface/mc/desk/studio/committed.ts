import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnGit } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";
import type { StudioFile, StudioFiles } from "./view";

async function git(dir: string, args: string[]): Promise<string> {
  const result = await spawnGit(args, dir);
  if (result.code !== 0) throw new Error("Studio committed source lookup failed; overseer deferred");
  return result.stdout;
}

async function readEntry(dir: string, entry: string): Promise<StudioFile> {
  const parsed = /^(\d+) (\w+) ([a-f0-9]+)\t([^\0]+)$/.exec(entry);
  const [, mode, kind, oid, path] = parsed ?? [];
  if (!mode || !kind || !oid || !path) throw new Error("Studio committed tree entry is incomplete");
  if (kind !== "blob" || !/^100(?:644|755)$/.test(mode)) throw new Error(`Studio committed input ${path} must be a regular file`);
  const target = join(dir, path);
  const info = await lstat(target);
  if (!info.isFile() || await realpath(target) !== target) throw new Error(`Studio committed input ${path} must remain a regular file inside Studio`);
  const size = Number((await git(dir, ["cat-file", "-s", oid])).trim());
  if (!Number.isSafeInteger(size) || size > STUDIO_MAX_FILE_BYTES || info.size > STUDIO_MAX_FILE_BYTES) throw new Error(`Studio committed input ${path} exceeds the file limit`);
  if ((await git(dir, ["hash-object", "--no-filters", "--", path])).trim() !== oid) throw new Error(`Studio input ${path} differs from its committed source; overseer deferred`);
  return { path, text: await git(dir, ["cat-file", "blob", oid]) };
}

export async function readCommittedStudioFile(dir: string, head: string, path: string): Promise<StudioFile | null> {
  const tree = await git(dir, ["ls-tree", "-z", "--full-tree", head, "--", path]);
  if (!tree) return null;
  const entries = tree.split("\0").filter(Boolean);
  const entry = entries[0];
  if (entries.length !== 1 || !entry) throw new Error("Studio committed source lookup is ambiguous");
  const file = await readEntry(dir, entry);
  if (file.path !== path) throw new Error("Studio committed source path does not match");
  return file;
}

export async function readCommittedStudioFiles(dir: string, head: string): Promise<StudioFiles> {
  const files: StudioFiles = { threads: [], inbox: [], proposals: [] };
  const tree = await git(dir, ["ls-tree", "-rz", "--full-tree", head, "--", "threads", "inbox", "proposals"]);
  for (const entry of tree.split("\0").filter(Boolean)) {
    const folder = /\t(threads|inbox|proposals)\/[^/]+\.md$/.exec(entry)?.[1];
    if (!folder) continue;
    const file = await readEntry(dir, entry);
    if (folder === "threads") files.threads.push(file);
    else if (folder === "inbox") files.inbox.push(file);
    else files.proposals.push(file);
  }
  if ((await git(dir, ["rev-parse", "HEAD"])).trim() !== head) throw new Error("Studio committed HEAD changed during source lookup; overseer deferred");
  return files;
}
