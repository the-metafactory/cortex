/**
 * IAW Phase A.6 — `CapabilitySchema` + cortex.yaml integration tests
 * (cortex#113).
 *
 * Three surfaces under test:
 *   1. `CapabilitySchema` — field-level grammar and structural invariants
 *      on a single capability declaration (id regex, description non-empty,
 *      tag regex, provider id regex, rate/cost envelope shapes).
 *   2. `CortexConfigSchema` integration — the top-level `capabilities:`
 *      block parses cleanly when absent (default `[]`), accepts a populated
 *      catalog, and rejects duplicate capability ids at the document level.
 *   3. Cross-field reference invariants (A.6.3) — every
 *      `agents[].runtime.capabilities[]` reference resolves to a declared
 *      `capabilities[].id`, and every `capabilities[].provided_by[]`
 *      reference resolves to a declared `agents[].id`. Symmetric dangling-
 *      reference guards; the error messages name the offending agent/id
 *      and the specific path the principal should edit.
 *
 * Test layout mirrors `./stack.test.ts`: minimal fixture builders at the
 * top, schema-level tests next, document-level tests after, and the
 * cross-field-invariant suite last.
 */

import { describe, test, expect } from "bun:test";

import {
  CapabilitySchema,
  type Capability,
  type CapabilityCost,
  type CapabilityRate,
} from "../capability";
import { CortexConfigSchema } from "../cortex-config";

// =============================================================================
// Fixture helpers (mirror the patterns in stack.test.ts + cortex-config.test.ts)
// =============================================================================

function minPrincipal() {
  return { id: "andreas" };
}

function minDiscordPresence() {
  return {
    token: "discord-bot-token",
    guildId: "1111111111111111111",
    agentChannelId: "2222222222222222222",
    logChannelId: "3333333333333333333",
  };
}

function minAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    presence: { discord: minDiscordPresence() },
    ...overrides,
  };
}

function minConfig(overrides: Record<string, unknown> = {}) {
  return {
    principal: minPrincipal(),
    agents: [minAgent()],
    claude: {},
    ...overrides,
  };
}

/**
 * A minimum-valid capability declaration. Tests that need a variant clone
 * this and override only the field under examination.
 */
function minCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-review.typescript",
    description: "TypeScript code review with type-checking analysis",
    tags: ["typescript", "code-review"],
    provided_by: ["luna"],
    ...overrides,
  };
}

// =============================================================================
// CapabilitySchema — id grammar
// =============================================================================

describe("CapabilitySchema.id grammar", () => {
  test("accepts canonical dot-separated id", () => {
    const parsed = CapabilitySchema.parse(minCapability());
    expect(parsed.id).toBe("code-review.typescript");
  });

  test("accepts bare single-segment id (no sub-capability)", () => {
    const parsed = CapabilitySchema.parse(minCapability({ id: "code-review" }));
    expect(parsed.id).toBe("code-review");
  });

  test("accepts multi-segment id with three levels", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ id: "literature-search.medline.full-text" }),
    );
    expect(parsed.id).toBe("literature-search.medline.full-text");
  });

  test("accepts underscores inside segments", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ id: "image_gen.dall_e_3" }),
    );
    expect(parsed.id).toBe("image_gen.dall_e_3");
  });

  test("rejects uppercase id segments", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ id: "Code-Review" })),
    ).toThrow(/capability id must be dot-separated/);
    expect(() =>
      CapabilitySchema.parse(minCapability({ id: "code-review.TypeScript" })),
    ).toThrow(/capability id must be dot-separated/);
  });

  test("rejects whitespace anywhere in id", () => {
    expect(() => CapabilitySchema.parse(minCapability({ id: "code review" }))).toThrow();
    expect(() => CapabilitySchema.parse(minCapability({ id: " code-review" }))).toThrow();
    expect(() => CapabilitySchema.parse(minCapability({ id: "code-review " }))).toThrow();
  });

  test("rejects digit-prefix segments (letter-prefix rule)", () => {
    expect(() => CapabilitySchema.parse(minCapability({ id: "2d-rendering" }))).toThrow(
      /capability id must be dot-separated/,
    );
    expect(() =>
      CapabilitySchema.parse(minCapability({ id: "code-review.3d" })),
    ).toThrow(/capability id must be dot-separated/);
  });

  test("rejects leading/trailing/consecutive dots", () => {
    expect(() => CapabilitySchema.parse(minCapability({ id: ".code-review" }))).toThrow();
    expect(() => CapabilitySchema.parse(minCapability({ id: "code-review." }))).toThrow();
    expect(() =>
      CapabilitySchema.parse(minCapability({ id: "code-review..typescript" })),
    ).toThrow();
  });

  test("rejects empty id", () => {
    expect(() => CapabilitySchema.parse(minCapability({ id: "" }))).toThrow(
      /capability id is required/,
    );
  });

  test("rejects NATS wildcards in id", () => {
    expect(() => CapabilitySchema.parse(minCapability({ id: "code-review.*" }))).toThrow();
    expect(() => CapabilitySchema.parse(minCapability({ id: "code-review.>" }))).toThrow();
  });
});

