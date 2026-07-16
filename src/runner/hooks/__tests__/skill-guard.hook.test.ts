/**
 * Tests for the Cortex Skill Guard PreToolUse hook (cortex#710, C-701 Part B).
 *
 * Two layers:
 *   - PURE logic (parseGrantList / extractSkillName / decideSkill) — the
 *     name-extraction + allow/deny decision, exercised directly.
 *   - PROCESS behaviour — spawn the hook with a Skill tool-call payload on
 *     stdin and assert the exit code + stdout decision:
 *       * granted skill → exit 0, {"continue":true}
 *       * un-granted skill → exit 2, structured PreToolUse deny
 *       * no/empty grant list → deny (fail-closed)
 *       * malformed payload → deny (fail-closed)
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { statSync } from "fs";
import { join } from "path";
import {
  parseGrantList,
  extractSkillName,
  decideSkill,
  normaliseSkillName,
} from "../skill-guard.hook";
import { CORTEX_GRANTED_PLUGIN_NAME } from "../../session-settings";

const HOOK_PATH = join(import.meta.dir, "..", "skill-guard.hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
}

/** Run the hook with a tool-call payload on stdin + a grant-list env. */
function runHook(
  payload: Record<string, unknown> | string,
  grants: string | undefined,
): RunResult {
  // Build a clean env: start from process.env, drop any inherited grant var,
  // then apply this test's value (undefined → unset).
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CORTEX_SKILL_GRANTS") merged[k] = v;
  }
  if (grants !== undefined) merged.CORTEX_SKILL_GRANTS = grants;

  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result = spawnSync("bun", [HOOK_PATH], {
    encoding: "utf-8",
    input,
    env: merged,
  });
  return { status: result.status, stdout: result.stdout };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("parseGrantList — fail-closed parsing", () => {
  test("parses a JSON array of skill names", () => {
    expect(parseGrantList('["code-review","art"]')).toEqual(["code-review", "art"]);
  });

  test("undefined env → empty (deny-all)", () => {
    expect(parseGrantList(undefined)).toEqual([]);
  });

  test("empty string → empty (deny-all)", () => {
    expect(parseGrantList("")).toEqual([]);
  });

  test("malformed JSON → empty (deny-all, never widens access)", () => {
    expect(parseGrantList("not json")).toEqual([]);
  });

  test("non-array JSON → empty (deny-all)", () => {
    expect(parseGrantList('{"skill":"code-review"}')).toEqual([]);
    expect(parseGrantList('"code-review"')).toEqual([]);
  });

  test("filters non-string members", () => {
    expect(parseGrantList('["code-review",42,null,"art"]')).toEqual([
      "code-review",
      "art",
    ]);
  });
});

describe("extractSkillName — name extraction from the Skill tool input", () => {
  test("reads tool_input.skill for tool_name 'Skill'", () => {
    expect(
      extractSkillName({ tool_name: "Skill", tool_input: { skill: "code-review" } }),
    ).toBe("code-review");
  });

  test("accepts the lowercase 'skill' tool name", () => {
    expect(
      extractSkillName({ tool_name: "skill", tool_input: { skill: "art" } }),
    ).toBe("art");
  });

  test("tolerates a raw-string tool_input", () => {
    expect(extractSkillName({ tool_name: "Skill", tool_input: "code-review" })).toBe(
      "code-review",
    );
  });

  test("non-Skill tool → null (this hook governs only Skill)", () => {
    expect(
      extractSkillName({ tool_name: "Bash", tool_input: { skill: "code-review" } }),
    ).toBeNull();
  });

  test("missing tool_name → null", () => {
    expect(extractSkillName({ tool_input: { skill: "code-review" } })).toBeNull();
  });

  test("empty / whitespace skill name → null", () => {
    expect(extractSkillName({ tool_name: "Skill", tool_input: { skill: "  " } })).toBeNull();
    expect(extractSkillName({ tool_name: "Skill", tool_input: {} })).toBeNull();
  });
});

