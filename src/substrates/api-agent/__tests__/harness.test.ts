// API-P1.3 (issue #2063) — LIVE contract tests for `ApiAgentHarness`, driven end
// to end through the harness → `InferenceRegistry` → real provider → shared fake
// streaming server (API-P1.5 scaffold). Never a live provider, never paid creds.
//
// REUSE WITHOUT TOUCHING THE SHARED METER: the shared
// `src/providers/__tests__/contract.ts` holds the epic progress meter (one
// `test.todo` per case per gated slice) and is edited by a SIBLING slice — we
// must not touch it. Instead we import its exported case-name constants
// (`HARNESS_CONTRACT_CASES` + `PROVIDER_CONTRACT_CASES`) and the exported fake
// server (`startFakeStreamingServer`), and name our live tests with those exact
// strings, so this file is the api-agent-harness slice's live proof of the same
// cases the meter tracks — with ZERO edits to the shared files.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  HARNESS_CONTRACT_CASES,
  PROVIDER_CONTRACT_CASES,
} from "../../../providers/__tests__/contract";
import {
  startFakeStreamingServer,
  type FakeStreamingServer,
} from "../../../providers/__tests__/fake-streaming-server";
import { InferenceConfigSchema } from "../../../common/types/cortex-config";
import type { DispatchEventSource } from "../../../bus/dispatch-events";
import type {
  DispatchRequest,
  MyelinEnvelope,
} from "../../../common/substrates/types";
import { ApiAgentHarness } from "../harness";
import { createInferenceRegistry } from "../provider-factories";
import { DefaultHarnessResolver } from "../../../runner/harness-resolver";
import type { AgentRuntime } from "../../../common/types/cortex-config";

// Name harness tests verbatim from the shared meter's case lists (so a rename in
// the meter breaks compilation here rather than silently drifting).
const HCASE = (needle: string): string => {
  const found = HARNESS_CONTRACT_CASES.find((c) => c.includes(needle));
  if (!found) throw new Error(`no shared HARNESS contract case matching "${needle}"`);
  return found;
};
const PCASE = (needle: string): string => {
  const found = PROVIDER_CONTRACT_CASES.find((c) => c.includes(needle));
  if (!found) throw new Error(`no shared PROVIDER contract case matching "${needle}"`);
  return found;
};

const SOURCE: DispatchEventSource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY = "sk-secret-DO-NOT-LEAK-abc123";
const TEST_ENV = { TEST_KEY: API_KEY };
const SSE_HEADERS = { "content-type": "text/event-stream" } as const;

// ── SSE frame builders (OpenAI Chat Completions wire; the fake server ignores
// the request path, so pointing baseUrl at it works for the openai adapter). ──
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
const contentChunk = (text: string): string =>
  sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const finishChunk = (reason = "stop"): string =>
  sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (input: number, output: number): string =>
  sse({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });

let server: FakeStreamingServer;

beforeEach(() => {
  server = startFakeStreamingServer();
});
afterEach(async () => {
  await server.stop();
});

/** Build a registry whose one profile points the openai adapter at the fake server. */
function makeHarness(overrides?: {
  inferenceProfile?: string | undefined;
  now?: () => number;
}): ApiAgentHarness {
  const config = InferenceConfigSchema.parse({
    providers: {
      test: {
        protocol: "openai-chat-completions",
        baseUrl: `${server.url}/v1`,
        apiKey: "env:TEST_KEY",
      },
    },
    profiles: {
      fast: { provider: "test", model: "test-model", modelClass: "any" },
    },
  });
  const registry = createInferenceRegistry(config, { env: TEST_ENV });
  return new ApiAgentHarness({
    source: SOURCE,
    registry,
    inferenceProfile:
      overrides !== undefined && "inferenceProfile" in overrides
        ? overrides.inferenceProfile
        : "fast",
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  });
}

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    persona: { path: "/agents/cortex.md", content: "# Cortex\nBe terse." },
    prompt: "say hello",
    tools: { allow: [] },
    context: [],
    agent: { id: "cortex", displayName: "Cortex" },
    requestId: REQUEST_ID,
    ...overrides,
  };
}

async function drain(it: AsyncIterable<MyelinEnvelope>): Promise<MyelinEnvelope[]> {
  const out: MyelinEnvelope[] = [];
  for await (const env of it) out.push(env);
  return out;
}

const startedOf = (envs: MyelinEnvelope[]): MyelinEnvelope[] =>
  envs.filter((e) => e.type === "dispatch.task.started");
