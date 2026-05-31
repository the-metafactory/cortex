/**
 * MIG-3b — `formatEnvelopeAsMarkdown` pure-function tests.
 *
 * The helper at `src/adapters/envelope-renderer.ts` is the v1 default
 * formatter shared by Discord + Mattermost surface adapters. Both adapters
 * exercise it indirectly through their renderEnvelope tests, but the
 * formatter has its own contract worth pinning explicitly so future
 * Renderer-model work (MIG-7.2d) doesn't accidentally regress the v1
 * fallback shape.
 *
 * Contract:
 *   Line 1: **{type}** [optional " [{correlation_id}]"]
 *   Line 2: ```json
 *   Line 3-N: JSON.stringify(payload, null, 2)
 *   Line N+1: ```
 */

import { describe, expect, test } from "bun:test";
import { formatEnvelopeAsMarkdown } from "../envelope-renderer";
import type { Envelope } from "../../bus/myelin/envelope-validator";

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "metafactory.pilot.local",
    type: "review.cycle.completed",
    timestamp: "2026-05-09T12:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { repo: "grove" },
    ...overrides,
  };
}

describe("formatEnvelopeAsMarkdown — type header", () => {
  test("renders envelope.type as bold markdown header", () => {
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ type: "attention.item.enqueued" }));
    // The type sits on the very first line, preceded only by **.
    expect(out.split("\n")[0]).toBe("**attention.item.enqueued**");
  });

  test("preserves dotted subject syntax in the header", () => {
    // No escaping or substitution — the type is rendered verbatim. This
    // is load-bearing for principals grepping logs by event type.
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ type: "review.cycle.completed" }));
    expect(out).toContain("**review.cycle.completed**");
  });
});

describe("formatEnvelopeAsMarkdown — correlation_id", () => {
  test("appends [<corr>] to the type line when correlation_id is present", () => {
    const out = formatEnvelopeAsMarkdown(
      makeEnvelope({ correlation_id: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(out.split("\n")[0]).toBe(
      "**review.cycle.completed** [11111111-1111-4111-8111-111111111111]",
    );
  });

  test("omits the bracket entirely when correlation_id is absent", () => {
    const out = formatEnvelopeAsMarkdown(makeEnvelope());
    // No `[uuid]` anywhere in the rendered output.
    expect(out).not.toMatch(/\[[0-9a-f-]{36}\]/);
  });

  test("does not pad with extra space when correlation_id is absent", () => {
    // Regression guard: the template literal in the helper builds the
    // suffix conditionally; a stray trailing space on the header line
    // would be ugly in Discord/Mattermost. Pin the exact line shape.
    const out = formatEnvelopeAsMarkdown(makeEnvelope());
    expect(out.split("\n")[0]).toBe("**review.cycle.completed**");
  });
});

describe("formatEnvelopeAsMarkdown — payload code block", () => {
  test("wraps payload in a ```json fenced block", () => {
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ payload: { ticket: "G-1111" } }));
    expect(out).toContain("```json");
    expect(out).toContain("```");
  });

  test("renders payload via JSON.stringify with 2-space indent", () => {
    const out = formatEnvelopeAsMarkdown(
      makeEnvelope({ payload: { ticket: "G-1111", urgency: "high" } }),
    );
    // Pretty-printing → keys on their own indented lines.
    expect(out).toContain('  "ticket": "G-1111"');
    expect(out).toContain('  "urgency": "high"');
  });

  test("renders empty payload as `{}`", () => {
    // Mattermost/Discord both happily accept `{}` inside a code block.
    // The formatter does NOT special-case empty objects.
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ payload: {} }));
    expect(out).toContain("```json\n{}\n```");
  });

  test("round-trips a complex nested payload through JSON.parse", () => {
    const payload = {
      ticket: "G-1111",
      reviewers: ["luna", "echo"],
      meta: { sovereignty: "local", attempts: 3, frontier: false },
    };
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ payload }));
    // Extract the JSON between the ```json … ``` fence and ensure it
    // round-trips back to the original object — proves we didn't drop
    // or reformat any field.
    const match = /```json\n([\s\S]*?)\n```/.exec(out);
    expect(match).not.toBeNull();
    const captured = match?.[1];
    expect(captured).toBeDefined();
    const parsed = JSON.parse(captured!);
    expect(parsed).toEqual(payload);
  });
});

describe("formatEnvelopeAsMarkdown — dispatch lifecycle", () => {
  test("renders dispatch lifecycle as concise status text", () => {
    expect(formatEnvelopeAsMarkdown(makeEnvelope({
      type: "dispatch.task.started",
      payload: { agent_id: "ivy" },
    }))).toBe("Ivy is working...");

    expect(formatEnvelopeAsMarkdown(makeEnvelope({
      type: "dispatch.task.completed",
      payload: { agent_id: "ivy", result_summary: "🗣️ Ivy: Here." },
    }))).toBe("🗣️ Ivy: Here.");

    expect(formatEnvelopeAsMarkdown(makeEnvelope({
      type: "dispatch.task.failed",
      payload: { agent_id: "ivy", error_summary: "claude exited 1" },
    }))).toBe("Ivy failed: claude exited 1");
  });
});

describe("formatEnvelopeAsMarkdown — overall shape", () => {
  test("output has exactly the documented N-line structure with correlation_id", () => {
    const out = formatEnvelopeAsMarkdown(
      makeEnvelope({
        type: "attention.item.enqueued",
        correlation_id: "22222222-2222-4222-8222-222222222222",
        payload: { ticket: "G-1111" },
      }),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("**attention.item.enqueued** [22222222-2222-4222-8222-222222222222]");
    expect(lines[1]).toBe("```json");
    expect(lines[2]).toBe("{");
    // Line 3 is the first payload field — exact whitespace pinned by
    // JSON.stringify's indent=2 contract.
    expect(lines[3]).toBe('  "ticket": "G-1111"');
    expect(lines[4]).toBe("}");
    expect(lines[5]).toBe("```");
    expect(lines).toHaveLength(6);
  });

  test("output is a string (no trailing newline added)", () => {
    // The helper joins with `\n` rather than appending one — pin this so
    // callers (postResponse, postReply) don't get a stray blank line.
    const out = formatEnvelopeAsMarkdown(makeEnvelope({ payload: {} }));
    expect(typeof out).toBe("string");
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith("```")).toBe(true);
  });
});
