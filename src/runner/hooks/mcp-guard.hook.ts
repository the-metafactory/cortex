#!/usr/bin/env bun
/**
 * Cortex MCP Guard — PreToolUse hook for the `mcp__*` tool namespace
 * (cortex#2111 — TRUST-PATH/security).
 *
 * ## Why a hook (and not the tool inventory)
 *
 * `resolvePolicyAccess` confines CC tools by inverting a principal's
 * `tool.*` grants against `CLAUDE_TOOL_INVENTORY` — deny-by-omission over an
 * enumerable, build-time-pinned set of 14 names. MCP tool names are NOT
 * enumerable at build time: they depend on which servers the host has
 * connected in `~/.claude/settings.json`, per-host, changing without a
 * cortex release. No inventory inversion can ever cover `mcp__*` (cortex#2111
 * — structural, not a lag). You cannot deny-by-omission a name you cannot
 * enumerate — but you CAN deny a namespace and require an explicit grant.
 *
 * This hook is that namespace gate: registered in the curated `--settings`
 * file under PreToolUse matcher `mcp__.*` (hooks run BEFORE permission rules;
 * a blocking hook beats allow-by-default), it denies every `mcp__*` invocation
 * that is not covered by the session's grant list.
 *
 * ## Grant grammar
 *
 * The grant list reaches this hook via the `CORTEX_MCP_GRANTS` env var (a
 * JSON array, set by `cc-session.ts` — same layering as `CORTEX_SKILL_GRANTS`).
 * Entries are lowercase patterns derived from `tool.mcp*` policy capabilities
 * (see `deriveMcpGrants` in `src/common/policy/resolve-access.ts`):
 *
 *   - `"*"`               — the whole MCP namespace (from `tool.mcp`, or the
 *                           reserved short-circuit capability)
 *   - `"<server>"`        — every tool of one server (from `tool.mcp.<server>`)
 *   - `"<server>.<tool>"` — a single tool (from `tool.mcp.<server>.<tool>`)
 *
 * A CC tool name `mcp__<server>__<tool>` matches a grant when the grant is
 * `"*"`, equals `<server>`, or equals `<server>.<tool>` (all compared
 * lowercase — mirrors the `tool.<lowercase>` capability convention).
 *
 * ## Deny behaviour
 *
 * Doubly fail-closed, mirroring skill-guard.hook.ts:
 *   1. Emits Claude Code's structured PreToolUse deny decision on stdout so
 *      the reason surfaces to the agent and the Cortex→Discord relay.
 *   2. Exits with code **2** — a hard block even for a CLI that ignores
 *      structured hook output.
 *
 * ## Fail-closed posture
 *
 * If `CORTEX_MCP_GRANTS` is absent or malformed, the grant list is empty →
 * every `mcp__*` tool is denied. An empty/unparseable stdin payload is a
 * deny (we cannot identify the tool; `mcp__*` is allow-by-default at the
 * permission layer, so passing through would fail OPEN — the exact
 * cortex#710 lesson). A non-`mcp__*` tool name is a pass-through allow:
 * this hook only governs the MCP namespace.
 */

interface HookInput {
  session_id?: string;
  tool_name?: string;
}

/** The CC tool-name prefix that marks an MCP server tool. */
const MCP_TOOL_PREFIX = "mcp__";

/** Grant entry that opens the whole MCP namespace. */
export const MCP_GRANT_ALL = "*";

/**
 * Parse the per-session grant list from `CORTEX_MCP_GRANTS` (JSON array of
 * lowercase pattern strings). Returns `[]` (deny-all) on absence or malformed
 * input — fail-closed. Exported for unit tests.
 */
export function parseMcpGrantList(raw: string | undefined): string[] {
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
 * Split a CC MCP tool name into its (server, tool) pair, lowercased.
 * `mcp__gdrive__read_file` → `{ server: "gdrive", tool: "read_file" }`.
 * Server names may contain single underscores (`claude_ai_Google_Drive`);
 * the separator is the DOUBLE underscore, so the server is the first
 * `__`-delimited segment and the tool is the remainder (re-joined, so a
 * tool name that itself contains `__` survives). Returns `null` when the
 * name is not an `mcp__*` tool or has no server segment. Exported for unit
 * tests.
 */
export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  if (rest.length === 0) return null;
  const segments = rest.split("__");
  const server = segments[0]?.toLowerCase() ?? "";
  if (server.length === 0) return null;
  return { server, tool: segments.slice(1).join("__").toLowerCase() };
}

/**
 * Decide allow/deny for an MCP tool invocation given the grant list. Pure —
 * exported for unit tests.
 */
