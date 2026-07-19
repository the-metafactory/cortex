/**
 * cortex#2257 — `makeSubstrateComposeFn` unit tests: the claude-code
 * substrate implementation of the daemon brain host's compose seam, driven
 * through a FAKE `CCSessionFactory` (no `claude` spawn). What is pinned:
 *
 *   - the turn is TOOL-LESS (`--tools ""`), on the CHEAP model
 *     (`--model haiku`), with the persona as the REPLACING system prompt
 *     (`--system-prompt <persona>`), under settings isolation;
 *   - the user turn is intent + fenced untrusted context;
 *   - every failure mode (abort/timeout, non-zero exit, empty output,
 *     factory throw) resolves `{ ok: false }` — never a rejection;
 *   - `composeSubstrateAllowed` excludes exactly the `local-only` ceiling.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPOSE_MODEL,
  COMPOSE_TIMEOUT_MS,
  buildComposePrompt,
  composeSubstrateAllowed,
  makeSubstrateComposeFn,
} from "../brain-compose";
import type { CCSessionOpts, CCSessionResult } from "../cc-session";
import type { CCSessionFactory } from "../../substrates/claude-code/harness";

function fakeFactory(result: Partial<CCSessionResult>): {
  factory: CCSessionFactory;
  seen: CCSessionOpts[];
} {
  const seen: CCSessionOpts[] = [];
  const factory: CCSessionFactory = (opts) => {
    seen.push(opts);
    return {
      start() {
        return this;
      },
      wait: async () => ({
        success: true,
        response: "rendered voice line",
        exitCode: 0,
        durationMs: 10,
        ...result,
      }),
    };
  };
  return { factory, seen };
}

describe("composeSubstrateAllowed (sovereignty ceiling, downgrade-only)", () => {
  test("local-only is excluded; frontier / any / unset are allowed", () => {
    expect(composeSubstrateAllowed("local-only")).toBe(false);
    expect(composeSubstrateAllowed("frontier")).toBe(true);
    expect(composeSubstrateAllowed("any")).toBe(true);
    expect(composeSubstrateAllowed(undefined)).toBe(true);
  });
});

describe("buildComposePrompt", () => {
  test("no context ⇒ the intent alone", () => {
    expect(buildComposePrompt("greet the newcomer")).toBe("greet the newcomer");
    expect(buildComposePrompt("greet the newcomer", "")).toBe("greet the newcomer");
  });

  test("context is fenced and labeled untrusted", () => {
    const p = buildComposePrompt("answer their question", "what is a display name?");
    expect(p).toStartWith("answer their question");
    expect(p).toContain("untrusted");
    expect(p).toContain("<context>\nwhat is a display name?\n</context>");
  });
});

describe("makeSubstrateComposeFn", () => {
  test("runs ONE tool-less cheap-model turn: --model haiku, --tools \"\", --system-prompt <persona>, isolated settings", async () => {
    const { factory, seen } = fakeFactory({});
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });

    const out = await compose({
      persona: "You are the doorkeeper.",
      intent: "greet this newcomer",
      context: "hi, I just arrived",
    });

    expect(out).toEqual({ ok: true, text: "rendered voice line" });
    expect(seen).toHaveLength(1);
    const opts = seen[0]!;
    expect(opts.prompt).toBe(
      buildComposePrompt("greet this newcomer", "hi, I just arrived"),
    );
    expect(opts.settingsIsolation).toBe(true);
    expect(opts.timeoutMs).toBe(COMPOSE_TIMEOUT_MS);
    expect(opts.additionalArgs).toEqual([
      "--model",
      COMPOSE_MODEL,
      "--tools",
      "",
      "--system-prompt",
      "You are the doorkeeper.",
    ]);
  });

  test("the response is trimmed", async () => {
    const { factory } = fakeFactory({ response: "  hello there \n" });
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });
    const out = await compose({ persona: "p", intent: "greet" });
    expect(out).toEqual({ ok: true, text: "hello there" });
  });

  test("an aborted (inactivity-timeout) turn resolves ok:false — never a rejection", async () => {
    const { factory } = fakeFactory({ aborted: true, abortReason: "timeout", success: false });
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });
    const out = await compose({ persona: "p", intent: "greet" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toMatch(/timed out/);
  });

  test("a failed turn (non-zero exit) resolves ok:false with the stderr tail", async () => {
    const { factory } = fakeFactory({
      success: false,
      exitCode: 1,
      response: "",
      stderr: "authentication_failed: token expired",
    });
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });
    const out = await compose({ persona: "p", intent: "greet" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.detail).toMatch(/exit 1/);
      expect(out.detail).toMatch(/authentication_failed/);
    }
  });

  test("an empty response resolves ok:false", async () => {
    const { factory } = fakeFactory({ response: "   \n" });
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });
    const out = await compose({ persona: "p", intent: "greet" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toMatch(/empty/);
  });

  test("a THROWING factory is contained to ok:false", async () => {
    const factory: CCSessionFactory = () => {
      throw new Error("claude binary missing");
    };
    const compose = makeSubstrateComposeFn({ agentId: "escort", ccSessionFactory: factory });
    const out = await compose({ persona: "p", intent: "greet" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toMatch(/claude binary missing/);
  });
});
