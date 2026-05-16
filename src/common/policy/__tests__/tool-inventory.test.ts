/**
 * v2.0.0 policy cutover — slice I-243B (cortex#294) tests.
 *
 * Pins the canonical Claude tool inventory + verifies the two
 * helpers (`toolCapability` + `invertDisallowedTools`) the migrator
 * (cortex#295) will call.
 *
 * The inventory pin is deliberate: adding a tool to
 * {@link CLAUDE_TOOL_INVENTORY} also requires updating this test —
 * otherwise the migrator inversion silently changes shape for
 * every operator on the next migration run. See the JSDoc on the
 * inventory constant for the rationale.
 *
 * Cross-references:
 *   - `docs/design-policy-cutover.md` §5.2 — `tool.<lowercase>`
 *     capability namespace convention.
 *   - `docs/persona-format.md` §"Frontmatter (v1.0)" — the
 *     authoritative source for the pinned list.
 */

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_TOOL_INVENTORY,
  invertDisallowedTools,
  toolCapability,
} from "../tool-inventory";

describe("CLAUDE_TOOL_INVENTORY", () => {
  test("includes the four tool names operators reference in cortex.yaml today", () => {
    // These four appear in `~/.config/cortex/cortex.yaml` `disallowedTools`
    // lists (multiple times across Discord/Mattermost role blocks). If
    // any of these drops out of the inventory the migrator will fail to
    // invert them and operators will silently lose enforcement on those
    // tools post-cutover.
    expect(CLAUDE_TOOL_INVENTORY).toContain("Bash");
    expect(CLAUDE_TOOL_INVENTORY).toContain("Edit");
    expect(CLAUDE_TOOL_INVENTORY).toContain("Write");
    expect(CLAUDE_TOOL_INVENTORY).toContain("NotebookEdit");
  });

  test("does NOT contain legacy `Task` (renamed to `Agent` in the v1.0 canonical list)", () => {
    // `Task` is the pre-rename name of the agent-spawn tool. At least
    // one role in `~/.config/cortex/cortex.yaml` denies it (Echo's
    // restricted role: `disallowedTools: [Edit, Write, NotebookEdit, Task]`).
    // The v1.0 canonical list in `docs/persona-format.md` carries the
    // post-rename name (`Agent`) instead. The migrator (cortex#295) is
    // responsible for handling legacy `Task` references — either by
    // also denying `Agent` on the migrated role, or by warning. Pinning
    // the absence here prevents accidentally adding both names to the
    // inventory in the future (which would let the inversion silently
    // double-grant the agent-spawn capability).
    const inventoryStrings: string[] = [...CLAUDE_TOOL_INVENTORY];
    expect(inventoryStrings).not.toContain("Task");
    expect(inventoryStrings).toContain("Agent");
  });

  test("pins the v1.0 canonical tool set (changes require deliberate sign-off)", () => {
    // Lifted from `docs/persona-format.md` §"Frontmatter — optional
    // fields (v1.0)" → the `allowedTools` row. If you're adding a tool,
    // update BOTH the inventory AND this pin — the failure on a
    // mismatch is the safety interlock.
    expect([...CLAUDE_TOOL_INVENTORY]).toEqual([
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Bash",
      "Glob",
      "Agent",
      "Skill",
      "WebFetch",
      "WebSearch",
      "NotebookEdit",
      "TodoWrite",
      "BashOutput",
      "KillShell",
    ]);
  });

  test("contains no duplicates (Set size equals array length)", () => {
    expect(new Set(CLAUDE_TOOL_INVENTORY).size).toBe(
      CLAUDE_TOOL_INVENTORY.length,
    );
  });
});

