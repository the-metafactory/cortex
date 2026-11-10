import { valid } from "semver";
import { z } from "zod";

export const identifier = z.string().min(1).refine(value => value.trim().length > 0 && value === value.trim());
export const exactVersion = z.string().refine(value => valid(value) === value);
export const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const DESK_ADAPTER_GENERATION_FORMAT = "desk-adapter-generation/1";
