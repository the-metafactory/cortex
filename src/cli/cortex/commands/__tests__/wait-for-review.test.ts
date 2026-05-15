/**
 * cortex#232 — tests for `cortex wait-for-review`.
 *
 * Coverage axes:
 *   1. Arg parsing — flag hydration, `--help`, implicit subcommand,
 *      validation errors map to exit 2.
 *   2. `parsePrRef` — grammar, malformed inputs, number parsing.
 *   3. `parseTimeoutMs` — units, malformed, zero/negative rejection.
 *   4. `matchesReview` (pure) — happy paths for all three GitHub
 *      event surfaces, state filtering, repo/PR mismatch rejection,
 *      issue-comment-on-plain-issue rejection.
 *   5. `runWaitForReview` integration — with stubbed NatsLink +
 *      MyelinSubscriber + loadConfig, exercises the
 *      subscribe → match → cleanup → JSON path AND the
 *      subscribe → timeout → exit 124 path.
 */

import { describe, expect, test } from "bun:test";

import {
  parseWaitForReviewArgs,
  parsePrRef,
  parseTimeoutMs,
  matchesReview,
  runWaitForReview,
  dispatchWaitForReview,
  type ReviewMatch,
  type WaitForReviewDeps,
} from "../wait-for-review";
import { CliArgsError } from "../_shared/arg-error";
import type { Envelope } from "../../../../bus/myelin/envelope-validator";

// =============================================================================
// Helpers
// =============================================================================

function makeReviewEnvelope(overrides: {
  event: "pull_request_review" | "pull_request_review_comment" | "issue_comment";
  action?: string;
  repo?: string;
  sender?: string;
  prNumber?: number;
  state?: string;
  body?: string;
  isPR?: boolean;
}): Envelope {
  const event = overrides.event;
  const action = overrides.action ?? "submitted";
  const repo = overrides.repo ?? "the-metafactory/cortex";
  const sender = overrides.sender ?? "mellanon";
  const prNumber = overrides.prNumber ?? 229;
  const state = overrides.state;
  const body = overrides.body ?? "LGTM";

  // Build the nested GitHub-shaped body per the three event surfaces.
  let nested: Record<string, unknown>;
  if (event === "issue_comment") {
    nested = {
      issue: {
        number: prNumber,
        ...(overrides.isPR !== false && { pull_request: { url: "x" } }),
      },
      comment: { body },
    };
  } else if (event === "pull_request_review") {
    nested = {
      pull_request: { number: prNumber },
      review: { state: state ?? "approved", body },
    };
  } else {
    nested = {
      pull_request: { number: prNumber },
      comment: { body },
    };
  }

  return {
    id: "11111111-2222-4333-8444-555555555555",
    source: "metafactory.cortex.local",
    type: `github.${event.replace(/_/g, "-")}.${action}`,
    timestamp: "2026-05-15T22:30:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    },
    payload: {
      delivery_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      event,
      action,
      repo,
      sender,
      body: nested,
    },
  };
}

// =============================================================================
// parsePrRef
// =============================================================================

describe("parsePrRef", () => {
  test("parses canonical owner/repo#N", () => {
    const r = parsePrRef("the-metafactory/cortex#229");
    expect(r).toEqual({
      owner: "the-metafactory",
      repo: "cortex",
      number: 229,
      fullName: "the-metafactory/cortex",
    });
  });

  test("accepts dots and underscores in owner/repo names", () => {
    const r = parsePrRef("user.name/my_repo.v2#1");
    expect(r.owner).toBe("user.name");
    expect(r.repo).toBe("my_repo.v2");
    expect(r.number).toBe(1);
  });

  test("rejects missing #N", () => {
    expect(() => parsePrRef("the-metafactory/cortex")).toThrow(CliArgsError);
  });

  test("rejects empty owner", () => {
    expect(() => parsePrRef("/cortex#1")).toThrow(CliArgsError);
  });

  test("rejects empty repo", () => {
    expect(() => parsePrRef("the-metafactory/#1")).toThrow(CliArgsError);
  });

  test("rejects non-numeric PR number", () => {
    expect(() => parsePrRef("a/b#abc")).toThrow(CliArgsError);
  });

  test("rejects zero PR number", () => {
    expect(() => parsePrRef("a/b#0")).toThrow(CliArgsError);
  });
});

// =============================================================================
// parseTimeoutMs
// =============================================================================

describe("parseTimeoutMs", () => {
  test("bare integer = seconds", () => {
    expect(parseTimeoutMs("30")).toBe(30_000);
  });

  test("s suffix = seconds", () => {
    expect(parseTimeoutMs("900s")).toBe(900_000);
  });

  test("m suffix = minutes", () => {
    expect(parseTimeoutMs("30m")).toBe(1_800_000);
  });

  test("h suffix = hours", () => {
    expect(parseTimeoutMs("1h")).toBe(3_600_000);
  });

  test("rejects zero", () => {
    expect(() => parseTimeoutMs("0")).toThrow(CliArgsError);
    expect(() => parseTimeoutMs("0m")).toThrow(CliArgsError);
  });

  test("rejects non-integer", () => {
    expect(() => parseTimeoutMs("1.5m")).toThrow(CliArgsError);
  });

  test("rejects unknown unit", () => {
    expect(() => parseTimeoutMs("30d")).toThrow(CliArgsError);
  });

  test("rejects compound form", () => {
    expect(() => parseTimeoutMs("1h30m")).toThrow(CliArgsError);
  });
});

