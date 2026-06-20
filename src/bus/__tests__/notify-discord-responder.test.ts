/**
 * F-6 downstream — NotifyDiscordResponder tests.
 *
 * Axes:
 *  1. parseIssueActivation — extracts repo/number/title/url/action; rejects
 *     non-objects / payloads without a repo.
 *  2. renderIssueMessage — formats; truncates over the Discord cap.
 *  3. handle — matching dispatch + known repo → webhook POST + `posted`
 *     visibility; unknown repo → `skipped`; unparseable payload → `skipped`;
 *     non-2xx / throw → `failed`; non-matching capability → ignored.
 *  4. lifecycle — disabled runtime dormant; start/stop idempotent.
 */

import { describe, test, expect } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { DiscordNotifyTarget } from "../../common/types/cortex-config";
import {
  createNotifyDiscordResponder,
  parseIssueActivation,
  renderIssueMessage,
  type WebhookPostResult,
} from "../notify-discord-responder";

const SOURCE = { principal: "jc", agent: "cortex", instance: "local" };
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";
const TARGETS: DiscordNotifyTarget[] = [{ repo: "jc/reflex", webhook_url: WEBHOOK }];

const ISSUE_PAYLOAD = {
  action: "opened",
  issue: { number: 42, title: "Bug: thing broke", html_url: "https://github.com/jc/reflex/issues/42" },
  repository: { full_name: "jc/reflex" },
};

function dispatchEnvelope(opts: {
  capability?: string;
  reflexPayload?: unknown;
  decisionId?: string;
  correlationId?: string;
} = {}): Envelope {
  const cap = opts.capability ?? "notify.discord";
  const env: Envelope = {
    id: "00000000-0000-4000-8000-0000000000d1",
    source: "jc.cortex.local",
    type: `tasks.${cap}`,
    timestamp: "2026-06-20T12:00:00.000Z",
    sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" },
    payload: {
      task_id: "00000000-0000-4000-8000-0000000000d2",
      agent_id: "reflex",
      reflex_payload: opts.reflexPayload ?? ISSUE_PAYLOAD,
      reflex_decision_id: opts.decisionId ?? "decision-1",
      reflex_target: "@jc/notify-discord",
    },
    target_assistant: "did:mf:reflex",
    distribution_mode: "direct",
  };
  if (opts.correlationId !== undefined) env.correlation_id = opts.correlationId;
  return env;
}

function fakeRuntime() {
  const published: Envelope[] = [];
  let handler: ((e: Envelope, s: string) => void) | undefined;
  const runtime = {
    enabled: true,
    onEnvelope(h: (e: Envelope, s: string) => void) {
      handler = h;
      return { unregister: () => { handler = undefined; } };
    },
    async publish(e: Envelope) { published.push(e); },
    async subscribe() { return { async stop() {} }; },
    async stop() {},
  } as unknown as MyelinRuntime;
  return {
    runtime,
    published,
    deliver: (e: Envelope, s: string) => handler?.(e, s),
    hasHandler: () => handler !== undefined,
  };
}

const SUBJECT = "local.jc.default.tasks.@did-mf-reflex.notify.discord";

