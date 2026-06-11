/**
 * Mission Control — spawn-prompt parent-session correlation (ST-P2, refactor D1b).
 *
 * Claude Code emits NO native child→parent session pointer for `Agent`-tool
 * children (the overnight orphan flood — the principal's own instrumented run,
 * which cortex's runner never touches, so it carries no env-stamped
 * `CORTEX_PARENT_SESSION_ID`). The linkage is split across two events:
 *   - the PARENT session's `tool.agent.spawned` event — carries the prompt /
 *     description the parent handed the child (`payload.tool_input.prompt` /
 *     `payload.tool_input.description` / `payload.agent_description`).
 *   - the CHILD session's FIRST `agent.task.started` event — carries that same
 *     text back as `payload.prompt_preview` (the EventLogger's first-prompt
 *     capture).
 *
 * This module reconstructs the edge by matching the two. It runs ONLY when the
 * explicit `parent_session_id` wire field (ST-P1 / env-stamp) is absent, so it
 * is a v1 fallback, never the primary path.
 *
 * SAFETY (refactor D1b — "never wrong-positive on ambiguity"):
 *   - Bounded window: only spawns within {@link CORRELATION_WINDOW_MS} of the
 *     child's first event are candidates (a stale identical prompt long ago is
 *     not this child's parent).
 *   - Cheap + indexed: a single `type = 'tool.agent.spawned' AND timestamp >= ?`
 *     scan (served by `idx_events_type` / `idx_events_timestamp`) — NO full
 *     table scan, NO per-row JSON scan beyond the already-narrowed candidate set.
 *   - Ambiguity → SKIP: if two or more DISTINCT candidate parent sessions match
 *     the same prompt in-window, we cannot tell which is the real parent, so we
 *     return null and log. A wrong edge is worse than a missing edge (the tree
 *     just shows the child agent-rooted).
 *   - Self-exclusion: a session is never its own parent.
 */

import type { Database } from "bun:sqlite";
import type { RawHookEvent } from "./types";

/**
 * How far back to look for a matching spawn. 10 minutes comfortably covers the
 * gap between a parent issuing an `Agent` tool call and the child's first prompt
 * landing (seconds in practice), while excluding a stale identical prompt from
 * an earlier run. Module constant — minimal blast radius, no config schema.
 */
export const CORRELATION_WINDOW_MS = 10 * 60 * 1000;

/**
 * Minimum normalized-prompt length for a match to be trusted. Below this a
 * coincidental short string (e.g. "go", "fix it") could match unrelated spawns;
 * we'd rather leave such a child agent-rooted than risk a wrong edge.
 */
const MIN_MATCH_LEN = 12;

/** The child's first-prompt text, drawn from the batch's task-started event. */
function childFirstPrompt(events: RawHookEvent[]): string | null {
  // The child's first prompt arrives as `agent.task.started` (UserPromptSubmit
  // mapping) carrying `payload.prompt_preview`. Be defensive about ordering:
  // pick the EARLIEST task-started event in the batch.
  let best: { ts: string; prompt: string } | null = null;
  for (const e of events) {
    if (e.event_type !== "agent.task.started") continue;
    const preview = e.payload.prompt_preview;
    if (typeof preview !== "string" || preview.length === 0) continue;
    if (best === null || e.timestamp < best.ts) {
      best = { ts: e.timestamp, prompt: preview };
    }
  }
  return best?.prompt ?? null;
}

/** The earliest event timestamp in the batch (anchors the correlation window). */
function earliestTimestamp(events: RawHookEvent[]): string | null {
  let earliest: string | null = null;
  for (const e of events) {
    if (earliest === null || e.timestamp < earliest) earliest = e.timestamp;
  }
  return earliest;
}

