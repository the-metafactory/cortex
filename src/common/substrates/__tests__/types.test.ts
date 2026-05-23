/**
 * IAW Phase A.1 — Type-level smoke tests for the substrate harness protocol.
 *
 * These tests don't exercise behaviour (there's none — types.ts is pure
 * types). Instead they pin the *shape* of each exported type so a future
 * accidental rename (e.g. `allow[]` → `tools[]`) is caught at PR time
 * rather than at downstream import sites.
 *
 * **Coverage axes:**
 *   1. `HarnessId` enumerates all 8 known substrates (cortex#91 §F).
 *      Adding/removing a value is a typed change that fails this test
 *      until the test list is updated — forcing the author to think
 *      about which downstream switch statements need updating.
 *   2. Each interface is instantiable with its minimum required fields,
 *      and each optional field is independently omissible.
 *   3. `SessionHarness.dispatch()` returns something awaitable as an
 *      async iterable (compile-time + one runtime drain).
 *   4. `ToolCapability.allow` is a `string[]` (not enum) — confirming
 *      the Q1-α "harness-native strings, no translation" lock-in.
 */

import { describe, expect, test } from "bun:test";
import type {
  Capability,
  DispatchRequest,
  HarnessId,
  MyelinEnvelope,
  SessionHarness,
  ToolCapability,
} from "../types";

// ---------------------------------------------------------------------------
// HarnessId exhaustiveness
// ---------------------------------------------------------------------------

describe("HarnessId", () => {
  /**
   * Exhaustive list of known substrates per cortex#91 §F. Update both this
   * array AND the `HarnessId` union when adding a new substrate — drift is
   * the bug this test exists to catch.
   */
  const ALL_HARNESS_IDS: HarnessId[] = [
    "claude-code",
    "bus-peer",
    "openai-codex",
    "cursor",
    "gemini",
    "mistral",
    "pi-dev",
    "agent-team",
  ];

  test("includes all eight known substrates", () => {
    expect(ALL_HARNESS_IDS).toHaveLength(8);
  });

  test("exhaustive switch compiles for all eight values", () => {
    // If a new HarnessId is added without updating this switch, tsc fails
    // (the `never` assignment becomes ill-typed). Compile-time proof that
    // every downstream switch must enumerate the union exhaustively.
    function exhaustive(id: HarnessId): string {
      switch (id) {
        case "claude-code": return "cc";
        case "bus-peer": return "bp";
        case "openai-codex": return "codex";
        case "cursor": return "cursor";
        case "gemini": return "gemini";
        case "mistral": return "mistral";
        case "pi-dev": return "pi";
        case "agent-team": return "team";
        default: {
          const _exhaustive: never = id;
          return _exhaustive;
        }
      }
    }
    expect(exhaustive("claude-code")).toBe("cc");
    expect(exhaustive("bus-peer")).toBe("bp");
    expect(exhaustive("pi-dev")).toBe("pi");
  });
});

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

describe("Capability", () => {
  test("minimum-required shape compiles", () => {
    const cap: Capability = {
      id: "code-review",
      description: "Reviews PRs for correctness and style",
    };
    expect(cap.id).toBe("code-review");
    expect(cap.tags).toBeUndefined();
  });

  test("with optional tags compiles", () => {
    const cap: Capability = {
      id: "code-review.typescript",
      description: "TypeScript-aware code review",
      tags: ["typescript", "code-review"],
    };
    expect(cap.tags).toEqual(["typescript", "code-review"]);
  });
});

// ---------------------------------------------------------------------------
// ToolCapability
// ---------------------------------------------------------------------------

describe("ToolCapability", () => {
  test("allow is a plain string array (Q1-α — substrate-native)", () => {
    const tools: ToolCapability = {
      allow: ["Bash", "Edit", "Write"],
    };
    // string[] (not enum) — proves the harness can pass any substrate's
    // native tool vocabulary through without cortex-side translation.
    expect(tools.allow).toEqual(["Bash", "Edit", "Write"]);
    expect(tools.deny).toBeUndefined();
  });

  test("deny is independently optional", () => {
    const tools: ToolCapability = {
      allow: ["*"],
      deny: ["WebFetch"],
    };
    expect(tools.deny).toEqual(["WebFetch"]);
  });
});

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

