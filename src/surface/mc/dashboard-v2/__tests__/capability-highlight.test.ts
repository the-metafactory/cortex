/**
 * G-1114.F.2 — cross-component hover-highlight logic tests.
 *
 * Pure (no DOM). Covers each hover target → highlight set, the null/empty
 * resting state, multi-match, and the membership helpers.
 */

import { describe, it, expect } from "bun:test";
import {
  buildCapabilityMatchIndex,
  type MatchAgent,
  type MatchTask,
} from "../lib/capability-match";
import {
  computeHighlight,
  isAgentHighlighted,
  isCapabilityHighlighted,
  isTaskHighlighted,
  EMPTY_HIGHLIGHT,
} from "../lib/capability-highlight";

function agent(
  key: string,
  capabilities: string[],
  origin: MatchAgent["origin"] = "local",
): MatchAgent {
  return { key, capabilities, origin };
}
function task(id: string, capability: string | null): MatchTask {
  return { id, capability };
}

const luna = agent("p/s/luna", ["review.code", "design"]);
const echo = agent("p/s/echo", ["review.code"]);
const tasks: MatchTask[] = [task("t1", "review.code"), task("t2", "design")];
const idx = buildCapabilityMatchIndex([luna, echo], tasks);

describe("computeHighlight — null target", () => {
  it("returns the shared empty highlight (nothing lit)", () => {
    const h = computeHighlight(null, idx);
    expect(h).toBe(EMPTY_HIGHLIGHT);
    expect(h.isEmpty).toBe(true);
    expect(isAgentHighlighted(h, "p/s/luna")).toBe(false);
    expect(isCapabilityHighlighted(h, "review.code")).toBe(false);
    expect(isTaskHighlighted(h, "t1")).toBe(false);
  });
});

describe("computeHighlight — capability hover", () => {
  it("lights every agent declaring the capability + the capability itself", () => {
    const h = computeHighlight(
      { kind: "capability", capability: "review.code" },
      idx,
    );
    expect([...h.agentKeys].sort()).toEqual(["p/s/echo", "p/s/luna"]);
    expect(isCapabilityHighlighted(h, "review.code")).toBe(true);
    expect(isAgentHighlighted(h, "p/s/luna")).toBe(true);
    expect(isAgentHighlighted(h, "p/s/echo")).toBe(true);
    // a capability hover lights no tasks.
    expect(h.taskIds.size).toBe(0);
    expect(h.isEmpty).toBe(false);
  });

  it("single-match capability lights only the one agent", () => {
    const h = computeHighlight({ kind: "capability", capability: "design" }, idx);
    expect([...h.agentKeys]).toEqual(["p/s/luna"]);
  });

  it("a capability nobody declares lights only the badge, no agents", () => {
    const h = computeHighlight({ kind: "capability", capability: "ops" }, idx);
    expect(h.agentKeys.size).toBe(0);
    expect(isCapabilityHighlighted(h, "ops")).toBe(true);
    // the badge itself counts as lit, so not "empty".
    expect(h.isEmpty).toBe(false);
  });
});

describe("computeHighlight — agent hover", () => {
  it("lights the agent + its capabilities + the tasks it could serve", () => {
    const h = computeHighlight({ kind: "agent", agentKey: "p/s/luna" }, idx);
    expect(isAgentHighlighted(h, "p/s/luna")).toBe(true);
    expect([...h.capabilities].sort()).toEqual(["design", "review.code"]);
    expect([...h.taskIds].sort()).toEqual(["t1", "t2"]);
  });

  it("an agent with caps but no matching task lights its caps, no tasks", () => {
    const sage = agent("p/s/sage", ["ops"]);
    const idx2 = buildCapabilityMatchIndex([sage], tasks);
    const h = computeHighlight({ kind: "agent", agentKey: "p/s/sage" }, idx2);
    expect(isAgentHighlighted(h, "p/s/sage")).toBe(true);
    expect([...h.capabilities]).toEqual(["ops"]);
    expect(h.taskIds.size).toBe(0);
  });

  it("an unknown agent key lights only itself (defensive)", () => {
    const h = computeHighlight({ kind: "agent", agentKey: "nope" }, idx);
    expect(isAgentHighlighted(h, "nope")).toBe(true);
    expect(h.capabilities.size).toBe(0);
    expect(h.taskIds.size).toBe(0);
  });
});

describe("computeHighlight — federated agent", () => {
  it("highlights a foreign agent on a capability hover like a local one", () => {
    const foreign = agent("jc/research/echo", ["review.code"], {
      principal: "jc",
      stack: "research",
    });
    const idx3 = buildCapabilityMatchIndex([luna, foreign], tasks);
    const h = computeHighlight(
      { kind: "capability", capability: "review.code" },
      idx3,
    );
    expect(isAgentHighlighted(h, "jc/research/echo")).toBe(true);
    expect(isAgentHighlighted(h, "p/s/luna")).toBe(true);
  });
});
