/**
 * API-2115 — the MC dispatch projection reads an api-agent dispatch's usage +
 * provider diagnostics off its terminal lifecycle envelope.
 *
 * ## Why these tests drive the REAL harness (issue #2115 acceptance criterion 4)
 *
 * The bug this slice fixes was a PRODUCER/CONSUMER SHAPE MISMATCH that survived
 * because each side was only ever tested against its own assumption: the harness
 * proved it stamped fields, MC proved nothing read them, and no test crossed the
 * seam. A hand-built fixture here would reproduce exactly that failure mode — it
 * would encode MY belief about the payload shape and pass even if the producer
 * stamped something else entirely.
 *
 * So these tests build the envelope the ONLY way production does: drive the real
 * `ApiAgentHarness` → real `InferenceRegistry` → real openai-compatible provider
 * → the shared fake streaming server (never a live provider, never paid creds),
 * take the terminal envelope it actually yields, and feed THAT to the real
 * `projectDispatchLifecycle`. If either side's field names drift, these fail.
 *
 * ## Scope
 *
 * The EXTRACTION half only. Persisting usage onto an MC row is a keying decision
 * still awaiting a ruling (the api-agent harness has no `cc_session_id`), so
 * there is deliberately no assertion here that a `sessions` column was written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import {
  readDispatchUsage,
  hasReportedUsage,
} from "../projection/dispatch-usage";
import {
  startFakeStreamingServer,
  type FakeStreamingServer,
} from "../../../providers/__tests__/fake-streaming-server";
import { InferenceConfigSchema } from "../../../common/types/cortex-config";
import { ApiAgentHarness } from "../../../substrates/api-agent/harness";
import { createInferenceRegistry } from "../../../substrates/api-agent/provider-factories";
import type { DispatchEventSource } from "../../../bus/dispatch-events";
import type {
  DispatchRequest,
  MyelinEnvelope,
} from "../../../common/substrates/types";
import { createDispatchTaskCompletedEvent } from "../../../bus/dispatch-events";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY = "sk-secret-DO-NOT-LEAK-abc123";
const TEST_ENV = { TEST_KEY: API_KEY };
const SSE_HEADERS = { "content-type": "text/event-stream" } as const;

// ── SSE frame builders (OpenAI Chat Completions wire) ────────────────────────
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = "data: [DONE]\n\n";
const contentChunk = (text: string): string =>
  sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const finishChunk = (reason = "stop"): string =>
  sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (
  input: number,
  output: number,
  cacheRead?: number,
): string =>
  sse({
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      ...(cacheRead !== undefined
        ? { prompt_tokens_details: { cached_tokens: cacheRead } }
        : {}),
    },
  });

let server: FakeStreamingServer;
let db: Database;

beforeEach(() => {
  server = startFakeStreamingServer();
  db = new Database(":memory:");
  for (const stmt of SCHEMA_SQL) db.run(stmt);
});
afterEach(async () => {
  await server.stop();
  db.close();
});

function makeHarness(): ApiAgentHarness {
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
    inferenceProfile: "fast",
  });
}

function makeRequest(): DispatchRequest {
  return {
    persona: { path: "/agents/cortex.md", content: "# Cortex\nBe terse." },
    prompt: "say hello",
    tools: { allow: [] },
    context: [],
    agent: { id: "cortex", displayName: "Cortex" },
    requestId: REQUEST_ID,
  };
}

async function drain(it: AsyncIterable<MyelinEnvelope>): Promise<MyelinEnvelope[]> {
  const out: MyelinEnvelope[] = [];
  for await (const env of it) out.push(env);
  return out;
}

const terminalOf = (envs: MyelinEnvelope[]): MyelinEnvelope => {
  const t = envs.find(
    (e) =>
      e.type === "dispatch.task.completed" ||
      e.type === "dispatch.task.failed" ||
      e.type === "dispatch.task.aborted",
  );
  if (t === undefined) throw new Error("harness yielded no terminal envelope");
  return t;
};

/**
 * Project every envelope the harness yielded, in order (started → terminal),
 * exactly as the renderer does. Returns the terminal's projection result.
 */
function projectAll(envs: MyelinEnvelope[]) {
  let last = null;
  for (const env of envs) {
    const r = projectDispatchLifecycle(db, env);
    if (r !== null) last = r;
  }
  if (last === null) throw new Error("nothing projected");
  return last;
}

