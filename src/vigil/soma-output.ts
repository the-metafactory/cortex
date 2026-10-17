import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { isWithin } from "../common/path-containment";

export const somaHome = () => process.env.SOMA_HOME ?? join(homedir(), ".soma");

const unavailableOutput = (): null => null;

export async function readSomaOutput(ref: string, home = somaHome()): Promise<string | null> {
  const prefix = "soma:outputs/";
  if (!ref.startsWith(prefix)) return null;
  const relative = ref.slice(prefix.length);
  if (!relative || relative.includes("..") || isAbsolute(relative) || win32.isAbsolute(relative)
    || relative.includes("\\") || /\p{Cc}/u.test(relative)) return null;
  try {
    const root = await realpath(join(home, "outputs"));
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
