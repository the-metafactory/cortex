import { clock, DAY_MS, startOfDay } from "./time";
import type { DeskAction } from "./types";

export const HANDOFF_STATES = ["working", "ready", "failed", "approved", "discarded"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];
export const OPEN_STATES: readonly HandoffState[] = ["working", "ready", "failed"];

export const MAX_INSTRUCTION = 1000;

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

/** A hand-off's time for a status line: the clock today, "yesterday 14:05", else the weekday and date. */
export function handoffWhen(at: number, now: number): string {
  if (startOfDay(at) === startOfDay(now)) return clock(at);
  if (startOfDay(now) - startOfDay(at) === DAY_MS) return `yesterday ${clock(at)}`;
  return `${new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${clock(at)}`;
}

export const handoffAction = (id: string, label: string, role: DeskAction["role"], target?: string): DeskAction => ({ id, label, role, wired: true, ...(target ? { target } : {}) });

export const HANDOFF_KEY_PREFIX = "assistant:";
export const handoffKey = (id: string): string => `${HANDOFF_KEY_PREFIX}${id}`;
