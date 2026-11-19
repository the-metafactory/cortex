import { createHash } from "node:crypto";
import { z } from "zod";

export const STUDIO_DRAFT_MAX_BYTES = 1_048_576;
export const draftDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const DraftMetadataSchema = z.object({ revision: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export const DRAFT_ATTRIBUTES_PATH = "drafts/.gitattributes";
export const DRAFT_ATTRIBUTES_TEXT = "* -text -diff -filter\n";
export const draftPaths = (thread: string): { text: string; meta: string } => ({ text: `drafts/${thread}.md`, meta: `drafts/${thread}.json` });
