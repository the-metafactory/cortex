/**
 * S2 (cortex#1160) — which agents earn a builtin chat dispatch listener.
 *
 * The builtin chat path (`createDispatchListener`) consumes
 * `tasks.@{agent}.chat` envelopes and spawns a CC session. An agent earns one
 * of these listeners iff it is reachable on a human-facing surface AND it runs
 * the builtin (in-process `claude-code`) brain:
 *
 *   - It has an ENABLED platform `presence` (discord / mattermost / slack) —
 *     the surface a human @-mentions it on. A headless agent (`presence: {}`,
 *     or every block `enabled: false`) is a bus-only worker; it runs CC via the
 *     dispatch-listener but is never @-mentioned, so no chat dispatch arrives.
 *   - It is NOT an exec-brain agent. An agent whose `runtime.brain.kind ===
 *     "exec"` is hosted by a `BrainConsumer` for its declared capabilities; its
 *     inbound @-mention becomes a `…brain.{capability}` bus task, NOT a
 *     `tasks.@{agent}.chat` envelope (design-bot-packs §6 — "instead of, not in
 *     addition to").
 *
 * Pure + side-effect-free so `cortex.ts` boot and tests share ONE rule (the
 * cortex#1033 §Maintainability single-predicate pattern the `brainAgents` /
 * `reviewCapableAgents` filters already follow).
 */
import type { Agent } from "../common/types/cortex-config";

/** True when a presence block exists and is not explicitly disabled. */
function isEnabledPresence(
  block: { enabled?: boolean } | undefined,
): boolean {
  return block !== undefined && block.enabled !== false;
}

/**
 * True when `agent` has at least one ENABLED platform presence — the criterion
 * for being @-mentionable on a surface, mirroring the adapter loop's
 * `if (!instance.enabled) continue` skip.
 */
export function hasEnabledPresence(agent: Agent): boolean {
  const p = agent.presence;
  return (
    isEnabledPresence(p.discord)
    || isEnabledPresence(p.mattermost)
    || isEnabledPresence(p.slack)
  );
}

/**
 * Filter `agents` down to the ones that earn a builtin chat dispatch listener:
 * an enabled platform presence AND a builtin (non-exec) brain.
 *
 * @param agents     the merged registry (inline ∪ agents.d fragments).
 * @param isExecBrain predicate identifying exec-brain agents (hosted by a
 *                    `BrainConsumer`, not the builtin chat path). Injected so
 *                    the boot path and tests use the SAME definition the rest of
 *                    `cortex.ts` uses, with no import cycle.
 */
export function chatCapableAgents(
  agents: readonly Agent[],
  isExecBrain: (a: Agent) => boolean,
): Agent[] {
  return agents.filter((a) => !isExecBrain(a) && hasEnabledPresence(a));
}
