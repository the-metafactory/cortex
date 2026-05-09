/**
 * MIG-3b — surface-router ↔ adapter integration tests.
 *
 * Covers the §3.6 acceptance shape from the migration plan:
 *   "Add new test: surface-router registers the [Mock/Discord] adapter,
 *    publishes an envelope, asserts adapter renders."
 *
 * We use `MockAdapter.surfaceConfig` rather than spinning up a real
 * Discord client — the Discord/Mattermost adapters expose the SAME
 * surface-adapter shape, so the integration contract is identical.
 * Adapter-specific render behaviour (channel IDs, formatting fallbacks,
 * disconnect handling) lives in the per-adapter render-envelope tests.
 */

import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import { createSurfaceRouter } from "../../bus/surface-router";
import { MockAdapter } from "../mock";

// ---------------------------------------------------------------------------
// Fakes — mirror the shape used in src/bus/__tests__/surface-router.test.ts
// ---------------------------------------------------------------------------

function fakeRuntimeWithTrigger(): {
  runtime: MyelinRuntime;
  trigger: (env: Envelope, subject: string) => void;
} {
  const handlers = new Set<Parameters<MyelinRuntime["onEnvelope"]>[0]>();
  return {
    runtime: {
      enabled: true,
      onEnvelope: (handler) => {
        handlers.add(handler);
        return { unregister: () => { handlers.delete(handler); } };
      },
      publish: async () => {},
      stop: async () => {},
    },
    trigger: (env, subject) => {
      for (const h of handlers) h(env, subject);
    },
  };
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-000000000001",
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
// Tests
// ---------------------------------------------------------------------------

describe("MIG-3b — surface-router ↔ MockAdapter integration", () => {
  test("router.register(adapter.surfaceConfig) → dispatch → render() called", async () => {
    const router = createSurfaceRouter(fakeRuntimeWithTrigger().runtime);
    const adapter = new MockAdapter("mock-int-1");
    adapter.surfaceSubjects = ["test.>"];

    router.register(adapter.surfaceConfig);
    const env = makeEnvelope({ id: "11111111-1111-4111-8111-111111111111" });

    await router.dispatch(env, "test.foo");

    expect(adapter.envelopesRendered).toHaveLength(1);
    expect(adapter.envelopesRendered[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("end-to-end: runtime envelope → onEnvelope handler → router → adapter render", async () => {
    // The full wiring: a fake MyelinRuntime fires the registered onEnvelope
    // handler; that handler is the one the router installs in `start()`;
    // the adapter's render() receives the envelope.
    const fake = fakeRuntimeWithTrigger();
    const router = createSurfaceRouter(fake.runtime);
    const adapter = new MockAdapter("mock-int-e2e");
    adapter.surfaceSubjects = ["local.metafactory.review.>"];

    router.register(adapter.surfaceConfig);
    await router.start();

    fake.trigger(
      makeEnvelope({ id: "22222222-2222-4222-8222-222222222222" }),
      "local.metafactory.review.cycle.completed",
    );
    // Yield once — dispatch is fire-and-forget from the handler's perspective.
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.envelopesRendered).toHaveLength(1);
    expect(adapter.envelopesRendered[0]?.id).toBe("22222222-2222-4222-8222-222222222222");

    await router.stop();
  });

  test("subject mismatch → adapter not invoked", async () => {
    const router = createSurfaceRouter(fakeRuntimeWithTrigger().runtime);
    const adapter = new MockAdapter("mock-int-2");
    adapter.surfaceSubjects = ["local.metafactory.review.>"];

    router.register(adapter.surfaceConfig);
    await router.dispatch(makeEnvelope(), "local.metafactory.attention.item.enqueued");

    expect(adapter.envelopesRendered).toHaveLength(0);
  });

  test("two adapters with different subjects → each receives only its own", async () => {
    const router = createSurfaceRouter(fakeRuntimeWithTrigger().runtime);
    const review = new MockAdapter("review-adapter");
    review.surfaceSubjects = ["local.metafactory.review.>"];
    const attention = new MockAdapter("attention-adapter");
    attention.surfaceSubjects = ["local.metafactory.attention.>"];

    router.register(review.surfaceConfig);
    router.register(attention.surfaceConfig);

    await router.dispatch(makeEnvelope(), "local.metafactory.review.cycle.completed");
    await router.dispatch(makeEnvelope(), "local.metafactory.attention.item.enqueued");

    expect(review.envelopesRendered).toHaveLength(1);
    expect(attention.envelopesRendered).toHaveLength(1);
  });

  test("default mock subject pattern (mock.>) matches by default", async () => {
    // Pin the default-subject behaviour — tests that don't customize
    // surfaceSubjects rely on this so they don't have to set it explicitly.
    const router = createSurfaceRouter(fakeRuntimeWithTrigger().runtime);
    const adapter = new MockAdapter("default-mock");

    router.register(adapter.surfaceConfig);
    await router.dispatch(makeEnvelope(), "mock.event.fired");

    expect(adapter.envelopesRendered).toHaveLength(1);
  });

  test("adapter doesn't open NATS subscriptions — only surface-router consumes the runtime", async () => {
    // §3.5 acknowledgement: the adapter exposes its render face via
    // `surfaceConfig` but never registers itself with the runtime. The
    // surface-router is the one wired to MyelinRuntime; the adapter is
    // dumb-by-design about NATS.
    const fake = fakeRuntimeWithTrigger();
    const adapter = new MockAdapter("dumb-adapter");

    // Without a router, the adapter's `surfaceConfig` exists but is never
    // wired to anything. Triggering the runtime fires no handlers (the
    // runtime's only consumer is the router we never created).
    fake.trigger(makeEnvelope(), "mock.never.delivered");

    expect(adapter.envelopesRendered).toHaveLength(0);
  });
});
