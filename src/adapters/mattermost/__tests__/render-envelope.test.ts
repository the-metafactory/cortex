/**
 * MIG-3b — MattermostAdapter.renderEnvelope unit tests.
 *
 * Mirrors `src/adapters/discord/__tests__/render-envelope.test.ts` so the
 * two adapters' bus-rendering surfaces stay symmetric. Mattermost has no
 * gateway client (it uses long-poll), so the failure shape is simpler:
 *   - missing fallback channel → log + drop
 *   - postReply throws / returns null → log + drop, never propagates
 *
 * We stub `postReply` by mocking global `fetch` — the real `postReply`
 * implementation in poller.ts hits `${apiUrl}/api/v4/posts` directly, so
 * intercepting fetch gives us the lightest possible test seam without
 * introducing a module-mock for poller.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { MattermostAdapter, type MattermostAdapterInfra } from "../index";
import type { Agent, MattermostPresence } from "../../../common/types/cortex-config";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

// ---------------------------------------------------------------------------
// Console + fetch suppression — these tests intentionally exercise
// log+warn paths and never want to hit a real Mattermost server.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalFetch: typeof fetch;
const warnings: string[] = [];

interface FetchCall {
  url: string;
  init?: RequestInit;
  /** Parsed JSON body, when init.body was a JSON string. */
  body?: unknown;
}

let fetchCalls: FetchCall[] = [];
/**
 * Per-test override for the fetch response. Default is a 201 Created with
 * `{ id: "post-1" }` matching the Mattermost POST /api/v4/posts shape.
 */
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  warnings.length = 0;
  fetchCalls = [];
  originalWarn = console.warn;
  originalError = console.error;
  originalFetch = globalThis.fetch;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = () => {};
  fetchHandler = async () =>
    new Response(JSON.stringify({ id: "post-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ url, init, body });
    return fetchHandler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(opts: {
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
  surfaceFilter?: MattermostAdapterInfra["surfaceFilter"];
} = {}) {
  // MIG-7.2c-mattermost: constructor now takes (agent, presence, infra).
  // Surface fields live on `infra`; credentials live on `presence`.
  const presence: MattermostPresence = {
    enabled: true,
    callbackPort: 8080,
    apiUrl: "https://mm.example",
    apiToken: "test-token",
    channels: ["c-default"],
    pollIntervalMs: 1000,
    allowedUsers: [],
    roles: [],
    defaultRole: "allow-all",
  };
  const agent: Agent = {
    id: "test",
    displayName: "Test",
    persona: "(test)",
    roles: [],
    trust: [],
    presence: { mattermost: presence },
  };
  const infra: MattermostAdapterInfra = {
    instanceId: "mm-renderer",
    operator: {},
    ...(opts.surfaceSubjects !== undefined && { surfaceSubjects: opts.surfaceSubjects }),
    ...(opts.surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId: opts.surfaceFallbackChannelId }),
    ...(opts.surfaceFilter !== undefined && { surfaceFilter: opts.surfaceFilter }),
  };
  return new MattermostAdapter(agent, presence, infra);
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000099",
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

/** The Mattermost POST /api/v4/posts URL fetch will hit when postReply runs. */
const POST_URL = "https://mm.example/api/v4/posts";

// ---------------------------------------------------------------------------
// surfaceConfig getter shape
// ---------------------------------------------------------------------------

describe("MattermostAdapter.surfaceConfig", () => {
  test("returns a SurfaceAdapter with id matching instanceId", () => {
    const adapter = makeAdapter();
    expect(adapter.surfaceConfig.id).toBe("mm-renderer");
  });

  test("subjects is empty array when surfaceSubjects is unset", () => {
    const adapter = makeAdapter();
    expect(adapter.surfaceConfig.subjects).toEqual([]);
  });

  test("subjects mirrors surfaceSubjects when set", () => {
    const adapter = makeAdapter({
      surfaceSubjects: ["local.metafactory.review.>", "local.metafactory.attention.>"],
    });
    expect(adapter.surfaceConfig.subjects).toEqual([
      "local.metafactory.review.>",
      "local.metafactory.attention.>",
    ]);
  });

  test("filter is omitted when surfaceFilter is unset", () => {
    const adapter = makeAdapter();
    expect(adapter.surfaceConfig.filter).toBeUndefined();
  });

  test("filter is forwarded when surfaceFilter is set", () => {
    const filter = { payload: { repo: ["grove"] } };
    const adapter = makeAdapter({ surfaceFilter: filter });
    expect(adapter.surfaceConfig.filter).toBe(filter);
  });

  test("render is bound to the adapter (this is preserved)", async () => {
    // Pulling render off surfaceConfig and calling it must still find
    // this.adapterConfig — i.e. the arrow in the getter binds correctly.
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-X" });
    const render = adapter.surfaceConfig.render;
    await render(makeEnvelope());
    expect(fetchCalls).toHaveLength(1);
    expect((fetchCalls[0]?.body as { channel_id?: string })?.channel_id).toBe("channel-X");
  });
});

// ---------------------------------------------------------------------------
// renderEnvelope — happy path
// ---------------------------------------------------------------------------

describe("MattermostAdapter.renderEnvelope — happy path", () => {
  test("posts envelope to fallback channel via /api/v4/posts", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(POST_URL);
    expect((fetchCalls[0]?.body as { channel_id?: string })?.channel_id).toBe("channel-A");
  });

  test("posts top-level (no root_id — not threaded)", async () => {
    // v1 contract: bus envelopes go to the fallback channel as top-level
    // posts, NOT threaded under a parent. Threading is the Renderer-model
    // concern (MIG-7.2d), not v1's job.
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(makeEnvelope());
    const body = fetchCalls[0]?.body as { root_id?: string };
    expect(body?.root_id).toBeUndefined();
  });

  test("formatted message contains envelope.type as bold header", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(
      makeEnvelope({ type: "attention.item.enqueued" }),
    );
    const body = fetchCalls[0]?.body as { message?: string };
    expect(body?.message).toContain("**attention.item.enqueued**");
  });

  test("formatted message contains correlation_id when present", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(
      makeEnvelope({ correlation_id: "11111111-1111-4111-8111-111111111111" }),
    );
    const body = fetchCalls[0]?.body as { message?: string };
    expect(body?.message).toContain("[11111111-1111-4111-8111-111111111111]");
  });

  test("formatted message omits correlation bracket when absent", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(makeEnvelope());
    const body = fetchCalls[0]?.body as { message?: string };
    expect(body?.message ?? "").not.toMatch(/\[[0-9a-f-]{36}\]/);
  });

  test("formatted message contains payload as JSON code block", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(
      makeEnvelope({ payload: { ticket: "G-1111" } }),
    );
    const body = fetchCalls[0]?.body as { message?: string };
    expect(body?.message).toContain("```json");
    expect(body?.message).toContain('"ticket": "G-1111"');
    expect(body?.message).toContain("```");
  });

  test("uses the configured apiToken in the Authorization header", async () => {
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await adapter.surfaceConfig.render(makeEnvelope());
    const headers = fetchCalls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-token");
  });
});

