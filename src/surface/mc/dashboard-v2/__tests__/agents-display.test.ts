/**
 * G-1114.B.4 — agents-panel display-helper tests.
 *
 * The panel mode selection + relative-time formatting are extracted into
 * `lib/agents-display.ts` so they stay unit-testable without a DOM (same
 * discipline as `working-grid-display`).
 */

import { describe, it, expect } from "bun:test";
import {
  pickAgentsPanelMode,
  formatRelativeTime,
  offlineReasonLabel,
  isTtlLapse,
  formatCapabilities,
  NO_CAPABILITIES_LABEL,
  TTL_LAPSE_REASON,
  type AgentsPanelInput,
} from "../lib/agents-display";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(): AgentPresenceTile {
  return {
    key: "andreas/research/luna",
    origin: "local",
    agent_id: "luna",
    assistant_name: "Luna",
    nkey_public_key: "NLUNA",
    principal: "andreas",
    stack: "research",
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 1000,
  };
}

function input(over: Partial<AgentsPanelInput> = {}): AgentsPanelInput {
  return { agents: [], loaded: false, error: null, ...over };
}

describe("pickAgentsPanelMode", () => {
  it("returns 'error' on a boot error before anything loaded", () => {
    expect(pickAgentsPanelMode(input({ error: "HTTP 500", loaded: false }))).toBe("error");
  });

  it("returns 'loading' pre-boot with no error", () => {
    expect(pickAgentsPanelMode(input({ loaded: false }))).toBe("loading");
  });

  it("returns 'empty' when loaded with no agents", () => {
    expect(pickAgentsPanelMode(input({ loaded: true }))).toBe("empty");
  });

  it("returns 'list' when there are agents", () => {
    expect(pickAgentsPanelMode(input({ loaded: true, agents: [tile()] }))).toBe("list");
  });

  it("keeps the last-good list on a refetch error (error + loaded → not 'error')", () => {
    // A swallowed refetch error after a successful boot: loaded stays true with
    // a stale error string — the list must remain, not flip to the error card.
    expect(
      pickAgentsPanelMode(input({ loaded: true, error: "HTTP 500", agents: [tile()] }))
    ).toBe("list");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;

  it("returns 'never' for null/undefined", () => {
    expect(formatRelativeTime(null, now)).toBe("never");
    expect(formatRelativeTime(undefined, now)).toBe("never");
  });

  it("returns 'just now' under 5s (and for clock skew into the future)", () => {
    expect(formatRelativeTime(now - 1000, now)).toBe("just now");
    expect(formatRelativeTime(now + 5000, now)).toBe("just now");
  });

  it("formats seconds", () => {
    expect(formatRelativeTime(now - 12_000, now)).toBe("12s ago");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
});

describe("offlineReasonLabel — G-1114.C.4", () => {
  it("maps the inferred TTL lapse to a 'no heartbeat' label (the agent went silent)", () => {
    expect(offlineReasonLabel(TTL_LAPSE_REASON)).toBe("no heartbeat");
    expect(offlineReasonLabel("ttl_lapse")).toBe("no heartbeat");
  });

  it("maps each graceful announced reason to a distinct human label", () => {
    expect(offlineReasonLabel("shutdown")).toBe("shut down");
    expect(offlineReasonLabel("restart")).toBe("restarting");
    expect(offlineReasonLabel("error")).toBe("errored");
  });

  it("renders a generic 'offline' for a missing/empty reason (still distinct from online)", () => {
    expect(offlineReasonLabel(null)).toBe("offline");
    expect(offlineReasonLabel(undefined)).toBe("offline");
    expect(offlineReasonLabel("")).toBe("offline");
  });

  it("echoes an unknown/future reason rather than blanking it", () => {
    expect(offlineReasonLabel("graceful-shutdown")).toBe("graceful-shutdown");
    expect(offlineReasonLabel("some-future-reason")).toBe("some-future-reason");
  });
});

describe("isTtlLapse — G-1114.C.4", () => {
  it("is true only for the TTL-lapse reason", () => {
    expect(isTtlLapse(TTL_LAPSE_REASON)).toBe(true);
    expect(isTtlLapse("ttl_lapse")).toBe(true);
  });

  it("is false for graceful reasons and absent reasons", () => {
    expect(isTtlLapse("shutdown")).toBe(false);
    expect(isTtlLapse("restart")).toBe(false);
    expect(isTtlLapse("error")).toBe(false);
    expect(isTtlLapse(null)).toBe(false);
    expect(isTtlLapse(undefined)).toBe(false);
  });
});

describe("formatCapabilities — G-1114.C.4", () => {
  it("yields one badge per capability, preserving registry order", () => {
    const badges = formatCapabilities(["review.code", "review.design", "moderate"]);
    expect(badges).toEqual([
      { label: "review.code", placeholder: false },
      { label: "review.design", placeholder: false },
      { label: "moderate", placeholder: false },
    ]);
  });

  it("yields a single placeholder badge for an empty capability set", () => {
    const badges = formatCapabilities([]);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toEqual({ label: NO_CAPABILITIES_LABEL, placeholder: true });
  });

  it("does not de-duplicate or sort (it reflects what the registry reported)", () => {
    const badges = formatCapabilities(["b", "a", "b"]);
    expect(badges.map((x) => x.label)).toEqual(["b", "a", "b"]);
  });
});