describe("toolCapability", () => {
  test("converts a CamelCase tool name to lowercase tool.<name>", () => {
    expect(toolCapability("Bash")).toBe("tool.bash");
  });

  test("lower-cases multi-segment CamelCase as one run (no dotting)", () => {
    // `NotebookEdit` → `tool.notebookedit`, NOT `tool.notebook.edit`.
    // The namespace convention is `tool.<full-lowercased-name>`; the
    // capability id segment count is always 2.
    expect(toolCapability("NotebookEdit")).toBe("tool.notebookedit");
    expect(toolCapability("TodoWrite")).toBe("tool.todowrite");
    expect(toolCapability("WebFetch")).toBe("tool.webfetch");
    expect(toolCapability("WebSearch")).toBe("tool.websearch");
    expect(toolCapability("BashOutput")).toBe("tool.bashoutput");
    expect(toolCapability("KillShell")).toBe("tool.killshell");
  });

  test("is idempotent under repeated application of lowercase input", () => {
    // Operators have historically written `bash` and `Bash` both —
    // calling toolCapability on the already-lowercased form must
    // produce the same capability id.
    expect(toolCapability("bash")).toBe(toolCapability("Bash"));
  });

  test("does not validate input (unknown names still produce a syntactic capability)", () => {
    // The helper is a string transform, not an inventory gate. The
    // migrator is responsible for warning on unknown names; we just
    // transform whatever we're handed.
    expect(toolCapability("MysteryTool")).toBe("tool.mysterytool");
  });
});

describe("invertDisallowedTools", () => {
  test("empty disallowed list returns the full inventory as tool.* capabilities", () => {
    const result = invertDisallowedTools([]);
    expect(result).toHaveLength(CLAUDE_TOOL_INVENTORY.length);
    // Every inventory entry maps to its tool.<lowercased> capability.
    expect(result).toEqual(
      CLAUDE_TOOL_INVENTORY.map((t) => `tool.${t.toLowerCase()}`),
    );
  });

  test("denying Bash + Edit drops exactly those two and preserves the rest", () => {
    const result = invertDisallowedTools(["Bash", "Edit"]);
    expect(result).toHaveLength(CLAUDE_TOOL_INVENTORY.length - 2);
    expect(result).not.toContain("tool.bash");
    expect(result).not.toContain("tool.edit");
    // Spot-check the remaining set contains other tools.
    expect(result).toContain("tool.read");
    expect(result).toContain("tool.write");
    expect(result).toContain("tool.notebookedit");
  });

  test("lowercase legacy input still denies the matching tool (case-insensitive)", () => {
    // Operators have written `bash` in YAML (lowercase) more than
    // once. Case-sensitive matching here would silently keep
    // `tool.bash` in the grant set — a security regression at
    // migration time.
    const result = invertDisallowedTools(["bash"]);
    expect(result).not.toContain("tool.bash");
  });

  test("mixed casing on input is normalised before matching", () => {
    const result = invertDisallowedTools(["NoTeBoOkEdIt"]);
    expect(result).not.toContain("tool.notebookedit");
    expect(result).toHaveLength(CLAUDE_TOOL_INVENTORY.length - 1);
  });

  test("unknown legacy tool names are inert (full inventory is returned)", () => {
    // Legacy configs may reference tools cortex v2 doesn't track —
    // e.g. third-party substrate tools or typos. The inversion
    // ignores them; the migrator is responsible for warning. Output
    // length matches the empty-input case exactly.
    const result = invertDisallowedTools(["NonExistent", "AlsoFake"]);
    expect(result).toEqual(invertDisallowedTools([]));
  });

  test("output order matches CLAUDE_TOOL_INVENTORY declaration order (deterministic diff)", () => {
    // The migrator writes the resulting capability list into the new
    // policy block and operators eyeball the diff. Set-iteration
    // order would scramble the list every run — the assertion locks
    // in the declaration order.
    const result = invertDisallowedTools(["Bash"]);
    const expected = CLAUDE_TOOL_INVENTORY
      .filter((t) => t !== "Bash")
      .map((t) => `tool.${t.toLowerCase()}`);
    expect(result).toEqual(expected);
  });

  test("denying every inventory tool produces an empty grant set", () => {
    const all = [...CLAUDE_TOOL_INVENTORY];
    expect(invertDisallowedTools(all)).toEqual([]);
  });
});