// =============================================================================
// CapabilitySchema — description / tags / provided_by
// =============================================================================

describe("CapabilitySchema.description", () => {
  test("rejects empty string", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ description: "" })),
    ).toThrow(/capability\.description is required/);
  });

  test("rejects missing field entirely", () => {
    const { description: _omitted, ...rest } = minCapability();
    expect(() => CapabilitySchema.parse(rest)).toThrow();
  });

  test("accepts a single-character description (e.g. '.')", () => {
    const parsed = CapabilitySchema.parse(minCapability({ description: "." }));
    expect(parsed.description).toBe(".");
  });

  test("rejects whitespace-only description (`.trim().min(1)` guard)", () => {
    // `.min(1)` alone accepts `" "` (length 1) — `.trim().min(1)` rejects
    // it because the trimmed length is 0. Pins the principal-facing contract:
    // blank-looking descriptions never propagate to the registry / dashboard.
    expect(() =>
      CapabilitySchema.parse(minCapability({ description: "   " })),
    ).toThrow(/capability\.description is required/);
    expect(() =>
      CapabilitySchema.parse(minCapability({ description: "\t\n " })),
    ).toThrow(/capability\.description is required/);
  });

  test("trims surrounding whitespace on otherwise-valid descriptions", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ description: "  TypeScript review  " }),
    );
    expect(parsed.description).toBe("TypeScript review");
  });
});

describe("CapabilitySchema.tags", () => {
  test("defaults to empty array when omitted", () => {
    const { tags: _omitted, ...rest } = minCapability();
    const parsed = CapabilitySchema.parse(rest);
    expect(parsed.tags).toEqual([]);
  });

  test("accepts canonical tag list", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ tags: ["typescript", "code-review", "ts"] }),
    );
    expect(parsed.tags).toEqual(["typescript", "code-review", "ts"]);
  });

  test("rejects uppercase tag", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ tags: ["TypeScript"] })),
    ).toThrow(/capability tags must be lowercase/);
  });

  test("rejects digit-prefix tag", () => {
    expect(() => CapabilitySchema.parse(minCapability({ tags: ["2d"] }))).toThrow(
      /capability tags must be lowercase/,
    );
  });

  test("rejects whitespace-bearing tag", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ tags: ["code review"] })),
    ).toThrow();
  });

  test("rejects dot-bearing tag (tags are flat, not taxonomic)", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ tags: ["code.review"] })),
    ).toThrow();
  });
});

describe("CapabilitySchema.provided_by", () => {
  test("accepts a single provider", () => {
    const parsed = CapabilitySchema.parse(minCapability({ provided_by: ["luna"] }));
    expect(parsed.provided_by).toEqual(["luna"]);
  });

  test("accepts multiple providers", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ provided_by: ["luna", "echo", "holly"] }),
    );
    expect(parsed.provided_by).toEqual(["luna", "echo", "holly"]);
  });

  test("rejects empty provider list (≥1 required)", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ provided_by: [] })),
    ).toThrow(/at least one provider agent id/);
  });

  test("rejects digit-only provider id (Discord-snowflake paste-bug; tightened by cortex#145)", () => {
    // Real failure mode this pins: a principal pastes a Discord snowflake into
    // provided_by and the schema silently accepts it. cortex#145 closed the
    // principal/stack/agent letter-prefix trilogy (cortex#141 → cortex#144 →
    // cortex#145) so the gate now catches the paste-bug deterministically at
    // parse time rather than relying on the cross-field provider-resolution
    // refine to surface it later. `provided_by` mirrors `AgentSchema.id`'s
    // letter-prefix regex; once one tightens, the other must too — that's
    // why they're enforced as a single coordinated edit in cortex#145.
    expect(() =>
      CapabilitySchema.parse(minCapability({ provided_by: ["6666666666666666666"] })),
    ).toThrow(/starting with a letter/);
  });

  test("rejects uppercase provider id", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ provided_by: ["Luna"] })),
    ).toThrow(/provided_by entries must be agent ids/);
  });

  test("rejects underscore in provider id (matches AgentSchema.id grammar)", () => {
    // AgentSchema.id is `/^[a-z0-9-]+$/` — no underscores. We mirror that.
    expect(() =>
      CapabilitySchema.parse(minCapability({ provided_by: ["my_agent"] })),
    ).toThrow(/provided_by entries must be agent ids/);
  });
});

