import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StudioFile, StudioFiles, StudioProblem } from "./view";

export const STUDIO_MAX_FILE_BYTES = 1_000_000;

const errCode = (err: unknown): string => (err && typeof err === "object" && "code" in err ? String(err.code) : "");
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function readFolder(dir: string, folder: string, problems: StudioProblem[]): Promise<StudioFile[]> {
  let names: string[];
  try {
    names = await readdir(join(dir, folder));
  } catch (err) {
    if (errCode(err) !== "ENOENT") problems.push({ path: `${folder}/`, reason: `could not be listed: ${message(err)}` });
    return [];
  }
  const files: StudioFile[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const path = `${folder}/${name}`;
    try {
      const info = await stat(join(dir, path));
      if (!info.isFile()) continue;
      if (info.size > STUDIO_MAX_FILE_BYTES) {
        problems.push({ path, reason: `is larger than ${STUDIO_MAX_FILE_BYTES} bytes` });
        continue;
      }
      files.push({ path, text: await readFile(join(dir, path), "utf8") });
    } catch (err) {
      problems.push({ path, reason: `could not be read: ${message(err)}` });
    }
  }
  return files;
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
  const [threads, inbox, proposals] = [
    await readFolder(dir, "threads", problems),
    await readFolder(dir, "inbox", problems),
    await readFolder(dir, "proposals", problems),
  ];
  return { files: { threads, inbox, proposals }, problems };
}
