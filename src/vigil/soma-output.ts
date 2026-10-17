import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { isWithin } from "../common/path-containment";

export const somaHome = () => process.env.SOMA_HOME ?? join(homedir(), ".soma");

const unavailableOutput = (): null => null;

export type SomaFileDirectory = "outputs" | "proposals";

export function somaFileTitle(content: string | null, fallback: string): string {
  return content?.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .split(/\r?\n/).find((line) => line.trim() !== "")?.trim().replace(/^#+\s+/, "") ?? fallback;
}

export async function readSomaFile(ref: string, directory: SomaFileDirectory, home = somaHome()): Promise<string | null> {
  const prefix = `soma:${directory}/`;
  if (!ref.startsWith(prefix)) return null;
  const relative = ref.slice(prefix.length);
  if (!relative || relative.includes("..") || /%(?:25)*2e/i.test(relative) || isAbsolute(relative) || win32.isAbsolute(relative)
    || relative.includes("\\") || /\p{Cc}/u.test(relative)) return null;
  try {
    const root = await realpath(join(home, directory));
    const target = await realpath(join(root, relative));
    if (root === target || !isWithin(root, target)) return null;
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return null;
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return unavailableOutput();
  }
}

export function readSomaOutput(ref: string, home = somaHome()): Promise<string | null> {
  return readSomaFile(ref, "outputs", home);
}