describe("decideSkill — allow/deny decision", () => {
  test("granted name → allow", () => {
    expect(decideSkill("code-review", ["code-review"]).allow).toBe(true);
  });

  test("un-granted name → deny with a reason naming the skill + grant list", () => {
    const d = decideSkill("art", ["code-review"]);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("art");
    expect(d.reason).toContain("code-review");
  });

  test("empty grant list → deny everything", () => {
    expect(decideSkill("code-review", []).allow).toBe(false);
  });

  test("null skill name (not a Skill invocation) → allow pass-through", () => {
    expect(decideSkill(null, ["code-review"]).allow).toBe(true);
  });

  // cortex#2150 — name normalisation. Policy grants are BARE; CC surfaces the
  // granted skill as `cortex-granted:<name>`. The guard must accept BOTH
  // spellings of a granted skill and deny BOTH spellings of a non-granted one.
  test("namespaced spelling of a granted skill → allow", () => {
    expect(decideSkill("cortex-granted:gws-drive", ["gws-drive"]).allow).toBe(true);
  });

  test("bare spelling of a granted skill → allow", () => {
    expect(decideSkill("gws-drive", ["gws-drive"]).allow).toBe(true);
  });

  test("bare non-granted skill → deny", () => {
    expect(decideSkill("anything-else", ["gws-drive"]).allow).toBe(false);
  });

  test("namespaced non-granted skill → deny (prefix is not a bypass)", () => {
    const d = decideSkill("cortex-granted:anything-else", ["gws-drive"]);
    expect(d.allow).toBe(false);
    // The reason names the spelling the model actually invoked.
    expect(d.reason).toContain("cortex-granted:anything-else");
  });

  test("prefix does NOT widen: a bare grant matches only its own skill", () => {
    // Regression: normalisation must not let `cortex-granted:` match a grant
    // that merely CONTAINS the bare name, nor allow an empty tail.
    expect(decideSkill("cortex-granted:", ["gws-drive"]).allow).toBe(false);
  });
});

describe("normaliseSkillName — namespace prefix stripping (cortex#2150)", () => {
  test("strips a leading cortex-granted: prefix", () => {
    expect(normaliseSkillName("cortex-granted:gws-drive")).toBe("gws-drive");
  });

  test("leaves a bare name unchanged", () => {
    expect(normaliseSkillName("gws-drive")).toBe("gws-drive");
  });

  test("strips only ONE leading prefix (not recursive)", () => {
    expect(normaliseSkillName("cortex-granted:cortex-granted:x")).toBe(
      "cortex-granted:x",
    );
  });

  // Drift guard: the hook's hard-coded prefix must track the materialiser's
  // plugin name. If session-settings renames the plugin, this fails loudly
  // rather than silently denying every real (namespaced) invocation.
  test("prefix tracks the materialiser plugin name", () => {
    expect(normaliseSkillName(`${CORTEX_GRANTED_PLUGIN_NAME}:gws-drive`)).toBe(
      "gws-drive",
    );
  });
});

// ---------------------------------------------------------------------------
// Process behaviour (the actual hook contract Claude Code sees)
// ---------------------------------------------------------------------------

describe("skill-guard.hook — install posture", () => {
  test("hook file is executable (owner +x) — bare-path hook command must run", () => {
    // cortex#710 fail-open root cause: the hook was committed 100644 (no +x).
    // arc installs the symlink preserving source mode, and the curated
    // settings invoke it by BARE PATH (`${claudeDir}/hooks/CortexSkillGuard.hook.ts`),
    // not `bun <path>`. A non-executable bare-path hook fails to run → the
    // broad `Skill` allow stands → every un-granted skill executes. Every
    // other cortex hook is committed 100755; this asserts skill-guard stays so.
    const mode = statSync(HOOK_PATH).mode;
    // owner execute bit
    expect(mode & 0o100).toBe(0o100);
  });
});

