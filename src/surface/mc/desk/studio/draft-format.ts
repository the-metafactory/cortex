import { createHash } from "node:crypto";
import { z } from "zod";
import { STUDIO_SLUG } from "./format";
import type { StudioFile } from "./view";

export const STUDIO_DRAFT_MAX_BYTES = 1_048_576;
export const draftDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const DraftMetadataSchema = z.object({ revision: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function validateDraftWrite(file: StudioFile): boolean | null {
  if (!file.path.startsWith("drafts/")) return null;
  const match = /^drafts\/(.+)\.(md|json)$/.exec(file.path);
  if (!match?.[1] || !STUDIO_SLUG.test(match[1])) return false;
  if (match[2] === "md") return Buffer.byteLength(file.text, "utf8") <= STUDIO_DRAFT_MAX_BYTES;
  try {
    return DraftMetadataSchema.safeParse(JSON.parse(file.text)).success;
  } catch {
    return false;
  }
}
