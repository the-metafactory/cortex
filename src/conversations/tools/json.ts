export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const rec = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
export const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
export const str = (value: unknown): string | null => typeof value === "string" ? value : null;
export const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