describe("skill-guard.hook — process behaviour", () => {
  test("granted skill → exit 0, {continue:true}", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      '["code-review"]',
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("un-granted skill → exit 2, structured PreToolUse deny", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "art" } },
      '["code-review"]',
    );
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("art");
  });

  test("no grant-list env → deny (fail-closed)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      undefined,
    );
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  test("empty grant list → deny (fail-closed)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      "[]",
    );
    expect(r.status).toBe(2);
  });

  test("malformed payload → deny (fail-closed)", () => {
    const r = runHook("not json at all", '["code-review"]');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  // cortex#2150 — the running hook honours normalisation end-to-end: the
  // namespaced spelling CC actually emits for a granted skill is allowed, and
  // the namespaced spelling of a non-granted skill is still denied.
  test("namespaced granted skill → exit 0 (allow)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "cortex-granted:gws-drive" } },
      '["gws-drive"]',
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("namespaced non-granted skill → exit 2 (deny; prefix is no bypass)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "cortex-granted:art" } },
      '["gws-drive"]',
    );
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  test("exactly one grant → only that skill passes, everything else denied", () => {
    const granted = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      '["code-review"]',
    );
    const other = runHook(
      { tool_name: "Skill", tool_input: { skill: "telos" } },
      '["code-review"]',
    );
    expect(granted.status).toBe(0);
    expect(other.status).toBe(2);
  });

  test("Skill call with no resolvable name → deny (fail-closed)", () => {
    // tool_name IS Skill but tool_input carries no `skill` — we cannot
    // identify the skill and the bare Skill tool is broadly allowed, so this
    // MUST fail closed (it used to fall through to allow via decideSkill(null)).
    const r = runHook({ tool_name: "Skill", tool_input: {} }, '["code-review"]');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  test("empty stdin → deny (fail-closed, NOT allow)", () => {
    // cortex#710 fail-open regression: an empty read means we failed to
    // capture the payload, not "this isn't a Skill call". Must deny.
    const r = runHook("", '["code-review"]');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });
});

// ---------------------------------------------------------------------------
// Live fail-open regression (cortex#710): stdin arriving AFTER the hook spawns
//
// The hook used to race the stdin read against a 200ms timeout and then treat
// an empty buffer as "not a Skill call" → allow. Under live Claude Code the
// payload routinely arrives >200ms after spawn, so a granted-but-restricted
// session launched EVERY un-granted skill (proven live). The fix reads stdin
// to EOF (5s hang-stop cap) and fails CLOSED on empty/timeout. These tests
// pipe a DELAYED payload through a shell so the hook process is already
// running before the JSON shows up — the exact race that failed live.
// ---------------------------------------------------------------------------

describe("skill-guard.hook — delayed-stdin fail-open regression", () => {
  /** Run the hook with the payload written to stdin after `delayMs`. */
  function runHookDelayed(
    payload: Record<string, unknown>,
    grants: string,
    delayMs: number,
  ): RunResult {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "CORTEX_SKILL_GRANTS") merged[k] = v;
    }
    merged.CORTEX_SKILL_GRANTS = grants;
    const json = JSON.stringify(payload);
    // `sleep` then `printf` the payload — the hook is spawned and reading
    // before the JSON arrives, reproducing the live pipe-delay race.
    const result = spawnSync(
      "bash",
      [
        "-c",
        `sleep ${(delayMs / 1000).toFixed(3)}; printf %s ${JSON.stringify(json)} | bun ${JSON.stringify(HOOK_PATH)}`,
      ],
      { encoding: "utf-8", env: merged },
    );
    return { status: result.status, stdout: result.stdout };
  }

  test("delayed un-granted skill → still DENY (no fail-open)", () => {
    const r = runHookDelayed(
      { tool_name: "Skill", tool_input: { skill: "simplify" } },
      '["code-review"]',
      300,
    );
    expect(r.status).toBe(2);
  });

  test("delayed granted skill → still ALLOW", () => {
    const r = runHookDelayed(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      '["code-review"]',
      300,
    );
    expect(r.status).toBe(0);
  });
});
