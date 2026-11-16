import { clock, DAY_MS, startOfDay } from "./time";
import type { DeskAction } from "./types";
import type { HandoffState, HandoffView } from "../../../desk-api/wire/handoff";
export type { HandoffState, HandoffView };

export const OPEN_STATES: readonly HandoffState[] = ["working", "ready", "failed"];

export const MAX_INSTRUCTION = 1000;

/** A hand-off's time for a status line: the clock today, "yesterday 14:05", else the weekday and date. */
export function handoffWhen(at: number, now: number): string {
  if (startOfDay(at) === startOfDay(now)) return clock(at);
  if (startOfDay(now) - startOfDay(at) === DAY_MS) return `yesterday ${clock(at)}`;
  return `${new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${clock(at)}`;
}

export const handoffAction = (id: string, label: string, role: DeskAction["role"], target?: string): DeskAction => ({ id, label, role, wired: true, ...(target ? { target } : {}) });

export const HANDOFF_KEY_PREFIX = "assistant:";
export const handoffKey = (id: string): string => `${HANDOFF_KEY_PREFIX}${id}`;

export const LEGACY_KEY_PREFIX = "ivy:";

export const LEGACY_ACTION_IDS: Readonly<Record<string, string>> = {
  "ivy.hand": "assistant.hand",
  "ivy.approve": "assistant.approve",
  "ivy.discard": "assistant.discard",
  "ivy.retry": "assistant.retry",
  "ivy.edit": "assistant.edit",
  "mail.ivy": "mail.assistant",
};
