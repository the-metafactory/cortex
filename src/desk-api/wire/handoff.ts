export const HANDOFF_STATES = ["working", "ready", "failed", "approved", "discarded"] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/** What a Desk card carries about its hand-off: the state, the status line and, once finished, what came back. */
export interface HandoffView {
  id: string;
  state: HandoffState;
  line: string;
  since: number;
  findings?: string[];
  draft?: string;
  result?: string;
  brief?: string;
}

export type TaskHandoffLines = Record<string, { state: HandoffState; line: string }>;