// =============================================================================
// parseWaitForReviewArgs
// =============================================================================

describe("parseWaitForReviewArgs", () => {
  test("--help yields help subcommand", () => {
    expect(parseWaitForReviewArgs(["--help"]).subcommand).toBe("help");
    expect(parseWaitForReviewArgs(["-h"]).subcommand).toBe("help");
  });

  test("hydrates all flags from implicit wait", () => {
    const args = parseWaitForReviewArgs([
      "--pr", "the-metafactory/cortex#229",
      "--reviewer", "mellanon",
      "--timeout", "30m",
      "--require", "approved",
      "--json",
    ]);
    expect(args.subcommand).toBe("wait");
    expect(args.pr).toBe("the-metafactory/cortex#229");
    expect(args.reviewer).toBe("mellanon");
    expect(args.timeout).toBe("30m");
    expect(args.require).toBe("approved");
    expect(args.json).toBe(true);
  });

  test("explicit `wait` subcommand works the same", () => {
    const args = parseWaitForReviewArgs([
      "wait",
      "--pr", "a/b#1",
      "--reviewer", "x",
      "--timeout", "60s",
    ]);
    expect(args.subcommand).toBe("wait");
    expect(args.pr).toBe("a/b#1");
  });

  test("unknown leading token surfaces as unknown subcommand", () => {
    expect(parseWaitForReviewArgs(["bogus"]).subcommand).toBe("unknown");
  });
});

// =============================================================================
// matchesReview — pure matcher
// =============================================================================

describe("matchesReview", () => {
  const FILTER_BASE = {
    prRef: parsePrRef("the-metafactory/cortex#229"),
    reviewer: "mellanon",
    requireState: "any" as const,
  };

  test("matches pull_request_review.submitted with `approved` state", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review", state: "approved" });
    const m = matchesReview(env, FILTER_BASE);
    expect(m).not.toBeNull();
    expect(m?.kind).toBe("pull_request_review");
    expect(m?.action).toBe("submitted");
    expect(m?.state).toBe("approved");
    expect(m?.reviewer).toBe("mellanon");
    expect(m?.pr).toBe(229);
    expect(m?.envelope_id).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("matches issue_comment.created on a PR", () => {
    const env = makeReviewEnvelope({
      event: "issue_comment",
      action: "created",
      body: "recommend: merge",
    });
    const m = matchesReview(env, FILTER_BASE);
    expect(m).not.toBeNull();
    expect(m?.kind).toBe("issue_comment");
    expect(m?.body_summary).toBe("recommend: merge");
  });

  test("rejects issue_comment on a plain issue (no .pull_request marker)", () => {
    const env = makeReviewEnvelope({ event: "issue_comment", isPR: false });
    expect(matchesReview(env, FILTER_BASE)).toBeNull();
  });

  test("matches pull_request_review_comment (inline diff comments)", () => {
    const env = makeReviewEnvelope({
      event: "pull_request_review_comment",
      action: "created",
    });
    const m = matchesReview(env, FILTER_BASE);
    expect(m?.kind).toBe("pull_request_review_comment");
  });

  test("rejects mismatched repo", () => {
    const env = makeReviewEnvelope({
      event: "pull_request_review",
      repo: "the-metafactory/different",
    });
    expect(matchesReview(env, FILTER_BASE)).toBeNull();
  });

  test("rejects mismatched PR number", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review", prNumber: 999 });
    expect(matchesReview(env, FILTER_BASE)).toBeNull();
  });

  test("rejects mismatched reviewer", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review", sender: "other-bot" });
    expect(matchesReview(env, FILTER_BASE)).toBeNull();
  });

  test("rejects non-review event types", () => {
    // pull_request.opened is NOT a review event — drop it.
    const env: Envelope = {
      ...makeReviewEnvelope({ event: "pull_request_review" }),
      type: "github.pull_request.opened",
      payload: {
        delivery_id: "x", event: "pull_request", action: "opened",
        repo: "the-metafactory/cortex", sender: "mellanon",
        body: { pull_request: { number: 229 } },
      },
    };
    expect(matchesReview(env, FILTER_BASE)).toBeNull();
  });

  test("--require approved rejects commented state", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review", state: "commented" });
    expect(matchesReview(env, { ...FILTER_BASE, requireState: "approved" })).toBeNull();
  });

  test("--require approved accepts approved state", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review", state: "approved" });
    expect(matchesReview(env, { ...FILTER_BASE, requireState: "approved" })).not.toBeNull();
  });

  test("--require approved rejects issue_comment surface (no structural approval)", () => {
    const env = makeReviewEnvelope({ event: "issue_comment" });
    expect(matchesReview(env, { ...FILTER_BASE, requireState: "approved" })).toBeNull();
  });

  test("preserves newlines in body_summary on JSON path (formatMatchText collapses them, but raw match keeps them)", () => {
    const env = makeReviewEnvelope({
      event: "pull_request_review",
      body: "line one\nline two\nline three",
    });
    const m = matchesReview(env, FILTER_BASE);
    expect(m?.body_summary).toBe("line one\nline two\nline three");
  });

  test("truncates body_summary at 240 chars", () => {
    const long = "x".repeat(300);
    const env = makeReviewEnvelope({ event: "pull_request_review", body: long });
    const m = matchesReview(env, FILTER_BASE);
    expect(m?.body_summary.length).toBe(240);
    expect(m?.body_summary.endsWith("…")).toBe(true);
  });

  test("carries delivery_id when present on payload", () => {
    const env = makeReviewEnvelope({ event: "pull_request_review" });
    const m = matchesReview(env, FILTER_BASE);
    expect(m?.delivery_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });
});

