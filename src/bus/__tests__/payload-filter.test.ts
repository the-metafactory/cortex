/**
 * Tests for `src/bus/payload-filter.ts` — G-1111.A v1 operator subset.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import { matchesFilter, type PayloadFilter } from "../payload-filter";

// ---------------------------------------------------------------------------
// Envelope factory — we only care about the fields the filter inspects, so
// build a structurally-valid Envelope-shaped object via a single helper.
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000000",
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
    payload: { repo: "grove", urgency: "normal" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Degenerate cases
// ---------------------------------------------------------------------------

describe("matchesFilter — degenerate cases", () => {
  test("undefined filter passes (no filter = match all)", () => {
    expect(matchesFilter(makeEnvelope(), undefined)).toBe(true);
  });

  test("empty filter object passes", () => {
    expect(matchesFilter(makeEnvelope(), {})).toBe(true);
  });

  test("filter with only an empty envelope pattern passes", () => {
    expect(matchesFilter(makeEnvelope(), { envelope: {} })).toBe(true);
  });

  test("filter with only an empty payload pattern passes", () => {
    expect(matchesFilter(makeEnvelope(), { payload: {} })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact match (any-of)
// ---------------------------------------------------------------------------

describe("matchesFilter — exact match (any-of)", () => {
  test("single literal in array — matches", () => {
    const filter: PayloadFilter = { payload: { repo: ["grove"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });

  test("single literal in array — no match", () => {
    const filter: PayloadFilter = { payload: { repo: ["myelin"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });

  test("multi-literal any-of — matches first", () => {
    const filter: PayloadFilter = { payload: { repo: ["grove", "myelin"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });

  test("multi-literal any-of — matches second", () => {
    const filter: PayloadFilter = { payload: { repo: ["myelin", "grove"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });

  test("multi-literal any-of — no match in any", () => {
    const filter: PayloadFilter = { payload: { repo: ["myelin", "signal"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });

  test("number literal exact match", () => {
    const env = makeEnvelope({ payload: { cycle: 3 } });
    expect(matchesFilter(env, { payload: { cycle: [3] } })).toBe(true);
    expect(matchesFilter(env, { payload: { cycle: [4] } })).toBe(false);
  });

  test("boolean literal exact match", () => {
    const env = makeEnvelope({ payload: { final: true } });
    expect(matchesFilter(env, { payload: { final: [true] } })).toBe(true);
    expect(matchesFilter(env, { payload: { final: [false] } })).toBe(false);
  });

  test("missing field — exact match fails", () => {
    const filter: PayloadFilter = { payload: { foo: ["bar"] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });

  test("empty candidate list — never matches", () => {
    const filter: PayloadFilter = { payload: { repo: [] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// anything-but
// ---------------------------------------------------------------------------

describe("matchesFilter — anything-but", () => {
  test("scalar form — matches when actual differs", () => {
    const env = makeEnvelope({ payload: { urgency: "low" } });
    const filter: PayloadFilter = { payload: { urgency: [{ "anything-but": "high" }] } };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("scalar form — fails when actual equals banned", () => {
    const env = makeEnvelope({ payload: { urgency: "low" } });
    const filter: PayloadFilter = { payload: { urgency: [{ "anything-but": "low" }] } };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("array form — matches when actual not in list", () => {
    const env = makeEnvelope({ payload: { urgency: "normal" } });
    const filter: PayloadFilter = {
      payload: { urgency: [{ "anything-but": ["low", "high"] }] },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("array form — fails when actual in list", () => {
    const env = makeEnvelope({ payload: { urgency: "high" } });
    const filter: PayloadFilter = {
      payload: { urgency: [{ "anything-but": ["low", "high"] }] },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("missing field — anything-but fails (presence required)", () => {
    const filter: PayloadFilter = {
      payload: { absent: [{ "anything-but": "x" }] },
    };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prefix
// ---------------------------------------------------------------------------

describe("matchesFilter — prefix", () => {
  test("matches when string starts with prefix", () => {
    const env = makeEnvelope({ payload: { title: "[security] fix CVE" } });
    const filter: PayloadFilter = { payload: { title: [{ prefix: "[security]" }] } };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("does not match when string lacks prefix", () => {
    const env = makeEnvelope({ payload: { title: "fix CVE" } });
    const filter: PayloadFilter = { payload: { title: [{ prefix: "[security]" }] } };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("empty prefix matches any string", () => {
    const env = makeEnvelope({ payload: { title: "anything" } });
    const filter: PayloadFilter = { payload: { title: [{ prefix: "" }] } };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("non-string field never matches a prefix operator", () => {
    const env = makeEnvelope({ payload: { count: 42 } });
    const filter: PayloadFilter = { payload: { count: [{ prefix: "4" }] } };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("missing field fails prefix match", () => {
    const filter: PayloadFilter = { payload: { absent: [{ prefix: "" }] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("matchesFilter — exists", () => {
  test("{exists: true} matches when present", () => {
    const filter: PayloadFilter = { payload: { repo: [{ exists: true }] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });

  test("{exists: true} fails when absent", () => {
    const filter: PayloadFilter = { payload: { absent: [{ exists: true }] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });

  test("{exists: false} matches when absent", () => {
    const filter: PayloadFilter = { payload: { absent: [{ exists: false }] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });

  test("{exists: false} fails when present", () => {
    const filter: PayloadFilter = { payload: { repo: [{ exists: false }] } };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// equals-ignore-case
// ---------------------------------------------------------------------------

describe("matchesFilter — equals-ignore-case", () => {
  test("matches across case differences", () => {
    const env = makeEnvelope({ payload: { state: "Approved" } });
    const filter: PayloadFilter = {
      payload: { state: [{ "equals-ignore-case": "APPROVED" }] },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("does not match different content", () => {
    const env = makeEnvelope({ payload: { state: "rejected" } });
    const filter: PayloadFilter = {
      payload: { state: [{ "equals-ignore-case": "approved" }] },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("non-string never matches equals-ignore-case", () => {
    const env = makeEnvelope({ payload: { count: 1 } });
    const filter: PayloadFilter = {
      payload: { count: [{ "equals-ignore-case": "1" }] },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed and-or — multi-key (AND across keys, OR within a leaf)
// ---------------------------------------------------------------------------

describe("matchesFilter — multi-key AND, multi-value OR", () => {
  test("two keys both match", () => {
    const env = makeEnvelope({ payload: { repo: "grove", urgency: "high" } });
    const filter: PayloadFilter = {
      payload: { repo: ["grove"], urgency: ["high"] },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("two keys, one fails => filter fails", () => {
    const env = makeEnvelope({ payload: { repo: "grove", urgency: "low" } });
    const filter: PayloadFilter = {
      payload: { repo: ["grove"], urgency: ["high"] },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("OR within a single key's array", () => {
    const env = makeEnvelope({ payload: { urgency: "high" } });
    const filter: PayloadFilter = {
      payload: {
        urgency: [{ prefix: "med" }, { "equals-ignore-case": "HIGH" }],
      },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nested paths
// ---------------------------------------------------------------------------

describe("matchesFilter — nested paths", () => {
  test("nested key matches", () => {
    const env = makeEnvelope({
      payload: { pr: { repo: "grove", number: 42 } },
    });
    const filter: PayloadFilter = {
      payload: { pr: { repo: ["grove"] } },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("nested key fails", () => {
    const env = makeEnvelope({
      payload: { pr: { repo: "myelin", number: 42 } },
    });
    const filter: PayloadFilter = {
      payload: { pr: { repo: ["grove"] } },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("two-deep nested key", () => {
    const env = makeEnvelope({
      payload: { reviewer: { principal: { did: "did:mf:luna" } } },
    });
    const filter: PayloadFilter = {
      payload: { reviewer: { principal: { did: ["did:mf:luna"] } } },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("nested missing object — leaf misses", () => {
    const filter: PayloadFilter = {
      payload: { pr: { repo: ["grove"] } },
    };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(false);
  });

  test("nested missing object with {exists: false} subtree passes", () => {
    const filter: PayloadFilter = {
      payload: { pr: { repo: [{ exists: false }] } },
    };
    expect(matchesFilter(makeEnvelope(), filter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Envelope-level matching
// ---------------------------------------------------------------------------

describe("matchesFilter — envelope-level", () => {
  test("envelope.type exact match", () => {
    const env = makeEnvelope();
    const filter: PayloadFilter = {
      envelope: { type: ["review.cycle.completed"] },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("envelope.type prefix match", () => {
    const env = makeEnvelope();
    const filter: PayloadFilter = {
      envelope: { type: [{ prefix: "review." }] },
    };
    expect(matchesFilter(env, filter)).toBe(true);
  });

  test("envelope.source mismatch", () => {
    const env = makeEnvelope({ source: "metafactory.discord.luna" });
    const filter: PayloadFilter = {
      envelope: { source: ["metafactory.pilot.local"] },
    };
    expect(matchesFilter(env, filter)).toBe(false);
  });

  test("envelope AND payload — both must pass", () => {
    const env = makeEnvelope();
    const passing: PayloadFilter = {
      envelope: { type: [{ prefix: "review." }] },
      payload: { repo: ["grove"] },
    };
    expect(matchesFilter(env, passing)).toBe(true);

    const failing: PayloadFilter = {
      envelope: { type: [{ prefix: "review." }] },
      payload: { repo: ["myelin"] },
    };
    expect(matchesFilter(env, failing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown-operator fail-closed (defensive)
// ---------------------------------------------------------------------------

describe("matchesFilter — unknown operator fails closed", () => {
  test("operator object with an unrecognised key never matches", () => {
    const env = makeEnvelope();
    // Build a value that bypasses the FilterValue union via a cast — this
    // models a malformed config that slipped past type-check (e.g.,
    // hand-edited YAML).
    const filter = {
      payload: { repo: [{ "wildcard-glob": "gr*ve" } as unknown as { prefix: string }] },
    } satisfies PayloadFilter;
    expect(matchesFilter(env, filter)).toBe(false);
  });
});
