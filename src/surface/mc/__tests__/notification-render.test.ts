/**
 * F-11 — `render.ts` payload tests.
 *
 * Pins the Decision 8 single-event DM and channel payload shapes plus
 * the Decision 7 coalesced summary shape from
 * `docs/design-mc-f11-discord-notifications.md`.
 */
import { describe, it, expect } from "bun:test";
import {
  renderDM,
  renderChannel,
  renderCoalescedDM,
  truncateWordBoundary,
  type RenderContext,
} from "../notifications/render";
import type { NotificationIntent } from "../notifications/should-notify";

const intentP1Err: NotificationIntent = {
  audiences: ["dm"],
  severity: "silent",
  urgencyTag: "P1-ERR",
};

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  const base: RenderContext = {
    intent: intentP1Err,
    agentName: "Luna",
    taskRef: "T-42",
    taskTitle: "fix webhook HMAC verification",
    toState: "blocked",
    blockReason: {
      kind: "tool.error",
      payload: { tool_name: "bash", error_message: "permission denied" },
    },
    cycle: 3,
    observedAgo: "2s ago",
    deepLink: "https://grove.meta-factory.ai/?focus=assignment/01HZ&from=dm",
  };
  return { ...base, ...overrides };
}

describe("renderDM — Decision 8 single-event DM shape", () => {
  it("renders the seven-line shape exactly when all fields present", () => {
    const out = renderDM(ctx({ recentAssistantMessage: "running bun test in src/worker" }));
    const lines = out.split("\n");
    // Subject
    expect(lines[0]).toBe('[P1-ERR] Luna blocked on T-42 "fix webhook HMAC verification"');
    // Reason structured line
    expect(lines[1]).toBe('tool.error: bash — "permission denied"');
    // Cycle line
    expect(lines[2]).toBe("Cycle 3 · observed 2s ago");
    // Blank
    expect(lines[3]).toBe("");
    // One-liner (sourced from recentAssistantMessage since blockReason has no context)
    expect(lines[4]).toBe("One-liner: running bun test in src/worker");
    // Blank
    expect(lines[5]).toBe("");
    // Open link
    expect(lines[6]).toBe(
      "Open: https://grove.meta-factory.ai/?focus=assignment/01HZ&from=dm"
    );
  });

  it("prefers block_reason.context over recentAssistantMessage for the one-liner", () => {
    const out = renderDM(
      ctx({
        blockReason: {
          kind: "permission.request",
          payload: {
            requested_action: "tool.bash",
            target: "bun test",
            context: "agent wants to run the test suite for the change",
          },
        },
        recentAssistantMessage: "should not appear",
      })
    );
    expect(out).toContain(
      "One-liner: agent wants to run the test suite for the change"
    );
    expect(out).not.toContain("should not appear");
  });

  it("omits the one-liner section when neither source is present", () => {
    const out = renderDM(
      ctx({
        blockReason: {
          kind: "tool.error",
          payload: { tool_name: "bash", error_message: "boom" },
        },
        recentAssistantMessage: undefined,
      })
    );
    expect(out).not.toContain("One-liner:");
    // Five-line render: subject, reason, cycle, blank, Open.
    // (When the one-liner is omitted the render drops the line + its
    // leading blank, so the count goes from 7 → 5, not 7 → 6.)
    expect(out.split("\n")).toHaveLength(5);
  });

  it("omits prefix when urgencyTag is null", () => {
    const out = renderDM(
      ctx({ intent: { audiences: ["dm"], severity: "silent", urgencyTag: null } })
    );
    expect(out.split("\n")[0]).toBe(
      'Luna blocked on T-42 "fix webhook HMAC verification"'
    );
  });

  it("appends a baseUrl warning when configured", () => {
    const out = renderDM(ctx({ baseUrlWarning: true }));
    expect(out).toContain("Deep link unavailable; configure `grove.baseUrl`.");
  });
});

describe("renderChannel — Decision 8 single-event channel shape", () => {
  it("renders the short failed-state subject + context + link", () => {
    const out = renderChannel(
      ctx({
        toState: "failed",
        blockReason: null,
        recentAssistantMessage: "bun test exited 1 after 3 cycles — context in dashboard",
        intent: {
          audiences: ["channel"],
          severity: "ping",
          urgencyTag: "P0-ERR",
        },
      })
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      '[P0-ERR] Luna failed T-42 "fix webhook HMAC verification"'
    );
    expect(lines[1]).toBe(
      "Root cause: bun test exited 1 after 3 cycles — context in dashboard"
    );
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe(
      "https://grove.meta-factory.ai/?focus=assignment/01HZ&from=dm"
    );
  });

  it("omits the context line when no rationale and no recent message", () => {
    const out = renderChannel(
      ctx({
        toState: "completed",
        blockReason: null,
        recentAssistantMessage: undefined,
        intent: { audiences: ["channel"], severity: "silent", urgencyTag: null },
      })
    );
    const lines = out.split("\n");
    // Subject, blank, link
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Luna completed T-42 "fix webhook HMAC verification"');
  });
});

describe("renderCoalescedDM — Decision 7 summary shape (N ≥ 2)", () => {
  it("renders the bullet-list shape from the addendum example", () => {
    const out = renderCoalescedDM({
      count: 3,
      topUrgencyTag: "P1",
      items: [
        {
          urgencyTag: "P1",
          agentName: "Luna",
          taskRef: "T-42",
          taskTitle: "fix webhook HMAC",
          reasonLine: "permission.request: tool.bash",
        },
        {
          urgencyTag: "P1",
          agentName: "rev",
          taskRef: "T-43",
          taskTitle: "review PR #45",
          reasonLine: "tool.error: exit 1",
        },
        {
          urgencyTag: "P1",
          agentName: "impl",
          taskRef: "T-44",
          taskTitle: "draft migration",
          reasonLine: "permission.request: tool.edit",
        },
      ],
      deepLink: "https://grove.meta-factory.ai/?focus=assignment/01HZABC",
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("[P1] 3 agents blocked");
    expect(lines[1]).toBe('- Luna · T-42 "fix webhook HMAC" · permission.request: tool.bash');
    expect(lines[2]).toBe('- rev · T-43 "review PR #45" · tool.error: exit 1');
    expect(lines[3]).toBe('- impl · T-44 "draft migration" · permission.request: tool.edit');
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe(
      "Dashboard: https://grove.meta-factory.ai/?focus=assignment/01HZABC"
    );
  });
});

describe("truncateWordBoundary", () => {
  it("returns the input unchanged when short enough", () => {
    expect(truncateWordBoundary("short title", 80)).toBe("short title");
  });
  it("truncates at the nearest word boundary with ellipsis", () => {
    const long = "fix webhook HMAC verification with rotating secret manual approval";
    const out = truncateWordBoundary(long, 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
    // Should not split a word — last char before ellipsis is not letter-mid-word.
    expect(out).not.toContain("verifica…");
  });
  it("falls back to hard cut when word boundary is too early", () => {
    const out = truncateWordBoundary("supercalifragilisticexpialidocious", 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });
});