describe("API-2115 · MC projection reads api-agent usage off a REAL envelope", () => {
  test("provider-reported input/output tokens reach the projection result", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        {
          data:
            contentChunk("hi there") +
            finishChunk("stop") +
            usageChunk(120, 34) +
            DONE,
        },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    // Guard the SEAM's premise: the real producer really did stamp these names.
    // If the harness ever renames them, this fails HERE (not silently downstream).
    const terminal = terminalOf(envs);
    expect(terminal.type).toBe("dispatch.task.completed");
    expect(terminal.payload.input_tokens).toBe(120);
    expect(terminal.payload.output_tokens).toBe(34);

    // The consumer half: the projection reads them off that same real envelope.
    const result = projectAll(envs);
    expect(result.kind).toBe("completed");
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(34);
    expect(hasReportedUsage(result.usage)).toBe(true);
  });

  test("cache-read tokens reach the projection when the provider reports them", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        {
          data:
            contentChunk("cached") +
            finishChunk("stop") +
            usageChunk(200, 10, 64) +
            DONE,
        },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const result = projectAll(envs);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.usage.cacheReadTokens).toBe(64);
  });

  test("cost stays NULL — no provider price, and an estimate is never invented (Q7)", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        { data: contentChunk("x") + finishChunk("stop") + usageChunk(50, 5) + DONE },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    // The provider reported TOKENS but no price. Design Q7 (where versioned price
    // data lives) is unresolved, so cost must stay unset — NEVER a silent estimate
    // derived from a price table this slice does not own.
    expect(terminalOf(envs).payload.cost_usd).toBeUndefined();
    const result = projectAll(envs);
    expect(result.usage.costUsd).toBeNull();
    // ...while the tokens it DID report are present — cost null is not "no usage".
    expect(result.usage.inputTokens).toBe(50);
  });

  test("a dispatch whose provider reports no usage extracts all-null, never zero", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("no usage frame") + finishChunk("stop") + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const result = projectAll(envs);
    // Honest absence: null ⇒ "unreported", distinct from a reported 0.
    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
    expect(result.usage.costUsd).toBeNull();
    expect(hasReportedUsage(result.usage)).toBe(false);
  });

  test("provider diagnostics off a REAL failed envelope (429 → rate_limit + retry hint)", async () => {
    server.enqueue({
      status: 429,
      headers: { "retry-after": "3" },
      chunks: [{ data: '{"error":{"message":"slow-down-should-not-leak"}}' }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    const terminal = terminalOf(envs);
    expect(terminal.type).toBe("dispatch.task.failed");

    const result = projectAll(envs);
    expect(result.kind).toBe("failed");
    expect(result.providerDiagnostics.providerErrorKind).toBe("rate_limit");
    expect(result.providerDiagnostics.retryAfterMs).toBe(3000);
    // Secret-safety: the raw provider body never rides the extraction.
    expect(JSON.stringify(result)).not.toContain("slow-down-should-not-leak");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test("a started envelope carries no usage — extraction is all-null", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("x") + finishChunk("stop") + usageChunk(9, 9) + DONE },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const started = envs.find((e) => e.type === "dispatch.task.started");
    if (started === undefined) throw new Error("harness yielded no started envelope");

    const result = projectDispatchLifecycle(db, started);
    expect(result?.kind).toBe("started");
    if (result === null) throw new Error("started envelope did not project");
    expect(hasReportedUsage(result.usage)).toBe(false);
  });
});

describe("API-2115 · readDispatchUsage rejects malformed wire values", () => {
  // A claude-code dispatch's completed envelope carries NO token fields — the
  // built-from-the-real-builder proof that extraction is a no-op for it.
  test("a real claude-code-shaped completed envelope extracts all-null", () => {
    const env = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: REQUEST_ID,
      agentId: "cortex",
      correlationId: REQUEST_ID,
      startedAt: new Date(),
      completedAt: new Date(),
      resultSummary: "done",
    });
    expect(hasReportedUsage(readDispatchUsage(env.payload))).toBe(false);
  });

  test("negative / non-integer / NaN token counts are rejected, not persisted", () => {
    expect(readDispatchUsage({ input_tokens: -5 }).inputTokens).toBeNull();
    expect(readDispatchUsage({ input_tokens: 1.5 }).inputTokens).toBeNull();
    expect(readDispatchUsage({ input_tokens: NaN }).inputTokens).toBeNull();
    expect(readDispatchUsage({ input_tokens: "120" }).inputTokens).toBeNull();
    expect(readDispatchUsage({ input_tokens: Infinity }).inputTokens).toBeNull();
    // A legitimately reported zero is KEPT — 0 ≠ absent.
    expect(readDispatchUsage({ input_tokens: 0 }).inputTokens).toBe(0);
  });

  test("a non-object payload is treated as no fields, never a throw", () => {
    expect(hasReportedUsage(readDispatchUsage(null))).toBe(false);
    expect(hasReportedUsage(readDispatchUsage("nonsense"))).toBe(false);
    expect(hasReportedUsage(readDispatchUsage(undefined))).toBe(false);
  });
});