describe("DispatchRequest", () => {
  test("minimum-required shape compiles", () => {
    const req: DispatchRequest = {
      persona: { path: "/agents/cortex.md", content: "# Cortex persona" },
      prompt: "say hello",
      tools: { allow: ["Bash"] },
      context: [],
      agent: { id: "cortex", displayName: "Cortex" },
      requestId: "00000000-0000-4000-8000-000000000000",
    };
    expect(req.timeoutMs).toBeUndefined();
    expect(req.inactivityMs).toBeUndefined();
    expect(req.agent.runtime).toBeUndefined();
  });

  test("with Q6 timeouts and runtime hint compiles", () => {
    const req: DispatchRequest = {
      persona: { path: "/agents/luna.md", content: "# Luna" },
      prompt: "review this PR",
      tools: { allow: ["Read", "Grep"], deny: ["Bash"] },
      context: [
        { kind: "discord-history", data: [{ author: "andreas", text: "hi" }] },
        { kind: "env", data: { operator: "andreas", entity: "pr/45" } },
      ],
      agent: {
        id: "luna",
        displayName: "Luna",
        runtime: { harness: "claude-code" },
      },
      requestId: "11111111-1111-4111-8111-111111111111",
      timeoutMs: 300_000,
      inactivityMs: 60_000,
    };
    expect(req.agent.runtime?.harness).toBe("claude-code");
    expect(req.timeoutMs).toBe(300_000);
    expect(req.inactivityMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// SessionHarness
// ---------------------------------------------------------------------------

describe("SessionHarness", () => {
  /**
   * A trivial in-test harness implementation. Used to assert the interface
   * is implementable end-to-end (the type-check + the runtime drain both
   * prove no field is unimplementable).
   */
  class NoopHarness implements SessionHarness {
    readonly id: HarnessId = "claude-code";
    readonly capabilities: Capability[] = [
      { id: "noop", description: "Does nothing" },
    ];

    async *dispatch(_req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
      // Yield a synthetic terminal envelope — minimal valid shape per
      // the validator's required fields.
      yield {
        id: "00000000-0000-4000-8000-000000000001",
        source: "metafactory.cortex.test",
        type: "dispatch.task.completed",
        timestamp: new Date().toISOString(),
        sovereignty: {
          classification: "local",
          data_residency: "NZ",
          max_hop: 0,
          frontier_ok: false,
          model_class: "local-only",
        },
        payload: { task_id: _req.requestId, agent_id: _req.agent.id },
      };
    }

    async shutdown(_opts: { graceful: boolean }): Promise<void> {
      // No-op — proves the optional method can be implemented as a
      // single Promise<void>.
    }
  }

  test("interface is implementable end-to-end", async () => {
    const harness: SessionHarness = new NoopHarness();
    expect(harness.id).toBe("claude-code");
    expect(harness.capabilities).toHaveLength(1);
    expect(harness.shutdown).toBeDefined();
  });

  test("dispatch yields at least one terminal envelope", async () => {
    const harness: SessionHarness = new NoopHarness();
    const req: DispatchRequest = {
      persona: { path: "/p.md", content: "" },
      prompt: "x",
      tools: { allow: [] },
      context: [],
      agent: { id: "test", displayName: "Test" },
      requestId: "22222222-2222-4222-8222-222222222222",
    };

    const collected: MyelinEnvelope[] = [];
    for await (const env of harness.dispatch(req)) {
      collected.push(env);
    }
    expect(collected.length).toBeGreaterThanOrEqual(1);
    expect(collected.at(-1)?.type).toBe("dispatch.task.completed");
  });

  test("shutdown is optional — harness may omit it", () => {
    class MinimalHarness implements SessionHarness {
      readonly id: HarnessId = "bus-peer";
      readonly capabilities: Capability[] = [];
      async *dispatch(_req: DispatchRequest): AsyncIterable<MyelinEnvelope> {
        // never yields — placeholder for shape test only
      }
    }
    const h: SessionHarness = new MinimalHarness();
    expect(h.shutdown).toBeUndefined();
  });
});
