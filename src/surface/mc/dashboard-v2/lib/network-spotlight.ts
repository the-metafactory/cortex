/**
 * G-1114.D.5 — Network spotlight search (pure match/rank + key helpers).
 *
 * The spotlight (Cmd+K / Ctrl+K on the Network tab) lets a principal find an
 * agent by assistant name / agent id / capability and SELECT its node — reusing
 * D.4's selection path (set `selectedKey` → opens the detail panel). The
 * overlay itself reuses the MC-base `CommandPalette` component; this module is
 * the pure brain behind it:
 *
 *   - `searchAgents(agents, query)` → a ranked list of `SpotlightHit`s. Pure, so
 *     it's unit-tested without a DOM (the D.1-4 pure/wrapper split).
 *   - `isSpotlightOpenChord(e)` → the Cmd+K / Ctrl+K predicate, testable as a
 *     plain function so the keyboard wiring stays a thin effect.
 *
 * Matching is a case-insensitive substring over {display name, agent id,
 * capabilities}. Ranking biases toward the most "this is the agent I meant"
 * signal: an exact id/name match, then a name/id PREFIX match, then any other
 * substring hit (capability or mid-string). Ties keep snapshot order (stable).
 *
 * ADR-0007: a hit carries presence + identity + capabilities only — never any
 * session interior (the source tile has none anyway).
 */

import type { AgentPresenceTile } from "../hooks/use-agents";

/** One spotlight result row — identity + presence + capabilities, nothing else. */
export interface SpotlightHit {
  /** Stable registry key (`{principal}/{stack}/{agent_id}`) — the selection key. */
  key: string;
  /** Logical agent id. */
  agentId: string;
  /** Assistant name, or the agent id when no name is declared. */
  displayName: string;
  /** Liveness, for the row's state dot. */
  state: "online" | "offline";
  /** Declared capabilities, for the row's subtitle. */
  capabilities: readonly string[];
}

/** Rank buckets (lower = better). Within a bucket, snapshot order is kept. */
const RANK_EXACT = 0;
const RANK_PREFIX = 1;
const RANK_SUBSTRING = 2;

interface RankedHit {
  hit: SpotlightHit;
  rank: number;
  order: number;
}

function toHit(a: AgentPresenceTile): SpotlightHit {
  return {
    key: a.key,
    agentId: a.agent_id,
    displayName: a.assistant_name ?? a.agent_id,
    state: a.state,
    capabilities: a.capabilities,
  };
}

/**
 * Search the agents snapshot for `query`, returning the matching agents ranked
 * best-first.
 *
 * - **Empty / whitespace query →** every agent, in snapshot order (the spotlight
 *   opens showing the full list to pick from).
 * - **Non-empty →** case-insensitive substring over {display name, agent id,
 *   capabilities}; ranked exact → name/id-prefix → other-substring; ties keep
 *   snapshot order.
 *
 * Pure: no DOM, no mutation of the input.
 */
export function searchAgents(
  agents: readonly AgentPresenceTile[],
  query: string,
): SpotlightHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return agents.map(toHit);

  const ranked: RankedHit[] = [];
  agents.forEach((a, order) => {
    const hit = toHit(a);
    const name = hit.displayName.toLowerCase();
    const id = hit.agentId.toLowerCase();
    const caps = hit.capabilities.map((c) => c.toLowerCase());

    const inName = name.includes(q);
    const inId = id.includes(q);
    const inCap = caps.some((c) => c.includes(q));
    if (!inName && !inId && !inCap) return;

    let rank = RANK_SUBSTRING;
    if (name === q || id === q) {
      rank = RANK_EXACT;
    } else if (name.startsWith(q) || id.startsWith(q)) {
      rank = RANK_PREFIX;
    }
    ranked.push({ hit, rank, order });
  });

  ranked.sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.order - y.order));
  return ranked.map((r) => r.hit);
}

/** The minimal keyboard-event shape `isSpotlightOpenChord` needs (testable). */
export interface ChordEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}

/**
 * True when the event is the spotlight-open chord: Cmd+K (mac) or Ctrl+K
 * (everywhere). Case-insensitive on the key. Extracted as a pure predicate so
 * the network-view keyboard effect is a one-line delegation.
 */
export function isSpotlightOpenChord(e: ChordEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}