// =============================================================================
// CapabilitySchema — rate / cost envelopes
// =============================================================================

describe("CapabilitySchema.rate", () => {
  test("accepts per_minute alone", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ rate: { per_minute: 10 } }),
    );
    expect(parsed.rate).toEqual({ per_minute: 10 });
  });

  test("accepts mixed-window rate (per_minute + per_day)", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ rate: { per_minute: 10, per_day: 5000 } }),
    );
    expect(parsed.rate).toEqual({ per_minute: 10, per_day: 5000 });
  });

  test("rejects empty rate envelope", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ rate: {} })),
    ).toThrow(/at least one window/);
  });

  test("rejects zero per_minute (not a meaningful rate)", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ rate: { per_minute: 0 } })),
    ).toThrow();
  });

  test("rejects negative per_hour", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ rate: { per_hour: -1 } })),
    ).toThrow();
  });

  test("rejects fractional per_day", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ rate: { per_day: 1.5 } })),
    ).toThrow();
  });
});

describe("CapabilitySchema.cost", () => {
  test("accepts cents_per_request alone", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ cost: { cents_per_request: 2 } }),
    );
    expect(parsed.cost).toEqual({ cents_per_request: 2 });
  });

  test("accepts cents_per_token alone", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ cost: { cents_per_token: 0.001 } }),
    );
    expect(parsed.cost).toEqual({ cents_per_token: 0.001 });
  });

  test("accepts zero cents_per_request (declared-free is a meaningful signal)", () => {
    const parsed = CapabilitySchema.parse(
      minCapability({ cost: { cents_per_request: 0 } }),
    );
    expect(parsed.cost).toEqual({ cents_per_request: 0 });
  });

  test("rejects empty cost envelope", () => {
    expect(() => CapabilitySchema.parse(minCapability({ cost: {} }))).toThrow(
      /at least one unit/,
    );
  });

  test("rejects negative cents_per_token", () => {
    expect(() =>
      CapabilitySchema.parse(minCapability({ cost: { cents_per_token: -0.5 } })),
    ).toThrow();
  });
});

// =============================================================================
// CortexConfigSchema integration — `capabilities:` block at top level
// =============================================================================

describe("CortexConfigSchema with capabilities: block", () => {
  test("absent capabilities: block parses cleanly (default [])", () => {
    const parsed = CortexConfigSchema.parse(minConfig());
    expect(parsed.capabilities).toEqual([]);
  });

  test("populated capabilities: block round-trips through CortexConfigSchema", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({ capabilities: [minCapability()] }),
    );
    expect(parsed.capabilities).toHaveLength(1);
    expect(parsed.capabilities[0]?.id).toBe("code-review.typescript");
    expect(parsed.capabilities[0]?.provided_by).toEqual(["luna"]);
  });

  test("invalid capability id is rejected at top-level CortexConfig parse", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({ capabilities: [minCapability({ id: "Code-Review" })] }),
      ),
    ).toThrow(/capability id must be dot-separated/);
  });

  test("missing description is rejected at top-level CortexConfig parse", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          capabilities: [
            { id: "code-review.typescript", tags: [], provided_by: ["luna"] },
          ],
        }),
      ),
    ).toThrow();
  });

  test("free-text capability declaration (string instead of object) is rejected", () => {
    // The most common "free-text" mistake: writing the capability as a bare
    // string slug. The schema is explicitly constrained per Q2 lock-in.
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({ capabilities: ["code-review.typescript"] }),
      ),
    ).toThrow();
  });
});

// =============================================================================
// Document-level invariants — uniqueness + cross-field references (A.6.3)
// =============================================================================

