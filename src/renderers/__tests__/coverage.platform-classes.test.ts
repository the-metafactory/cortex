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
  PLATFORM_CLASS_BY_KIND,
  RendererCoverageConfigError,
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
    // NOT `toContain("chat-gateway")` — RULE_PREAMBLE prints the whole class
    // table on every failure, so that assertion passes no matter what the
    // verdict said. Assert on the line that reports THIS config's classes.
    expect(msg).toContain("Platform class(es) present: [chat-gateway]");
    expect(msg).toContain("PLATFORM CLASSES");
    // It must tell the principal that adding another chat kind won't help.
    expect(msg).toContain("CANNOT overlap");
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

  test("mattermost + discord is REFUSED — ambiguity resolves against the config", () => {
    // Tempting to pass by assigning mattermost=webhook-out. But if that
    // mattermost is running in bot mode, both sinks are chat gateways and one
    // vendor outage takes out both. A fail-closed guard cannot assume the
    // mode that makes the config pass.
    const v = evaluateSystemCoverage([r("mattermost"), r("discord")], CTX);
    expect(v.satisfied).toBe(false);
  });

  test("mattermost + pagerduty IS satisfied — class sets are disjoint", () => {
    // No mode of mattermost is `paging`, so diversity holds either way.
    const v = evaluateSystemCoverage([r("mattermost"), r("pagerduty")], CTX);
    expect(v.satisfied).toBe(true);
  });

  test("the error does not claim 'fewer than two classes' while listing two", () => {
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("mattermost"), r("discord")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("DISJOINT");
    expect(msg).not.toContain("fewer than the two required");
  });
});

describe("prototype keys are not classified kinds", () => {
  for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    test(`\`${evil}\` resolves to undefined, not an Object.prototype member`, () => {
      expect(platformClassesForKind(evil)).toBeUndefined();
    });
  }

  test("a renderer kind named `constructor` cannot fake a class", () => {
    const v = evaluateSystemCoverage([r("constructor"), r("toString")], CTX);
    expect(v.satisfied).toBe(false);
  });
});

describe("unknown kinds are refused, never counted", () => {
  test("an unclassified kind does not become a class of its own", () => {
    const v = evaluateSystemCoverage([r("pagerduty"), r("my-custom-sink")], CTX);
    expect(v.unclassifiedKinds).toEqual(["my-custom-sink"]);
    // `pagerduty` alone is one class, and the custom sink cannot be counted.
    expect(v.satisfied).toBe(false);
  });

  test("a third-party renderer does NOT block a stack that is already covered", () => {
    // ADR-0024 D5 exists so out-of-tree renderer bundles can ship. Refusing
    // every stack that installs one would break that. The unclassified kind is
    // ignored here because dashboard+pagerduty already satisfy the floor — it
    // is only ever refused when the decision would otherwise rest on it.
    const v = evaluateSystemCoverage(
      [r("dashboard"), r("pagerduty"), r("some-third-party-sink")], CTX,
    );
    expect(v.unclassifiedKinds).toEqual(["some-third-party-sink"]);
    expect(v.satisfied).toBe(true);
  });

  test("two unclassified kinds cannot fake diversity", () => {
    // The open `RendererKindSchema` means a plugin author can pick any two
    // strings. That must not read as two classes.
    const v = evaluateSystemCoverage([r("sink-a"), r("sink-b")], CTX);
    expect(v.satisfied).toBe(false);
  });

  test("ONE error carries both facts — the unclassified kind never masks the real failure", () => {
    // An earlier cut raised a separate "unclassified kind" error and preferred
    // it whenever any unclassified kind was present. That HID the actual
    // problem: here the classified pair (discord+slack) is same-class, and
    // that is what the principal has to fix.
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("discord"), r("slack"), r("weird")], CTX);
    } catch (e) {
      expect(e).toBeInstanceOf(RendererCoverageConfigError);
      msg = (e as Error).message;
    }
    // Again the specific line, not the always-present class table.
    expect(msg).toContain("Platform class(es) present: [chat-gateway]");
    expect(msg).toContain("weird"); // and the uncounted kind is still named
    expect(msg).toContain("PLATFORM_CLASS_BY_KIND");
  });

  test("the message does not tell the principal the kind must be removed", () => {
    // It does not: once the other renderers meet the floor, it is just an
    // extra sink. Saying otherwise sends them to delete a working renderer.
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("pagerduty"), r("weird")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("does NOT have to be removed");
  });
});

describe("the rule's stated limits", () => {
  test("error text admits class does not identify vendor", () => {
    // `webhook-out` posting to PagerDuty + a `pagerduty` renderer read as two
    // classes but are one vendor. The guard cannot see that, and must not
    // claim a guarantee it does not provide.
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("discord"), r("slack")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("LIMIT");
    expect(msg).toContain("does not identify the VENDOR");
  });

  test("the class table in the message is generated, not hand-copied", () => {
    // It had already drifted once when maintained by hand.
    let msg = "";
    try {
      assertConfiguredSystemCoverage([r("discord"), r("slack")], CTX);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const kind of Object.keys(PLATFORM_CLASS_BY_KIND)) {
      expect(msg).toContain(kind);
    }
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
