type ParserProvider = "codex" | "pi";

type CandidateProvider = "claude" | ParserProvider;

type CandidateReason = "not-configured" | "not-permitted" | "already-attempted" | "parser-incapable" | "missing-reading" | "stale-reading" | "capped" | "quota-ineligible" | "eligible";

interface ParserRoutingEvidence {
  version: 1;
  attempted: ParserProvider[];
  candidates: { substrate: CandidateProvider; reason: CandidateReason }[];
  fallbackReasons: { provider: ParserProvider; reason: "quota-exhausted" }[];
  capabilityExclusions: { provider: CandidateProvider; reason: string }[];
}

interface ParserRoutingSelected extends ParserRoutingEvidence {
  kind: "selected";
  provider: ParserProvider;
  reason: "most-headroom" | "pi-fallback";
}

interface ParserRoutingUnavailable extends ParserRoutingEvidence {
  kind: "unavailable";
  reason: string;
}

export type ParserRouting = ParserRoutingSelected | ParserRoutingUnavailable;

export type ParserUnavailableCause = CandidateReason | "quota-exhausted";
