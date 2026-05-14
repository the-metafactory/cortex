/**
 * MIG-5.6 (C-106) — integration test: Worker → local receiver → envelope.
 *
 * Wires the actual CF Worker entry point (`src/taps/gh-webhook/src/index.ts`)
 * together with the local Bun receiver (`src/taps/gh-webhook-receiver/server.ts`)
 * via the `CORTEX_FORWARDER_URL` config knob. This is the closest we can get
 * to a "production-shaped" test without standing up an actual Cloudflare
 * runtime — the Worker is invoked through its Hono handler (the test harness
 * the gh-webhook subpackage already uses), and its `executionCtx.waitUntil`
 * is wired so the fan-out happens before we assert.
 *
 * What this asserts that the unit tests cannot:
 *   - The Worker's forwarded headers exactly match the receiver's HMAC
 *     re-verification expectations (i.e. the `X-Hub-Signature-256` we
 *     forward must round-trip through the receiver's `verify()` call).
 *   - A valid push webhook ingested at the Worker produces an envelope
 *     with the expected `type` / `source` / `payload` on the publish
 *     callback the receiver was started with.
 *
 * **Why this test lives under `gh-webhook-receiver/__tests__/`** (and not
 * under `gh-webhook/__tests__/`): it imports from BOTH subtrees, which the
 * gh-webhook subpackage tsconfig would reject (it doesn't see the root
 * project). The root tsconfig sees both (`src/taps/gh-webhook` is excluded
 * for tsc but bun test still loads it at runtime).
 */

import { describe, expect, test, afterEach } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
// The CF Worker subpackage uses `@cloudflare/workers-types` in its own
// tsconfig. Root tsc transitively type-checks `gh-webhook/src/index.ts`
// when we import from it here; the Worker file uses a local
// `ServiceBindingFetcher` shape so root tsc accepts it without needing
// CF types globally. Local stand-ins for `ExecutionContext` / `Fetcher`
// below cover the integration's own use sites.
import workerApp, { _resetDeliveryCache } from "../../gh-webhook/src/index";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "../server";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

// Minimal local stand-ins for the CF Worker types so root tsc accepts
// this file without pulling `@cloudflare/workers-types` into the root
// project. These shapes are the subset the integration uses.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}
interface Fetcher {
  fetch(input: Request | string): Promise<Response>;
}

const TEST_SECRET = "integration-test-secret";
const TEST_SOURCE = {
  org: "metafactory",
  agent: "cortex",
  instance: "local",
};

// Port counter — far above the unit test range to keep parallel runs
// from colliding.
let nextPort = 19770;
function pickPort(): number {
  return nextPort++;
}

const handles: GithubWebhookReceiverHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
  _resetDeliveryCache();
});

/**
 * Minimal ExecutionContext that records waitUntil promises so the test
 * can drain fan-out before assertions. Mirrors the helper in
 * `gh-webhook/__tests__/proxy.test.ts` but lives here so the integration
 * file is self-contained.
 */
function makeExecutionCtx(): {
  ctx: ExecutionContext;
  drain: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil(p: Promise<unknown>): void {
      pending.push(p);
    },
    passThroughOnException(): void {},
    props: {},
  };
  return {
    ctx,
    drain: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.allSettled(batch);
      }
    },
  };
}

/**
 * Mock `GROVE_API` Service Binding — the Worker still calls it before
 * fanning out to the cortex forwarder. We return 200 so the Worker treats
 * the request as success and the integration is exercising the
 * cortex-forwarder side rather than failing at grove-api.
 */
