/**
 * MIG-5.6 (C-106) — tests for the local GitHub webhook receiver.
 *
 * Three coverage axes:
 *   1. Auth gates — secret-absent (503), missing-headers (400),
 *      bad-signature (401), verifier-throw (401).
 *   2. Body handling — malformed JSON (400), JSON-but-not-object (400),
 *      valid payload extraction (repo, sender, action).
 *   3. Happy path — full webhook → envelope → publish callback invoked
 *      with a validly-shaped Envelope.
 *
 * Tests use a real `@octokit/webhooks-methods` signature so we exercise
 * the production verification path end-to-end. A unique port is picked
 * per test to avoid TIME_WAIT collisions between bun test invocations.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "../server";
import { validateEnvelope, type Envelope } from "../../../bus/myelin/envelope-validator";

const TEST_SECRET = "test-secret-for-receiver-tests";
const TEST_SOURCE = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

// Port-allocation strategy: each test calls `pickPort()` which increments a
// shared counter. The base port is well outside cortex's other listeners
// (mattermost 8080, dashboard 8766, receiver default 8770) so a parallel
// test runner doesn't collide with a live cortex on the same machine.
let nextPort = 18770;
function pickPort(): number {
  return nextPort++;
}

const handles: GithubWebhookReceiverHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.stop();
  }
});

function start(
  overrides: Partial<Parameters<typeof startGithubWebhookReceiver>[0]> = {},
): {
  handle: GithubWebhookReceiverHandle;
  published: Envelope[];
} {
  const published: Envelope[] = [];
  const handle = startGithubWebhookReceiver({
    secret: TEST_SECRET,
    port: pickPort(),
    hostname: "127.0.0.1",
    source: TEST_SOURCE,
    publish: async (env) => {
      published.push(env);
    },
    ...overrides,
  });
  handles.push(handle);
  return { handle, published };
}

async function postWebhook(
  handle: GithubWebhookReceiverHandle,
  body: string,
  options: {
    event?: string;
    deliveryId?: string;
    signature?: string;
    skipEvent?: boolean;
    skipDelivery?: boolean;
    skipSignature?: boolean;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!options.skipEvent) {
    headers["X-GitHub-Event"] = options.event ?? "push";
  }
  if (!options.skipDelivery) {
    headers["X-GitHub-Delivery"]
      = options.deliveryId ?? "12345678-1234-4234-8234-123456789012";
  }
  if (!options.skipSignature) {
    headers["X-Hub-Signature-256"]
      = options.signature ?? (await sign(TEST_SECRET, body));
  }
  return fetch(`http://127.0.0.1:${handle.port}/internal/webhook`, {
    method: "POST",
    headers,
    body,
  });
}

describe("startGithubWebhookReceiver — health check", () => {
  test("GET /health returns 200 with service identifier", async () => {
    const { handle } = start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string; service: string };
    expect(json).toEqual({
      status: "ok",
      service: "github-webhook-receiver",
    });
  });

  test("non-/health GET returns 404", async () => {
    const { handle } = start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(404);
  });

  test("non-POST on /internal/webhook returns 404", async () => {
    const { handle } = start();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/internal/webhook`,
    );
    expect(res.status).toBe(404);
  });
});

describe("startGithubWebhookReceiver — auth gates", () => {
  test("empty secret → 503 not configured", async () => {
    const { handle } = start({ secret: "" });
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("not configured");
  });

  test("missing X-Hub-Signature-256 → 400 missing headers", async () => {
    const { handle } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, { skipSignature: true });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing headers");
  });

  test("missing X-GitHub-Event → 400 missing headers", async () => {
    const { handle } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, { skipEvent: true });
    expect(res.status).toBe(400);
  });

  test("missing X-GitHub-Delivery → 400 missing headers", async () => {
    const { handle } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, { skipDelivery: true });
    expect(res.status).toBe(400);
  });

  test("invalid HMAC → 401 unauthorized", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, {
      signature: "sha256=" + "0".repeat(64),
    });
    expect(res.status).toBe(401);
    expect(published).toHaveLength(0);
  });

  test("malformed signature → 401 unauthorized (verifier throws)", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, {
      signature: "not-a-real-signature-format",
    });
    expect(res.status).toBe(401);
    expect(published).toHaveLength(0);
  });

  test("verifyImpl throw is caught and surfaces as 401", async () => {
    const { handle, published } = start({
      verifyImpl: async () => {
        throw new Error("verifier exploded");
      },
    });
    const body = JSON.stringify({});
    const res = await postWebhook(handle, body);
    expect(res.status).toBe(401);
    expect(published).toHaveLength(0);
  });
});

describe("startGithubWebhookReceiver — body handling", () => {
  test("non-JSON body → 400 invalid json", async () => {
    const { handle, published } = start();
    const body = "this is not json";
    const res = await postWebhook(handle, body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid json");
    expect(published).toHaveLength(0);
  });

  test("JSON array (not object) → 400 invalid json", async () => {
    const { handle, published } = start();
    const body = JSON.stringify([1, 2, 3]);
    const res = await postWebhook(handle, body);
    expect(res.status).toBe(400);
    expect(published).toHaveLength(0);
  });

  test("JSON null → 400 invalid json", async () => {
    const { handle, published } = start();
    const body = JSON.stringify(null);
    const res = await postWebhook(handle, body);
    expect(res.status).toBe(400);
    expect(published).toHaveLength(0);
  });
});

describe("startGithubWebhookReceiver — happy path", () => {
  test("valid push webhook → 200 ok + envelope published", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
      commits: [{ id: "abc123", message: "feat: x" }],
    });
    const res = await postWebhook(handle, body, { event: "push" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(published).toHaveLength(1);
    const env = published[0]!;
    expect(env.type).toBe("github.push.received");
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toMatchObject({
      delivery_id: "12345678-1234-4234-8234-123456789012",
      event: "push",
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
    expect(env.payload.body).toEqual({
      ref: "refs/heads/main",
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
      commits: [{ id: "abc123", message: "feat: x" }],
    });
  });

  test("valid pull_request opened webhook → envelope type maps underscores to hyphens", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
    });
    const res = await postWebhook(handle, body, { event: "pull_request" });
    expect(res.status).toBe(200);

    expect(published).toHaveLength(1);
    const env = published[0]!;
    expect(env.type).toBe("github.pull-request.opened");
    expect(env.payload).toMatchObject({
      delivery_id: "12345678-1234-4234-8234-123456789012",
      event: "pull_request",
      action: "opened",
      repo: "the-metafactory/cortex",
      sender: "mellanon",
    });
  });

  test("payload without repository.full_name → envelope has no repo field", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, { event: "push" });
    expect(res.status).toBe(200);
    const env = published[0]!;
    expect("repo" in env.payload).toBe(false);
    expect("sender" in env.payload).toBe(false);
  });

  test("payload with non-string action falls through to no-action envelope", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({ action: 42, ref: "refs/heads/main" });
    const res = await postWebhook(handle, body, { event: "push" });
    expect(res.status).toBe(200);
    const env = published[0]!;
    expect(env.type).toBe("github.push.received");
    // The verbatim non-string `action` is preserved in `payload.body` but
    // NOT promoted to the top-level `payload.action` (which is reserved
    // for the string action used to assemble the envelope `type`).
    expect("action" in env.payload).toBe(false);
    expect((env.payload.body as Record<string, unknown>).action).toBe(42);
  });

  test("published envelope passes vendored myelin schema validation", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({
      action: "opened",
      issue: { number: 7, title: "test", body: "test issue" },
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
    });
    const res = await postWebhook(handle, body, { event: "issues" });
    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    const env = published[0]!;
    const validation = validateEnvelope(env);
    if (!validation.ok) {
      throw new Error(
        `envelope failed schema validation: ${JSON.stringify(validation.errors)}`,
      );
    }
    expect(validation.ok).toBe(true);
  });

  test("UUID delivery id is promoted to envelope correlation_id", async () => {
    const { handle, published } = start();
    const body = JSON.stringify({ action: "opened" });
    const deliveryId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const res = await postWebhook(handle, body, {
      event: "issues",
      deliveryId,
    });
    expect(res.status).toBe(200);
    expect(published[0]!.correlation_id).toBe(deliveryId);
  });

  test("publish callback rejection is swallowed (response still 200)", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const { handle } = start({
        publish: async () => {
          throw new Error("bus is down");
        },
      });
      const body = JSON.stringify({ action: "opened" });
      const res = await postWebhook(handle, body, { event: "issues" });
      // Receiver acks even when publish fails — fire-and-forget per
      // the MyelinRuntime.publish contract.
      expect(res.status).toBe(200);
      // The error was logged so a principal can find it.
      expect(errors.some((e) => e.includes("publish failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });

  test("buildEnvelope override receives correctly-extracted inputs", async () => {
    let capturedOpts: Parameters<NonNullable<Parameters<typeof startGithubWebhookReceiver>[0]["buildEnvelope"]>>[0] | undefined;
    const fakeEnv: Envelope = {
      id: "00000000-0000-4000-8000-000000000000",
      source: "metafactory.cortex.local",
      type: "github.push.received",
      timestamp: new Date().toISOString(),
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "local-only",
      },
      payload: {},
    };
    const { handle, published } = start({
      buildEnvelope: (opts) => {
        capturedOpts = opts;
        return fakeEnv;
      },
    });
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "the-metafactory/cortex" },
      sender: { login: "mellanon" },
    });
    const res = await postWebhook(handle, body, {
      event: "push",
      deliveryId: "deadbeef-dead-4dea-8dea-deadbeefdead",
    });
    expect(res.status).toBe(200);
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.event).toBe("push");
    expect(capturedOpts!.deliveryId).toBe("deadbeef-dead-4dea-8dea-deadbeefdead");
    expect(capturedOpts!.repo).toBe("the-metafactory/cortex");
    expect(capturedOpts!.sender).toBe("mellanon");
    expect(capturedOpts!.source).toEqual(TEST_SOURCE);
    expect(published[0]).toBe(fakeEnv);
  });
});

describe("startGithubWebhookReceiver — shutdown", () => {
  test("stop() can be called multiple times safely", () => {
    const { handle } = start();
    handle.stop();
    // Second stop is a no-op; should not throw.
    expect(() => handle.stop()).not.toThrow();
  });

  test("after stop(), connections are refused", async () => {
    const { handle } = start();
    handle.stop();
    // Give the OS a tick to release the port.
    await Bun.sleep(50);
    let connectErrored = false;
    try {
      await fetch(`http://127.0.0.1:${handle.port}/health`);
    } catch {
      connectErrored = true;
    }
    expect(connectErrored).toBe(true);
  });
});
