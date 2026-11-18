import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeskStudioDraft, DeskStudioDraftWrite } from "../../../../desk-api";
import { parseThreadFile, STUDIO_SLUG } from "./format";
import { draftDigest, DraftMetadataSchema, STUDIO_DRAFT_MAX_BYTES } from "./draft-format";
import { spawnGit } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";
import { runStudioTransaction, withStudioLock, type StudioWriteInput } from "./writer";

type DraftInput = Omit<StudioWriteInput, "act" | "requestId"> & { thread: string };
interface DraftFailure { ok: false; status: number; error: string }
export type DraftResult = { ok: true; draft: DeskStudioDraft } | DraftFailure | (DraftFailure & DeskStudioDraft);

const missing = (error: unknown): boolean => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

async function optionalFile(path: string, maxBytes: number): Promise<string | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (!info.isFile() || info.size > maxBytes) throw new Error("A Studio draft file is not a regular file within its size limit.");
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error("A Studio draft file exceeds its size limit.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function readDraft(input: DraftInput): Promise<DraftResult> {
  if (!STUDIO_SLUG.test(input.thread)) return { ok: false, status: 400, error: "Invalid Studio thread slug." };
  const threadPath = `threads/${input.thread}.md`;
  const source = await optionalFile(join(input.options.dir, threadPath), STUDIO_MAX_FILE_BYTES);
  if (source === null) return { ok: false, status: 404, error: "No such Studio thread." };
  const parsed = parseThreadFile(threadPath, source, input.assistantName);
  if (!parsed.ok) throw new Error(`The Studio thread could not be read: ${parsed.reason}`);
  try {
    const folder = await lstat(join(input.options.dir, "drafts"));
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("The Studio drafts path is not a directory.");
  } catch (error) { if (!missing(error)) throw error; }
  const text = await optionalFile(join(input.options.dir, `drafts/${input.thread}.md`), STUDIO_DRAFT_MAX_BYTES);
  const metadata = await optionalFile(join(input.options.dir, `drafts/${input.thread}.json`), 1024);
  const editable = parsed.value.state === "active";
  if (text === null && metadata === null) {
    const history = await (input.git ?? spawnGit)(["log", "-1", "--format=%H", "--", `drafts/${input.thread}.md`, `drafts/${input.thread}.json`], input.options.dir);
    if (history.code !== 0 || history.stdout.trim()) throw new Error("A previously saved Studio draft is missing or its history could not be read.");
    const birth = await (input.git ?? spawnGit)(["log", "-1", "--diff-filter=A", "--format=%H", "--", threadPath], input.options.dir);
    if (birth.code !== 0 || !/^[a-f0-9]{40,64}$/.test(birth.stdout.trim())) throw new Error("The Studio thread's persisted creation revision could not be read.");
    return { ok: true, draft: { text: "", revision: draftDigest(`studio-draft:${input.thread}:${birth.stdout.trim()}`), editable } };
  }
  if (text === null || metadata === null) throw new Error("Studio draft text or revision metadata is missing.");
  const meta = DraftMetadataSchema.parse(JSON.parse(metadata));
  if (meta.digest !== draftDigest(text)) throw new Error("Studio draft text does not match its revision metadata.");
  return { ok: true, draft: { text, revision: meta.revision, editable } };
}

export async function getStudioDraft(input: DraftInput): Promise<DraftResult> {
  return withStudioLock(input, () => readDraft(input), true);
}

export async function saveStudioDraft(input: DraftInput & DeskStudioDraftWrite): Promise<DraftResult> {
  return runStudioTransaction(input, async () => {
    const current = await readDraft(input);
    if (!current.ok) return current;
    if (!current.draft.editable) return { status: 409, error: "Only active Studio drafts are editable." };
    if (input.revision !== current.draft.revision) return { status: 409, error: "The Studio draft changed. Read it before saving again." };
    const revision = randomUUID();
    return {
      writes: [
        { path: `drafts/${input.thread}.md`, text: input.text },
        { path: `drafts/${input.thread}.json`, text: `${JSON.stringify({ revision, digest: draftDigest(input.text) })}\n` },
      ],
      removes: [],
      subject: `Save draft for ${input.thread}`,
      message: "Studio draft saved.",
    };
  }, async result => {
    const current = await readDraft(input);
    if (!current.ok) return current;
    if (!current.draft.editable) return { ok: false, status: 409, error: "Only active Studio drafts are editable.", ...current.draft };
    if (!result.ok) return { ...result, ...(result.status === 409 ? current.draft : {}) };
    return current;
  });
}
