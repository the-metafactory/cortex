#!/usr/bin/env bun
/**
 * Cortex Skill Guard — PreToolUse hook for the `Skill` tool (cortex#710,
 * C-701 Part B — TRUST-PATH/security).
 *
 * ## Why a hook (and not a permission rule)
 *
 * The original #706 Part B tried to express per-skill grants with
 * `allowedTools: ["Skill(code-review)"]` + `disallowedTools: ["Skill"]`.
 * That is broken by design (proven in the #706 review):
 *
 *   - Claude Code's `Skill` tool has **no specifier syntax** — there is no
 *     `Skill(<name>)` rule form, so `Skill(code-review)` matches nothing.
 *   - Permission precedence is **deny → ask → allow; deny ALWAYS wins**,
 *     regardless of specificity. So a bare `Skill` deny suppresses the
 *     granted skill too → a granted reviewer gets NO skills at all.
 *
 * The correct mechanism is a **PreToolUse hook** (matcher `Skill`):
 *
 *   - Hooks run **before** permission rules; a blocking hook beats `allow`.
 *   - So the session can broadly **allow** the bare `Skill` tool (the
 *     permission rule is permissive) while THIS hook is the real gate: it
 *     inspects the invoked skill name and DENIES any name ∉ the grant list.
 *
 * Wiring (see `src/runner/session-settings.ts`):
 *   - A session WITH grants registers this hook under `PreToolUse` matcher
 *     `Skill` in the curated `--settings` file, AND broadly allows `Skill`.
 *   - The grant list reaches this hook via the `CORTEX_SKILL_GRANTS` env
 *     var (a JSON array of allowed skill names), set on the child env by
 *     `cc-session.ts` — the same layering as `CORTEX_BASH_GUARD`.
 *   - A session with NO grants does NOT register this hook; it keeps the
 *     bare-`Skill` `disallowedTools` deny (default-deny, no Skill tool).
 *
 * ## Deny behaviour
 *
 * On an un-granted skill the hook is **doubly fail-closed**:
 *   1. Emits Claude Code's structured PreToolUse *deny* decision on stdout
 *      ({"hookSpecificOutput":{...,"permissionDecision":"deny",
 *       "permissionDecisionReason":"…"}}) so the reason surfaces to the
 *      agent and the Cortex→Discord relay (mirrors bash-guard.hook.ts).
 *   2. Exits with code **2** — Claude Code treats a PreToolUse hook exit 2
 *      as a hard block. Belt-and-braces: even a CLI that ignored the
 *      structured output would still be blocked by the non-zero exit.
 *
 * ## Fail-closed posture on malformed input / missing grant list
 *
 * If `CORTEX_SKILL_GRANTS` is absent or not a JSON array, the grant list is
 * empty → every skill is denied. A session that wants skills MUST register
 * this hook with a populated grant list; the absence of a grant list never
 * silently allows skills. (A session with no grants doesn't register the
 * hook at all and relies on the `disallowedTools: ["Skill"]` rule instead,
 * so this path is the defence-in-depth backstop.)
 */

interface HookInput {
  session_id?: string;
  tool_name?: string;
  // The `Skill` tool input carries the invoked skill name on `skill`
  // (verified against the codebase's own event-utils.ts, which reads
  // `input.skill` for the "Using skill: …" detail). May arrive as a raw
  // string in degenerate cases; we tolerate both shapes.
  tool_input?: { skill?: unknown } | string;
}

/** The Skill tool's name as Claude Code emits it (seen as both casings). */
const SKILL_TOOL_NAMES = new Set(["Skill", "skill"]);

/**
 * Parse the per-session grant list from `CORTEX_SKILL_GRANTS` (JSON array of
 * skill-name strings). Returns `[]` (deny-all) on absence or malformed input
 * — fail-closed. Exported for unit tests.
 */
