/**
 * Review-engine resolution (cortex#917).
 *
 * Two orthogonal axes were historically conflated in `runtime.substrate`:
 *   - WHICH review ENGINE runs — the standalone sage lens-CLI (deterministic
 *     pipeline: fixed lens registry + pure `decideVerdict`) vs a Claude-Code
 *     PERSONA session that reads the CodeReview SKILL.md and reviews in-session.
 *   - WHICH LLM the sage engine runs its lenses through (`claude` | `codex` | `pi`).
 *
 * `substrate === "pi-dev"` used to mean "use the sage runner", so a sage agent
 * configured `substrate: codex` silently fell through to the assistant path —
 * "codex" only names a harness, never the engine. This module splits the axes:
 * `runtime.engine` selects the engine; `runtime.model` is the LLM the sage CLI
 * runs lenses through (forwarded to `sage review --substrate <model>`);
 * `runtime.substrate` stays the M6 harness (CONTEXT.md).
 *
 * Pure + deterministic — unit-tested in `review-engine.test.ts`.
 */

export type ReviewEngine = "sage" | "assistant";
export type SageModel = "claude" | "codex" | "pi";

export interface ResolvedReviewEngine {
  /** sage = standalone lens CLI; assistant = Claude-Code session + CodeReview skill. */
  engine: ReviewEngine;
  /**
   * The LLM the sage CLI runs its lenses through (`sage review --substrate
   * <model>`). `undefined` ⇒ the sage runner applies its own default
   * (`SAGE_SUBSTRATE` env, else `pi`). Only meaningful for `engine === "sage"`.
   */
  model?: SageModel;
}

/** The runtime fields this resolver reads. Structural so it accepts AgentRuntime. */
export interface ReviewEngineInput {
  engine?: ReviewEngine;
  model?: SageModel;
  substrate?: string;
}

/**
 * Resolve `{engine, model}` from an agent's runtime config.
 *
 * Precedence:
 *   1. Explicit `runtime.engine` wins. For sage, `model` is the (already
 *      zod-validated) `runtime.model`; `undefined` defers to the runner default.
 *   2. Legacy (no `engine`): only `substrate === "pi-dev"` selected the sage
 *      runner before, so it maps to `{engine: sage}` with NO model (runner uses SAGE_SUBSTRATE env, else pi — true parity); legacy
 *      backend). EVERY other legacy substrate (`claude-code`, `codex`, `cursor`,
 *      `custom`, unset) kept the Claude-Code path → `{engine: assistant}`. This
 *      preserves pre-split ROUTING for un-migrated configs — the resolved
 *      engine string is `assistant` (renamed from `persona` in cortex#921), so
 *      it is routing-equivalent, not byte-identical, to the pre-split value.
 *
 * No coercion of unknown values — `model` is constrained to `SageModel` by the
 * schema's `z.enum`, so an unsupported LLM is rejected at config load rather
 * than silently falling open here.
 */
export function resolveReviewEngine(runtime?: ReviewEngineInput): ResolvedReviewEngine {
  if (runtime?.engine === "sage") {
    return runtime.model !== undefined
      ? { engine: "sage", model: runtime.model }
      : { engine: "sage" };
  }
  if (runtime?.engine === "assistant") {
    return { engine: "assistant" };
  }
  // Legacy migration — engine unset. NO `model`: the runner falls back to
  // SAGE_SUBSTRATE env (else pi), exactly as pre-split `makePiDevPipelineRunner({})`
  // did, so an un-migrated `substrate: pi-dev` config keeps honouring a
  // `SAGE_SUBSTRATE=claude|codex` override (true parity, not forced-pi).
  if (runtime?.substrate === "pi-dev") {
    return { engine: "sage" };
  }
  return { engine: "assistant" };
}