describe("CortexConfigSchema — capability id uniqueness", () => {
  test("duplicate capability ids in catalog rejected", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          capabilities: [
            minCapability({ id: "code-review.typescript" }),
            minCapability({ id: "code-review.typescript", description: "dup" }),
          ],
        }),
      ),
    ).toThrow(/capability ids must be unique/);
  });

  test("two distinct ids in catalog parse cleanly", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        capabilities: [
          minCapability({ id: "code-review.typescript" }),
          minCapability({ id: "code-review.python" }),
        ],
      }),
    );
    expect(parsed.capabilities).toHaveLength(2);
  });
});

describe("CortexConfigSchema — provided_by → agents[] reference resolution", () => {
  test("provided_by referencing declared agent parses", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [minAgent({ id: "echo" })],
        capabilities: [minCapability({ provided_by: ["echo"] })],
      }),
    );
    expect(parsed.capabilities[0]?.provided_by).toEqual(["echo"]);
  });

  test("provided_by referencing undeclared agent is rejected with named error", () => {
    // ZodError.message JSON-encodes the issues array, so inner double-quotes
    // get backslash-escaped. The regex matches the substring shape without
    // anchoring on the quote character (`["]` lets us accept either).
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [minAgent({ id: "luna" })],
          capabilities: [
            minCapability({
              id: "code-review.typescript",
              provided_by: ["echo"], // not declared
            }),
          ],
        }),
      ),
    ).toThrow(/lists provider agent .*echo/);
  });

  test("error message names the offending capability and the declared agent set", () => {
    try {
      CortexConfigSchema.parse(
        minConfig({
          agents: [minAgent({ id: "luna" }), minAgent({ id: "echo" })],
          capabilities: [
            minCapability({
              id: "code-review.typescript",
              provided_by: ["holly"], // not in [luna, echo]
            }),
          ],
        }),
      );
      throw new Error("expected parse to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("code-review.typescript");
      expect(msg).toContain("holly");
      expect(msg).toContain("luna");
      expect(msg).toContain("echo");
    }
  });

  test("multiple dangling provider references are all reported", () => {
    // Principals with many broken references see the full batch, not just
    // the first — the superRefine accumulates issues across the walk.
    try {
      CortexConfigSchema.parse(
        minConfig({
          agents: [minAgent({ id: "luna" })],
          capabilities: [
            minCapability({
              id: "code-review.typescript",
              provided_by: ["luna", "echo"], // echo not declared
            }),
            minCapability({
              id: "deploy",
              provided_by: ["holly"], // holly not declared
            }),
          ],
        }),
      );
      throw new Error("expected parse to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("echo");
      expect(msg).toContain("holly");
    }
  });
});

