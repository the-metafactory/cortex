/**
 * ST-P5 — substrate-projection label matrix.
 *
 * THE DOMAIN RULE (CONTEXT.md §Sessions / §"Sub-agent"): the MC model speaks
 * **session** / **child session**. "sub-agent" is NOT a domain entity — it is
 * the Claude-Code-lens DISPLAY label for a `claude-code` child session, derived
 * at render time only. Codex (or any other substrate) projects its own word.
 *
 * Matrix under test (`substrateLabel(substrate, hasParent)`):
 *   claude-code + parent   → "sub-agent"   (the CC lens label for a child session)
 *   claude-code + root     → "session"
 *   <other>     + root     → "<other> session"   (e.g. "codex session")
 *   <other>     + parent   → "<other> session"   (substrate-neutral; no CC label)
 */

import { describe, it, expect } from "bun:test";
import { substrateLabel } from "../lib/substrate-label";

describe("substrateLabel — substrate-projection display matrix", () => {
  it("claude-code child session → 'sub-agent' (the CC-lens label)", () => {
    expect(substrateLabel("claude-code", true)).toBe("sub-agent");
  });

  it("claude-code root session → 'session'", () => {
    expect(substrateLabel("claude-code", false)).toBe("session");
  });

  it("codex root session → 'codex session' (substrate string itself)", () => {
    expect(substrateLabel("codex", false)).toBe("codex session");
  });

  it("codex child session → 'codex session' (no CC sub-agent label)", () => {
    // Other substrates project their own word; "sub-agent" is CC-only.
    expect(substrateLabel("codex", true)).toBe("codex session");
  });

  it("unknown substrate → '<substrate> session' for both root and child", () => {
    expect(substrateLabel("gemini-cli", false)).toBe("gemini-cli session");
    expect(substrateLabel("gemini-cli", true)).toBe("gemini-cli session");
  });

  it("empty / whitespace substrate falls back to bare 'session'", () => {
    // Defensive: a missing substrate must not render an orphaned " session".
    expect(substrateLabel("", false)).toBe("session");
    expect(substrateLabel("   ", true)).toBe("session");
  });
});
