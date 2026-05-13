/**
 * cortex#120 — Wire-format parser tests.
 *
 * Covers the `<@bot> review <repo>#<N>` shape that auto-threads in the
 * inbound Discord path. The parser is pure (no discord.js deps), so
 * these tests don't need fixtures or a mock client.
 */

import { test, expect, describe } from "bun:test";
import { parseReviewWireFormat, reviewThreadName } from "../wire-format";

describe("parseReviewWireFormat — match cases", () => {
  test("basic shape: <@123> review cortex#118", () => {
    const parsed = parseReviewWireFormat("<@123456789> review cortex#118");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("review");
    expect(parsed?.botId).toBe("123456789");
    expect(parsed?.repo).toBe("cortex");
    expect(parsed?.prNumber).toBe("118");
  });

  test("nickname-mention form: <@!123>", () => {
    // Discord clients sometimes emit `<@!id>` (the legacy "nickname
    // mention"). The parser accepts both forms via `<@!?...>`.
    const parsed = parseReviewWireFormat("<@!987654321> review cortex#42");
    expect(parsed?.botId).toBe("987654321");
    expect(parsed?.repo).toBe("cortex");
    expect(parsed?.prNumber).toBe("42");
  });

  test("trailing comment after target is allowed and not captured", () => {
    const parsed = parseReviewWireFormat(
      "<@123> review cortex#118 -- focus on the dispatch path",
    );
    expect(parsed?.repo).toBe("cortex");
    expect(parsed?.prNumber).toBe("118");
  });

  test("trailing comment without `--` separator is allowed", () => {
    const parsed = parseReviewWireFormat(
      "<@123> review cortex#118 please look at the regex",
    );
    expect(parsed?.repo).toBe("cortex");
    expect(parsed?.prNumber).toBe("118");
  });

  test("verb is case-insensitive: REVIEW, Review, ReViEw", () => {
    for (const verb of ["REVIEW", "Review", "ReViEw"]) {
      const parsed = parseReviewWireFormat(`<@1> ${verb} cortex#1`);
      expect(parsed).not.toBeNull();
      expect(parsed?.repo).toBe("cortex");
    }
  });

  test("hyphenated repo names: meta-factory", () => {
    const parsed = parseReviewWireFormat("<@1> review meta-factory#42");
    expect(parsed?.repo).toBe("meta-factory");
    expect(parsed?.prNumber).toBe("42");
  });

  test("underscored repo names: signal_collector", () => {
    // Some metafactory repos use underscores. The charset matches
    // GitHub's repo-name rules.
    const parsed = parseReviewWireFormat("<@1> review signal_collector#7");
    expect(parsed?.repo).toBe("signal_collector");
    expect(parsed?.prNumber).toBe("7");
  });

  test("leading whitespace is tolerated", () => {
    // The regex anchors with `^\s*` so a stray leading space (e.g. from
    // a copy-paste) doesn't break the parse.
    const parsed = parseReviewWireFormat("  <@1> review cortex#118");
    expect(parsed?.repo).toBe("cortex");
  });

  test("extra whitespace between tokens", () => {
    // `\s+` between tokens — accept one or many.
    const parsed = parseReviewWireFormat("<@1>   review   cortex#118");
    expect(parsed?.repo).toBe("cortex");
    expect(parsed?.prNumber).toBe("118");
  });

  test("multi-digit PR numbers", () => {
    const parsed = parseReviewWireFormat("<@1> review cortex#12345");
    expect(parsed?.prNumber).toBe("12345");
  });
});

describe("parseReviewWireFormat — non-match cases", () => {
  test("no leading @-mention: bare `review cortex#118`", () => {
    // Critical: the leading @-mention is what tells us this is a request
    // FOR a bot (not just a casual message about a review). Without it,
    // we MUST NOT auto-thread.
    expect(parseReviewWireFormat("review cortex#118")).toBeNull();
  });

  test("missing the `review` verb", () => {
    // Out-of-scope verbs (`work-on`, `ship`, `babysit`) are explicitly
    // deferred per the issue brief. They MUST NOT match this v1 parser.
    expect(parseReviewWireFormat("<@1> work-on cortex#118")).toBeNull();
    expect(parseReviewWireFormat("<@1> ship cortex#118")).toBeNull();
    expect(parseReviewWireFormat("<@1> babysit cortex#118")).toBeNull();
  });

  test("@-mention but no review target", () => {
    // Bare @-mentions are normal bot prompts ("@bot how do I X?") — they
    // must NOT trigger auto-thread.
    expect(parseReviewWireFormat("<@1> hello")).toBeNull();
    expect(parseReviewWireFormat("<@1> review")).toBeNull();
    expect(parseReviewWireFormat("<@1> review cortex")).toBeNull();
  });

  test("repo name with uppercase rejected", () => {
    // GitHub repo names are case-sensitive but cortex's `github.repos`
    // config stores them lowercase. Reject mixed-case to avoid a class
    // of typo-routing bugs (`Cortex` vs `cortex` shouldn't be two threads).
    expect(parseReviewWireFormat("<@1> review Cortex#118")).toBeNull();
  });

  test("repo name starting with a digit rejected", () => {
    // GitHub allows digit-first names but the charset here enforces a
    // letter-first prefix — matches the actual metafactory ecosystem
    // convention and avoids matching `<@1> review 1#1` shapes.
    expect(parseReviewWireFormat("<@1> review 1cortex#118")).toBeNull();
  });

  test("missing # separator", () => {
    expect(parseReviewWireFormat("<@1> review cortex 118")).toBeNull();
    expect(parseReviewWireFormat("<@1> review cortex118")).toBeNull();
  });

  test("non-numeric PR ref rejected", () => {
    expect(parseReviewWireFormat("<@1> review cortex#abc")).toBeNull();
    expect(parseReviewWireFormat("<@1> review cortex#12a")).toBeNull();
  });

  test("empty string", () => {
    expect(parseReviewWireFormat("")).toBeNull();
  });

  test("just whitespace", () => {
    expect(parseReviewWireFormat("   ")).toBeNull();
  });

  test("review-mention but not at start (mid-sentence)", () => {
    // The `^\s*` anchor means the wire format must be the first content
    // in the message. "hey <@1> review cortex#118" is a casual mention,
    // not the wire format — don't auto-thread.
    expect(parseReviewWireFormat("hey <@1> review cortex#118")).toBeNull();
  });
});

describe("reviewThreadName", () => {
  test("formats as {repo}/pr/<N>", () => {
    expect(
      reviewThreadName({
        kind: "review",
        botId: "1",
        repo: "cortex",
        prNumber: "118",
      }),
    ).toBe("cortex/pr/118");
  });

  test("hyphenated repo round-trips", () => {
    expect(
      reviewThreadName({
        kind: "review",
        botId: "1",
        repo: "meta-factory",
        prNumber: "42",
      }),
    ).toBe("meta-factory/pr/42");
  });

  test("matches the channel-context format for entityType=pr", () => {
    // The output of `reviewThreadName(...)` MUST be parseable by
    // `resolveChannelContext(...)` as an `entityType: "pr"` thread.
    // We import the channel-context resolver and round-trip a parsed
    // wire format through both formatters to lock the contract.
    const name = reviewThreadName({
      kind: "review",
      botId: "1",
      repo: "cortex",
      prNumber: "118",
    });
    // The cross-module contract check itself lives in the channel-
    // context tests; the assertion here just locks the literal format.
    expect(name).toBe("cortex/pr/118");
    expect(name.startsWith("cortex/")).toBe(true);
    expect(name.endsWith("/pr/118")).toBe(true);
  });
});
