/**
 * CK-2 (cortex#1289) — the stack-detail COCKPIT HEADER component.
 *
 * A presentation-only wrapper over the pure {@link StackHeaderModel} (built in
 * `lib/mc-stack-header.ts`). Renders the mockup header:
 *
 *   ◉ <label> · LOCAL STACK|FEDERATED PEER · N/M online · <verdict chip>
 *   [capability chips …]
 *
 * A FEDERATED PEER is AGGREGATE-ONLY (ADR-0005): the header shows rolled-up
 * capabilities + presence counts, never a session interior. CK-1 already bars
 * SESSION altitude for a peer; this header is the aggregate face of that rule, so
 * it also carries an explicit `aggregate` tag.
 *
 * The verdict chip renders signal's verdict string VERBATIM with a severity colour
 * (keyed on `data-severity`, sourced from the overlay's canonical `verdictBadge`).
 * When signal is dark for the stack it renders an honest `unobserved` chip in a
 * distinct neutral treatment — never default-green.
 */

import type { StackHeaderModel, StackVerdictChip } from "../lib/mc-stack-header";
import { formatRtt } from "../lib/network-transport-overlay";

/** The on-screen tag rendered after the stack label. */
const VARIANT_LABEL: Record<StackHeaderModel["variant"], string> = {
  local: "LOCAL STACK",
  peer: "FEDERATED PEER",
};

export interface McStackHeaderProps {
  model: StackHeaderModel;
}

export function McStackHeader({ model }: McStackHeaderProps) {
  const { label, variant, capabilities, presence, verdict } = model;
  return (
    <header
      className="mc-stack-header"
      data-variant={variant}
      aria-label={`stack ${label}`}
    >
      <div className="mc-stack-header-id">
        <span className="mc-stack-header-glyph" aria-hidden="true">
          ◉
        </span>
        <span className="mc-stack-header-name">{label}</span>
        <span className="mc-stack-header-variant">· {VARIANT_LABEL[variant]}</span>
        {variant === "peer" ? (
          <span
            className="mc-stack-header-aggregate"
            title="Federated peer — aggregate metadata only (ADR-0005); no session interiors."
          >
            aggregate
          </span>
        ) : null}
        <span className="mc-stack-header-presence">
          {presence.online}/{presence.total} online
        </span>
        <span className="mc-stack-header-verdict-slot">
          <VerdictChip verdict={verdict} />
        </span>
      </div>
      <div className="mc-stack-header-caps" aria-label="stack capabilities">
        {capabilities.length === 0 ? (
          <span className="mc-stack-cap mc-stack-cap--none dim">
            no capabilities declared
          </span>
        ) : (
          capabilities.map((cap) => (
            <span key={cap} className="mc-stack-cap" data-capability={cap}>
              {cap}
            </span>
          ))
        )}
      </div>
    </header>
  );
}

/**
 * The transport-verdict chip. Observed → the VERBATIM verdict label + its severity
 * colour (`data-severity` = the overlay badge's severity) + the leaf RTT when
 * reported. Unobserved → an honest neutral chip that is deliberately NOT any of
 * the ok/warn/alert colours (signal dark is not a health claim).
 */
function VerdictChip({ verdict }: { verdict: StackVerdictChip }) {
  if (!verdict.observed) {
    return (
      <span
        className="mc-verdict-chip mc-verdict-chip--unobserved"
        data-severity="unobserved"
        title="No transport signal observed for this stack (unobserved — not a health claim)."
      >
        unobserved
      </span>
    );
  }
  const { badge, rttMs } = verdict;
  return (
    <span
      className="mc-verdict-chip"
      data-severity={badge.severity}
      data-verdict={badge.verdict}
      title={badge.title}
    >
      {badge.label}
      {rttMs !== null ? (
        <span className="mc-verdict-chip-rtt">{formatRtt(rttMs)}</span>
      ) : null}
    </span>
  );
}