const terminalsOf = (envs: MyelinEnvelope[]): MyelinEnvelope[] =>
  envs.filter(
    (e) =>
      e.type === "dispatch.task.completed" ||
      e.type === "dispatch.task.failed" ||
      e.type === "dispatch.task.aborted",
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Happy path + lifecycle invariant ──────────────────────────────────────────
describe("provider contract · api-agent-harness (live, #2063)", () => {
  test(HCASE("exactly one started event"), async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("hi there") + finishChunk("stop") + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    expect(startedOf(envs)).toHaveLength(1);
    expect(envs[0]?.type).toBe("dispatch.task.started");
  });

  test(HCASE("exactly one terminal event"), async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("done") + finishChunk("stop") + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    // Happy path → completed, carrying the assistant text.
    expect(terminals[0]?.type).toBe("dispatch.task.completed");
    expect(terminals[0]?.payload.chat_response).toBe("done");
    // Terminal is the LAST yield; iterator closes after it.
    expect(envs[envs.length - 1]?.type).toBe("dispatch.task.completed");
  });

  test(HCASE("correlation identifiers stable"), async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("x") + finishChunk("stop") + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const ids = new Set(envs.map((e) => e.correlation_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(REQUEST_ID); // UUID-shaped requestId is reused verbatim
  });

  test(HCASE("shuts down cleanly on request without leaking"), async () => {
    // A stream that hangs open forces the harness's inactivity/abort path to own
    // teardown. We shut down mid-flight and assert a clean single terminal — no
    // hang (the afterEach `server.stop()` completing is the no-leak proof).
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("partial ") }],
      hangOpen: true,
    });
    const harness = makeHarness();
    const collected: Promise<MyelinEnvelope[]> = drain(harness.dispatch(makeRequest()));
    await sleep(25); // let the loop enter its await on the hanging stream
    await harness.shutdown({ graceful: false });

    const envs = await collected;
    expect(startedOf(envs)).toHaveLength(1);
    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.aborted");
  });

  // ── Limits + cancellation ───────────────────────────────────────────────────
  test(HCASE("fails closed on a denied policy / tool grant"), async () => {
    // Tool grant present → rejected BEFORE any provider call (D5). ZERO network.
    const envs = await drain(
      makeHarness().dispatch(makeRequest({ tools: { allow: ["Bash"] } })),
    );

    expect(startedOf(envs)).toHaveLength(1);
    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    expect(String(terminals[0]?.payload.error_summary)).toContain(
      "unsupported_capability",
    );
    expect(server.requests).toHaveLength(0); // never dispatched to the provider
  });

  test(PCASE("rejects an unsupported_capability request before dispatch"), async () => {
    // Attachments present → rejected BEFORE any provider call. ZERO network.
    const envs = await drain(
      makeHarness().dispatch(
        makeRequest({
          context: [{ kind: "attachments", data: [{ filename: "x.png" }] }],
        }),
      ),
    );

    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    expect(String(terminals[0]?.payload.error_summary)).toContain(
      "unsupported_capability",
    );
    expect(server.requests).toHaveLength(0);
  });

  test(
    PCASE("honors cancellation and both timeout types") + " · inactivity gap",
    async () => {
      server.enqueue({
        status: 200,
        headers: SSE_HEADERS,
        chunks: [{ data: contentChunk("slow") }],
        hangOpen: true,
      });
      const envs = await drain(
        makeHarness().dispatch(
          makeRequest({ timeoutMs: 10_000, inactivityMs: 40 }),
        ),
      );

      const terminals = terminalsOf(envs);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe("dispatch.task.failed");
      expect(String(terminals[0]?.payload.error_summary)).toContain("inactivity");
    },
  );

  test(
    PCASE("honors cancellation and both timeout types") + " · wall-clock deadline",
    async () => {
      server.enqueue({
        status: 200,
        headers: SSE_HEADERS,
        chunks: [{ data: contentChunk("slow") }],
        hangOpen: true,
      });
      const envs = await drain(
        makeHarness().dispatch(
          makeRequest({ timeoutMs: 40, inactivityMs: 10_000 }),
        ),
      );

      const terminals = terminalsOf(envs);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe("dispatch.task.failed");
      expect(String(terminals[0]?.payload.error_summary)).toContain("wall-clock");
    },
  );

  test(
    PCASE("honors cancellation and both timeout types") + " · cancellation → aborted",
    async () => {
      server.enqueue({
        status: 200,
        headers: SSE_HEADERS,
        chunks: [{ data: contentChunk("partial ") }],
        hangOpen: true,
      });
      const harness = makeHarness();
      const collected = drain(harness.dispatch(makeRequest({ timeoutMs: 10_000 })));
      await sleep(25);
      await harness.shutdown({ graceful: false });

      const envs = await collected;
      const terminals = terminalsOf(envs);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe("dispatch.task.aborted");
      expect(String(terminals[0]?.payload.reason)).toContain("cancelled");
    },
  );

  // ── Provider error seam (providers YIELD errors; loop → failed terminal) ──────
  test(PCASE("authentication (401)"), async () => {
    server.enqueue({ status: 401, chunks: [{ data: '{"error":{"message":"nope-should-not-leak"}}' }] });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    const summary = String(terminals[0]?.payload.error_summary);
    expect(summary).toContain("401");
    // The redacted provider summary carries no secret and no raw body detail.
    expect(summary).not.toContain("nope-should-not-leak");
    expect(summary).not.toContain(API_KEY);
  });

  test(PCASE("in-stream error that arrives AFTER a committed HTTP 200"), async () => {
    const payload =
      contentChunk("partial ") +
      sse({ error: { type: "server_error", code: "internal", message: "boom-should-not-leak" } });
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    expect(String(terminals[0]?.payload.error_summary)).not.toContain("boom-should-not-leak");
  });

  test(PCASE("malformed / truncated streams"), async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("half") }],
      abortAfterChunks: true, // truncated: no terminal frame
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
  });

  // ── Usage accounting → Mission Control token fields ───────────────────────────
  test(PCASE("normalizes usage from a final usage frame"), async () => {
    const payload = contentChunk("hello") + finishChunk("stop") + usageChunk(11, 7) + DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const completed = envs.find((e) => e.type === "dispatch.task.completed");
    expect(completed).toBeDefined();
    // Usage lands on MC's existing token field names.
    expect(completed?.payload.input_tokens).toBe(11);
    expect(completed?.payload.output_tokens).toBe(7);
  });

  test(PCASE("omits the final usage frame (missing usage)"), async () => {
    const payload = contentChunk("hello") + finishChunk("stop") + DONE;
    server.enqueue({ status: 200, headers: SSE_HEADERS, chunks: [{ data: payload }] });

    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const completed = envs.find((e) => e.type === "dispatch.task.completed");
    expect(completed).toBeDefined();
    // No usage frame → no token fields fabricated on the wire.
    expect(completed?.payload.input_tokens).toBeUndefined();
    expect(completed?.payload.output_tokens).toBeUndefined();
  });

  test(PCASE("keeps secrets absent from errors, events, snapshots, and logs"), async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("hi") + finishChunk("stop") + DONE }],
    });
    const ok = await drain(makeHarness().dispatch(makeRequest()));
    server.enqueue({ status: 401, chunks: [{ data: '{"error":{"message":"denied"}}' }] });
    const bad = await drain(makeHarness().dispatch(makeRequest()));

    const serialized = JSON.stringify([...ok, ...bad]);
    expect(serialized).not.toContain(API_KEY);
  });

  // ── Profile resolution fails closed ───────────────────────────────────────────
  test("fails closed to a failed terminal when the inferenceProfile is unknown", async () => {
    const envs = await drain(
      makeHarness({ inferenceProfile: "does-not-exist" }).dispatch(makeRequest()),
    );
    const terminals = terminalsOf(envs);
    expect(startedOf(envs)).toHaveLength(1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    expect(server.requests).toHaveLength(0); // never reached a provider
  });

  test("fails closed to a failed terminal when no inferenceProfile is configured", async () => {
    const envs = await drain(
      makeHarness({ inferenceProfile: undefined }).dispatch(makeRequest()),
    );
    const terminals = terminalsOf(envs);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.type).toBe("dispatch.task.failed");
    expect(server.requests).toHaveLength(0);
  });
});

