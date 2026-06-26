/**
 * #1206 (operator-driven dev-loop, S1) — orchestrator command boundary tests.
 *
 * Two surfaces under test, per the slice brief:
 *   (a) the gated parse — principal vs non-principal sender, valid vs invalid
 *       command, orchestrator vs chat agent;
 *   (b) the dispatch publish — mock the runtime, assert the `dev-events`
 *       builder produced a `tasks.dev.implement` envelope of the right shape
 *       and that it was published exactly once.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../../bus/myelin/runtime";
import type { DevEventSource } from "../../bus/dev-events";
import { parseDevImplementPayload } from "../../bus/dev-events";
import { createDispatchTaskCompletedEvent } from "../../bus/dispatch-events";
import { readLogicalRouting } from "../../adapters/response-routing-delivery";
import {
  ORCHESTRATOR_CAPABILITY,
  DEFAULT_RUN_SURFACE,
  parseImplementCommand,
  resolveRepo,
  buildImplementPayload,
  buildRunThreadRouting,
  handleOrchestratorCommand,
} from "../orchestrator-command";

const SOURCE: DevEventSource = {
  principal: "andreas",
  agent: "vega",
  instance: "local",
};

const REPOS = ["the-metafactory/cortex", "the-metafactory/myelin"];

/** A runtime that records every published envelope. */
function recordingRuntime(): { runtime: MyelinRuntime; published: Envelope[] } {
  const published: Envelope[] = [];
  const handlers = new Set<EnvelopeHandler>();
  const runtime: MyelinRuntime = {
    enabled: true,
    onEnvelope(h) {
      handlers.add(h);
      return { unregister: () => handlers.delete(h) };
    },
    publish: async (e: Envelope) => {
      published.push(e);
    },
    stop: async () => {},
  };
  return { runtime, published };
}

// ---------------------------------------------------------------------------
// (a) parser
// ---------------------------------------------------------------------------

describe("parseImplementCommand", () => {
  test("parses `implement {short-repo}#{N}`", () => {
    expect(parseImplementCommand("implement cortex#1196")).toEqual({
      repoToken: "cortex",
      issue: 1196,
    });
  });

  test("parses `owner/name` repo form", () => {
    expect(parseImplementCommand("implement the-metafactory/cortex#42")).toEqual({
      repoToken: "the-metafactory/cortex",
      issue: 42,
    });
  });

  test("case-insensitive verb + tolerates a trailing comment", () => {
    expect(
      parseImplementCommand("Implement cortex#7 — focus on the dispatch path"),
    ).toEqual({ repoToken: "cortex", issue: 7 });
  });

  test("rejects a non-command chat message", () => {
    expect(parseImplementCommand("hey pilot, how's the loop going?")).toBeNull();
    expect(parseImplementCommand("what's the status on cortex#5?")).toBeNull();
  });

  test("does not match `implementation` (verb needs a word boundary)", () => {
    expect(parseImplementCommand("implementation cortex#5")).toBeNull();
  });

  test("rejects a missing / zero issue number", () => {
    expect(parseImplementCommand("implement cortex")).toBeNull();
    expect(parseImplementCommand("implement cortex#0")).toBeNull();
  });
});

describe("resolveRepo", () => {
  test("short name → owner/name", () => {
    expect(resolveRepo("cortex", REPOS)).toBe("the-metafactory/cortex");
  });

  test("owner/name passes through only when on the roster", () => {
    expect(resolveRepo("the-metafactory/cortex", REPOS)).toBe("the-metafactory/cortex");
    expect(resolveRepo("evil/cortex", REPOS)).toBeNull();
  });

  test("unknown short name → null", () => {
    expect(resolveRepo("signal", REPOS)).toBeNull();
  });

  test("ambiguous short name → null (never guesses)", () => {
    expect(resolveRepo("cortex", ["a/cortex", "b/cortex"])).toBeNull();
  });
});

describe("buildImplementPayload", () => {
  test("produces a dev-consumer-valid payload", () => {
    const payload = buildImplementPayload({ repoToken: "cortex", issue: 1196 }, REPOS);
    expect(payload).not.toBeNull();
    expect(payload?.repo).toBe("the-metafactory/cortex");
    expect(payload?.base).toBe("main");
    expect(payload?.branch).toBe("feat/1196-cortex");
    expect(payload?.issue).toBe(1196);
    expect(payload?.brief).toContain("the-metafactory/cortex#1196");
    // No repo-specific gate commands baked in by the orchestrator.
    expect(payload?.gates).toBeUndefined();
  });

  test("unresolvable repo → null", () => {
    expect(buildImplementPayload({ repoToken: "ghost", issue: 1 }, REPOS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (a) gate + (b) dispatch — handleOrchestratorCommand
// ---------------------------------------------------------------------------

describe("handleOrchestratorCommand — gate", () => {
  test("non-orchestrator agent → pass-through (never dispatches)", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: false,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });
    expect(outcome.kind).toBe("pass-through");
    expect(published).toHaveLength(0);
  });

  test("orchestrator + non-command message → pass-through (falls to chat)", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "hey vega, anything blocked?",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });
    expect(outcome.kind).toBe("pass-through");
    expect(published).toHaveLength(0);
  });

  test("FAIL-CLOSED: command from a non-principal is ignored, NOT dispatched", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: false,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });
    expect(outcome.kind).toBe("ignored");
    expect(published).toHaveLength(0);
  });

  test("principal command against an unknown repo → error, no dispatch", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement ghost#5",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });
    expect(outcome.kind).toBe("error");
    expect(published).toHaveLength(0);
  });

  test("principal command but bus runtime unavailable → error, no throw", async () => {
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime: undefined,
      source: undefined,
    });
    expect(outcome.kind).toBe("error");
  });
});

