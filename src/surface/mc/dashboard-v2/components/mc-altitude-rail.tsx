/**
 * MC-D2 (cortex#1289) / CK-1 (cortex#1289) — the constellation skin's **altitude
 * rail** (left chrome).
 *
 * The primary navigation gesture: a vertical spine of altitude stops —
 * NETWORKS (10k ft) → NETWORK → STACK → ASSISTANT → SESSION — with the current
 * level lit. D2 wired the top two; CK-1 makes the whole spine live: diving into a
 * constellation stack lights STACK/ASSISTANT, and — on an OWN-LOCAL stack only —
 * the selected assistant's sessions expand as SESSION drill targets that open the
 * reused F-7 drill-down interior. A FEDERATED peer bottoms out at STACK/ASSISTANT
 * (SESSION stays a disabled `future` stub) — the ADR-0005 sovereignty boundary,
 * rendered.
 *
 * The NETWORK stop expands the joined networks as drill targets; a reachable
 * higher stop ascends to that level. Everything is backed by real coordinates on
 * the selection — a stop is only interactive when `stopReachability` says so, so
 * the rail never fabricates a drill.
 *
 * Presentation-only: reachability + posture are computed by `mc-shell-model`.
 */

import {
  ALTITUDE_LEVELS,
  ALTITUDE_META,
  networkPosture,
  stackReachesSession,
  stopReachability,
  type AltitudeLevel,
  type AltitudeSelection,
} from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

/** One SESSION drill target under the ASSISTANT stop (own-local sessions only). */
export interface RailSessionTarget {
  /** The session id (keys the reused drill-down interior). */
  id: string;
  /** Short label rendered on the rail. */
  label: string;
}

export interface McAltitudeRailProps {
  /** The current you-are-here selection. */
  selection: AltitudeSelection;
  /** Joined networks (drill targets under the NETWORK stop). */
  networks: readonly NetworkMembershipDTO[];
  /** Ascend to the 10k-ft networks root. */
  onAscendRoot: () => void;
  /** Drill into a specific network (networks → network). */
  onDrillNetwork: (networkId: string) => void;
  /**
   * CK-1 — ascend to a reachable ancestor stop (network/stack/assistant/session),
   * truncating deeper coordinates. The shell maps this through `ascendToLevel`.
   */
  onAscendToLevel: (level: AltitudeLevel) => void;
  /**
   * CK-1 — the selected LOCAL assistant's sessions, expanded under the ASSISTANT
   * stop as SESSION drill targets. Empty for a federated peer (SESSION is capped)
   * or when no assistant is selected — the rail renders none in that case.
   */
  sessionTargets?: readonly RailSessionTarget[];
  /**
   * CK-1 — open a session interior. Dives the rail to SESSION and mounts the
   * reused F-7 drill-down (wired by the caller). Only ever called for an
   * own-local session (ADR-0005).
   */
  onOpenSession?: (sessionId: string) => void;
}

