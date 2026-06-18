/**
 * S2 (cortex#1160) — chat-capability filter unit tests.
 *
 * The boot path constructs one builtin chat dispatch listener per
 * chat-capable agent. "Chat-capable" = an ENABLED platform presence AND a
 * builtin (non-exec) brain. These tests pin that rule so the boot loop and the
 * design stay in lockstep.
 */
import { describe, expect, test } from "bun:test";
import type { Agent } from "../../common/types/cortex-config";
import { chatCapableAgents, hasEnabledPresence } from "../chat-capable-agents";

/** The SAME exec-brain predicate `cortex.ts` boot uses. */
const isExecBrain = (a: Agent): boolean => a.runtime?.brain?.kind === "exec";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    displayName: id,
    persona: `/tmp/${id}.md`,
    trust: [],
    presence: {},
    ...overrides,
  };
}

// Minimal Discord presence. The schema fills the remaining defaults at parse
// time; the chat-capability filter only reads `enabled` + block-presence, so a
// structural literal (cast to the parsed shape) is sufficient for these tests.
const discordPresence = (enabled = true): Agent["presence"] =>
  ({
    discord: {
      enabled,
      token: `${enabled ? "on" : "off"}-token`,
      guildId: "g",
      agentChannelId: "c",
      logChannelId: "cl",
    },
  }) as Agent["presence"];

describe("chatCapableAgents (S2 / cortex#1160)", () => {
  test("a headless agent (presence: {}) is NOT chat-capable", () => {
    const headless = agent("dev"); // presence: {}
    expect(hasEnabledPresence(headless)).toBe(false);
    expect(chatCapableAgents([headless], isExecBrain)).toEqual([]);
  });

  test("an agent with an enabled Discord presence IS chat-capable", () => {
    const luna = agent("luna", { presence: discordPresence(true) });
    expect(hasEnabledPresence(luna)).toBe(true);
    expect(chatCapableAgents([luna], isExecBrain).map((a) => a.id)).toEqual([
      "luna",
    ]);
  });

  test("a DISABLED presence does not earn chat-capability (no live adapter)", () => {
    const pier = agent("pier", { presence: discordPresence(false) });
    expect(hasEnabledPresence(pier)).toBe(false);
    expect(chatCapableAgents([pier], isExecBrain)).toEqual([]);
  });

  test("an exec-brain agent with presence is EXCLUDED (routes via BrainConsumer)", () => {
    const sage = agent("sage", {
      presence: discordPresence(true),
      runtime: {
        substrate: "claude-code",
        mode: "in-process",
        capabilities: ["code-review.typescript"],
        brain: { kind: "exec", run: "bun {pack}/brain/main.ts" },
      } as Agent["runtime"],
    });
    expect(chatCapableAgents([sage], isExecBrain)).toEqual([]);
  });

  test("mixed registry: only enabled-presence builtin agents survive, order preserved", () => {
    const luna = agent("luna", { presence: discordPresence(true) });
    const pierDisabled = agent("pier-off", { presence: discordPresence(false) });
    const dev = agent("dev"); // headless
    const pierLive = agent("pier", { presence: discordPresence(true) });
    const result = chatCapableAgents(
      [luna, pierDisabled, dev, pierLive],
      isExecBrain,
    ).map((a) => a.id);
    expect(result).toEqual(["luna", "pier"]);
  });
});