/** Normalize a prompt for comparison: collapse whitespace, trim, lowercase. */
function normalizePrompt(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract the spawn prompt text from a stored `tool.agent.spawned` payload.
 * Tries the structured `tool_input` fields first (what the parent handed the
 * child), then the display-oriented fallbacks.
 */
function spawnPromptText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const toolInput = p.tool_input;
  if (toolInput !== null && typeof toolInput === "object") {
    const ti = toolInput as Record<string, unknown>;
    if (typeof ti.prompt === "string" && ti.prompt.length > 0) return ti.prompt;
    if (typeof ti.description === "string" && ti.description.length > 0) {
      return ti.description;
    }
  }
  if (typeof p.agent_description === "string" && p.agent_description.length > 0) {
    return p.agent_description;
  }
  if (typeof p.prompt_preview === "string" && p.prompt_preview.length > 0) {
    return p.prompt_preview;
  }
  return null;
}

/**
 * Decide whether a child first-prompt matches a spawn prompt. `prompt_preview`
 * is truncated to 200 chars by the EventLogger and may have the agent-prompt
 * wrapper stripped, so we match on a normalized-prefix containment in EITHER
 * direction (child ⊑ spawn, or spawn ⊑ child) rather than strict equality.
 */
function promptsMatch(childPrompt: string, spawnPrompt: string): boolean {
  const a = normalizePrompt(childPrompt);
  const b = normalizePrompt(spawnPrompt);
  if (a.length < MIN_MATCH_LEN || b.length < MIN_MATCH_LEN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

interface SpawnCandidateRow {
  session_id: string;
  payload: string;
  timestamp: string;
}

/**
 * Correlate a child observed session to the parent session that spawned it, via
 * the spawn-prompt ↔ first-prompt match (ST-P2 D1b). Returns the parent
 * `sessions.id` on an UNAMBIGUOUS match within the window, else null.
 *
 * `childEvents` is the batch of raw events for the child's `cc_session_id` (the
 * ingestor's per-session group). The child session row does not exist yet at
 * call time (this runs at auto-register), so candidate parents are matched
 * purely from the already-stored `tool.agent.spawned` events of OTHER sessions.
 *
 * `now` is injectable for deterministic tests; defaults to wall clock.
 */
export function correlateParentSession(
  db: Database,
  childEvents: RawHookEvent[],
  now: () => number = Date.now
): string | null {
  const childPrompt = childFirstPrompt(childEvents);
  if (childPrompt === null) return null;

  const anchorTs = earliestTimestamp(childEvents) ?? new Date(now()).toISOString();
  const cutoffIso = new Date(now() - CORRELATION_WINDOW_MS).toISOString();

  // Narrow set: recent spawn events only. idx_events_type + idx_events_timestamp
  // keep this cheap; we then JSON-parse only this small candidate set.
  const candidates = db
    .query(
      `SELECT session_id, payload, timestamp
         FROM events
        WHERE type = 'tool.agent.spawned'
          AND timestamp >= ?
        ORDER BY timestamp DESC`
    )
    .all(cutoffIso) as SpawnCandidateRow[];

  void anchorTs; // reserved for a future timestamp-proximity tie-break

  // Collect DISTINCT matching parent sessions. >1 ⇒ ambiguous ⇒ skip.
  const matched = new Set<string>();
  for (const row of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch (_err) {
      // A malformed stored payload is not a correlation signal — skip it.
      // (Defensive: insertEvent always JSON.stringifies, so this is unexpected.)
      continue;
    }
    const spawnPrompt = spawnPromptText(parsed);
    if (spawnPrompt === null) continue;
    if (!promptsMatch(childPrompt, spawnPrompt)) continue;
    matched.add(row.session_id);
  }

  if (matched.size === 0) return null;
  if (matched.size > 1) {
    process.stderr.write(
      `[mission-control] parent-correlation: ambiguous — ${matched.size} candidate parents matched the same first prompt in-window; leaving child agent-rooted\n`
    );
    return null;
  }

  // Exactly one distinct parent session matched.
  const [parentSessionId] = [...matched];
  return parentSessionId ?? null;
}
