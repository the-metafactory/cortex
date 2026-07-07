/**
 * MC-D2 (cortex#1289) — the constellation skin's **shell chrome** composer.
 *
 * Frames the MC Network view with the command bar (top) + altitude rail (left),
 * with the existing view body as `children` in the content area. The whole shell
 * — chrome AND the pane it frames — is wrapped in a single `.mc-skin` container
 * so D1's OKLCH tokens + JetBrains/Inter fonts apply here and ONLY here: this is
 * how the skin adopts pane-by-pane, with zero blast radius on the dashboard's
 * other tabs (which never carry `.mc-skin`).
 *
 * Additive + non-regressive: the existing Network body renders unchanged as
 * `children`; the chrome mounts around it. D3 re-skins the canvas itself next.
 *
 * The selection state is owned by the caller (the Network view) and threaded in;
 * this component is presentation + a thin click→selection mapping over the pure
 * `mc-shell-model`.
 */

import type { ReactNode } from "react";
import { McCommandBar } from "./mc-command-bar";
import { McAltitudeRail, type RailSessionTarget } from "./mc-altitude-rail";
import { McStackHeader } from "./mc-stack-header";
import {
  buildBreadcrumb,
  drillToNetwork,
  navigateToSegment,
  ascendToRoot,
  ascendToLevel,
  selectedNetworkPosture,
  type AltitudeSelection,
} from "../lib/mc-shell-model";
import type { StackHeaderModel } from "../lib/mc-stack-header";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import "./mc-shell.css";

export interface McShellProps {
  /** The serving (local) principal; `null` until a local agent is observed. */
  principal: string | null;
  /** Joined networks (drives the breadcrumb, posture, count, and drill list). */
  networks: readonly NetworkMembershipDTO[];
  /** The current you-are-here selection (owned by the caller). */
  selection: AltitudeSelection;
  /** Report a new selection from a chrome navigation gesture. */
  onSelectionChange: (next: AltitudeSelection) => void;
  /**
   * CK-1 — the selected LOCAL assistant's sessions, forwarded to the rail as
   * SESSION drill targets (own-local only; empty for a federated peer). The
   * caller (Network view) derives these from the working-agents session tree.
   */
  sessionTargets?: readonly RailSessionTarget[];
  /**
   * CK-1 — open a session interior (reuses the App-level F-7 drill-down). The
   * caller wires this to the existing drill overlay; the shell only reports the
   * chosen session id and dives the rail to SESSION.
   */
  onOpenSession?: (sessionId: string) => void;
  /**
   * CK-2 — the stack-detail cockpit header model, present ONLY when a stack is
   * dived into (STACK level or deeper). `null`/absent above STACK → no header
   * (the framed pane renders unchanged, exactly as pre-CK-2). Built by the caller
   * from the live agent snapshot + the transport overlay (`buildStackHeader`).
   */
  stackHeader?: StackHeaderModel | null;
  /** The framed pane (the existing Network view body). */
  children: ReactNode;
}

export function McShell({
  principal,
  networks,
  selection,
  onSelectionChange,
  sessionTargets = [],
  onOpenSession,
  stackHeader = null,
  children,
}: McShellProps) {
  const breadcrumb = buildBreadcrumb(selection);
  const posture = selectedNetworkPosture(networks, selection);

  return (
    <div className="mc-skin mc-shell">
      <McCommandBar
        principal={principal}
        breadcrumb={breadcrumb}
        posture={posture}
        networkCount={networks.length}
        onNavigate={(seg) => onSelectionChange(navigateToSegment(seg))}
      />
      <div className="mc-shell-body">
        <McAltitudeRail
          selection={selection}
          networks={networks}
          onAscendRoot={() => onSelectionChange(ascendToRoot())}
          onDrillNetwork={(id) => onSelectionChange(drillToNetwork(id))}
          onAscendToLevel={(level) =>
            onSelectionChange(ascendToLevel(selection, level))
          }
          sessionTargets={sessionTargets}
          {...(onOpenSession ? { onOpenSession } : {})}
        />
        <div className="mc-shell-content">
          {stackHeader ? <McStackHeader model={stackHeader} /> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