describe("handleOrchestratorCommand — dispatch publish", () => {
  test("principal command publishes ONE tasks.dev.implement envelope (dev-events builder)", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });

    expect(outcome.kind).toBe("dispatched");
    expect(published).toHaveLength(1);

    const env = published[0]!;
    // Built by the dev-events builder: correct type + UUID id + local sovereignty.
    expect(env.type).toBe("tasks.dev.implement");
    expect(env.source).toBe("andreas.vega.local");
    expect(env.sovereignty?.classification).toBe("local");
    expect(typeof env.id).toBe("string");
    expect(env.id.length).toBeGreaterThan(0);

    // The published envelope round-trips through the consumer's own parser —
    // proves the orchestrator emits exactly what `dev-consumer` parses.
    const parsed = parseDevImplementPayload(env);
    expect(parsed).not.toBeNull();
    expect(parsed?.repo).toBe("the-metafactory/cortex");
    expect(parsed?.base).toBe("main");
    expect(parsed?.branch).toBe("feat/1196-cortex");
    expect(parsed?.issue).toBe(1196);
  });
});

describe("ORCHESTRATOR_CAPABILITY", () => {
  test("is the stable routing marker id", () => {
    expect(ORCHESTRATOR_CAPABILITY).toBe("dev.orchestrate");
  });
});

// ---------------------------------------------------------------------------
// cortex#1206 (S2) — dev-loop thread consolidation: run-thread routing
// ---------------------------------------------------------------------------

describe("buildRunThreadRouting", () => {
  test("keys the run thread on the ENTITY (issue), repo-short channel", () => {
    expect(buildRunThreadRouting("the-metafactory/cortex", 1196, "discord")).toEqual({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/issue/1196",
    });
  });

  test("carries the inbound surface verbatim", () => {
    expect(buildRunThreadRouting("the-metafactory/myelin", 7, "mattermost").surface).toBe(
      "mattermost",
    );
  });
});

describe("handleOrchestratorCommand — run-thread routing (cortex#1206 S2)", () => {
  test("stamps the LOGICAL run-thread routing on the dispatch envelope", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
      surface: "discord",
    });

    expect(outcome.kind).toBe("dispatched");
    if (outcome.kind !== "dispatched") return;

    // The outcome carries the routing so the handler can post the ack into it.
    expect(outcome.routing).toEqual({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/issue/1196",
    });

    // The dispatch envelope carries the SAME routing as `response_routing` —
    // this is exactly what the dev consumer reads via `readLogicalRouting`
    // and echoes onto every lifecycle envelope.
    const env = published[0]!;
    expect(readLogicalRouting(env)).toEqual(outcome.routing);
  });

  test("surface defaults to discord when the caller omits it", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
    });
    expect(outcome.kind).toBe("dispatched");
    expect(readLogicalRouting(published[0]!)?.surface).toBe(DEFAULT_RUN_SURFACE);
  });

  test("the run routing flows dispatch → lifecycle unchanged (one thread key)", async () => {
    const { runtime, published } = recordingRuntime();
    const outcome = await handleOrchestratorCommand({
      text: "implement cortex#1196",
      isOrchestrator: true,
      authorIsPrincipal: true,
      knownRepos: REPOS,
      runtime,
      source: SOURCE,
      surface: "discord",
    });
    expect(outcome.kind).toBe("dispatched");

    // Simulate the dev consumer echoing the request's routing onto a terminal
    // `dispatch.task.completed` (PR opened). The lifecycle envelope must carry
    // the IDENTICAL logical thread address, so the review-sink resolves both
    // the dispatch and the lifecycle to the SAME `{repo}/issue/N` thread.
    const echoed = readLogicalRouting(published[0]!);
    expect(echoed).not.toBeNull();
    const completed = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: crypto.randomUUID(),
      agentId: "forge",
      correlationId: published[0]!.id,
      responseRouting: echoed!,
      startedAt: new Date(),
      completedAt: new Date(),
      resultSummary: "opened the-metafactory/cortex#1200",
      chatResponse: JSON.stringify({ pr: { number: 1200 } }),
    });
    expect(readLogicalRouting(completed)).toEqual({
      surface: "discord",
      channel: "cortex",
      thread: "cortex/issue/1196",
    });
  });
});
