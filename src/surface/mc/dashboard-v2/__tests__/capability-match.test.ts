/**
 * G-1114.F.1 — capability-match index tests.
 *
 * Pure lib (no DOM), so plain `bun test`. Covers task→agents, agent→tasks,
 * no-match, multi-match, federated agents, null-capability (unrouted) tasks,
 * dedupe, and the membership/`allCapabilities` accessors.
 */

import { describe, it, expect } from "bun:test";
import {
  buildCapabilityMatchIndex,
  type MatchAgent,
  type MatchTask,
} from "../lib/capability-match";

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

describe("buildCapabilityMatchIndex — agentsForCapability", () => {
  it("maps a capability to every agent declaring it (multi-match, input order)", () => {
    const a = agent("p/s/luna", ["review.code", "design"]);
    const b = agent("p/s/echo", ["review.code"]);
    const c = agent("p/s/sage", ["design"]);
    const idx = buildCapabilityMatchIndex([a, b, c], []);

    expect(idx.agentsForCapability("review.code").map((x) => x.key)).toEqual([
      "p/s/luna",
      "p/s/echo",
    ]);
    expect(idx.agentsForCapability("design").map((x) => x.key)).toEqual([
      "p/s/luna",
      "p/s/sage",
    ]);
  });

  it("returns an empty set for a capability no agent declares (no-match)", () => {
    const idx = buildCapabilityMatchIndex([agent("p/s/luna", ["design"])], []);
    expect(idx.agentsForCapability("review.code")).toEqual([]);
  });

  it("dedupes a capability declared twice by the same agent", () => {
    const idx = buildCapabilityMatchIndex(
      [agent("p/s/luna", ["design", "design"])],
      [],
    );
    expect(idx.agentsForCapability("design").map((x) => x.key)).toEqual([
      "p/s/luna",
    ]);
    expect(idx.capabilitiesForAgent("p/s/luna")).toEqual(["design"]);
  });
});

describe("buildCapabilityMatchIndex — tasksForAgent / agentsForTask", () => {
  it("maps an agent to the tasks whose capability it declares", () => {
    const luna = agent("p/s/luna", ["review.code", "design"]);
    const echo = agent("p/s/echo", ["review.code"]);
    const tasks: MatchTask[] = [
      task("t1", "review.code"),
      task("t2", "design"),
      task("t3", "ops"), // no agent declares it
    ];
    const idx = buildCapabilityMatchIndex([luna, echo], tasks);

    expect(idx.tasksForAgent("p/s/luna").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(idx.tasksForAgent("p/s/echo").map((t) => t.id)).toEqual(["t1"]);

    expect(idx.agentsForTask("t1").map((a) => a.key)).toEqual([
      "p/s/luna",
      "p/s/echo",
    ]);
    expect(idx.agentsForTask("t2").map((a) => a.key)).toEqual(["p/s/luna"]);
    expect(idx.agentsForTask("t3")).toEqual([]); // capability nobody serves
  });

  it("an agent that serves no task → empty tasks", () => {
    const idx = buildCapabilityMatchIndex(
      [agent("p/s/sage", ["ops"])],
      [task("t1", "review.code")],
    );
    expect(idx.tasksForAgent("p/s/sage")).toEqual([]);
  });

  it("an unknown agent key → empty (no throw)", () => {
    const idx = buildCapabilityMatchIndex([], []);
    expect(idx.tasksForAgent("nope")).toEqual([]);
    expect(idx.capabilitiesForAgent("nope")).toEqual([]);
    expect(idx.agentsForCapability("nope")).toEqual([]);
    expect(idx.agentsForTask("nope")).toEqual([]);
  });
});

describe("buildCapabilityMatchIndex — null-capability tasks (unrouted)", () => {
  it("a task with no required capability matches no agent", () => {
    const idx = buildCapabilityMatchIndex(
      [agent("p/s/luna", ["review.code"])],
      [task("t1", null)],
    );
    expect(idx.agentsForTask("t1")).toEqual([]);
    expect(idx.tasksForAgent("p/s/luna")).toEqual([]);
    expect(idx.isMatch("p/s/luna", "t1")).toBe(false);
  });
});

describe("buildCapabilityMatchIndex — federated agents", () => {
  it("matches a foreign-origin agent purely on declared capabilities", () => {
    const local = agent("andreas/research/luna", ["review.code"], "local");
    const foreign = agent("jc/research/echo", ["review.code"], {
      principal: "jc",
      stack: "research",
    });
    const idx = buildCapabilityMatchIndex(
      [local, foreign],
      [task("t1", "review.code")],
    );

    const matched = idx.agentsForCapability("review.code");
    expect(matched.map((a) => a.key)).toEqual([
      "andreas/research/luna",
      "jc/research/echo",
    ]);
    // origin is carried through, so a consumer can read local-vs-foreign.
    expect(matched[1]?.origin).toEqual({ principal: "jc", stack: "research" });
    expect(idx.isMatch("jc/research/echo", "t1")).toBe(true);
  });
});

describe("buildCapabilityMatchIndex — isMatch + allCapabilities", () => {
  it("isMatch is the capability-membership predicate", () => {
    const idx = buildCapabilityMatchIndex(
      [agent("p/s/luna", ["design"]), agent("p/s/echo", ["review.code"])],
      [task("t1", "design")],
    );
    expect(idx.isMatch("p/s/luna", "t1")).toBe(true);
    expect(idx.isMatch("p/s/echo", "t1")).toBe(false);
    expect(idx.isMatch("p/s/luna", "unknown-task")).toBe(false);
  });

  it("allCapabilities lists every distinct cap in first-seen order", () => {
    const idx = buildCapabilityMatchIndex(
      [
        agent("p/s/luna", ["design", "review.code"]),
        agent("p/s/echo", ["review.code", "ops"]),
      ],
      [],
    );
    expect(idx.allCapabilities()).toEqual(["design", "review.code", "ops"]);
  });

  it("empty inputs → empty index, no throw", () => {
    const idx = buildCapabilityMatchIndex([], []);
    expect(idx.allCapabilities()).toEqual([]);
  });
});
