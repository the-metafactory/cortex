/**
 * MC-D3 (cortex#1290) — the constellation canvas NETWORK HEADER.
 *
 * Renders the mockup's per-network header strip — `<NETWORK> · <admin|member> ·
 * N stacks` (e.g. `MERIDIAN · admin · 2 stacks`) — above the glowing star-map.
 * It is a thin presentational shell over the pure `buildConstellationHeader`
 * projection; all posture/aggregate logic lives there (unit-tested DOM-free).
 *
 * ## Vocabulary (load-bearing — CONTEXT.md §"Network posture (admin vs member)")
 *
 * The posture pill reads **admin** / **member** — the design mockup's original
 * on-screen label is renamed to `admin` per the vocabulary migration. The
 * deprecated network-posture word is reserved for the MC authorization-role tier
 * + the NATS account-tree root, never this per-network posture (CONTEXT.md
 * §"Network posture"); the `check-carveouts` ratchet enforces it.
 *
 * ## Sovereignty (the privacy boundary)
 *
 * The header is an AGGREGATE — network id, the viewer's posture, a present-stack
 * tally, and the A3 confidentiality token. It exposes NO session affordance, for
 * any network, admin or member: a federated peer is visible in aggregate but
 * never drillable into sessions (ADR-0007). Self-effacing: no joined networks →
 * renders nothing (a non-federated stack is unchanged).
 */

import type { NetworkMembershipDTO } from "../hooks/use-networks";
import {
  buildConstellationHeader,
  type ConstellationHeaderNetwork,
} from "../lib/network-constellation-header";

export interface ConstellationHeaderProps {
  networks: readonly NetworkMembershipDTO[];
}

/** The A3 confidentiality token → a short, honest on-glass marker. */
function confidentialityMarker(
  token: ConstellationHeaderNetwork["confidentiality"],
): { label: string; title: string } | null {
  switch (token) {
    case "encrypted-required":
      return { label: "🔒 sealed (required)", title: "Sealed — cleartext-in rejected (key held)" };
    case "encrypted":
      return { label: "🔒 sealed", title: "Sealed — key held (transition window)" };
    case "degraded":
      return { label: "⚠ no key", title: "Configured to seal but no key — publishing cleartext (ADR-0019)" };
    case "cleartext":
      return { label: "signed", title: "Signed, not sealed (encryption off)" };
    case "unknown":
      // Never assume encrypted; the marker is finalized in D4. Show nothing
      // rather than over-claim.
      return null;
  }
}

export function ConstellationHeader({ networks }: ConstellationHeaderProps) {
  const rows = buildConstellationHeader(networks);
  // Self-effacing: a non-federated stack (no joined networks) renders no header.
  if (rows.length === 0) return null;

  return (
    <header className="mc-constellation-header" aria-label="Networks (constellation header)">
      <ul className="mc-constellation-header-list">
        {rows.map((row) => {
          const marker = confidentialityMarker(row.confidentiality);
          const stackPlural = row.stackCount === 1 ? "" : "s";
          return (
            <li
              key={row.networkId}
              className="mc-constellation-header-net"
              data-network={row.networkId}
              data-posture={row.posture}
            >
              <span className="mc-ch-name">{row.networkId}</span>
              <span className="mc-ch-sep" aria-hidden="true">·</span>
              <span
                className={`mc-ch-posture mc-ch-posture-${row.posture}`}
                title={
                  row.posture === "admin"
                    ? "You administer this network — roster, Pier queue, grant/revoke"
                    : "You are an admitted member — a sovereign peer, no admin affordances"
                }
              >
                {row.posture}
              </span>
              <span className="mc-ch-sep" aria-hidden="true">·</span>
              <span className="mc-ch-stacks">
                {row.stackCount} stack{stackPlural}
              </span>
              {marker && (
                <span
                  className="mc-ch-conf"
                  data-confidentiality={row.confidentiality}
                  title={marker.title}
                >
                  {marker.label}
                  {row.keyId && (
                    <span
                      className="mc-ch-keyid"
                      data-key-id={row.keyId}
                      title={`Per-network payload key (epoch) ${row.keyId} — ADR-0019`}
                    >
                      {" · "}K{row.keyId}
                    </span>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </header>
  );
}
