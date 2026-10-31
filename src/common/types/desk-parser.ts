import { z } from "zod";

export const ParserProviderSchema = z.enum(["claude", "codex", "pi"]);
export const ParserPermissionsSchema = z.object({ permitted: z.array(ParserProviderSchema).max(3).refine((v) => new Set(v).size === v.length) }).strict();
export type ParserPermissions = z.infer<typeof ParserPermissionsSchema>;