export function decideMcp(
  toolName: string,
  grants: string[],
): { allow: boolean; reason?: string } {
  const parsed = parseMcpToolName(toolName);
  if (parsed === null) {
    // Adversarial-review M2 — split the two null cases; only ONE may pass:
    //   (a) name does NOT start with `mcp__` → genuinely not ours to gate
    //       (matcher over-match; the tool has its own confinement via
    //       toolRestrictions/allowlist). Pass through.
    //   (b) name IS in the `mcp__` namespace but unparseable (empty server
    //       segment, e.g. `mcp__` / `mcp____tool`) → we cannot attribute it
    //       to a server, and the namespace is allow-by-default at the
    //       permission layer. Fail CLOSED — never let an unattributable
    //       in-namespace name through.
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      return {
        allow: false,
        reason:
          `[Cortex MCP Guard] Blocked MCP tool "${toolName}": in the ` +
          `mcp__ namespace but not parseable into a (server, tool) pair — ` +
          `denying to stay fail-closed (cortex#2111).`,
      };
    }
    return { allow: true };
  }
  const { server, tool } = parsed;
  const granted =
    grants.includes(MCP_GRANT_ALL) ||
    grants.includes(server) ||
    (tool.length > 0 && grants.includes(`${server}.${tool}`));
  if (granted) return { allow: true };
  return {
    allow: false,
    reason:
      `[Cortex MCP Guard] Blocked MCP tool "${toolName}": server "${server}"` +
      `${tool.length > 0 ? ` / tool "${tool}"` : ""} is not in this ` +
      `session's MCP grant list [${grants.map((g) => `"${g}"`).join(", ")}]. ` +
      `MCP tools are deny-by-default per principal (cortex#2111). Ask the ` +
      `principal to grant \`tool.mcp.${server}\` (whole server) or ` +
      `\`tool.mcp.${server}.${tool || "<tool>"}\` (single tool) on a role ` +
      `this sender holds in policy.roles[].capabilities[].`,
  };
}

/** Emit the pass-through decision (mirrors skill-guard.hook.ts). */
function allow(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent + the Cortex→Discord
 * relay (mirrors skill-guard.hook.ts / bash-guard.hook.ts).
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
 * Read the PreToolUse payload from stdin to EOF, bounded by a hang-stop cap.
 * On the cap firing we throw and the caller fails CLOSED (deny) — never
 * allow. Same posture (and rationale) as skill-guard.hook.ts: `mcp__*` is
 * allow-by-default at the permission layer, so an abandoned read that fell
 * through to `allow()` would run an un-identified MCP tool.
 */
const STDIN_READ_CAP_MS = 5_000;

async function readStdin(): Promise<string> {
  const timedOut = Symbol("timedOut");
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
    throw new Error("mcp-guard: stdin read exceeded cap before EOF");
  }
  return outcome;
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      // Empty payload: we cannot identify the tool, and the namespace is
      // allow-by-default at the permission layer. Fail CLOSED.
      deny(
        "[Cortex MCP Guard] Blocked: empty PreToolUse input — could not " +
          "identify the MCP tool; denying to stay fail-closed.",
      );
      process.exit(2);
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    deny(
      "[Cortex MCP Guard] Blocked: could not parse the PreToolUse input — " +
        "denying to stay fail-closed.",
    );
    process.exit(2);
  }

  const toolName = input.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    // A payload with no tool name: cannot attribute the call. The matcher
    // only fires on mcp__* names, so an unattributable payload here is a
    // capture failure, not a non-MCP call. Fail CLOSED.
    deny(
      "[Cortex MCP Guard] Blocked: PreToolUse input carries no tool_name — " +
        "denying to stay fail-closed.",
    );
    process.exit(2);
  }

  const grants = parseMcpGrantList(process.env.CORTEX_MCP_GRANTS);
  const decision = decideMcp(toolName, grants);

  if (decision.allow) {
    allow();
    return;
  }

  // Write the deny decision FIRST (surfaces the reason), then exit 2 so the
  // block is enforced even by a CLI that ignores structured hook output.
  deny(decision.reason ?? "[Cortex MCP Guard] Blocked.");
  process.exit(2);
}

// Only execute the gate when run AS a script (the production hook path) —
// same import.meta.main guard (and rationale) as skill-guard.hook.ts, so
// unit tests can import the pure helpers without triggering the stdin read.
if (import.meta.main) {
  main().catch(() => {
    // An unexpected failure in the gate must fail CLOSED, not open.
    deny(
      "[Cortex MCP Guard] Blocked: internal hook error — denying to stay " +
        "fail-closed.",
    );
    process.exit(2);
  });
}
