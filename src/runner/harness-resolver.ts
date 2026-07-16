// ---------------------------------------------------------------------------
// Harness selection (API-P0.5, part of #2055 · Phase 0 · Decision D3)
// ---------------------------------------------------------------------------
//
// The single seam that decides WHICH `SessionHarness` a dispatch runs on.
// Extracted verbatim from the inline conditional that used to live at
// `dispatch-listener.ts` (`envelope.distribution_mode === "delegate"
// ? new AgentTeamHarness(...) : new ClaudeCodeHarness(...)`).
//
// **This is a PURE, behaviour-preserving refactor.** Construction of each
// harness is BYTE-IDENTICAL to the pre-extraction call site — the same
// options objects, the same optional-factory spreads, the same factories.
// No new substrate is wired here. It exists so harness choice is a single,
// testable seam rather than a conditional buried in the 2.6k-line runner
// hot-file.
//
// Selection rules:
//   - `delegate` mode                 → `AgentTeamHarness` (multi-agent
//                                        moderator + participants).
//   - any other (ordinary) dispatch   → the receiving agent's configured
//                                        `substrate`, **defaulting to
//                                        `claude-code` when unset** (D3).
//
// The ordinary-dispatch `switch` selects on the receiving agent's configured
// `substrate`, defaulting to `claude-code` when unset. API-P1.3 added the
// `api-agent` case (direct-API harness resolved through the injected
// `InferenceRegistry`); every other substrate value still resolves to
// `ClaudeCodeHarness`, so a claude-code agent (or one with no substrate) behaves
// exactly as the pre-extraction ternary did (all non-delegate dispatches →
// claude-code).

import type { AgentRuntime } from "../common/types/cortex-config";
import type { DistributionMode } from "../bus/myelin/envelope-validator";
import type { SessionHarness } from "../common/substrates/types";
import type { SystemEventSource } from "../bus/system-events";
import {
  ClaudeCodeHarness,
  type CCSessionFactory,
} from "../substrates/claude-code/harness";
import { ApiAgentHarness } from "../substrates/api-agent/harness";
import { InferenceRegistry } from "../common/inference/registry";
import { AgentTeamHarness, type AgentTeamFactory } from "./agent-team";

/**
 * Per-dispatch construction inputs the resolver needs to build a harness.
 *
 * `source` is the per-dispatch envelope source triple; `ccSessionFactory`
 * and `agentTeamFactory` are the listener-level optional test-injection
 * factories (threaded from `DispatchHandlerContext`). All three are passed
 * through verbatim to the harness constructors — see the byte-identical note
 * in the module header.
 *
 * `source` is typed `SystemEventSource` (what the runner holds); the harness
 * opts declare `DispatchEventSource`, but the two alias the same shape in
 * `dispatch-events.ts` — the pre-extraction call site relied on exactly this
 * structural compatibility.
 */
export interface HarnessResolverDeps {
  source: SystemEventSource;
  ccSessionFactory: CCSessionFactory | undefined;
  agentTeamFactory: AgentTeamFactory | undefined;
  /**
   * API-P1.3 — the inference registry the `api-agent` substrate resolves its
   * profile through. Optional so the pre-existing claude-code / delegate call
   * sites and tests construct the resolver unchanged; when an `api-agent`
   * dispatch arrives with no registry wired, the harness is built against an
   * empty registry and fails closed (unknown-profile) at dispatch.
   */
  inferenceRegistry?: InferenceRegistry;
}

/**
 * The harness-selection seam. `resolve` maps a (receiving agent,
 * distribution mode) pair onto the `SessionHarness` that will run the
 * dispatch.
 *
 * `agent` is optional: the receiving agent's `AgentRuntime` is not threaded
 * into the dispatch seam today, so the runner passes `undefined` and the
 * ordinary-dispatch branch falls to the `claude-code` default (D3). API-P1.3
 * threads the real agent through when it wires the `api-agent` substrate.
 */
export interface HarnessResolver {
  resolve(
    agent: AgentRuntime | undefined,
    mode: DistributionMode | undefined,
  ): SessionHarness;
}

/**
 * Default resolver — the behaviour-preserving extraction of the
 * dispatch-listener ternary.
 */
export class DefaultHarnessResolver implements HarnessResolver {
  constructor(private readonly deps: HarnessResolverDeps) {}

  resolve(
    agent: AgentRuntime | undefined,
    mode: DistributionMode | undefined,
  ): SessionHarness {
    if (mode === "delegate") {
      return this.agentTeamHarness();
    }

    // D3 — ordinary dispatch runs on the agent's configured substrate,
    // defaulting to `claude-code` when unset. The `switch` is the seam a
    // future `api-agent` branch (API-P1.3) slots into as a single `case`;
    // today every value lands on `claude-code`, matching the pre-extraction
    // behaviour (all non-delegate dispatches → ClaudeCodeHarness).
    const substrate = agent?.substrate ?? "claude-code";
    switch (substrate) {
      case "api-agent":
        return this.apiAgentHarness(agent);
      case "claude-code":
      default:
        return this.claudeCodeHarness();
    }
  }

  /**
   * API-P1.3 — the direct-API substrate. Reads the receiving agent's
   * `inferenceProfile` (the harness fails closed when it is absent) and resolves
   * it through the injected registry. When no registry was wired, use an empty
   * one so an `api-agent` dispatch fails closed (`unknown-profile`) rather than
   * throwing — the claude-code default path is unaffected.
   */
  private apiAgentHarness(agent: AgentRuntime | undefined): SessionHarness {
    const { source } = this.deps;
    const registry =
      this.deps.inferenceRegistry ??
      new InferenceRegistry({ providers: {}, profiles: {} }, {});
    return new ApiAgentHarness({
      source,
      registry,
      inferenceProfile: agent?.inferenceProfile,
    });
  }

  private agentTeamHarness(): SessionHarness {
    const { source, agentTeamFactory } = this.deps;
    return new AgentTeamHarness({
      source,
      ...(agentTeamFactory !== undefined && { agentTeamFactory }),
    });
  }

  private claudeCodeHarness(): SessionHarness {
    const { source, ccSessionFactory } = this.deps;
    return new ClaudeCodeHarness({
      source,
      ...(ccSessionFactory !== undefined && { ccSessionFactory }),
    });
  }
}