function makeGroveApiStub(): Fetcher {
  return {
    fetch: async () => new Response("ok", { status: 200 }),
    connect: () => { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

describe("integration: Worker → cortex receiver → envelope", () => {
  test("valid push webhook produces correctly-shaped envelope on bus", async () => {
    const port = pickPort();
    const published: Envelope[] = [];
    const handle = startGithubWebhookReceiver({
      secret: TEST_SECRET,
      port,
      hostname: "127.0.0.1",
      source: TEST_SOURCE,
      publish: async (env) => {
        published.push(env);
      },
    });
    handles.push(handle);

    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
      commits: [{ id: "abc", message: "feat: x" }],
    });
    const signature = await sign(TEST_SECRET, body);
    const deliveryId = "11111111-2222-4333-8444-555555555555";

    const req = new Request("http://localhost/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": deliveryId,
      },
      body,
    });

    const env = {
      GITHUB_WEBHOOK_SECRET: TEST_SECRET,
      GROVE_API: makeGroveApiStub(),
      CORTEX_FORWARDER_URL: `http://127.0.0.1:${port}/internal/webhook`,
    };
    const { ctx, drain } = makeExecutionCtx();
    const res = await workerApp.fetch(req, env, ctx);
    await drain();

    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.type).toBe("github.push.received");
    expect(envelope.source).toBe("metafactory.cortex.local");
    expect(envelope.payload).toMatchObject({
      delivery_id: deliveryId,
      event: "push",
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
    // The original webhook body lives under `payload.body` verbatim.
    expect(envelope.payload.body).toEqual({
      ref: "refs/heads/main",
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
      commits: [{ id: "abc", message: "feat: x" }],
    });
  });

  test("pull_request opened produces github.pull-request.opened envelope", async () => {
    const port = pickPort();
    const published: Envelope[] = [];
    const handle = startGithubWebhookReceiver({
      secret: TEST_SECRET,
      port,
      hostname: "127.0.0.1",
      source: TEST_SOURCE,
      publish: async (env) => {
        published.push(env);
      },
    });
    handles.push(handle);

    const body = JSON.stringify({
      action: "opened",
      number: 42,
      pull_request: { title: "feat: x", state: "open" },
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
    });
    const signature = await sign(TEST_SECRET, body);

    const req = new Request("http://localhost/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "22222222-3333-4444-8555-666666666666",
      },
      body,
    });

    const env = {
      GITHUB_WEBHOOK_SECRET: TEST_SECRET,
      GROVE_API: makeGroveApiStub(),
      CORTEX_FORWARDER_URL: `http://127.0.0.1:${port}/internal/webhook`,
    };
    const { ctx, drain } = makeExecutionCtx();
    const res = await workerApp.fetch(req, env, ctx);
    await drain();

    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0]!.type).toBe("github.pull-request.opened");
    expect(published[0]!.payload).toMatchObject({
      event: "pull_request",
      action: "opened",
    });
  });

  test("Worker → receiver HMAC propagates: tampered body at receiver is rejected", async () => {
    // This guards against accidental body-rewriting between the Worker
    // and the receiver. We forward the body verbatim, so the receiver's
    // HMAC re-verification MUST succeed — and tampering on the wire MUST
    // be rejected. Simulate the tampering by signing a different body
    // than we send; receiver should 401 even though the Worker accepted
    // the (signed) original.
    const port = pickPort();
    const published: Envelope[] = [];
    const handle = startGithubWebhookReceiver({
      secret: TEST_SECRET,
      port,
      hostname: "127.0.0.1",
      source: TEST_SOURCE,
      publish: async (env) => {
        published.push(env);
      },
    });
    handles.push(handle);

    // Forge: sign one body, send a different one to the receiver
    // directly. The Worker isn't in this path — we're asserting the
    // receiver's defense-in-depth.
    const signedBody = JSON.stringify({ action: "opened" });
    const sentBody = JSON.stringify({ action: "tampered" });
    const signature = await sign(TEST_SECRET, signedBody);

    const resp = await fetch(`http://127.0.0.1:${port}/internal/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "33333333-4444-4555-8666-777777777777",
      },
      body: sentBody,
    });

    expect(resp.status).toBe(401);
    expect(published).toHaveLength(0);
  });
});
