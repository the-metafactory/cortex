/**
 * G-1114.B.4 — `GET /api/agents` (live agents panel data source).
 *
 * Exposes the stack-local runtime agent-presence registry (G-1114.B.3) as a
 * read-only REST snapshot the dashboard's agents panel renders. The registry is
 * the bus-side observable store fed by the `agent.*` presence stream
 * (`agent.online` / `agent.heartbeat` / `agent.offline` /
 * `agent.capabilities-changed`); this handler projects its `getAgents()`
 * snapshot into a stable DTO so the dashboard never touches bus internals.
 *
 * ## Dependency direction
 *
 * The MC surface layer must NOT import the bus. The server depends only on the
 * minimal {@link AgentPresenceView} interface declared here — `cortex.ts` adapts
 * the concrete `AgentPresenceRegistry` to it at boot. This keeps the
 * registry→API seam one-directional (bus → surface), matching how `wsRegistry`
 * and `db` are threaded.
 *
 * ## Gating-mismatch graceful path
 *
 * When MC is enabled but the presence registry is absent (e.g. a gating skew
 * where the embed runs without the registry), the server passes `null` and this
 * handler returns an empty list — never a 5xx. An empty panel is the correct
 * "no agents observed yet" rendering.
 */

import type { Database } from "bun:sqlite";

/**
 * The minimal read-only contract the MC server depends on to serve
 * `/api/agents`. The concrete `AgentPresenceRegistry` (from
 * `src/bus/agent-network/registry.ts`) satisfies this structurally — the server
 * never imports the bus type, only this interface. `cortex.ts` supplies the
 * live registry; tests supply a hand-rolled stub.
 */
export interface AgentPresenceView {
  /** Snapshot of every known agent presence record (copies — caller-safe). */
  getAgents(): AgentPresenceSnapshotRecord[];
}

/**
 * One agent's presence as the registry exposes it. A structural subset of the
 * bus-side `AgentPresenceRecord` — only the fields the API surfaces. Declared
 * here (not imported from the bus) so the surface layer stays bus-free; the
 * registry's richer record assigns to this shape structurally.
 */
export interface AgentPresenceSnapshotRecord {
  key: string;
  /**
   * G-1114.E.2 — record PROVENANCE. `"local"` for a stack-own agent (the B.3
   * path); a `{kind:"foreign", principal, stack}` struct for a trust-verified
   * federated peer agent (the E.2 path). The registry's `AgentRecordOrigin`
   * assigns to this structurally — the surface layer never imports the bus type.
   */
  origin: "local" | { kind: "foreign"; principal: string; stack: string };
  agentId: string;
  nkeyPublicKey: string;
  assistantName: string | null;
  principal: string;
  stack: string;
  capabilities: readonly string[];
  state: "online" | "offline";
  offlineReason?: string;
  startedAt?: string;
  lastHeartbeatAt?: number;
  lastSeenAt: number;
}

/**
 * G-1114.E.4 — an agent's federation provenance, snake_case for the DTO.
 *
 *   - `"local"` — a stack-own agent (the default; byte-identical to pre-E DTOs).
 *   - `{ principal, stack }` — a trust-verified FOREIGN peer agent, carrying the
 *     peer's chain-verified `{principal}/{stack}`. The object form IS the
 *     "foreign" discriminant — a consumer reads `origin === "local"` vs an
 *     object. The `{principal}/{stack}` here is the VERIFIED source identity
 *     (PR #914), safe to render as provenance + group by.
 */
export type AgentOrigin = "local" | { principal: string; stack: string };

/** One agent row in the `GET /api/agents` response. */
export interface AgentPresenceTile {
  /** Stable registry key — `{principal}/{stack}/{agent_id}`. */
  key: string;
  /**
   * G-1114.E.4 — federation provenance: `"local"` for a stack-own agent, or the
   * foreign peer's `{principal, stack}`. The Network view groups agents under
   * their origin stack-hub and renders foreign agents distinctly off this.
   */
  origin: AgentOrigin;
  /** Logical agent id (`luna`, `echo`, …). */
  agent_id: string;
  /** Soma-layer assistant name the agent hosts, or `null`. */
  assistant_name: string | null;
  /** The agent's NKey public key (stable cross-restart identity). */
  nkey_public_key: string;
  /** `{principal}` the agent lives in. */
  principal: string;
  /** `{stack}` the agent lives in. */
  stack: string;
  /** Declared capability set (latest observed). */
  capabilities: readonly string[];
  /** Last explicit liveness state observed from the presence stream. */
  state: "online" | "offline";
  /** Reason from the last `agent.offline`, when `state === "offline"`. */
  offline_reason: string | null;
  /** Boot time from the last `agent.online` (ISO-8601), when known. */
  started_at: string | null;
  /** Epoch-ms of the last `agent.heartbeat` observed, when known. */
  last_heartbeat_at: number | null;
  /** Epoch-ms any presence envelope was last applied for this agent. */
  last_seen_at: number;
}

/** `GET /api/agents` response body. */
export interface ListAgentsResponse {
  agents: AgentPresenceTile[];
}

/**
 * Flatten the registry's `AgentRecordOrigin` (`"local"` |
 * `{kind:"foreign",principal,stack}`) into the DTO `AgentOrigin` (`"local"` |
 * `{principal,stack}`). The `kind` discriminant is dropped — the object-vs-string
 * shape already discriminates foreign from local on the wire.
 */
function toOrigin(origin: AgentPresenceSnapshotRecord["origin"]): AgentOrigin {
  return origin === "local"
    ? "local"
    : { principal: origin.principal, stack: origin.stack };
}

/** Project one registry record into the snake_case API DTO. */
function toTile(r: AgentPresenceSnapshotRecord): AgentPresenceTile {
  return {
    key: r.key,
    origin: toOrigin(r.origin),
    agent_id: r.agentId,
    assistant_name: r.assistantName,
    nkey_public_key: r.nkeyPublicKey,
    principal: r.principal,
    stack: r.stack,
    capabilities: r.capabilities,
    state: r.state,
    offline_reason: r.offlineReason ?? null,
    started_at: r.startedAt ?? null,
    last_heartbeat_at: r.lastHeartbeatAt ?? null,
    last_seen_at: r.lastSeenAt,
  };
}

/**
 * Handle `GET /api/agents`.
 *
 * Read-only: projects the live registry snapshot. `db` is accepted for handler
 * signature parity with the other `/api/*` handlers (the agents feed is
 * registry-derived, not DB-derived, so it is unused — but keeping the parameter
 * keeps the router call-site uniform and leaves room for a future DB join).
 *
 * `view === null` (MC enabled but no presence registry — a gating mismatch)
 * returns an empty list gracefully rather than erroring.
 */
export function handleListAgents(
  _db: Database,
  view: AgentPresenceView | null,
): Response {
  try {
    const records = view ? view.getAgents() : [];
    const body: ListAgentsResponse = { agents: records.map(toTile) };
    return Response.json(body);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/agents failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return Response.json(
      { error: `Failed to list agents: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
