/**
 * cortex#2195 — the model-placement EXECUTE gate (RFC-0005 §2.5 consumer half).
 *
 * myelin#260 / PR #265 shipped the PRODUCER half: it rejects the unsatisfiable
 * `frontier_ok:false` + `model_class:"frontier"` combo and exports the advisory
 * `parseSovereignty` reader (`canReachFrontier`). But nothing ENFORCED placement
 * at execution — no execute path lives in myelin. This gate is that enforcement:
 * at cortex's dispatch/execute decision point it refuses (`policy_denied`/term,
 * the RFC-0010 permanent shape) any dispatch whose SELECTED harness would run a
 * local-only-required envelope on a frontier model.
 *
 * ## Placement class — config-declared, fail-closed on unknown
 *
 * The map from a selected harness id to its placement class (`frontier` vs
 * `local`) is CONFIG-DECLARED (`execution.model_placement`). There is NO
 * hardcoded model list — the only built-in is the fail-closed default: a harness
 * id ABSENT from the map is treated as `frontier` (the unsafe direction), so a
 * local-only envelope never silently runs on an unclassified harness. Declaring
 * a harness `local` is an explicit, auditable config act.
 *
 * ## The rule (RFC-0005 §2.5, via the myelin reader)
 *
 *   - `local` placement → ALWAYS allowed: a local model cannot leak a local-only
 *     payload to a frontier model.
 *   - `frontier` placement → allowed ONLY when the envelope clears frontier
 *     (`parseSovereignty(env).canReachFrontier`, i.e. `frontier_ok &&
 *     model_class !== "local-only"`). Otherwise REFUSED.
 *
 * The reader is imported from the `@the-metafactory/myelin` package (the pinned
 * dep exports it) — NOT re-vendored (the drift class this epic kills).
 */

import { parseSovereignty } from "@the-metafactory/myelin";

/** A selected harness's execution placement. */
export type PlacementClass = "frontier" | "local";

/**
 * `execution.model_placement` — the config-declared harness→placement map. Inert
 * when absent (the gate is skipped; byte-identical dispatch).
 */
export interface ModelPlacementConfig {
  /**
   * Selected-harness id (`SessionHarness.id`: `claude-code` / `api-agent` /
   * `agent-team`, …) → placement class. Config-declared; no hardcoded models.
   */
  readonly harnesses: Readonly<Record<string, PlacementClass>>;
  /**
   * Placement for a harness id ABSENT from `harnesses`. FAIL-CLOSED: defaults to
   * `frontier` so an unclassified harness cannot run a local-only envelope.
   */
  readonly default?: PlacementClass;
}

/** The sovereignty fields the myelin `parseSovereignty` reader consumes. */
export interface PlacementSovereignty {
  readonly classification: string;
  readonly data_residency: string;
  readonly max_hop: number;
  readonly frontier_ok: boolean;
  readonly model_class: string;
}

/** The minimal envelope shape the gate needs — only `.sovereignty` is read (via
 * the myelin reader). Structural so the gate is unit-testable without a full
 * signed envelope, and so cortex's `Envelope` (which structurally carries a
 * richer, but compatible, sovereignty block) passes without a call-site cast —
 * the vendored-vs-package envelope-type drift this epic ultimately kills. */
interface PlacementEnvelope {
  readonly sovereignty: PlacementSovereignty;
}

export type ModelPlacementDecision =
  | { readonly allow: true; readonly placement: PlacementClass }
  | {
      readonly allow: false;
      readonly placement: PlacementClass;
      /** Operator-facing explanation for the `policy_denied` refusal. */
      readonly detail: string;
    };

/** Resolve a selected harness id to its placement class (fail-closed on
 * unknown → `frontier`). */
export function resolvePlacementClass(
  harnessId: string,
  config: ModelPlacementConfig,
): PlacementClass {
  return config.harnesses[harnessId] ?? config.default ?? "frontier";
}

/**
 * Evaluate whether the SELECTED harness may execute this envelope under
 * RFC-0005 §2.5. Never throws.
 *
 * @param envelope  the dispatch envelope (only `.sovereignty` is read, via the
 *   myelin `parseSovereignty` reader).
 * @param harnessId the resolved `SessionHarness.id` about to run the dispatch.
 * @param config    the config-declared placement map.
 */
export function evaluateModelPlacement(
  envelope: PlacementEnvelope,
  harnessId: string,
  config: ModelPlacementConfig,
): ModelPlacementDecision {
  const placement = resolvePlacementClass(harnessId, config);
  if (placement === "local") {
    // A local placement cannot leak a local-only payload to a frontier model.
    return { allow: true, placement };
  }
  // Frontier placement — permitted only if the envelope clears frontier. The
  // reader reads only `.sovereignty`; cast bridges the structural
  // `PlacementEnvelope` to the package's `MyelinEnvelope` param (safe — the
  // sovereignty fields are identical).
  const { canReachFrontier } = parseSovereignty(
    envelope as unknown as Parameters<typeof parseSovereignty>[0],
  );
  if (canReachFrontier) return { allow: true, placement };
  return {
    allow: false,
    placement,
    detail:
      `harness "${harnessId}" is frontier-placement but the envelope demands ` +
      `local execution (RFC-0005 §2.5: frontier_ok/model_class) — refusing`,
  };
}
