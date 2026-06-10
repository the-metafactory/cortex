/**
 * G-1114.D.5 — Network SPOTLIGHT (Cmd+K find-agent).
 *
 * REUSES the MC-base `CommandPalette` component (the dashboard's existing ⌘K
 * overlay — keyboard nav, fuzzy substring filter, Esc-close) rather than building
 * a bespoke overlay. We feed it a "find agent" command source: one `Command` per
 * agent whose `run()` selects that agent's node (D.4's selection path —
 * `onSelect(key)` → the view sets `selectedKey` → the detail panel opens).
 *
 * The command LABEL encodes the agent's display name + id + capabilities so the
 * palette's built-in substring filter matches all three search dimensions
 * (name / id / capability) the spotlight promises. The `group` carries liveness
 * so an offline agent reads as such in the list.
 *
 * Open/close + the Cmd+K listener + Esc-precedence (spotlight closes before the
 * D.4 detail panel) are owned by `network-view`; this component is the overlay +
 * the pure agents→commands mapping. The mapping (`buildAgentCommands`) is pure
 * and unit-tested; the overlay renders via the reused `CommandPalette`.
 *
 * ADR-0007: commands carry identity + presence + capabilities only — never any
 * session interior.
 */

import { CommandPalette, type Command } from "./command-palette";
import type { AgentPresenceTile } from "../hooks/use-agents";

export interface NetworkSpotlightProps {
  open: boolean;
  onClose: () => void;
  /** The (already filter-narrowed) agents to search. */
  agents: readonly AgentPresenceTile[];
  /** Select an agent's node by key — D.4's selection path. */
  onSelect: (key: string) => void;
}

/**
 * Map the agents snapshot into the `CommandPalette` command list.
 *
 * Pure (no DOM): one command per agent. The label embeds the display name, the
 * agent id, and the capabilities so the palette's substring filter matches a
 * query against any of them; the group carries liveness. `run()` closes the
 * spotlight and selects the agent's node.
 *
 * Exported for unit testing — asserts the label/group encoding + that `run`
 * selects the right key and closes.
 */
export function buildAgentCommands(
  agents: readonly AgentPresenceTile[],
  onSelect: (key: string) => void,
  onClose: () => void,
): Command[] {
  return agents.map((a) => {
    const name = a.assistant_name ?? a.agent_id;
    const caps = a.capabilities.length > 0 ? a.capabilities.join(" ") : "";
    // The label is what the palette filters + displays. We show the name + id;
    // the capabilities ride along (searchable) after a separator.
    const capSuffix = caps ? `  ·  ${caps}` : "";
    return {
      id: a.key,
      group: a.state === "online" ? "online" : "offline",
      label: `${name} (${a.agent_id})${capSuffix}`,
      run: () => {
        onSelect(a.key);
        onClose();
      },
    };
  });
}

export function NetworkSpotlight({
  open,
  onClose,
  agents,
  onSelect,
}: NetworkSpotlightProps) {
  const commands = buildAgentCommands(agents, onSelect, onClose);
  return <CommandPalette open={open} onClose={onClose} commands={commands} />;
}