describe("CortexConfigSchema — agents[].runtime.capabilities → catalog (A.6.3)", () => {
  test("agent runtime capability referencing declared catalog entry parses", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript"],
            },
          }),
        ],
        capabilities: [minCapability({ id: "code-review.typescript", provided_by: ["luna"] })],
      }),
    );
    expect(parsed.agents[0]?.runtime?.capabilities).toEqual([
      "code-review.typescript",
    ]);
  });

  test("B-0 (cortex#1021) — agent declaring an uncatalogued capability now parses cleanly", () => {
    // The former check #3 (every runtime.capabilities[] entry must exist in
    // the top-level catalog) is RETIRED per design-bot-packs §7 + §11. An
    // agent declaring `runtime.capabilities: [X]` IS a provider of X; the
    // effective catalog synthesizes the entry. So this no longer throws.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript"], // not in empty catalog
            },
          }),
        ],
        // capabilities: omitted → defaults to []
      }),
    );
    expect(parsed.agents[0]?.runtime?.capabilities).toEqual([
      "code-review.typescript",
    ]);
    // The explicit catalog is still empty — derivation happens at boot/reload
    // (`deriveEffectiveCapabilityCatalog`), NOT inside the parsed config.
    expect(parsed.capabilities).toEqual([]);
  });

  test("B-0 (cortex#1021) — mixed catalogued + declaration-only capabilities both parse", () => {
    // One capability has an explicit catalog entry; another exists ONLY via
    // the agent's declaration. Both are accepted; the explicit one is
    // unchanged in the parsed config, the declaration-only one is NOT injected
    // into `config.capabilities` (it surfaces only in the derived catalog).
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "echo",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript", "deploy.k8s"],
            },
          }),
        ],
        capabilities: [
          minCapability({ id: "code-review.typescript", provided_by: ["echo"] }),
        ],
      }),
    );
    expect(parsed.capabilities.map((c) => c.id)).toEqual([
      "code-review.typescript",
    ]);
    expect(parsed.agents[0]?.runtime?.capabilities).toEqual([
      "code-review.typescript",
      "deploy.k8s",
    ]);
  });

  test("B-0 (cortex#1021) — an EXPLICIT provided_by naming a nonexistent agent is STILL rejected", () => {
    // The typo guard (check #2) is preserved: a hand-authored provided_by[]
    // that names a phantom agent is still a config error. Only the agent-side
    // reference check (former check #3) was retired.
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [minAgent({ id: "echo" })],
          capabilities: [
            minCapability({
              id: "code-review.typescript",
              provided_by: ["nonexistent-agent"],
            }),
          ],
        }),
      ),
    ).toThrow(/provider agent .*nonexistent-agent/);
  });

  test("empty catalog + empty agent runtime.capabilities parses cleanly", () => {
    // Backward-compat path: deployments not yet declaring any capabilities
    // continue to parse without surfacing a refine error.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: [],
            },
          }),
        ],
      }),
    );
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.agents[0]?.runtime?.capabilities).toEqual([]);
  });

  test("multiple agents may share a capability id (catalog is stack-wide)", () => {
    // Q2 lock-in: a capability declaration is stack-wide. Multiple agents
    // can reference the same id, and the catalog's `provided_by[]` can list
    // multiple providers — they're parallel expressions of the same fact.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript"],
            },
          }),
          {
            id: "echo",
            displayName: "Echo",
            persona: "./personas/echo.md",
            presence: { discord: minDiscordPresence() },
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript"],
            },
          },
        ],
        capabilities: [
          minCapability({
            id: "code-review.typescript",
            provided_by: ["luna", "echo"],
          }),
        ],
      }),
    );
    expect(parsed.capabilities[0]?.provided_by).toEqual(["luna", "echo"]);
    expect(parsed.agents.map((a) => a.runtime?.capabilities)).toEqual([
      ["code-review.typescript"],
      ["code-review.typescript"],
    ]);
  });

  test("B-0 (cortex#1021) — multiple declaration-only capabilities all parse (former dangling-ref check retired)", () => {
    // Pre-B-0 this asserted that an agent claiming multiple uncatalogued
    // capabilities surfaced a dangling-reference error per capability. Under
    // B-0 those declarations are valid: each becomes a derived/synthesized
    // catalog entry. Assert the config now parses and preserves the claims.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["missing-a", "missing-b"],
            },
          }),
        ],
      }),
    );
    expect(parsed.agents[0]?.runtime?.capabilities).toEqual([
      "missing-a",
      "missing-b",
    ]);
    expect(parsed.capabilities).toEqual([]);
  });
});

// =============================================================================
// cortex#237 PR-4 — AgentRuntimeSchema sovereignty + maxConcurrent extension
// =============================================================================
//
// Both new fields are OPTIONAL siblings on `agents[].runtime`. The load-bearing
// invariant is back-compat: every cortex.yaml that parsed before PR-4 MUST
// continue to parse byte-identically. The new fields add validation only when
// the principal opts in.
//
// Runtime consumption of these values (sovereignty checks in the per-envelope
// pipeline, maxConcurrent backpressure naks) is PR-5/PR-6's concern — these
// tests assert schema parsing only.

