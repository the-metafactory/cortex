// Integration pin — Claude Code CLI `--plugin-dir` skill semantics.
//
// Part of epic #990 / issue #2151. The `--plugin-dir` mechanism is an EXTERNAL
// dependency on Claude Code CLI behaviour that cortex's reviewer dispatch relies
// on. #990's original production failure was a CC behaviour shift ("skill not
// loaded" at dispatch time). This file pins the observable CLI semantics so the
// NEXT shift fails a test here, not a live reviewer. It intentionally does NOT
// test cortex's own materialiser/guard (unit-tested in #A1/#A2) — only the
// CLI's semantics.
//
// Pinned CC version: 2.1.211 (Claude Code)
// Observed live:     2026-07-17 (Pacific/Auckland); spike re-scope 2026-07-16.
//
// GATE: these spawn the real `claude` binary. Set CLAUDE_BIN to the binary path
// to run them; when CLAUDE_BIN is unset they SKIP (not fail), so CI without the
// binary stays green. This deliberately gates on CLAUDE_BIN rather than the
// repo's `testClaude`/`Bun.which("claude")` helper: issue #2151's verification
// contract requires a skip when CLAUDE_BIN is unset even on a machine that has
// `claude` on $PATH. Verify locally with:
//     CLAUDE_BIN=$(which claude) bun test src/runner/__tests__/cc-plugin-dir-pin.integration.test.ts
//   (without CLAUDE_BIN: every case reports as skipped, none fail)
//
// ── DIVERGENCE FROM ISSUE FACT 2 ("invocable-but-unlisted") ──────────────────
// The issue's fact 2 asserts the plugin skill is invocable but does NOT appear
// in the session's skill listing. That does NOT reproduce on 2.1.211: the plugin
// skill IS surfaced. It appears in the session-init `skills` array (and in
// `slash_commands`) as the NAMESPACED id `cortex-granted:spike-probe`, and the
// model names it when asked to list skills. What IS true — and what the fact-2
// assertion below pins — is that the skill is exposed ONLY under its namespaced
// id, never under the bare skill name `spike-probe`. A bare-name dispatch lookup
// (the #990 failure mode) therefore still misses. The epic should re-verify the
// spike's fact-2 observation against this. See the issue report for detail.
// ────────────────────────────────────────────────────────────────────────────

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim();
/** `test(...)` that skips unless CLAUDE_BIN names a claude binary to exercise. */
const testCC = test.skipIf(!CLAUDE_BIN);

const PLUGIN_NAME = "cortex-granted";
const SKILL_NAME = "spike-probe";
const NAMESPACED = `${PLUGIN_NAME}:${SKILL_NAME}`;
// Fixed, distinctive sentinel the fixture skill is told to emit verbatim.
const SENTINEL = "CORTEX_SPIKE_SENTINEL_7f3a9c";
// Built-in skills observed present under `--setting-sources ""` on 2.1.211.
const EXPECTED_BUILTINS = ["verify", "code-review", "loop"];

/**
 * Build a minimal, valid Claude Code plugin under `root` at runtime:
 * a `.claude-plugin/plugin.json` manifest plus one skill that emits SENTINEL.
 * Built here (not committed) so the fixture can never rot against CC's schema.
 */
function buildPluginFixture(root: string): string {
  const plug = join(root, PLUGIN_NAME);
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plug, "skills", SKILL_NAME), { recursive: true });
  writeFileSync(
    join(plug, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_NAME,
        version: "0.0.1",
        description: "Cortex CC-behaviour pin fixture (built at test runtime; not committed).",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(plug, "skills", SKILL_NAME, "SKILL.md"),
    `---
name: ${SKILL_NAME}
description: Emits a fixed sentinel string. Pins Claude Code --plugin-dir skill invocation semantics.
---

When invoked, output EXACTLY this sentinel and nothing else:

${SENTINEL}
`,
  );
  return plug;
}

async function runClaude(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([CLAUDE_BIN!, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/**
 * Parse a stream-json (newline-delimited) transcript into events. Lines that
 * aren't valid JSON are skipped rather than thrown: if CC ever prints a stray
 * non-NDJSON line (a warning/deprecation banner), a specific pinned assertion
 * should shift, not the whole suite error out of beforeAll.
 */
function parseStreamJson(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue; // non-NDJSON noise on stdout — ignore
    }
  }
  return events;
}

describe("CC --plugin-dir skill semantics (pinned @ 2.1.211)", () => {
  let base = "";
  let pluginDir = "";

  // Captured from ONE slash-invocation stream-json run (keeps this to a single
  // model call): the init event's skill registry + the assistant/result text.
  let initSkills: string[] = [];
  let invocationText = "";

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "cc-plugin-dir-pin-"));
    pluginDir = buildPluginFixture(base);
    if (!CLAUDE_BIN) return; // fixture built for validate-less inspection; no spawns when skipping

    const { stdout } = await runClaude([
      "-p",
      "--setting-sources",
      "",
      "--plugin-dir",
      pluginDir,
      "--model",
      "haiku",
      "--max-turns",
      "2",
      "--output-format",
      "stream-json",
      "--verbose",
      `/${NAMESPACED}`,
    ]);
    const events = parseStreamJson(stdout);

    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    initSkills = (init?.skills as string[] | undefined) ?? [];

    let text = "";
    for (const e of events) {
      if (e.type === "result" && typeof e.result === "string") text += e.result;
      if (e.type === "assistant") {
        const content = (e.message as { content?: { type: string; text?: string }[] } | undefined)
          ?.content;
        for (const c of content ?? []) if (c.type === "text" && c.text) text += c.text;
      }
    }
    invocationText = text;
  }, 120_000);

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  // Fact 1 — slash invocation of the plugin skill EXECUTES (emits the sentinel).
  testCC("slash invocation of the plugin skill returns the sentinel", () => {
    expect(invocationText).toContain(SENTINEL);
  });

  // Fact 2 (reframed to reality; see header divergence note) — the plugin skill
  // is surfaced ONLY under its namespaced id, never the bare skill name.
  testCC("plugin skill is listed namespaced, and the bare skill name is NOT listed", () => {
    expect(initSkills).toContain(NAMESPACED); // surfaced (contra issue fact 2's "unlisted")
    expect(initSkills).not.toContain(SKILL_NAME); // ...but never under the bare name
  });

  // Fact 3 — `--setting-sources ""` still exposes CC BUILT-IN skills
  // ("no setting sources" != "no skills"; #701-relevant). Pinned in both
  // directions: a future add OR drop of built-ins under empty sources is noticed.
  testCC("empty --setting-sources still exposes CC built-in skills", () => {
    for (const b of EXPECTED_BUILTINS) expect(initSkills).toContain(b);
  });

  // `claude plugin validate` exits 0 on the fixture (separate, non-model spawn).
  testCC("claude plugin validate exits 0 on the fixture", async () => {
    const { code } = await runClaude(["plugin", "validate", pluginDir]);
    expect(code).toBe(0);
  }, 60_000);
});