// ---------------------------------------------------------------------------
// renderEnvelope — failure modes (log + drop, never throw)
// ---------------------------------------------------------------------------

describe("MattermostAdapter.renderEnvelope — failure modes", () => {
  test("drops + warns when no surfaceFallbackChannelId is configured", async () => {
    const adapter = makeAdapter({
      // no surfaceFallbackChannelId
    });
    await adapter.surfaceConfig.render(makeEnvelope());
    expect(fetchCalls).toHaveLength(0);
    expect(
      warnings.some((w) => w.includes("no surfaceFallbackChannelId configured")),
    ).toBe(true);
  });

  test("drops + warns when postReply throws (fetch rejects)", async () => {
    fetchHandler = async () => {
      throw new Error("network down");
    };
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await expect(
      adapter.surfaceConfig.render(makeEnvelope()),
    ).resolves.toBeUndefined();
    // postReply itself swallows the throw via console.error, but in this
    // path the renderEnvelope wrapper still completes cleanly without
    // propagating to the surface-router. Either way: never throws.
  });

  test("drops + does not throw when fetch returns 500", async () => {
    fetchHandler = async () =>
      new Response("boom", { status: 500, statusText: "Server Error" });
    const adapter = makeAdapter({ surfaceFallbackChannelId: "channel-A" });
    await expect(
      adapter.surfaceConfig.render(makeEnvelope()),
    ).resolves.toBeUndefined();
    // Fetch was called once — the 500 was handled internally by postReply.
    expect(fetchCalls).toHaveLength(1);
  });

  test("never throws — render contract returns a resolved Promise<void>", async () => {
    const adapter = makeAdapter({
      // no fallback channel — drops at the channel-id guard
    });
    await expect(
      adapter.surfaceConfig.render(makeEnvelope()),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty-surfaceSubjects construction warning
// ---------------------------------------------------------------------------

describe("MattermostAdapter — empty surfaceSubjects warning", () => {
  test("warns at construction when surfaceSubjects is explicitly []", () => {
    makeAdapter({ surfaceSubjects: [] });
    expect(
      warnings.some((w) =>
        w.includes("surfaceSubjects is empty") &&
        w.includes("never render bus envelopes"),
      ),
    ).toBe(true);
  });

  test("does NOT warn when surfaceSubjects is undefined (opted out)", () => {
    makeAdapter({ /* surfaceSubjects: undefined */ });
    expect(warnings.some((w) => w.includes("surfaceSubjects is empty"))).toBe(false);
  });

  test("does NOT warn when surfaceSubjects has entries", () => {
    makeAdapter({ surfaceSubjects: ["local.metafactory.review.>"] });
    expect(warnings.some((w) => w.includes("surfaceSubjects is empty"))).toBe(false);
  });
});
