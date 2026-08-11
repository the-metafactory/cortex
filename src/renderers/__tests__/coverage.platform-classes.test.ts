/**
 * cortex#2503 — the guard must count PLATFORM CLASSES, not `kind` strings.
 *
 * ## The bug these tests pin closed
 *
 * `evaluateSystemCoverage` used to count distinct `renderers[].kind` strings.
 * Since S4/ADR-0024 D5 `RendererKindSchema` is an open `z.string().min(1)`, so
 * "two distinct classes" degenerated into "two distinct arbitrary strings" —
 * and a `discord` + `slack` pair cleared a rule that exists so that ONE vendor
 * outage cannot blind the principal. Both are `chat-gateway`. When that vendor
 * has a bad day both sinks die together and the stack boots believing it is
 * monitored: fail-open, inside a guard whose whole design (ADR-0024 §OQ9) is to
 * fail LOUD rather than page into the void.
 *
 * Every test below is a case the old kind-counting logic got wrong, or a case
 * the fix must NOT break.
 */

import { describe, expect, test } from "bun:test";
import {
  RendererCoverageConfigError,
  RendererCoverageUnclassifiedKindError,
  assertConfiguredSystemCoverage,
  evaluateSystemCoverage,
  platformClassesForKind,
} from "../coverage";

const CTX = { principal: "andreas" } as const;
const SYS = ["local.{principal}.system.>"];
const r = (kind: string) => ({ kind, subscribe: SYS });

describe("platform-class counting (cortex#2503)", () => {
  test("discord + slack is ONE class → refused (the reported fail-open)", () => {
    const v = evaluateSystemCoverage([r("discord"), r("slack")], CTX);
    expect(v.coveringKinds).toEqual(["discord", "slack"]);
    expect(v.coveringClasses).toEqual(["chat-gateway"]);
    expect(v.satisfied).toBe(false);
  });

  test("discord + pagerduty is TWO classes → satisfied", () => {
    const v = evaluateSystemCoverage([r("discord"), r("pagerduty")], CTX);
    expect(v.coveringClasses).toEqual(["chat-gateway", "paging"]);
    expect(v.satisfied).toBe(true);
  });

  test("the canonical dashboard + pagerduty pair still boots (ADR-0024 acc. #5)", () => {
    const v = evaluateSystemCoverage([r("dashboard"), r("pagerduty")], CTX);
    expect(v.satisfied).toBe(true);
  });

  test("dashboard + cli-tail is one class, and all-inert besides → refused", () => {
    const v = evaluateSystemCoverage([r("dashboard"), r("cli-tail")], CTX);
    expect(v.coveringClasses).toEqual(["local-projection"]);
    expect(v.satisfied).toBe(false);
  });

  test("the error names the CLASSES, not just the kinds", () => {
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("discord"), r("slack")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("chat-gateway");
    expect(msg).toContain("PLATFORM CLASSES");
    // It must tell the principal that adding another chat kind won't help.
    expect(msg).toContain("DIFFERENT class");
  });
});

describe("mode-ambiguous kinds cannot satisfy diversity against themselves", () => {
  test("mattermost maps to two classes", () => {
    expect(platformClassesForKind("mattermost")).toEqual(["chat-gateway", "webhook-out"]);
  });

  test("TWO mattermost renderers are still one vendor → refused", () => {
    // This is the trap the two-class mapping would otherwise open: a naive
    // "does the class set have ≥2 entries" check passes here, but both sinks
    // are the same Mattermost deployment.
    const v = evaluateSystemCoverage([r("mattermost"), r("mattermost")], CTX);
    expect(v.satisfied).toBe(false);
  });

  test("mattermost + discord resolves to distinct classes → satisfied", () => {
    // mattermost can take `webhook-out` while discord takes `chat-gateway`.
    const v = evaluateSystemCoverage([r("mattermost"), r("discord")], CTX);
    expect(v.satisfied).toBe(true);
  });
});

describe("unknown kinds are refused, never counted", () => {
  test("an unclassified kind does not become a class of its own", () => {
    const v = evaluateSystemCoverage([r("pagerduty"), r("my-custom-sink")], CTX);
    expect(v.unclassifiedKinds).toEqual(["my-custom-sink"]);
    expect(v.satisfied).toBe(false);
  });

  test("two unclassified kinds cannot fake diversity", () => {
    // The open `RendererKindSchema` means a plugin author can pick any two
    // strings. That must not read as two classes.
    const v = evaluateSystemCoverage([r("sink-a"), r("sink-b")], CTX);
    expect(v.satisfied).toBe(false);
  });

  test("raises a DISTINCT error type — not reported as 'you configured one sink'", () => {
    expect(() => assertConfiguredSystemCoverage([r("pagerduty"), r("weird")], CTX)).toThrow(
      RendererCoverageUnclassifiedKindError,
    );
    // A genuine one-class config is still the config error.
    expect(() => assertConfiguredSystemCoverage([r("discord"), r("slack")], CTX)).toThrow(
      RendererCoverageConfigError,
    );
  });

  test("the unclassified error names the kind and how to fix it", () => {
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("pagerduty"), r("weird")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("weird");
    expect(msg).toContain("PLATFORM_CLASS_BY_KIND");
  });
});

describe("scope is unchanged by this fix", () => {
  test("a stack with no system-covering renderer is still out of scope", () => {
    const v = evaluateSystemCoverage(
      [{ kind: "discord", subscribe: ["local.{principal}.review.>"] }],
      CTX,
    );
    expect(v.inScope).toBe(false);
    expect(v.satisfied).toBe(true);
  });

  test("zero renderers is still out of scope", () => {
    expect(evaluateSystemCoverage([], CTX).satisfied).toBe(true);
  });
});
