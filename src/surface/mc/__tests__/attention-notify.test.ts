/**
 * G-1113.E.4 — attention notification envelopes + publish seam.
 */
import { describe, it, expect } from "bun:test";
import {
  attentionNotificationEnvelope,
  attentionPresentation,
  publishAttentionNotifications,
} from "../attention-notify";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { AttentionItem } from "../types";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-1", stackId: "laptop", workItemId: "wi-1", sessionId: null,
  kind: "review", severity: "high", status: "open", ...over,
});
const source = { principal: "metafactory" };

describe("attentionNotificationEnvelope (E.4)", () => {
  it("builds a system.attention.opened envelope with the system.* posture + deterministic presentation", () => {
    const env = attentionNotificationEnvelope(item(), "opened", {
      source,
      deepLinkUrl: "https://cortex.meta-factory.ai/work-items/wi-1",
    });
    expect(env.type).toBe("system.attention.opened");
    expect(env.source).toBe("metafactory.cortex.local"); // {principal}.{agent}.{instance} defaults
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    const p = env.payload as { attention: Record<string, unknown>; deep_link_url: string; presentation: string };
    expect(p.attention).toEqual({
      id: "att-1", stack_id: "laptop", kind: "review", severity: "high",
      work_item_id: "wi-1", session_id: null,
    });
    expect(p.deep_link_url).toBe("https://cortex.meta-factory.ai/work-items/wi-1");
    // Code-rendered, deterministic — no LLM tokens.
    expect(p.presentation).toBe("[high] review needs attention — https://cortex.meta-factory.ai/work-items/wi-1");
    // Fresh id + ISO timestamp per call.
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.timestamp).toMatch(/T.*Z$/);
  });

  it("resolved presentation omits the deep-link; honours source overrides + residency", () => {
    const env = attentionNotificationEnvelope(item({ kind: "blocked", severity: "critical" }), "resolved", {
      source: { principal: "acme", agent: "cortex", instance: "dash", dataResidency: "EU" },
      deepLinkUrl: "https://x/y",
    });
    expect(env.type).toBe("system.attention.resolved");
    expect(env.source).toBe("acme.cortex.dash");
    expect((env.sovereignty as { data_residency: string }).data_residency).toBe("EU");
    expect((env.payload as { presentation: string }).presentation).toBe("[critical] blocked cleared");
  });

  it("presentation is pure + deterministic", () => {
    expect(attentionPresentation(item({ severity: "low", kind: "stale" }), "opened", null)).toBe(
      "[low] stale needs attention"
    );
  });

  it("publishAttentionNotifications emits one envelope per item via the injected publisher", async () => {
    const published: Envelope[] = [];
    const n = await publishAttentionNotifications(
      [item({ id: "a-1", workItemId: "wi-1" }), item({ id: "a-2", workItemId: "wi-2" })],
      "opened",
      { source, deepLinkFor: (it) => `https://x/${it.workItemId}` },
      (env) => { published.push(env); }
    );
    expect(n).toBe(2);
    expect(published.map((e) => e.type)).toEqual(["system.attention.opened", "system.attention.opened"]);
    expect((published[0]?.payload as { deep_link_url: string }).deep_link_url).toBe("https://x/wi-1");
    expect((published[1]?.payload as { deep_link_url: string }).deep_link_url).toBe("https://x/wi-2");
  });

  it("publishAttentionNotifications falls back to opts.deepLinkUrl when deepLinkFor is absent", async () => {
    const published: Envelope[] = [];
    await publishAttentionNotifications(
      [item({ id: "a-1" })],
      "opened",
      { source, deepLinkUrl: "https://fixed/link" }, // no deepLinkFor
      (env) => { published.push(env); }
    );
    expect((published[0]?.payload as { deep_link_url: string }).deep_link_url).toBe("https://fixed/link");
    expect((published[0]?.payload as { presentation: string }).presentation).toContain("https://fixed/link");
  });
});
