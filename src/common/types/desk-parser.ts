import { z } from "zod";

export const ParserProviderSchema = z.enum(["codex", "pi"]);
export const MAX_PARSER_PROVIDERS = ParserProviderSchema.options.length;
export const ParserPermissionsSchema = z.object({ permitted: z.array(ParserProviderSchema).max(MAX_PARSER_PROVIDERS).refine((v) => new Set(v).size === v.length) }).strict();
export type ParserPermissions = z.infer<typeof ParserPermissionsSchema>;