// ── claude-code NON-REGRESSION (resolver selection unchanged) ──────────────────
describe("harness resolver — substrate selection (api-agent + non-regression)", () => {
  const deps = {
    source: SOURCE,
    ccSessionFactory: undefined,
    agentTeamFactory: undefined,
  };

  test("undefined agent → claude-code (pre-P1.3 default preserved)", () => {
    const resolver = new DefaultHarnessResolver(deps);
    expect(resolver.resolve(undefined, undefined).id).toBe("claude-code");
  });

  test("substrate: claude-code → claude-code (unchanged)", () => {
    const resolver = new DefaultHarnessResolver(deps);
    const agent: AgentRuntime = {
      substrate: "claude-code",
      mode: "in-process",
      capabilities: [],
    };
    expect(resolver.resolve(agent, undefined).id).toBe("claude-code");
  });

  test("delegate mode → agent-team (unchanged)", () => {
    const resolver = new DefaultHarnessResolver(deps);
    expect(resolver.resolve(undefined, "delegate").id).toBe("agent-team");
  });

  test("substrate: api-agent → api-agent", () => {
    const resolver = new DefaultHarnessResolver(deps);
    const agent: AgentRuntime = {
      substrate: "api-agent",
      inferenceProfile: "fast",
      mode: "in-process",
      capabilities: [],
    };
    expect(resolver.resolve(agent, undefined).id).toBe("api-agent");
  });
});
