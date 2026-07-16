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
 * Extraction AND persistence. The keying is Option A: usage lands on the ANCHOR
 * SESSION the projection already creates per `correlation_id` — so these assert
 * against the real `sessions` row, and that the claude-code path writes nothing.
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
import {
  createDispatchTaskCompletedEvent,
  createDispatchTaskStartedEvent,
} from "../../../bus/dispatch-events";

const CC_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

function makeHarness(profileExtras: Record<string, unknown> = {}): ApiAgentHarness {
  const config = InferenceConfigSchema.parse({
    providers: {
      test: {
        protocol: "openai-chat-completions",
        baseUrl: `${server.url}/v1`,
        apiKey: "env:TEST_KEY",
      },
    },
    profiles: {
      fast: {
        provider: "test",
        model: "test-model",
        modelClass: "any",
        ...profileExtras,
      },
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

/** Read the persisted usage columns straight off the sessions row. */
function sessionRow(sessionId: string) {
  return db
    .query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cost_usd, substrate
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cost_usd: number | null;
    substrate: string;
  };
}

describe("API-2115 · usage PERSISTS onto the anchor session (keying: Option A)", () => {
  test("the UPDATE lands on the anchor session the projection returns", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        {
          data:
            contentChunk("hi") + finishChunk("stop") + usageChunk(120, 34, 64) + DONE,
        },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const result = projectAll(envs);

    // The row the projection says it landed on really carries the tokens —
    // asserted against the DB, not the returned struct.
    const row = sessionRow(result.sessionId);
    expect(row.input_tokens).toBe(120);
    expect(row.output_tokens).toBe(34);
    expect(row.cache_read_tokens).toBe(64);

    // Option A writes NO extra row: one session for the dispatch, the anchor's.
    const count = db.query(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("substrate is labelled 'api-agent', not the 'claude-code' column default", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("x") + finishChunk("stop") + usageChunk(1, 1) + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));

    // Born correctly labelled at `started` — not mislabelled for its running life
    // and corrected at terminal.
    const started = envs.find((e) => e.type === "dispatch.task.started");
    if (started === undefined) throw new Error("no started envelope");
    const atStart = projectDispatchLifecycle(db, started);
    if (atStart === null) throw new Error("started did not project");
    expect(sessionRow(atStart.sessionId).substrate).toBe("api-agent");

    // ...and still correct after the terminal.
    const result = projectAll(envs);
    expect(sessionRow(result.sessionId).substrate).toBe("api-agent");
  });

  test("a cortex-side api-agent failure (no usage, no provider error) is STILL labelled api-agent", async () => {
    // The exact case that defeats inferring substrate from usage-presence: an
    // unsupported-capability failure never reaches the provider, so it carries
    // neither tokens nor provider diagnostics. It must not read as claude-code.
    const harness = makeHarness();
    const envs = await drain(
      harness.dispatch({ ...makeRequest(), tools: { allow: ["Bash"] } }),
    );
    const result = projectAll(envs);
    expect(result.kind).toBe("failed");
    expect(hasReportedUsage(result.usage)).toBe(false);
    expect(sessionRow(result.sessionId).substrate).toBe("api-agent");
  });

  test("cost stays NULL on the row when the provider reported no price (Q7)", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [{ data: contentChunk("x") + finishChunk("stop") + usageChunk(50, 5) + DONE }],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const result = projectAll(envs);

    // Tokens written; cost left NULL. No price table was consulted, and no
    // estimate was written unlabelled.
    const row = sessionRow(result.sessionId);
    expect(row.input_tokens).toBe(50);
    expect(row.cost_usd).toBeNull();
  });

  test("a reported 0 is written (0 ≠ absent); unreported columns stay NULL", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        // Reports 0 output tokens and no cache-read figure at all.
        { data: contentChunk("") + finishChunk("stop") + usageChunk(7, 0) + DONE },
      ],
    });
    const envs = await drain(makeHarness().dispatch(makeRequest()));
    const result = projectAll(envs);

    const row = sessionRow(result.sessionId);
    expect(row.input_tokens).toBe(7);
    // A legitimately reported 0 survives the COALESCE guard...
    expect(row.output_tokens).toBe(0);
    // ...while an UNREPORTED column stays NULL rather than being zero-filled.
    expect(row.cache_read_tokens).toBeNull();
  });
});

describe("API-2115 × API-2114 · a profile-bounded dispatch still projects usage", () => {
  // #2119 (API-2114) made the profile's `maxOutputTokens` / `options` actually
  // reach the wire. Both changes touch this harness, so pin that a profile
  // carrying those knobs does not disturb the usage seam — the request body and
  // the response usage frame are independent, but that is checked, not assumed.
  test("maxOutputTokens on the profile reaches the wire AND usage still persists", async () => {
    server.enqueue({
      status: 200,
      headers: SSE_HEADERS,
      chunks: [
        { data: contentChunk("bounded") + finishChunk("stop") + usageChunk(11, 22, 33) + DONE },
      ],
    });
    const envs = await drain(
      makeHarness({ maxOutputTokens: 8192 }).dispatch(makeRequest()),
    );

    // #2119's half: the bound really is on the wire body.
    const body = JSON.parse(server.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.max_tokens).toBe(8192);

    // My half: usage still extracts and persists onto the anchor session.
    const result = projectAll(envs);
    expect(result.usage.inputTokens).toBe(11);
    const row = sessionRow(result.sessionId);
    expect(row.input_tokens).toBe(11);
    expect(row.output_tokens).toBe(22);
    expect(row.cache_read_tokens).toBe(33);
    expect(row.substrate).toBe("api-agent");
  });
});

describe("API-2115 · the claude-code path writes NOTHING (guard proof)", () => {
  /** Build the real claude-code-shaped lifecycle pair (no token fields, no substrate). */
  function ccEnvelopes() {
    const started = createDispatchTaskStartedEvent({
      source: SOURCE,
      taskId: REQUEST_ID,
      agentId: "cortex",
      correlationId: REQUEST_ID,
      startedAt: new Date(),
    });
    const completed = createDispatchTaskCompletedEvent({
      source: SOURCE,
      taskId: REQUEST_ID,
      agentId: "cortex",
      correlationId: REQUEST_ID,
      startedAt: new Date(),
      completedAt: new Date(),
      resultSummary: "done",
      ccSessionId: CC_SESSION,
    });
    return [started, completed];
  }

  test("a claude-code dispatch leaves every usage column NULL and substrate default", () => {
    let last = null;
    for (const env of ccEnvelopes()) {
      const r = projectDispatchLifecycle(db, env);
      if (r !== null) last = r;
    }
    if (last === null) throw new Error("nothing projected");

    const row = sessionRow(last.sessionId);
    // Structurally a no-op: the guard skips the UPDATE entirely, so these are
    // the INSERT's NULLs — never a fabricated 0.
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cost_usd).toBeNull();
    // Declares no substrate → the column default stands, unchanged from pre-2115.
    expect(row.substrate).toBe("claude-code");
  });

  test("the cc terminal still backfills cc_session_id (no regression from the new writes)", () => {
    let last = null;
    for (const env of ccEnvelopes()) {
      const r = projectDispatchLifecycle(db, env);
      if (r !== null) last = r;
    }
    if (last === null) throw new Error("nothing projected");
    const cc = db
      .query(`SELECT cc_session_id FROM sessions WHERE id = ?`)
      .get(last.sessionId) as { cc_session_id: string | null };
    expect(cc.cc_session_id).toBe(CC_SESSION);
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
