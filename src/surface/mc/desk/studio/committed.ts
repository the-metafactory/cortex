import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnGit } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";
import type { StudioFiles } from "./view";

export async function readCommittedStudioFiles(dir: string, head: string): Promise<StudioFiles> {
  const git = async (args: string[]): Promise<string> => {
    const result = await spawnGit(args, dir);
    if (result.code !== 0) throw new Error("Studio committed source lookup failed; overseer deferred");
    return result.stdout;
  };
  const files: StudioFiles = { threads: [], inbox: [], proposals: [] };
  const tree = await git(["ls-tree", "-rz", "--full-tree", head, "--", "threads", "inbox", "proposals"]);
  for (const entry of tree.split("\0").filter(Boolean)) {
    const parsed = /^(\d+) (\w+) ([a-f0-9]+)\t((threads|inbox|proposals)\/[^/]+\.md)$/.exec(entry);
    if (!parsed) continue;
    const [, mode, kind, oid, path, folder] = parsed;
    if (!mode || !kind || !oid || !path) throw new Error("Studio committed tree entry is incomplete");
    if (kind !== "blob" || !/^100(?:644|755)$/.test(mode)) throw new Error(`Studio committed input ${path} must be a regular file`);
    const target = join(dir, path);
    const info = await lstat(target);
    if (!info.isFile() || await realpath(target) !== target) throw new Error(`Studio committed input ${path} must remain a regular file inside Studio`);
    const size = Number((await git(["cat-file", "-s", oid])).trim());
    if (!Number.isSafeInteger(size) || size > STUDIO_MAX_FILE_BYTES || info.size > STUDIO_MAX_FILE_BYTES) throw new Error(`Studio committed input ${path} exceeds the file limit`);
    if ((await git(["hash-object", "--no-filters", "--", path])).trim() !== oid) throw new Error(`Studio input ${path} differs from its committed source; overseer deferred`);
    const file = { path, text: await git(["cat-file", "blob", oid]) };
    if (folder === "threads") files.threads.push(file);
    else if (folder === "inbox") files.inbox.push(file);
    else files.proposals.push(file);
  }
  if ((await git(["rev-parse", "HEAD"])).trim() !== head) throw new Error("Studio committed HEAD changed during source lookup; overseer deferred");
  return files;
}
