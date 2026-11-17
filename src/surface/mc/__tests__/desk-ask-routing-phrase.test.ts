import { describe, expect, it } from "bun:test";
import { parserRoutingNotice, parserRoutingPhrase, parserUnavailable, type ParserRouting } from "../desk/parser-routing";
import { DESK_ASK_PHRASE_CODES } from "../desk/phrases";
import { snoozeAt, snoozeTimesAt, SNOOZE_TIMES } from "../desk/mail-snooze-schema";

const selected: ParserRouting = {
  version: 1, kind: "selected", provider: "pi", reason: "pi-fallback", attempted: ["codex", "pi"],
  candidates: [{ substrate: "claude", reason: "not-permitted" }, { substrate: "codex", reason: "capped" }, { substrate: "pi", reason: "eligible" }],
  fallbackReasons: [{ provider: "codex", reason: "quota-exhausted" }], capabilityExclusions: [],
};

describe("parserRoutingPhrase", () => {
  it("names the provider that answered and each unavailable parser with its cause", () => {
    expect(parserRoutingPhrase(selected)).toEqual({ code: "ask.answered", params: { provider: "pi", unavailable: [{ provider: "codex", cause: "quota-exhausted" }] } });
  });
  it("matches the failure case parserRoutingNotice words", () => {
    const cases: [string, string][] = [
      ["invalid-output", "ask.invalid-output"],
      ["parser deadline passed", "ask.timeout"],
      ["all providers attempted", "ask.quota-reached"],
      ["ENOENT", "ask.connection-unavailable"],
      ["something else", "ask.failed"],
    ];
    for (const [reason, code] of cases) {
      const routing = parserUnavailable(reason);
      expect(parserRoutingPhrase(routing)).toEqual({ code } as never);
      expect(DESK_ASK_PHRASE_CODES).toContain(code as never);
      expect(parserRoutingNotice(routing)).not.toContain("No permitted provider");
    }
  });
  it("lists the unavailable parsers when no provider is permitted", () => {
    const routing: ParserRouting = { ...parserUnavailable("no-eligible-substrate"), candidates: [{ substrate: "codex", reason: "not-configured" }] };
    expect(parserRoutingPhrase(routing)).toEqual({ code: "ask.no-provider", params: { unavailable: [{ provider: "codex", cause: "not-configured" }] } });
    expect(parserRoutingNotice(routing)).toContain("No permitted provider is available. Codex is not configured.");
  });
});

describe("snoozeTimesAt", () => {
  it("maps each time choice to what snoozeAt returns at that moment", () => {
    const now = new Date(2026, 10, 17, 10, 7).getTime();
    const times = snoozeTimesAt(now);
    expect(Object.keys(times)).toEqual([...SNOOZE_TIMES]);
    for (const kind of SNOOZE_TIMES) expect(times[kind]).toBe(snoozeAt({ kind }, now)!);
  });
});
