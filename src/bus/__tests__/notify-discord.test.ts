/**
 * F-6 downstream — notify.discord code handler tests.
 *
 * Axes:
 *  1. parseIssueActivation — extracts repo/number/title/url/action; rejects
 *     non-objects / payloads without a repo.
 *  2. renderIssueMessage — formats; truncates over the Discord cap.
 *  3. createDiscordNotifier handler — known repo → webhook POST (with
 *     allowed_mentions:{parse:[]}) + `posted` visibility; unknown repo →
 *     `skipped` (returns, no throw); unparseable → `skipped`; a failed POST
 *     (non-2xx of any status, or a thrown fetch) → `failed` + THROWS so the
 *     bridge leaves the Decision un-marked. (v1 does not classify 4xx-permanent
 *     vs 5xx-transient — any failure throws; reflex's guards bound re-fires.)
 */

import { describe, test, expect } from "bun:test";
import type { Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { DiscordNotifyTarget } from "../../common/types/cortex-config";
import type { FiredActivation } from "../reflex-activation-listener";
import {
  createDiscordNotifier,
  parseIssueActivation,
  renderIssueMessage,
  type WebhookPostResult,
} from "../notify-discord";

const SOURCE = { principal: "jc", agent: "cortex", instance: "local" };
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";
const TARGETS: DiscordNotifyTarget[] = [{ repo: "jc/reflex", webhook_url_env: "DISCORD_WH_REFLEX" }];
const ENV = { DISCORD_WH_REFLEX: WEBHOOK };

const ISSUE = {
  action: "opened",
  issue: { number: 42, title: "Bug: thing broke", html_url: "https://github.com/jc/reflex/issues/42" },
  repository: { full_name: "jc/reflex" },
};

function activation(payload: unknown): FiredActivation {
  return {
    target: "@jc/notify-discord",
    payload: payload as Record<string, unknown>,
    decisionId: "decision-1",
    correlationId: "00000000-0000-4000-8000-0000000000aa",
    classification: "local",
  };
}

function fakeRuntime() {
  const published: Envelope[] = [];
  const runtime = {
    enabled: true,
    onEnvelope() { return { unregister: () => {} }; },
    async publish(e: Envelope) { published.push(e); },
    async stop() {},
  } as unknown as MyelinRuntime;
  return { runtime, published };
}

function recordingPoster(result: WebhookPostResult = { ok: true, status: 204 }) {
  const calls: { url: string; body: string }[] = [];
  return {
    calls,
    post: async (url: string, body: string): Promise<WebhookPostResult> => {
      calls.push({ url, body });
      return result;
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

const lastNotify = (published: Envelope[]) =>
  published.find((e) => e.type === "system.bus.notify-discord")?.payload;

// ===========================================================================

describe("parseIssueActivation", () => {
  test("extracts repo + issue fields", () => {
    expect(parseIssueActivation(ISSUE)).toEqual({
      repo: "jc/reflex",
      number: 42,
      title: "Bug: thing broke",
      url: "https://github.com/jc/reflex/issues/42",
      action: "opened",
    });
  });
  test("accepts the flat `repository` string reflex-edge fires (github_hmac)", () => {
    const r = parseIssueActivation({
      action: "opened",
      issue: { number: 7, title: "t", html_url: "u" },
      repository: "the-metafactory/cortex", // flat full_name, not nested
      github_event: "issues",
    });
    expect(r?.repo).toBe("the-metafactory/cortex");
    expect(r?.number).toBe(7);
  });
  test("non-object / missing repo → undefined", () => {
    expect(parseIssueActivation("nope")).toBeUndefined();
    expect(parseIssueActivation(null)).toBeUndefined();
    expect(parseIssueActivation({ issue: { number: 1 } })).toBeUndefined();
  });
});

describe("renderIssueMessage", () => {
  test("formats ref + title + url", () => {
    const msg = renderIssueMessage(parseIssueActivation(ISSUE)!);
    expect(msg).toContain("jc/reflex#42");
    expect(msg).toContain("Bug: thing broke");
    expect(msg).toContain("https://github.com/jc/reflex/issues/42");
  });
  test("truncates over the Discord cap", () => {
    const msg = renderIssueMessage(
      parseIssueActivation({ repository: { full_name: "a/b" }, issue: { number: 1, title: "x".repeat(5000) } })!,
    );
    expect(msg.length).toBeLessThanOrEqual(1900);
  });
  test("escapes Discord markdown in untrusted titles (masked-link/format injection)", () => {
    const msg = renderIssueMessage(
      parseIssueActivation({
        repository: { full_name: "a/b" },
        issue: { number: 1, title: "[click](https://evil.example) **bold** `code`" },
      })!,
    );
    // The injected markdown controls are backslash-escaped → inert.
    expect(msg).not.toContain("[click](https://evil.example)");
    expect(msg).toContain("\\[click\\]");
  });
});

describe("createDiscordNotifier", () => {
  test("known repo → POST with allowed_mentions + posted visibility", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({ runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: ENV, post: poster.post });

    await handler(activation(ISSUE));
    await flush();

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.url).toBe(WEBHOOK);
    const body = JSON.parse(poster.calls[0]!.body);
    expect(body.content).toContain("jc/reflex#42");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(lastNotify(ctrl.published)?.outcome).toBe("posted");
  });

  test("`*` catch-all routes a repo with no exact entry", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({
      runtime: ctrl.runtime, source: SOURCE,
      targets: [{ repo: "*", webhook_url_env: "DISCORD_WH_ALL" }],
      env: { DISCORD_WH_ALL: WEBHOOK },
      post: poster.post,
    });

    await handler(activation({ repository: { full_name: "the-metafactory/anything" }, issue: { number: 9, title: "x" } }));
    await flush();

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]!.url).toBe(WEBHOOK);
    expect(lastNotify(ctrl.published)?.outcome).toBe("posted");
  });

  test("exact repo entry overrides the `*` catch-all", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({
      runtime: ctrl.runtime, source: SOURCE,
      targets: [
        { repo: "*", webhook_url_env: "DISCORD_WH_ALL" },
        { repo: "jc/reflex", webhook_url_env: "DISCORD_WH_REFLEX" },
      ],
      env: { DISCORD_WH_ALL: "https://discord.com/api/webhooks/9/all", DISCORD_WH_REFLEX: WEBHOOK },
      post: poster.post,
    });

    await handler(activation(ISSUE)); // repo jc/reflex
    await flush();

    expect(poster.calls[0]!.url).toBe(WEBHOOK); // exact, not the catch-all
  });

  test("unknown repo → skipped, no POST, no throw", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({ runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: ENV, post: poster.post });

    await handler(activation({ repository: { full_name: "other/repo" }, issue: { number: 1 } }));
    await flush();

    expect(poster.calls).toHaveLength(0);
    expect(lastNotify(ctrl.published)?.outcome).toBe("skipped");
    expect(lastNotify(ctrl.published)?.reason).toBe("no-webhook-for-repo");
  });

  test("unparseable payload → skipped, no throw", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({ runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: ENV, post: poster.post });

    await handler(activation({ no: "repo" }));
    await flush();

    expect(poster.calls).toHaveLength(0);
    expect(lastNotify(ctrl.published)?.outcome).toBe("skipped");
  });

  test("non-2xx → failed visibility + throws (transient)", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster({ ok: false, status: 500 });
    const handler = createDiscordNotifier({ runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: ENV, post: poster.post });

    let threw = false;
    try { await handler(activation(ISSUE)); } catch { threw = true; }
    expect(threw).toBe(true);
    await flush();
    expect(lastNotify(ctrl.published)?.outcome).toBe("failed");
    expect(lastNotify(ctrl.published)?.reason).toBe("http-500");
  });

  test("unset webhook env binding → repo not notified (skipped)", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({
      runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: {}, post: poster.post,
    });

    await handler(activation(ISSUE));
    await flush();

    expect(poster.calls).toHaveLength(0);
    expect(lastNotify(ctrl.published)?.outcome).toBe("skipped");
  });

  test("env binding resolving to a non-Discord URL → repo dropped (SSRF guard)", async () => {
    const ctrl = fakeRuntime();
    const poster = recordingPoster();
    const handler = createDiscordNotifier({
      runtime: ctrl.runtime, source: SOURCE, targets: TARGETS,
      env: { DISCORD_WH_REFLEX: "https://evil.example.com/api/webhooks/1/x" },
      post: poster.post,
    });

    await handler(activation(ISSUE));
    await flush();

    expect(poster.calls).toHaveLength(0);
    expect(lastNotify(ctrl.published)?.outcome).toBe("skipped");
  });

  test("poster throws → failed visibility + rethrows", async () => {
    const ctrl = fakeRuntime();
    const handler = createDiscordNotifier({
      runtime: ctrl.runtime, source: SOURCE, targets: TARGETS, env: ENV,
      post: async () => { throw new Error("network down"); },
    });

    let err: Error | undefined;
    try { await handler(activation(ISSUE)); } catch (e) { err = e as Error; }
    expect(err?.message).toBe("network down");
    await flush();
    expect(lastNotify(ctrl.published)?.outcome).toBe("failed");
  });
});
