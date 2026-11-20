import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeskStudioDraft } from "../../../../desk-api";
import { parseThreadFile, STUDIO_SLUG } from "./format";
import { draftDigest, draftPaths, DraftMetadataSchema, STUDIO_DRAFT_MAX_BYTES } from "./draft-format";
import { spawnGit, type GitRunner } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";
import type { StudioWriteInput } from "./writer";
import { errnoIs } from "./file-error";

export type DraftInput = Omit<StudioWriteInput, "act" | "requestId"> & { thread: string };
interface DraftFailure { ok: false; status: number; error: string }
export type DraftResult = { ok: true; draft: DeskStudioDraft; legacy: boolean } | DraftFailure | (DraftFailure & DeskStudioDraft);

const legacyRevisions = new WeakMap<GitRunner, Map<string, { head: string; revision: string }>>();

async function legacyRevision(git: GitRunner, dir: string, thread: string, threadPath: string): Promise<string> {
  const head = await git(["rev-parse", "--verify", "HEAD"], dir);
  if (head.code !== 0) throw new Error("The Studio history could not be read.");
  let cache = legacyRevisions.get(git);
  if (!cache) { cache = new Map(); legacyRevisions.set(git, cache); }
  const key = join(dir, threadPath);
  const cached = cache.get(key);
  if (cached?.head === head.stdout) return cached.revision;
  const history = await git(["log", "-1", "--format=%H", "--", draftPaths(thread).text, draftPaths(thread).meta], dir);
  if (history.code !== 0 || history.stdout.trim()) throw new Error("A previously saved Studio draft is missing or its history could not be read.");
  const birth = await git(["log", "-1", "--diff-filter=A", "--format=%H", "--", threadPath], dir);
  if (birth.code !== 0 || !/^[a-f0-9]{40,64}$/.test(birth.stdout.trim())) throw new Error("The Studio thread's persisted creation revision could not be read.");
  const revision = draftDigest(`studio-draft:${thread}:${birth.stdout.trim()}`);
  if (cache.size >= 256) cache.clear();
  cache.set(key, { head: head.stdout, revision });
  return revision;
}

export async function optionalStudioFile(path: string, maxBytes: number): Promise<string | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (errnoIs(error, "ENOENT")) return null;
    throw error;
  }
  if (!info.isFile() || info.size > maxBytes) throw new Error("A Studio draft file is not a regular file within its size limit.");
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error("A Studio draft file exceeds its size limit.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function readStudioDraftThread(input: DraftInput) {
  if (!STUDIO_SLUG.test(input.thread)) return { ok: false as const, status: 400, error: "Invalid Studio thread slug." };
  const threadPath = `threads/${input.thread}.md`;
  const source = await optionalStudioFile(join(input.options.dir, threadPath), STUDIO_MAX_FILE_BYTES);
  if (source === null) return { ok: false as const, status: 404, error: "No such Studio thread." };
  const parsed = parseThreadFile(threadPath, source, input.assistantName);
  if (!parsed.ok) throw new Error(`The Studio thread could not be read: ${parsed.reason}`);
  return { ok: true as const, thread: parsed.value };
}

export async function readStudioDraftUnlocked(input: DraftInput): Promise<DraftResult> {
  const git = input.git ?? spawnGit;
  const found = await readStudioDraftThread(input);
  if (!found.ok) return found;
  const threadPath = `threads/${input.thread}.md`;
  try {
    const folder = await lstat(join(input.options.dir, "drafts"));
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("The Studio drafts path is not a directory.");
  } catch (error) { if (!errnoIs(error, "ENOENT")) throw error; }
  const text = await optionalStudioFile(join(input.options.dir, draftPaths(input.thread).text), STUDIO_DRAFT_MAX_BYTES);
  const metadata = await optionalStudioFile(join(input.options.dir, draftPaths(input.thread).meta), 1024);
  const editable = found.thread.state === "active";
  if (text === null && metadata === null) {
    return { ok: true, legacy: true, draft: { text: "", revision: await legacyRevision(git, input.options.dir, input.thread, threadPath), editable } };
  }
  if (text === null || metadata === null) throw new Error("Studio draft text or revision metadata is missing.");
  const meta = DraftMetadataSchema.parse(JSON.parse(metadata));
  if (meta.digest !== draftDigest(text)) throw new Error("Studio draft text does not match its revision metadata.");
  return { ok: true, legacy: false, draft: { text, revision: meta.revision, editable } };
}