export function McAltitudeRail({
  selection,
  networks,
  onAscendRoot,
  onDrillNetwork,
  onAscendToLevel,
  sessionTargets = [],
  onOpenSession,
}: McAltitudeRailProps) {
  const networkCount = networks.length;

  return (
    <nav className="mc-altitude-rail" aria-label="Altitude">
      <div className="mc-rail-title">ALTITUDE</div>
      <ol className="mc-rail-stops">
        {ALTITUDE_LEVELS.map((level) => {
          const meta = ALTITUDE_META[level];
          const reach = stopReachability(level, selection, networkCount);
          const isFuture = reach === "future";
          const isCurrent = reach === "current";
          const isReachable = reach === "reachable";

          // Click behaviour is data-driven off reachability:
          //   - NETWORKS  → ascend to the 10k-ft root;
          //   - NETWORK   → ascend to the drilled network (only when one is
          //     selected; otherwise the stop's children are the drill targets);
          //   - STACK/ASSISTANT/SESSION → ascend to that reachable stop.
          // A `future` or `current` stop is inert (children carry the forward
          // drill). This never fabricates a target — `isReachable` gates it.
          let onClick: (() => void) | undefined;
          if (isReachable) {
            if (level === "networks") onClick = onAscendRoot;
            else if (level === "network") {
              onClick =
                selection.networkId !== null
                  ? () => onAscendToLevel("network")
                  : undefined;
            } else onClick = () => onAscendToLevel(level);
          }

          // Only genuinely-future deeper stops carry the "not yet" copy. SESSION
          // on a federated peer is the load-bearing case: it's `future` BY the
          // sovereignty boundary, not because it's unbuilt — say so honestly.
          const futureTitle =
            level === "session" && selection.stack !== null
              ? "SESSION — own-local stacks only; a federated peer bottoms out at ASSISTANT"
              : `${meta.label} — dive into a stack to reach this level`;

          return (
            <li
              key={level}
              className={
                "mc-rail-stop" +
                (isCurrent ? " mc-rail-stop--current" : "") +
                (isFuture ? " mc-rail-stop--future" : "")
              }
              data-level={level}
              data-reach={reach}
              aria-current={isCurrent ? "step" : undefined}
            >
              <button
                type="button"
                className="mc-rail-stop-btn"
                disabled={onClick === undefined}
                onClick={onClick}
                // A disabled future stub is removed from the tab order, so its
                // explanatory `title` is unreachable to AT — carry the same
                // information on an always-announced `aria-label` instead.
                aria-label={isFuture ? futureTitle : undefined}
                title={isFuture ? futureTitle : undefined}
              >
                <span className="mc-rail-dot" aria-hidden="true" />
                <span className="mc-rail-stop-labels">
                  <span className="mc-rail-stop-label">{meta.label}</span>
                  {meta.altLabel && (
                    <span className="mc-rail-stop-alt">{meta.altLabel}</span>
                  )}
                </span>
              </button>

              {/* Drill targets under the NETWORK stop (the working drill). */}
              {level === "network" && networkCount > 0 && (
                <ul className="mc-rail-networks">
                  {networks.map((n) => {
                    const active =
                      selection.networkId === n.network_id;
                    const posture = networkPosture(n);
                    return (
                      <li key={n.network_id} className="mc-rail-network">
                        <button
                          type="button"
                          className={
                            "mc-rail-network-btn" +
                            (active ? " mc-rail-network-btn--active" : "")
                          }
                          data-network-id={n.network_id}
                          data-posture={posture}
                          aria-current={active ? "true" : undefined}
                          onClick={() => onDrillNetwork(n.network_id)}
                        >
                          <span className="mc-rail-network-name">
                            {n.network_id}
                          </span>
                          <span
                            className={`mc-rail-network-posture mc-rail-network-posture--${posture}`}
                          >
                            {posture}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* CK-1 — SESSION drill targets under the ASSISTANT stop, for the
                  selected OWN-LOCAL assistant only. Renders nothing for a
                  federated peer (`stackReachesSession` false) — the boundary. */}
              {level === "assistant" &&
                stackReachesSession(selection.stack) &&
                sessionTargets.length > 0 && (
                  <ul className="mc-rail-sessions">
                    {sessionTargets.map((s) => {
                      const active = selection.sessionId === s.id;
                      return (
                        <li key={s.id} className="mc-rail-session">
                          <button
                            type="button"
                            className={
                              "mc-rail-session-btn" +
                              (active ? " mc-rail-session-btn--active" : "")
                            }
                            data-session-id={s.id}
                            aria-current={active ? "true" : undefined}
                            onClick={() => onOpenSession?.(s.id)}
                          >
                            <span className="mc-rail-session-name">
                              {s.label}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
            </li>
          );
        })}
      </ol>
      <div className="mc-rail-dive" aria-hidden="true">
        ↓<br />
        DIVE
      </div>
    </nav>
  );
}
