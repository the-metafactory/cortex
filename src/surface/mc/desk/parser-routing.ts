import { z } from "zod";

import { ParserProviderSchema } from "../../../common/types/desk-parser";

const reason = z.string().trim().min(1).max(200);
const evidence = {
  version: z.literal(1),
  attempted: z.array(ParserProviderSchema).max(3).refine((v) => new Set(v).size === v.length),
  candidates: z.array(z.object({ substrate: ParserProviderSchema, reason: z.enum(["not-configured", "not-permitted", "already-attempted", "parser-incapable", "missing-reading", "stale-reading", "capped", "quota-ineligible", "eligible"]) }).strict()).max(3).refine((v) => new Set(v.map((c) => c.substrate)).size === v.length),
  fallbackReasons: z.array(z.object({ provider: ParserProviderSchema, reason: z.literal("quota-exhausted") }).strict()).max(3),
  capabilityExclusions: z.array(z.object({ provider: ParserProviderSchema, reason }).strict()).max(3),
};

export const ParserRoutingSchema = z.discriminatedUnion("kind", [
  z.object({ ...evidence, kind: z.literal("selected"), provider: ParserProviderSchema, reason: z.enum(["most-headroom", "pi-fallback"]) }).strict(),
  z.object({ ...evidence, kind: z.literal("unavailable"), reason }).strict(),
]).superRefine((v, ctx) => {
  if (v.kind === "selected" && (v.candidates.length !== 3 || v.attempted.at(-1) !== v.provider || !v.candidates.some((c) => c.substrate === v.provider && c.reason === "eligible") || (v.reason === "pi-fallback") !== (v.provider === "pi"))) {
    ctx.addIssue({ code: "custom", message: "inconsistent selected provider" });
  }
});
export type ParserRouting = z.infer<typeof ParserRoutingSchema>;
export type SelectedParserRouting = Extract<ParserRouting, { kind: "selected" }>;

export const parserUnavailable = (reason: string): Extract<ParserRouting, { kind: "unavailable" }> => ({ version: 1, kind: "unavailable", reason, attempted: [], candidates: [], fallbackReasons: [], capabilityExclusions: [] });
const names = { claude: "Claude", codex: "Codex", pi: "Pi" };
const causes: Record<string, string> = {
  capped: "has reached its usage limit",
  "quota-ineligible": "has too little allowance left",
  "missing-reading": "has no usage reading",
  "stale-reading": "has an out-of-date usage reading",
  "quota-exhausted": "reached its usage limit while answering",
  "parser-incapable": "cannot answer with tools disabled",
  "not-permitted": "is excluded by this request's permissions",
  "not-configured": "is not configured",
};

export function parserRoutingNotice(routing: ParserRouting): string {
  const reasons = new Map<z.infer<typeof ParserProviderSchema>, string>(routing.candidates.filter((c) => c.reason !== "eligible" && c.reason !== "already-attempted").map((c) => [c.substrate, c.reason]));
  for (const fallback of routing.fallbackReasons) reasons.set(fallback.provider, fallback.reason);
  const why = [...reasons].map(([provider, cause]) => `${names[provider]} ${causes[cause] ?? "is unavailable"}`).join("; ");
  if (routing.kind === "selected") return `Answered by ${names[routing.provider]}.${why ? ` ${why}.` : ""}`;
  if (routing.reason === "no-eligible-substrate") return `No permitted provider is available.${why ? ` ${why}.` : ""} Wait for availability or ask the person who manages this stack to check provider permissions and usage readings.`;
  if (routing.reason === "invalid-output") return "The parser returned an incomplete or invalid answer. Nothing was created. Try again or ask the person who manages this stack to check the parser connection.";
  if (/deadline|timeout/i.test(routing.reason)) return "The parser took too long to answer. Nothing was created. Try a shorter request or try again later.";
  if (/quota|all providers attempted/i.test(routing.reason)) return "The permitted providers reached their usage limits. Nothing was created. Wait for allowance to reset or ask the person who manages this stack to check alternatives.";
  if (/integration|selector|command|ENOENT|configuration/i.test(routing.reason)) return "The parser connection is unavailable. Nothing was created. Ask the person who manages this stack to check the configured parser and provider connections.";
  return "The provider could not finish this request. Nothing was created. Try again or ask the person who manages this stack to check provider availability and the parser connection.";
}
