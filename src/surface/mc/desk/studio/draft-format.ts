import { createHash } from "node:crypto";
import { z } from "zod";

export const STUDIO_DRAFT_MAX_BYTES = 1_048_576;
export const draftDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const DraftMetadataSchema = z.object({ revision: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
