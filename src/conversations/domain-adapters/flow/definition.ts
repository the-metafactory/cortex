import { parse } from "yaml";

export function definitionName(definition: string): string | undefined {
  try {
    const document: unknown = parse(definition);
    if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
    const name: unknown = (document as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