describe("AgentRuntimeSchema — cortex#237 PR-4 sovereignty + maxConcurrent", () => {
  test("runtime without sovereignty/maxConcurrent parses unchanged (back-compat)", () => {
    // THE load-bearing test: every existing cortex.yaml that omits the new
    // fields parses with the same shape it did before PR-4.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: [],
            },
          }),
        ],
      }),
    );
    const rt = parsed.agents[0]?.runtime;
    expect(rt).toBeDefined();
    expect(rt?.sovereignty).toBeUndefined();
    expect(rt?.maxConcurrent).toBeUndefined();
  });

  test("runtime with sovereignty: selective parses", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: [],
              sovereignty: "selective",
            },
          }),
        ],
      }),
    );
    expect(parsed.agents[0]?.runtime?.sovereignty).toBe("selective");
  });

  test("all four sovereignty modes are accepted (open/selective/strict/bidding)", () => {
    // The enum mirrors myelin's `sovereignty_required` taxonomy (vendor
    // envelope.schema.json:159, F-021 + F-10) and architecture §7.4. The test
    // pins the full set so a future enum trim shows up here, not in runtime.
    for (const mode of ["open", "selective", "strict", "bidding"] as const) {
      const parsed = CortexConfigSchema.parse(
        minConfig({
          agents: [
            minAgent({
              id: "luna",
              runtime: {
                substrate: "claude-code",
                mode: "in-process",
                capabilities: [],
                sovereignty: mode,
              },
            }),
          ],
        }),
      );
      expect(parsed.agents[0]?.runtime?.sovereignty).toBe(mode);
    }
  });

  test("sovereignty with an unknown value is rejected", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [
            minAgent({
              id: "luna",
              runtime: {
                substrate: "claude-code",
                mode: "in-process",
                capabilities: [],
                sovereignty: "lenient", // not a valid mode
              },
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  test("maxConcurrent: 5 parses", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: [],
              maxConcurrent: 5,
            },
          }),
        ],
      }),
    );
    expect(parsed.agents[0]?.runtime?.maxConcurrent).toBe(5);
  });

  test("maxConcurrent: 1 parses (lower bound)", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "luna",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: [],
              maxConcurrent: 1,
            },
          }),
        ],
      }),
    );
    expect(parsed.agents[0]?.runtime?.maxConcurrent).toBe(1);
  });

  test("maxConcurrent: 0 is rejected with a helpful message", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [
            minAgent({
              id: "luna",
              runtime: {
                substrate: "claude-code",
                mode: "in-process",
                capabilities: [],
                maxConcurrent: 0,
              },
            }),
          ],
        }),
      ),
    ).toThrow(/positive integer/);
  });

  test("maxConcurrent: -1 is rejected", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [
            minAgent({
              id: "luna",
              runtime: {
                substrate: "claude-code",
                mode: "in-process",
                capabilities: [],
                maxConcurrent: -1,
              },
            }),
          ],
        }),
      ),
    ).toThrow(/positive integer/);
  });

  test("maxConcurrent: 1.5 is rejected (must be integer)", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({
          agents: [
            minAgent({
              id: "luna",
              runtime: {
                substrate: "claude-code",
                mode: "in-process",
                capabilities: [],
                maxConcurrent: 1.5,
              },
            }),
          ],
        }),
      ),
    ).toThrow(/integer/);
  });

  test("sovereignty + maxConcurrent compose with declared capabilities (full PR-4 shape)", () => {
    // The shape the design spec uses in its cortex.yaml example (§3.4):
    // capabilities[] + sovereignty + maxConcurrent as siblings under runtime.
    const parsed = CortexConfigSchema.parse(
      minConfig({
        agents: [
          minAgent({
            id: "echo",
            displayName: "Echo",
            persona: "./personas/echo.md",
            runtime: {
              substrate: "claude-code",
              mode: "in-process",
              capabilities: ["code-review.typescript"],
              sovereignty: "selective",
              maxConcurrent: 3,
            },
          }),
        ],
        capabilities: [
          minCapability({ id: "code-review.typescript", provided_by: ["echo"] }),
        ],
      }),
    );
    const rt = parsed.agents[0]?.runtime;
    expect(rt?.capabilities).toEqual(["code-review.typescript"]);
    expect(rt?.sovereignty).toBe("selective");
    expect(rt?.maxConcurrent).toBe(3);
  });
});

// =============================================================================
// Type round-trip — exported type aliases match the schema
// =============================================================================

describe("Type exports", () => {
  test("Capability infers from CapabilitySchema", () => {
    // The structural compile-time check: a `Capability` value can be
    // constructed inline matching the schema's output shape. If the type
    // export drifts, this test fails to compile rather than asserting
    // at runtime.
    const cap: Capability = {
      id: "code-review.typescript",
      description: "TypeScript code review",
      tags: ["typescript"],
      provided_by: ["luna"],
    };
    const parsed = CapabilitySchema.parse(cap);
    expect(parsed.id).toBe(cap.id);
  });

  test("CapabilityRate type aligns with the rate envelope shape", () => {
    const rate: CapabilityRate = { per_minute: 10 };
    expect(rate.per_minute).toBe(10);
  });

  test("CapabilityCost type aligns with the cost envelope shape", () => {
    const cost: CapabilityCost = { cents_per_request: 2 };
    expect(cost.cents_per_request).toBe(2);
  });
});
