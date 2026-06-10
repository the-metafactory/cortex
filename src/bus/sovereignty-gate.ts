/**
 * Consumer-side sovereignty gate (governance Stage 1b).
 *
 * The envelope DECLARES `model_class` / `frontier_ok`; until something refuses
 * a claim that violates it, the declaration is documentation. Today the only
 * "I am a frontier model, this task is local-only, therefore I refuse" logic
 * lives in demo fleet simulators — voluntary, application-layer. This gate
 * makes the refusal mandatory at the consumer, before the reviewer spawns.
 *
 * Pure decision core, fail-closed (mirrors the pulse enforcement gate and
 * Magnús Smárason's enforcement-gate SPEC.md invariants): an agent whose model
 * class cannot be proven compliant is DENIED, never waved through.
 *
 * Scope boundary: this gate guards the data-sovereignty breach — confidential
 * payload reaching a frontier model. It is NOT a capability-match check (that
 * is the dispatcher's job) and NOT the cross-principal `peers[]` gate (that
 * guards the requester). It composes alongside both.
 */

/**
 * Sovereignty requirement carried on the inbound envelope.
 *
 * Both fields are OPTIONAL here, deliberately looser than the canonical
 * `Envelope["sovereignty"]` (where both are required): the gate is a pure
 * function callable from outside the envelope pipeline (tests, future bus
 * sources that haven't stamped a full block). The fail-closed logic below
 * treats a missing field conservatively, so the loosening never opens a hole.
 */
export interface EnvelopeSovereignty {
  model_class?: "local-only" | "frontier" | "any";
  frontier_ok?: boolean;
}

/** The executing agent's own model class — what kind of model it actually runs. */
export type AgentModelClass = "local-only" | "frontier" | "any";

export interface SovereigntyDecision {
  decision: "allow" | "deny";
  reason: string;
}

/**
 * Decide whether an agent of `agentClass` may execute a task carrying
 * `sovereignty`. Fail-closed: a missing/unknown agent class, or a missing
 * sovereignty block, denies.
 *
 * The breach guarded: a task that demands a local model must NOT be executed
 * by a frontier-capable agent (class "frontier" or "any"). A task "demands
 * local" when model_class is "local-only" OR frontier_ok is anything other
 * than an explicit `true` — i.e. a MISSING frontier_ok is treated as "not
 * cleared for frontier" (fail closed), not "frontier is fine". On a real
 * Envelope frontier_ok is required so this only bites callers outside the
 * pipeline; the conservative default keeps the gate safe for them too.
 * Everything the demand explicitly permits is allowed.
 */
export function evaluateSovereignty(
  sovereignty: EnvelopeSovereignty | null | undefined,
  agentClass: AgentModelClass | undefined,
): SovereigntyDecision {
  // Fail closed: an agent that can't prove its class can't prove compliance.
  if (agentClass !== "local-only" && agentClass !== "frontier" && agentClass !== "any") {
    return { decision: "deny", reason: `agent model class missing or unknown (got ${String(agentClass)}) — failing closed` };
  }
  // Fail closed: an envelope with no sovereignty block carries no permission to read.
  if (!sovereignty || typeof sovereignty !== "object") {
    return { decision: "deny", reason: "envelope carries no sovereignty block — failing closed" };
  }

  // frontier_ok !== true (not just === false) so a MISSING frontier_ok also
  // demands local — fail closed for callers that omit the field.
  const demandsLocal = sovereignty.model_class === "local-only" || sovereignty.frontier_ok !== true;

  if (demandsLocal && (agentClass === "frontier" || agentClass === "any")) {
    return {
      decision: "deny",
      reason:
        `sovereignty violation: task requires a local model ` +
        `(model_class=${sovereignty.model_class ?? "?"}, frontier_ok=${sovereignty.frontier_ok ?? "?"}) ` +
        `but agent model class is '${agentClass}'`,
    };
  }

  // A local-only agent may always execute (it cannot leak to a frontier model);
  // a frontier/any agent may execute anything the demand does not restrict.
  return { decision: "allow", reason: "agent model class satisfies the task sovereignty demand" };
}
