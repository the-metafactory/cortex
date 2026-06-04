/**
 * cortex#701 (Part B) — least-privilege skill gate tests.
 *
 * Asserts the default-DENY posture and that a one-skill grant exposes
 * EXACTLY that skill (AC: "An agent granted exactly one skill gets exactly
 * that skill — nothing else" + "Default with no grants = no Skill tool").
 */

import { describe, test, expect } from "bun:test";
import { resolveSkillGate } from "../skill-gate";

describe("resolveSkillGate — default-deny", () => {
  test("undefined grant ⇒ no Skill tool (deny bare Skill, zero allows)", () => {
    const gate = resolveSkillGate(undefined);
    expect(gate.allow).toEqual([]);
    expect(gate.deny).toEqual(["Skill"]);
  });

  test("empty grant [] ⇒ no Skill tool (explicit deny)", () => {
    const gate = resolveSkillGate([]);
    expect(gate.allow).toEqual([]);
    expect(gate.deny).toEqual(["Skill"]);
  });
});

describe("resolveSkillGate — explicit per-skill grants", () => {
  test("one granted skill ⇒ exactly Skill(name), bare Skill still denied", () => {
    const gate = resolveSkillGate(["code-review"]);
    expect(gate.allow).toEqual(["Skill(code-review)"]);
    // The bare Skill deny is the backstop so un-granted skills can't run.
    expect(gate.deny).toEqual(["Skill"]);
  });

  test("multiple grants ⇒ one Skill(name) per skill, nothing else", () => {
    const gate = resolveSkillGate(["code-review", "verify"]);
    expect(gate.allow).toEqual(["Skill(code-review)", "Skill(verify)"]);
    expect(gate.deny).toEqual(["Skill"]);
  });

  test("granted skill X does NOT produce an allow for un-granted skill Y", () => {
    const gate = resolveSkillGate(["code-review"]);
    expect(gate.allow).not.toContain("Skill(research)");
    expect(gate.allow).not.toContain("Skill"); // never grant the bare tool
  });

  test("duplicate grants are de-duplicated", () => {
    const gate = resolveSkillGate(["code-review", "code-review"]);
    expect(gate.allow).toEqual(["Skill(code-review)"]);
  });
});
