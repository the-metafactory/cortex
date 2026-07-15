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
// The ordinary-dispatch `switch` is deliberately structured so a future
// `api-agent` substrate (API-P1.3) is a ONE-LINE addition — a new `case`
// alongside `claude-code`. Do NOT add `api-agent` here (out of scope for
// P0.5); today every substrate value resolves to `ClaudeCodeHarness`,
// exactly as the pre-extraction ternary did (it never consulted the
// substrate at all — all non-delegate dispatches went to claude-code).

import type { AgentRuntime } from "../common/types/cortex-config";
import type { DistributionMode } from "../bus/myelin/envelope-validator";
import type { SessionHarness } from "../common/substrates/types";
import type { SystemEventSource } from "../bus/system-events";
import {
  ClaudeCodeHarness,
  type CCSessionFactory,
} from "../substrates/claude-code/harness";
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
      // API-P1.3 will add: case "api-agent": return this.apiAgentHarness();
      case "claude-code":
      default:
        return this.claudeCodeHarness();
    }
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
