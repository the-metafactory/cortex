// glossary-ignore: node, path
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { isWithin } from "../common/path-containment";

export const somaHome = () => process.env.SOMA_HOME ?? join(homedir(), ".soma");

const TITLE_PREFIX_BYTES = 8 * 1024;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export type SomaFileDirectory = "outputs" | "proposals";

function somaFileTitle(content: string | null, fallback: string): string {
  return content?.replace(FRONTMATTER, "")
    .split(/\r?\n/).find((line) => line.trim() !== "")?.trim().replace(/^#+\s+/, "") ?? fallback;
}

function titleFromPrefix(text: string, truncated: boolean): string | null {
  if (truncated && text.startsWith("---") && !FRONTMATTER.test(text)) return null;
  return somaFileTitle(text, "") || null;
}

function relativeSomaRef(ref: string, directory: SomaFileDirectory): string | null {
  const prefix = `soma:${directory}/`;
  if (!ref.startsWith(prefix)) return null;
  const relative = ref.slice(prefix.length);
  if (!relative || relative.includes("..") || /%(?:25)*2e/i.test(relative) || isAbsolute(relative) || win32.isAbsolute(relative)
    || relative.includes("\\") || /\p{Cc}/u.test(relative)) return null;
  return relative;
}

async function openWithin(root: string, relative: string): Promise<FileHandle | null> {
  let file: FileHandle | null = null;
  try {
    const base = await realpath(root);
    const target = await realpath(join(base, relative));
    if (base === target || !isWithin(base, target)) return null;
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) {
      await file.close();
      return null;
    }
    return file;
  } catch {
    if (file !== null) await file.close().catch(() => undefined);
    return null;
  }
}

async function readTitleWithin(root: string, relative: string): Promise<string | null> {
  const file = await openWithin(root, relative);
  if (file === null) return null;
  try {
    const buffer = Buffer.alloc(TITLE_PREFIX_BYTES);
    const { bytesRead } = await file.read(buffer, 0, TITLE_PREFIX_BYTES, 0);
    return titleFromPrefix(buffer.subarray(0, bytesRead).toString("utf8"), bytesRead === TITLE_PREFIX_BYTES);
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function readSomaFile(ref: string, directory: SomaFileDirectory, home = somaHome()): Promise<string | null> {
  const relative = relativeSomaRef(ref, directory);
  if (relative === null) return null;
  const file = await openWithin(join(home, directory), relative);
  if (file === null) return null;
  try {
    return await file.readFile("utf8");
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

export async function readSomaTitle(ref: string, directory: SomaFileDirectory, home = somaHome()): Promise<string | null> {
  const relative = relativeSomaRef(ref, directory);
  return relative === null ? null : readTitleWithin(join(home, directory), relative);
}

export function readSomaOutputTitle(ref: string, home = somaHome()): Promise<string | null> {
  return readSomaTitle(ref, "outputs", home);
}

export function readSomaProposalTitle(ref: string, home = somaHome()): Promise<string | null> {
  return readSomaTitle(ref, "proposals", home);
}

export async function readSomaGoalTitle(goalId: string, home = somaHome()): Promise<string | null> {
  return /^G\d+$/.test(goalId) ? readTitleWithin(join(home, "profile", "goals"), `${goalId}.md`) : null;
}
