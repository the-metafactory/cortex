/**
 * Review-engine resolution (cortex#917 follow-up).
 *
 * Two orthogonal axes were historically conflated in `runtime.substrate`:
 *   - WHICH review ENGINE runs — the standalone sage lens-CLI (deterministic
 *     pipeline: fixed lens registry + pure `decideVerdict`) vs a Claude-Code
 *     PERSONA session that reads the CodeReview SKILL.md and reviews in-session.
 *   - WHICH LLM BACKEND the engine's calls go through (`claude` | `codex` | `pi`).
 *
 * `substrate === "pi-dev"` used to mean "use the sage runner", so a sage agent
 * configured `substrate: codex` silently fell through to the persona path —
 * "codex" only names a backend, never the engine. This module splits the axes:
 * `runtime.engine` selects the engine; `runtime.substrate` is purely the
 * backend forwarded to `sage review --substrate <backend>`.
 *
 * Pure + deterministic — unit-tested in `review-engine.test.ts`.
 */

export type ReviewEngine = "sage" | "persona";

export interface ResolvedReviewEngine {
  /** sage = standalone lens CLI; persona = Claude-Code session + CodeReview skill. */
  engine: ReviewEngine;
  /**
   * LLM backend the sage CLI runs its lenses through (`sage review --substrate
   * <backend>`). Only meaningful when `engine === "sage"`; informational for
   * persona (the CC session always spawns `claude`).
   */
  backend: "claude" | "codex" | "pi";
}

/** The runtime fields this resolver reads. Structural so it accepts AgentRuntime. */
export interface ReviewEngineInput {
  engine?: ReviewEngine;
  substrate?: string;
}

/**
 * Normalize a (possibly engine-flavored, legacy) substrate value to a sage
 * backend. `pi-dev`→`pi`, `claude-code`→`claude`, `codex`→`codex`. Anything
 * unrecognized (incl. undefined) → `pi` (sage's own default backend).
 */
function normalizeBackend(substrate: string | undefined): ResolvedReviewEngine["backend"] {
  switch (substrate) {
    case "pi":
    case "pi-dev":
      return "pi";
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    default:
      return "pi";
  }
}

/**
 * Resolve `{engine, backend}` from an agent's runtime config.
 *
 * Precedence:
 *   1. Explicit `runtime.engine` wins; `backend` = normalized `substrate`.
 *   2. Legacy (no `engine`): only `substrate === "pi-dev"` selected the sage
 *      runner before, so it maps to `{engine: sage, backend: pi}`. EVERY other
 *      legacy substrate (`claude-code`, `codex`, `cursor`, `custom`, unset)
 *      kept the Claude-Code path → `{engine: persona, …}`. This preserves
 *      pre-split behaviour byte-for-byte for un-migrated configs.
 */
export function resolveReviewEngine(runtime?: ReviewEngineInput): ResolvedReviewEngine {
  if (runtime?.engine === "sage") {
    return { engine: "sage", backend: normalizeBackend(runtime.substrate) };
  }
  if (runtime?.engine === "persona") {
    return { engine: "persona", backend: normalizeBackend(runtime.substrate) };
  }
  // Legacy migration — engine unset.
  if (runtime?.substrate === "pi-dev") {
    return { engine: "sage", backend: "pi" };
  }
  return { engine: "persona", backend: normalizeBackend(runtime?.substrate) };
}
