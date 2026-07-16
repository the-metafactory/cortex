/**
 * Tests for the Cortex MCP Guard PreToolUse hook (cortex#2111).
 *
 * Two layers, mirroring skill-guard.hook.test.ts:
 *   - PURE logic (parseMcpGrantList / parseMcpToolName / decideMcp) — the
 *     name-parsing + allow/deny decision, exercised directly.
 *   - PROCESS behaviour — spawn the hook with a PreToolUse payload on stdin
 *     and assert the exit code + stdout decision:
 *       * granted server/tool → exit 0, {"continue":true}
 *       * un-granted mcp__* tool → exit 2, structured PreToolUse deny
 *       * no/empty/malformed grant list → deny (fail-closed)
 *       * empty/malformed payload → deny (fail-closed)
 *       * non-mcp tool name → pass-through allow (not this hook's namespace)
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  parseMcpGrantList,
  parseMcpToolName,
  decideMcp,
  MCP_GRANT_ALL,
} from "../mcp-guard.hook";

const HOOK_PATH = join(import.meta.dir, "..", "mcp-guard.hook.ts");

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
    if (v !== undefined && k !== "CORTEX_MCP_GRANTS") merged[k] = v;
  }
  if (grants !== undefined) merged.CORTEX_MCP_GRANTS = grants;

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

describe("parseMcpGrantList — fail-closed parsing", () => {
  test("parses a JSON array of grant patterns", () => {
    expect(parseMcpGrantList('["gdrive","jira.search_issues"]')).toEqual([
      "gdrive",
      "jira.search_issues",
    ]);
  });

  test("undefined env → empty (deny-all)", () => {
    expect(parseMcpGrantList(undefined)).toEqual([]);
  });

  test("empty string → empty (deny-all)", () => {
    expect(parseMcpGrantList("")).toEqual([]);
  });

  test("malformed JSON → empty (deny-all, never widens access)", () => {
    expect(parseMcpGrantList("not json")).toEqual([]);
  });

  test("non-array JSON → empty (deny-all)", () => {
    expect(parseMcpGrantList('{"server":"gdrive"}')).toEqual([]);
    expect(parseMcpGrantList('"gdrive"')).toEqual([]);
  });

  test("filters non-string members", () => {
    expect(parseMcpGrantList('["gdrive",42,null,"*"]')).toEqual(["gdrive", "*"]);
  });
});

describe("parseMcpToolName — (server, tool) split", () => {
  test("splits mcp__<server>__<tool>", () => {
    expect(parseMcpToolName("mcp__gdrive__read_file")).toEqual({
      server: "gdrive",
      tool: "read_file",
    });
  });

  test("lowercases both segments", () => {
    expect(parseMcpToolName("mcp__Claude_ai_Google_Drive__ReadFile")).toEqual({
      server: "claude_ai_google_drive",
      tool: "readfile",
    });
  });

  test("preserves a double underscore INSIDE the tool name", () => {
    expect(parseMcpToolName("mcp__srv__ns__op")).toEqual({
      server: "srv",
      tool: "ns__op",
    });
  });

  test("server-only name (no tool segment) parses with empty tool", () => {
    expect(parseMcpToolName("mcp__gdrive")).toEqual({ server: "gdrive", tool: "" });
  });

  test("non-mcp tool → null", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("Read")).toBeNull();
  });

  test("bare prefix / empty server → null", () => {
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp____tool")).toBeNull();
  });
});

describe("decideMcp — allow/deny decision", () => {
  test("wildcard grant allows any mcp tool", () => {
    expect(decideMcp("mcp__gdrive__read_file", [MCP_GRANT_ALL]).allow).toBe(true);
    expect(decideMcp("mcp__anything__at_all", ["*"]).allow).toBe(true);
  });

  test("server grant allows every tool of that server only", () => {
    expect(decideMcp("mcp__gdrive__read_file", ["gdrive"]).allow).toBe(true);
    expect(decideMcp("mcp__gdrive__delete_file", ["gdrive"]).allow).toBe(true);
    expect(decideMcp("mcp__jira__search", ["gdrive"]).allow).toBe(false);
  });

  test("tool grant allows exactly that tool", () => {
    const grants = ["jira.search_issues"];
    expect(decideMcp("mcp__jira__search_issues", grants).allow).toBe(true);
    expect(decideMcp("mcp__jira__create_issue", grants).allow).toBe(false);
    expect(decideMcp("mcp__gdrive__search_issues", grants).allow).toBe(false);
  });

  test("matching is case-insensitive on the tool-name side", () => {
    expect(decideMcp("mcp__GDrive__Read_File", ["gdrive.read_file"]).allow).toBe(true);
  });

  test("empty grants deny every mcp tool (deny-by-default)", () => {
    const d = decideMcp("mcp__gdrive__read_file", []);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("mcp__gdrive__read_file");
    expect(d.reason).toContain("tool.mcp.gdrive");
  });

  test("non-mcp tool passes through (not this hook's namespace)", () => {
    expect(decideMcp("Bash", []).allow).toBe(true);
    expect(decideMcp("Read", []).allow).toBe(true);
  });

  test("M2: in-namespace but UNPARSEABLE names are DENIED even with a wildcard grant", () => {
    // `mcp__` / `mcp____tool` parse to null but sit inside the namespace the
    // matcher fired on — unattributable ⇒ fail-closed, never pass-through.
    expect(decideMcp("mcp__", ["*"]).allow).toBe(false);
    expect(decideMcp("mcp____tool", ["*"]).allow).toBe(false);
    expect(decideMcp("mcp__", []).allow).toBe(false);
  });

  test("server-only invocation is allowed by server grant, denied otherwise", () => {
    expect(decideMcp("mcp__gdrive", ["gdrive"]).allow).toBe(true);
    expect(decideMcp("mcp__gdrive", ["jira"]).allow).toBe(false);
    // An empty tool segment must NOT match a `server.` pattern.
    expect(decideMcp("mcp__gdrive", ["gdrive."]).allow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Process behaviour
// ---------------------------------------------------------------------------

describe("mcp-guard hook process — enforcement", () => {
  test("granted server → exit 0 + continue", () => {
    const r = runHook({ tool_name: "mcp__gdrive__read_file" }, '["gdrive"]');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ continue: true });
  });

  test("wildcard grant → exit 0 + continue", () => {
    const r = runHook({ tool_name: "mcp__anything__tool" }, '["*"]');
    expect(r.status).toBe(0);
  });

  test("un-granted server → exit 2 + structured deny", () => {
    const r = runHook({ tool_name: "mcp__jira__search" }, '["gdrive"]');
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("mcp__jira__search");
  });

  test("no grant env → deny-all (fail-closed)", () => {
    const r = runHook({ tool_name: "mcp__gdrive__read_file" }, undefined);
    expect(r.status).toBe(2);
  });

  test("empty grant list → deny-all", () => {
    const r = runHook({ tool_name: "mcp__gdrive__read_file" }, "[]");
    expect(r.status).toBe(2);
  });

  test("malformed grant env → deny-all (fail-closed)", () => {
    const r = runHook({ tool_name: "mcp__gdrive__read_file" }, "not json");
    expect(r.status).toBe(2);
  });

  test("empty stdin payload → deny (fail-closed)", () => {
    const r = runHook("", '["*"]');
    expect(r.status).toBe(2);
  });

  test("malformed stdin payload → deny (fail-closed)", () => {
    const r = runHook("{not json", '["*"]');
    expect(r.status).toBe(2);
  });

  test("payload without tool_name → deny (fail-closed)", () => {
    const r = runHook({ session_id: "s1" }, '["*"]');
    expect(r.status).toBe(2);
  });

  test("non-mcp tool name → pass-through allow", () => {
    const r = runHook({ tool_name: "Bash" }, "[]");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ continue: true });
  });
});