function recordingPoster() {
  const calls: { url: string; body: string }[] = [];
  let result: WebhookPostResult = { ok: true, status: 204 };
  const post = async (url: string, body: string): Promise<WebhookPostResult> => {
    calls.push({ url, body });
    return result;
  };
  return { post, calls, setResult: (r: WebhookPostResult) => { result = r; } };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

// ===========================================================================

describe("parseIssueActivation", () => {
  test("extracts repo + issue fields", () => {
    const r = parseIssueActivation(ISSUE_PAYLOAD);
    expect(r).toEqual({ repo: "jc/reflex", number: 42, title: "Bug: thing broke", url: "https://github.com/jc/reflex/issues/42", action: "opened" });
  });
  test("non-object → undefined", () => {
    expect(parseIssueActivation("nope")).toBeUndefined();
    expect(parseIssueActivation(null)).toBeUndefined();
  });
  test("missing repository → undefined", () => {
    expect(parseIssueActivation({ issue: { number: 1 } })).toBeUndefined();
  });
});

describe("renderIssueMessage", () => {
  test("formats ref + title + url", () => {
    const msg = renderIssueMessage(parseIssueActivation(ISSUE_PAYLOAD)!);
    expect(msg).toContain("jc/reflex#42");
    expect(msg).toContain("Bug: thing broke");
    expect(msg).toContain("https://github.com/jc/reflex/issues/42");
  });
  test("truncates over the Discord cap", () => {
    const long = { repository: { full_name: "a/b" }, issue: { number: 1, title: "x".repeat(5000) } };
    const msg = renderIssueMessage(parseIssueActivation(long)!);
    expect(msg.length).toBeLessThanOrEqual(1900);
  });
});

describe("NotifyDiscordResponder.handle", () => {
  test("known repo → webhook POST + posted visibility", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS, post: poster.post });
    await r.start();
    ctrl.deliver(dispatchEnvelope(), SUBJECT);
    await flush();

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.url).toBe(WEBHOOK);
    expect(JSON.parse(poster.calls[0]!.body).content).toContain("jc/reflex#42");
    const vis = ctrl.published.find((e) => e.type === "system.bus.notify_discord");
    expect((vis!.payload).outcome).toBe("posted");
  });

  test("unknown repo → skipped, no POST", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS, post: poster.post });
    await r.start();
    ctrl.deliver(dispatchEnvelope({ reflexPayload: { repository: { full_name: "other/repo" }, issue: { number: 1 } } }), SUBJECT);
    await flush();

    expect(poster.calls).toHaveLength(0);
    const vis = ctrl.published.find((e) => e.type === "system.bus.notify_discord");
    expect((vis!.payload).outcome).toBe("skipped");
    expect((vis!.payload).reason).toBe("no-webhook-for-repo");
  });

  test("unparseable payload → skipped", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS, post: poster.post });
    await r.start();
    ctrl.deliver(dispatchEnvelope({ reflexPayload: { no: "repo" } }), SUBJECT);
    await flush();

    expect(poster.calls).toHaveLength(0);
    expect(ctrl.published.some((e) => (e.payload).outcome === "skipped")).toBe(true);
  });

  test("non-2xx → failed visibility", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    poster.setResult({ ok: false, status: 500 });
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS, post: poster.post });
    await r.start();
    ctrl.deliver(dispatchEnvelope(), SUBJECT);
    await flush();

    const vis = ctrl.published.find((e) => e.type === "system.bus.notify_discord");
    expect((vis!.payload).outcome).toBe("failed");
    expect((vis!.payload).reason).toBe("http-500");
  });

  test("poster throws → failed visibility, no throw into fan-out", async () => {
    const ctrl = fakeRuntime();
    const r = createNotifyDiscordResponder({
      runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS,
      post: async () => { throw new Error("network down"); },
    });
    await r.start();
    expect(() => ctrl.deliver(dispatchEnvelope(), SUBJECT)).not.toThrow();
    await flush();
    const vis = ctrl.published.find((e) => e.type === "system.bus.notify_discord");
    expect((vis!.payload).outcome).toBe("failed");
  });

  test("non-matching capability → ignored", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS, post: poster.post });
    await r.start();
    ctrl.deliver(dispatchEnvelope({ capability: "chat" }), "local.jc.default.tasks.@did-mf-luna.chat");
    await flush();
    expect(poster.calls).toHaveLength(0);
    expect(ctrl.published).toHaveLength(0);
  });
});

describe("NotifyDiscordResponder — lifecycle", () => {
  test("disabled runtime → dormant, idempotent stop", async () => {
    const ctrl = fakeRuntime();
    (ctrl.runtime as { enabled: boolean }).enabled = false;
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS });
    await r.start();
    expect(ctrl.hasHandler()).toBe(false);
    await r.stop();
    await r.stop();
  });

  test("start registers handler; stop unregisters", async () => {
    const ctrl = fakeRuntime();
    const r = createNotifyDiscordResponder({ runtime: ctrl.runtime, source: SOURCE, principal: "jc", stack: "default", targets: TARGETS });
    await r.start();
    expect(ctrl.hasHandler()).toBe(true);
    await r.stop();
    expect(ctrl.hasHandler()).toBe(false);
  });
});
