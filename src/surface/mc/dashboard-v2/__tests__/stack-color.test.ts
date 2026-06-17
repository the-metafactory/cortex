/**
 * #1068 — per-stack color-coding tests.
 *
 * `stackColor(origin)` must be:
 *   - deterministic + stable: the SAME origin always yields the SAME color;
 *   - distinct: different stacks generally yield different colors (no collision
 *     across the small set used in the snapshot);
 *   - local-distinguished: `"local"` always maps to the reserved signature hue,
 *     and a foreign stack never steals that signature color;
 *   - palette-bounded: every output is a member of the fixed palette.
 */

import { describe, it, expect } from "bun:test";
import {
  stackColor,
  originScopeKey,
  STACK_PALETTE,
  LOCAL_STACK_COLOR,
} from "../lib/stack-color";
import type { AgentOrigin } from "../hooks/use-agents";

const peer = (principal: string, stack: string): AgentOrigin => ({
  principal,
  stack,
});

describe("stackColor (#1068)", () => {
  it("maps the local stack to the reserved signature color", () => {
    expect(stackColor("local")).toBe(LOCAL_STACK_COLOR);
    expect(LOCAL_STACK_COLOR).toBe(STACK_PALETTE[0]!);
  });

  it("is deterministic + stable: the same origin always yields the same color", () => {
    const o = peer("jc", "research");
    const first = stackColor(o);
    // Re-resolve from a fresh object with the same scope — color is content-only.
    const second = stackColor(peer("jc", "research"));
    expect(first).toBe(second);
    // And stable across many calls.
    for (let i = 0; i < 50; i++) expect(stackColor(o)).toBe(first);
  });

  it("always returns a member of the fixed palette", () => {
    const origins: AgentOrigin[] = [
      "local",
      peer("andreas", "work"),
      peer("andreas", "halden"),
      peer("andreas", "community"),
      peer("jc", "research"),
      peer("nova", "ops"),
    ];
    for (const o of origins) {
      expect(STACK_PALETTE).toContain(stackColor(o));
    }
  });

  it("gives distinct colors to the distinct stacks present today", () => {
    // The 4 local stacks the principal runs (meta-factory is the local self) +
    // a couple of federated peers — assert no two NON-self stacks collide.
    const stacks: AgentOrigin[] = [
      peer("andreas", "work"),
      peer("andreas", "halden"),
      peer("andreas", "community"),
      peer("jc", "research"),
    ];
    const colors = stacks.map(stackColor);
    expect(new Set(colors).size).toBe(stacks.length);
  });

  it("never lets a foreign stack steal the local signature color", () => {
    // Sweep a wide range of peer scopes; none may land on the reserved palette[0].
    for (let p = 0; p < 40; p++) {
      for (let s = 0; s < 40; s++) {
        const c = stackColor(peer(`principal${p}`, `stack${s}`));
        expect(c).not.toBe(LOCAL_STACK_COLOR);
      }
    }
  });

  it("different stacks of the SAME principal get their own colors", () => {
    const work = stackColor(peer("andreas", "work"));
    const halden = stackColor(peer("andreas", "halden"));
    expect(work).not.toBe(halden);
  });

  it("originScopeKey distinguishes local from peers and encodes principal/stack", () => {
    expect(originScopeKey("local")).toBe("local");
    expect(originScopeKey(peer("jc", "research"))).toBe("jc/research");
    // Two different stacks → different keys (so different color buckets).
    expect(originScopeKey(peer("andreas", "work"))).not.toBe(
      originScopeKey(peer("andreas", "halden")),
    );
  });
});
