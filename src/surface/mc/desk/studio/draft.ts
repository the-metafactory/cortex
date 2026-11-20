import { randomUUID } from "node:crypto";
import type { DeskStudioDraftWrite } from "../../../../desk-api";
import { STUDIO_SLUG } from "./format";
import { DRAFT_ATTRIBUTES_FILE, draftDigest, hasFinalDraftRule, withDraftAttributes, draftPaths, DraftMetadataSchema, STUDIO_DRAFT_MAX_BYTES } from "./draft-format";
import { writeStudioTransaction, withStudioLock } from "./writer";
import { optionalStudioFile, readStudioDraftUnlocked, type DraftInput, type DraftResult } from "./draft-read";
import type { StudioFile } from "./view";
import { join } from "node:path";

export type { DraftResult } from "./draft-read";
const DRAFT_ATTRIBUTES_MAX_BYTES = 65_536;
const NOT_EDITABLE = "Only active Studio drafts are editable.";

function validateDraftWrite(file: StudioFile): string | null {
  if (file.path === DRAFT_ATTRIBUTES_FILE) return hasFinalDraftRule(file.text) ? null : "The draft plan is invalid; nothing was written.";
  const match = /^drafts\/(.+)\.(md|json)$/.exec(file.path);
  const invalid = "The draft plan is invalid; nothing was written.";
  if (!match?.[1] || !STUDIO_SLUG.test(match[1])) return invalid;
  if (match[2] === "md") return Buffer.byteLength(file.text, "utf8") <= STUDIO_DRAFT_MAX_BYTES ? null : invalid;
  try {
    return DraftMetadataSchema.safeParse(JSON.parse(file.text)).success ? null : invalid;
  } catch {
    return invalid;
  }
}

export async function getStudioDraft(input: DraftInput): Promise<DraftResult> {
  return withStudioLock(input, () => readStudioDraftUnlocked(input), true);
}

export async function saveStudioDraft(input: DraftInput & DeskStudioDraftWrite): Promise<DraftResult> {
  return writeStudioTransaction(input, async () => {
    const current = await readStudioDraftUnlocked(input);
    if (!current.ok) return current;
    if (!current.draft.editable) return { status: 409, error: NOT_EDITABLE };
    if (input.revision !== current.draft.revision) return { status: 409, error: "The Studio draft changed. Read it before saving again." };
    const revision = randomUUID();
    const attributes = withDraftAttributes(await optionalStudioFile(join(input.options.dir, DRAFT_ATTRIBUTES_FILE), DRAFT_ATTRIBUTES_MAX_BYTES));
    if (attributes !== null && Buffer.byteLength(attributes, "utf8") > DRAFT_ATTRIBUTES_MAX_BYTES) throw new Error("The Studio drafts attributes file would exceed its size limit.");
    return {
      writes: [
        ...(attributes === null ? [] : [{ path: DRAFT_ATTRIBUTES_FILE, text: attributes }]),
        { path: draftPaths(input.thread).text, text: input.text },
        { path: draftPaths(input.thread).meta, text: `${JSON.stringify({ revision, digest: draftDigest(input.text) })}\n` },
      ],
      removes: [],
      subject: `Save draft for ${input.thread}`,
      message: "Studio draft saved.",
    };
  }, { wait: true, validateWrite: validateDraftWrite, project: async result => {
    const current = await readStudioDraftUnlocked(input);
    if (!current.ok) return current;
    if (!current.draft.editable) return { ok: false, status: 409, error: NOT_EDITABLE, ...current.draft };
    if (!result.ok) return { ...result, ...(result.status === 409 ? current.draft : {}) };
    return current;
  } });
}
