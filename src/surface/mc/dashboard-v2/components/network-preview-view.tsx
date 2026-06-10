/**
 * G-1114.A — Network (preview) tab.
 *
 * A grounding-slice placeholder for the Agent Network Topology view (G-1114).
 * This renders a clear "preview — coming in G-1114.B" card and NO data: there
 * is no producer publishing `agent.*` presence envelopes and no subscriber /
 * runtime registry feeding this surface yet (ADR-0007 — the live producer +
 * subscriber land in Phase B). It exists so the work-in-flight is visible on
 * the dashboard and the tab slot is reserved.
 *
 * When G-1114.B wires the runtime registry, this view is replaced by the real
 * stack-local agents panel; when G-1114.D lands, by the React Flow + ELK graph.
 */

/** The four `agent`-domain presence actions this view will eventually render. */
const PRESENCE_ACTIONS = [
  "online",
  "heartbeat",
  "offline",
  "capabilities-changed",
] as const;

export function NetworkPreviewView() {
  return (
    <section
      className="scaffold-section network-preview-view"
      aria-label="Network topology (preview)"
    >
      <h2>Network (preview)</h2>
      <p className="dim">
        The <strong>Agent Network Topology</strong> view is in flight (G-1114).
        It will render agent <strong>presence</strong> across stacks — which
        agents are up and consuming the bus, their declared capabilities, and
        their liveness — built from the new <code>agent</code>-domain presence
        protocol on the bus.
      </p>
      <p className="dim">
        Nothing is wired yet: this slice (G-1114.A) lands only the inert
        protocol types. The live stack-local agents panel arrives in{" "}
        <strong>G-1114.B</strong>; the graph view in G-1114.D.
      </p>
      <ul className="network-preview-actions" aria-label="Presence protocol actions">
        {PRESENCE_ACTIONS.map((action) => (
          <li key={action} className="network-preview-action">
            <code>agent.{action}</code>
          </li>
        ))}
      </ul>
      <p className="dim network-preview-note">
        Presence (<code>agent.heartbeat</code>) is distinct from the
        dispatch-scoped <code>system.agent.heartbeat</code>: an idle agent has
        presence without running a dispatch. Peer agents show presence and
        dispatch-lifecycle metadata only — never session interiors.
      </p>
    </section>
  );
}
