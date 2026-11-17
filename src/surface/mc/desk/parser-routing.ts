import { z } from "zod";

import { MAX_PARSER_PROVIDERS, ParserProviderSchema } from "../../../common/types/desk-parser";
import type { Expect, SameShape } from "../../../common/types/same-shape";
import type { ParserRouting as WireParserRouting, ParserUnavailableCause } from "../../../desk-api/wire/parser-routing";
import type { DeskPhrase, UnavailableParser } from "../../../desk-api/wire/phrases";

const reason = z.string().trim().min(1).max(200);
const RangerCandidateProviderSchema = z.enum(["claude", ...ParserProviderSchema.options]);
const MAX_CANDIDATE_PROVIDERS = RangerCandidateProviderSchema.options.length;
const evidence = {
  version: z.literal(1),
  attempted: z.array(ParserProviderSchema).max(MAX_PARSER_PROVIDERS).refine((v) => new Set(v).size === v.length),
  candidates: z.array(z.object({ substrate: RangerCandidateProviderSchema, reason: z.enum(["not-configured", "not-permitted", "already-attempted", "parser-incapable", "missing-reading", "stale-reading", "capped", "quota-ineligible", "eligible"]) }).strict()).max(MAX_CANDIDATE_PROVIDERS).refine((v) => new Set(v.map((c) => c.substrate)).size === v.length),
  fallbackReasons: z.array(z.object({ provider: ParserProviderSchema, reason: z.literal("quota-exhausted") }).strict()).max(MAX_PARSER_PROVIDERS).refine((v) => new Set(v.map((c) => c.provider)).size === v.length),
  capabilityExclusions: z.array(z.object({ provider: RangerCandidateProviderSchema, reason }).strict()).max(MAX_CANDIDATE_PROVIDERS),
};

export const ParserRoutingSchema = z.discriminatedUnion("kind", [
  z.object({ ...evidence, kind: z.literal("selected"), provider: ParserProviderSchema, reason: z.enum(["most-headroom", "pi-fallback"]) }).strict(),
  z.object({ ...evidence, kind: z.literal("unavailable"), reason }).strict(),
]).superRefine((v, ctx) => {
  if (v.fallbackReasons.some((f) => !v.attempted.includes(f.provider) || (v.kind === "selected" && f.provider === v.provider))) {
    ctx.addIssue({ code: "custom", message: "inconsistent fallback attempts" });
  }
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

type UnavailableCase = "no-provider" | "invalid-output" | "timeout" | "quota-reached" | "connection-unavailable" | "failed";

function unavailableCase(reason: string): UnavailableCase {
  if (reason === "no-eligible-substrate") return "no-provider";
  if (reason === "invalid-output") return "invalid-output";
  if (/deadline|timeout/i.test(reason)) return "timeout";
  if (/quota|all providers attempted/i.test(reason)) return "quota-reached";
  if (/integration|selector|command|ENOENT|configuration/i.test(reason)) return "connection-unavailable";
  return "failed";
}

const unavailableParsers = (routing: ParserRouting): UnavailableParser[] => {
  const causeOf = new Map<z.infer<typeof RangerCandidateProviderSchema>, ParserUnavailableCause>(routing.candidates.filter((c) => c.substrate !== "claude" && c.reason !== "eligible" && c.reason !== "already-attempted").map((c) => [c.substrate, c.reason]));
  for (const fallback of routing.fallbackReasons) causeOf.set(fallback.provider, fallback.reason);
  return [...causeOf].map(([provider, cause]) => ({ provider, cause }));
};

const NOTICES: Record<Exclude<UnavailableCase, "no-provider">, string> = {
  "invalid-output": "The parser returned an incomplete or invalid answer. Nothing was created. Try again or ask the person who manages this stack to check the parser connection.",
  timeout: "The parser took too long to answer. Nothing was created. Try a shorter request or try again later.",
  "quota-reached": "The permitted providers reached their usage limits. Nothing was created. Wait for allowance to reset or ask the person who manages this stack to check alternatives.",
  "connection-unavailable": "The parser connection is unavailable. Nothing was created. Ask the person who manages this stack to check the configured parser and provider connections.",
  failed: "The provider could not finish this request. Nothing was created. Try again or ask the person who manages this stack to check provider availability and the parser connection.",
};

export function parserRoutingNotice(routing: ParserRouting): string {
  const why = unavailableParsers(routing).map(({ provider, cause }) => `${names[provider]} ${causes[cause] ?? "is unavailable"}`).join("; ");
  if (routing.kind === "selected") return `Answered by ${names[routing.provider]}.${why ? ` ${why}.` : ""}`;
  const failure = unavailableCase(routing.reason);
  if (failure === "no-provider") return `No permitted provider is available.${why ? ` ${why}.` : ""} Wait for availability or ask the person who manages this stack to check provider permissions and usage readings.`;
  return NOTICES[failure];
}

export function parserRoutingPhrase(routing: ParserRouting): DeskPhrase {
  if (routing.kind === "selected") return { code: "ask.answered", params: { provider: routing.provider, unavailable: unavailableParsers(routing) } };
  const failure = unavailableCase(routing.reason);
  return failure === "no-provider" ? { code: "ask.no-provider", params: { unavailable: unavailableParsers(routing) } } : { code: `ask.${failure}` };
}

type _WireParserRouting = Expect<SameShape<ParserRouting, WireParserRouting>>;