// =============================================================================
// runWaitForReview — integration with stubbed deps
// =============================================================================

function stubDeps(opts: {
  matchedEnvelope?: Envelope;
  publishDelayMs?: number;
}): WaitForReviewDeps {
  const closed: string[] = [];
  return {
    loadConfig: (_path: string) => ({
      config: {
        agent: { operatorId: "metafactory" },
        nats: { url: "nats://localhost:4222" },
      } as unknown as ReturnType<typeof import("../../../../common/config/loader").loadConfigWithAgents>["config"],
      inlineAgents: [],
    }),
    connect: async () => ({
      raw: {},
      name: "test",
      publish() { /* no-op */ },
      close: async () => { closed.push("link"); },
    }) as unknown as Awaited<ReturnType<typeof import("../../../../bus/nats/connection").NatsLink.connect>>,
    subscriberStart: (_link, subOpts) => {
      // Drive a match (or not) on the next tick — simulates a real
      // envelope arriving after the subscribe call returns.
      if (opts.matchedEnvelope !== undefined) {
        setTimeout(
          () => { void subOpts.onEnvelope(opts.matchedEnvelope!, `local.metafactory.${opts.matchedEnvelope!.type}`); },
          opts.publishDelayMs ?? 5,
        );
      }
      return {
        pattern: subOpts.pattern,
        stop: async () => { closed.push("subscriber"); },
      } as unknown as ReturnType<typeof import("../../../../bus/myelin/subscriber").MyelinSubscriber.start>;
    },
  };
}

describe("runWaitForReview — integration", () => {
  test("subscribes, matches, returns JSON exit 0", async () => {
    const env = makeReviewEnvelope({
      event: "pull_request_review",
      state: "approved",
    });
    const args = parseWaitForReviewArgs([
      "--pr", "the-metafactory/cortex#229",
      "--reviewer", "mellanon",
      "--timeout", "10s",
      "--require", "approved",
      "--json",
    ]);
    const result = await runWaitForReview(args, stubDeps({ matchedEnvelope: env }));
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      items: ReviewMatch[];
      data?: Record<string, string>;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.kind).toBe("pull_request_review");
    expect(parsed.items[0]?.state).toBe("approved");
    expect(parsed.data?.subject_pattern).toBe("local.metafactory.github.>");
  });

  test("times out → exit 124, JSON error envelope", async () => {
    const args = parseWaitForReviewArgs([
      "--pr", "the-metafactory/cortex#229",
      "--reviewer", "mellanon",
      // 1s is the minimum valid `parseTimeoutMs` value; the stubbed
      // subscriber never resolves a match, so the timeout fires.
      "--timeout", "1s",
      "--json",
    ]);
    const result = await runWaitForReview(args, stubDeps({ /* no envelope */ }));
    expect(result.exitCode).toBe(124);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      error: { reason: string; context?: Record<string, string> };
    };
    expect(parsed.status).toBe("error");
    expect(parsed.error.reason).toBe("timeout");
    expect(parsed.error.context?.pr).toBe("the-metafactory/cortex#229");
    expect(parsed.error.context?.reviewer).toBe("mellanon");
  }, 5_000);

  test("missing --pr → exit 2", async () => {
    const args = parseWaitForReviewArgs([
      "--reviewer", "mellanon",
      "--timeout", "10s",
    ]);
    const result = await runWaitForReview(args, stubDeps({}));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--pr");
  });

  test("malformed --pr → exit 2 with descriptive error", async () => {
    const args = parseWaitForReviewArgs([
      "--pr", "not-a-valid-ref",
      "--reviewer", "mellanon",
      "--timeout", "10s",
    ]);
    const result = await runWaitForReview(args, stubDeps({}));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("owner/repo#N");
  });

  test("--help short-circuits before any IO", async () => {
    const result = await dispatchWaitForReview(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cortex wait-for-review");
  });
});
