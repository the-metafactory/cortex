/**
 * API-P1.5 (issue #2065) — Shared provider contract-test suite: THE GUARD.
 *
 * WHAT THIS IS
 * ------------
 * One shared contract suite that every model-provider adapter and the API agent
 * harness must pass, run against recorded fixtures + the local fake streaming
 * HTTP server (`./fake-streaming-server.ts`) — never a live provider, never paid
 * credentials in CI (design §"Verification strategy").
 *
 * Per the plan-breakdown SOP this file is the epic's PROGRESS METER. It lands in
 * Wave 1 (this issue, #2065) with a `test.todo(...)` entry for EVERY case in the
 * design's verification strategy, grouped one `describe` block per gated slice:
 *
 *   - `anthropic`         → converted to live tests by API-P1.1 (issue #2061)
 *   - `openai-compatible` → converted to live tests by API-P1.2 (issue #2062)
 *   - `api-agent-harness` → converted to live tests by API-P1.3 (issue #2063)
 *
 * HOW EACH SLICE FLIPS ITS TODOS (the meter mechanic)
 * ---------------------------------------------------
 * When a gated slice lands it OWNS its `describe` block below. It replaces each
 * `test.todo("…")` string in its block with a live `test("…", async () => { … })`
 * that:
 *   1. imports the now-existing contract types from `src/common/inference/`
 *      (added by API-P0.3 / #2058) and the slice's provider factory;
 *   2. stands up `startFakeStreamingServer()`, enqueues the fixture frames for
 *      the case, points the provider `baseUrl` at `server.url`;
 *   3. drives the provider/harness and asserts the normalized contract outcome.
 * Because the case NAMES are stable, the suite output is a live burndown: every
 * flipped todo is one epic checkbox ticked.
 *
 * SCAFFOLD CONSTRAINT (Wave 1 — READ BEFORE EDITING)
 * --------------------------------------------------
 * This branch is cut from origin/main, which does NOT yet contain
 * `src/common/inference/` — issue #2058 (contract types) lands separately. So on
 * Wave 1 the todos below are PLAIN STRINGS ONLY. They deliberately reference no
 * not-yet-existing type, provider, or symbol; importing one here would break
 * typecheck before the dependency slice merges. `test.todo(name)` registers a
 * pending test that is reported but never executed, so this file performs ZERO
 * network I/O and cannot fail the build. Keep it that way until your slice lands.
 *
 * CASE LIST (design §"Verification strategy")
 * -------------------------------------------
 * The ten provider-contract cases apply to EVERY gated slice (acceptance
 * criterion: "every case present as at least a test.todo for each gated slice").
 * The `api-agent-harness` slice additionally carries the five harness-specific
 * cases. The secret-absence case is a FIRST-CLASS named todo in every slice, not
 * an optional add-on.
 */

import { describe, test } from "bun:test";

/**
 * The ten provider-contract cases from design §"Verification strategy", shared
 * verbatim across all three gated slices. Exported so a landing slice can assert
 * it has covered the full set (and so this list is the single source of truth
 * for the case names the progress meter tracks).
 */
export const PROVIDER_CONTRACT_CASES: readonly string[] = [
  "streams text with a Unicode grapheme split across frame boundaries",
  "reassembles tool-call JSON split across arbitrary chunk boundaries (parser-level)",
  "tolerates unknown / unrecognized event variants without aborting the stream",
  "honors cancellation and both timeout types — wall-clock deadline and inactivity/idle gap",
  "maps authentication (401) responses to the normalized authentication error",
  "maps rate_limit (429) responses to the normalized rate_limit error",
  "maps overloaded (529) responses to the normalized overloaded error",
  "maps unavailable (503) responses to the normalized unavailable error",
  "surfaces an in-stream error that arrives AFTER a committed HTTP 200",
  "fails cleanly on malformed / truncated streams",
  "normalizes usage from a final usage frame",
  "handles a stream that omits the final usage frame (missing usage)",
  "rejects an unsupported_capability request before dispatch",
  "keeps secrets absent from errors, events, snapshots, and logs",
] as const;

/**
 * The five harness-specific cases from design §"Verification strategy" — the
 * lifecycle/fail-closed contract the `ApiAgentHarness` must satisfy on top of
 * the provider-contract cases.
 */
export const HARNESS_CONTRACT_CASES: readonly string[] = [
  "emits exactly one started event per run",
  "emits exactly one terminal event per run",
  "keeps correlation identifiers stable across the run's event stream",
  "shuts down cleanly on request without leaking the provider connection",
  "fails closed on a denied policy / tool grant (no silent tool execution)",
] as const;

/**
 * Register the Wave 1 `test.todo` scaffold for one gated slice.
 *
 * On Wave 1 this emits the case list as pending todos. When the owning slice
 * lands it replaces this call in its `describe` block with live `test(...)`
 * bodies (see "HOW EACH SLICE FLIPS ITS TODOS" above) — the todo names it flips
 * are exactly the strings in {@link PROVIDER_CONTRACT_CASES} (+
 * {@link HARNESS_CONTRACT_CASES} for the harness).
 */
function registerContractTodos(cases: readonly string[]): void {
  for (const name of cases) {
    // Bun's types require a body, but `test.todo` never executes it under a
    // normal `bun test` run (only with the explicit `--todo` flag). The body is
    // a deliberate throw so the case stays a pending todo even under `--todo`
    // (a todo whose body throws remains todo; an empty passing body would be
    // flagged as a todo that "passed unexpectedly"). It references NO
    // not-yet-existing type — the owning slice replaces the whole `test.todo`
    // call with a live `test(...)` when it lands.
    test.todo(name, () => {
      throw new Error(`unimplemented contract case: ${name}`);
    });
  }
}

// ── anthropic ───────────────────────────────────────────────────────────────
// Owned by API-P1.1 (issue #2061 — native Anthropic Messages adapter).
// Flips these todos to live tests against src/providers/anthropic/.
describe("provider contract · anthropic", () => {
  registerContractTodos(PROVIDER_CONTRACT_CASES);
});

// ── openai-compatible ─────────────────────────────────────────────────────────
// Owned by API-P1.2 (issue #2062 — OpenAI-compatible Chat Completions adapter).
// Flips these todos to live tests against src/providers/openai-compatible/.
describe("provider contract · openai-compatible", () => {
  registerContractTodos(PROVIDER_CONTRACT_CASES);
});

// ── api-agent-harness ─────────────────────────────────────────────────────────
// Owned by API-P1.3 (issue #2063 — ApiAgentHarness). Carries the full provider
// contract PLUS the harness-specific lifecycle/fail-closed cases.
// Flips these todos to live tests against src/substrates/api-agent/.
describe("provider contract · api-agent-harness", () => {
  registerContractTodos(PROVIDER_CONTRACT_CASES);
  registerContractTodos(HARNESS_CONTRACT_CASES);
});