export function parseGrantList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // Malformed grant list — fail closed (deny all). A bad env value must
    // never widen access.
    return [];
  }
}

/**
 * Extract the invoked skill name from a PreToolUse hook input for the
 * `Skill` tool. Returns `null` when the input is not a Skill invocation or
 * carries no usable name. Exported for unit tests.
 */
export function extractSkillName(input: HookInput): string | null {
  if (input.tool_name === undefined || !SKILL_TOOL_NAMES.has(input.tool_name)) {
    return null;
  }
  const ti = input.tool_input;
  if (typeof ti === "string") {
    const trimmed = ti.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (ti && typeof ti === "object" && typeof ti.skill === "string") {
    const trimmed = ti.skill.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Decide allow/deny for a Skill invocation given the grant list. Pure —
 * exported for unit tests. `null` skill name (not a Skill invocation, or no
 * name) is treated as a pass-through allow: this hook only gates Skill, and
 * Claude Code only fires it on the `Skill` matcher, so a `null` here means
 * "not something this hook governs".
 */
export function decideSkill(
  skillName: string | null,
  grants: string[],
): { allow: boolean; reason?: string } {
  if (skillName === null) return { allow: true };
  if (grants.includes(skillName)) return { allow: true };
  return {
    allow: false,
    reason:
      `[Cortex Skill Guard] Blocked skill "${skillName}": not in this ` +
      `session's grant list [${grants.map((g) => `"${g}"`).join(", ")}]. ` +
      `This is a hard security boundary (least-privilege per-skill grants, ` +
      `cortex#701). Ask the principal to grant this skill to the agent's ` +
      `role if it is genuinely needed.`,
  };
}

/** Emit the pass-through decision (mirrors bash-guard.hook.ts). */
function allow(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent + the Cortex→Discord
 * relay (mirrors bash-guard.hook.ts).
 */
function deny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

/**
 * Read the PreToolUse payload from stdin to EOF.
 *
 * ## Why this MUST read to EOF (cortex#710 fail-open fix)
 *
 * An earlier version raced the read against a 200ms timeout (copied from
 * bash-guard). That is sound for bash-guard — the Bash tool is allow-by-
 * default, so a timed-out guard that falls through to `allow()` merely
 * declines to block one Bash command. It is **catastrophic here**: the whole
 * skill model is "the bare `Skill` tool is broadly ALLOWED and THIS hook is
 * the only gate". If the read abandons before Claude Code has finished piping
 * the JSON payload (observed live, CLI 2.1.158: the payload routinely arrives
 * >200ms after the hook process spawns), `raw` is empty → the caller's
 * empty-input branch ran `allow()` → **every un-granted skill executed**
 * (proven live: a session granted only `code-review` launched `simplify`).
 *
 * So we read to EOF with a generous hard cap purely as a hang-stop (a wedged
 * pipe must not hang the session forever). On the cap firing we throw, and the
 * caller treats a throw as fail-CLOSED (deny) — never allow.
 */
const STDIN_READ_CAP_MS = 5_000;

async function readStdin(): Promise<string> {
  // `Bun.stdin.text()` consumes the stream to EOF and resolves with the FULL
  // payload — the correct primitive for a hook that MUST see the whole JSON
  // before deciding (it was verified live to deliver the complete Claude Code
  // PreToolUse payload, where the old 200ms-race reader returned empty). We
  // still bound it with a hang-stop cap: a wedged/never-closing pipe must not
  // hang the session forever. On the cap firing we reject → the caller treats
  // a throw as fail-CLOSED (deny), never allow. This is the opposite posture
  // from the old race, which returned partial/empty input and let the
  // empty-input branch fail OPEN.
  const timedOut = Symbol("timedOut");
  // Hold the timer id so we can clear it the instant the read wins. A pending
  // setTimeout keeps the event loop alive, so on the ALLOW path (which falls
  // off the end of `main()` rather than `process.exit`ing) an uncleared timer
  // would block process exit for the full cap — the hook would appear to hang.
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Bun.stdin.text(),
    new Promise<typeof timedOut>((r) => {
      capTimer = setTimeout(() => {
        r(timedOut);
      }, STDIN_READ_CAP_MS);
    }),
  ]);
  if (capTimer !== undefined) clearTimeout(capTimer);
  if (outcome === timedOut) {
    throw new Error("skill-guard: stdin read exceeded cap before EOF");
  }
  return outcome;
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      // Empty payload. Claude Code ONLY fires this hook on the `Skill`
      // matcher, so an empty read means we failed to capture the payload
      // (e.g. the read ended before the JSON was piped) — NOT "this isn't a
      // Skill call". We cannot identify the skill, and the bare `Skill` tool
      // is broadly allowed, so allowing here would let an un-granted skill
      // run. Fail CLOSED. (cortex#710 — this branch used to `allow()`, which
      // was a live-proven fail-open under the old 200ms stdin race.)
      const reason =
        "[Cortex Skill Guard] Blocked: empty Skill tool input — could not " +
        "identify the skill; denying to stay fail-closed.";
      deny(reason);
      process.exit(2);
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    // Can't read or parse the payload. We CANNOT confirm which skill is being
    // invoked, so the only safe posture is to deny — a malformed (or
    // never-fully-read) payload must not slip an un-named skill past the
    // gate. Fail closed.
    const reason =
      "[Cortex Skill Guard] Blocked: could not parse the Skill tool input — " +
      "denying to stay fail-closed.";
    deny(reason);
    process.exit(2);
  }

  const skillName = extractSkillName(input);
  const grants = parseGrantList(process.env.CORTEX_SKILL_GRANTS);

  // cortex#710 fail-closed disambiguation. `extractSkillName` returns `null`
  // for TWO different cases; only ONE of them is safe to allow:
  //   (a) the tool_name is NOT a Skill call → genuinely not ours to gate
  //       (Claude Code shouldn't fire us here, but if it does, pass through).
  //   (b) the tool_name IS `Skill`/`skill` but the name is missing/empty/
  //       unparseable → we CANNOT identify the skill. The bare `Skill` tool is
  //       broadly allowed, so passing through would run an un-identified skill.
  //       That must fail CLOSED.
  const isSkillCall =
    input.tool_name !== undefined && SKILL_TOOL_NAMES.has(input.tool_name);
  if (skillName === null && isSkillCall) {
    const reason =
      "[Cortex Skill Guard] Blocked: Skill invocation with no resolvable " +
      "skill name — denying to stay fail-closed.";
    deny(reason);
    process.exit(2);
  }

  const decision = decideSkill(skillName, grants);

  if (decision.allow) {
    allow();
    return;
  }

  // Write the deny decision FIRST (surfaces the reason), then exit 2 so the
  // block is enforced even by a CLI that ignores structured hook output.
  deny(decision.reason ?? "[Cortex Skill Guard] Blocked.");
  process.exit(2);
}

// Only execute the gate when run AS a script (the production hook path).
// Guard with `import.meta.main` so unit tests can `import` the pure helpers
// (parseGrantList / extractSkillName / decideSkill) WITHOUT triggering
// `main()` — which now reads stdin to EOF and `process.exit(2)`s on an empty
// read (the fail-closed fix). Without this guard, importing the module from
// the test runner would hang on stdin or kill the runner with exit 2 before
// the suite summary prints. The installed hook is always invoked as a script,
// so `import.meta.main` is true there and the gate runs exactly as before.
if (import.meta.main) {
  main().catch(() => {
    // An unexpected failure in the gate must fail CLOSED, not open: if we
    // can't run the check, deny. Mirrors the malformed-input path above.
    deny(
      "[Cortex Skill Guard] Blocked: internal hook error — denying to stay " +
        "fail-closed.",
    );
    process.exit(2);
  });
}
