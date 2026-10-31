import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StudioFile, StudioFiles, StudioProblem } from "./view";

export const STUDIO_MAX_FILE_BYTES = 1_000_000;

const errCode = (err: unknown): string => (err && typeof err === "object" && "code" in err ? String(err.code) : "");
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readFolder(dir: string, folder: string): Promise<{ files: StudioFile[]; problems: StudioProblem[] }> {
  const problems: StudioProblem[] = [];
  let names: string[];
  try {
    names = await readdir(join(dir, folder));
  } catch (err) {
    return { files: [], problems: errCode(err) === "ENOENT" ? [] : [{ path: `${folder}/`, reason: `could not be listed: ${message(err)}` }] };
  }
  const read = async (name: string): Promise<StudioFile | StudioProblem | null> => {
    const path = `${folder}/${name}`;
    try {
      const info = await stat(join(dir, path));
      if (!info.isFile()) return null;
      if (info.size > STUDIO_MAX_FILE_BYTES) return { path, reason: `is larger than ${STUDIO_MAX_FILE_BYTES} bytes` };
      return { path, text: await readFile(join(dir, path), "utf8") };
    } catch (err) {
      return { path, reason: `could not be read: ${message(err)}` };
    }
  };
  const results = await Promise.all(names.filter((n) => n.endsWith(".md")).sort().map(read));
  const files: StudioFile[] = [];
  for (const r of results) {
    if (r === null) continue;
    if ("text" in r) files.push(r);
    else problems.push(r);
  }
  return { files, problems };
}

export async function readStudioFiles(dir: string): Promise<{ files: StudioFiles; problems: StudioProblem[] }> {
  const problems: StudioProblem[] = [];
  const empty = { threads: [], inbox: [], proposals: [] };
  try {
    if (!(await stat(dir)).isDirectory()) return { files: empty, problems: [{ path: ".", reason: "desk.studio.dir is not a directory" }] };
  } catch (err) {
    return { files: empty, problems: [{ path: ".", reason: `desk.studio.dir could not be opened: ${message(err)}` }] };
  }
  try {
    await stat(join(dir, ".git"));
  } catch {
    problems.push({ path: ".", reason: "desk.studio.dir is not a git working tree; later Studio writes need one" });
  }
  const [threads, inbox, proposals] = await Promise.all([readFolder(dir, "threads"), readFolder(dir, "inbox"), readFolder(dir, "proposals")]);
  return {
    files: { threads: threads.files, inbox: inbox.files, proposals: proposals.files },
    problems: [...problems, ...threads.problems, ...inbox.problems, ...proposals.problems],
  };
}
