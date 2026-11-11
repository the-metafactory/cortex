import type { ConversationEntry, ConversationResponseUpdate } from "../../../../conversations/types";

export interface TranscriptState {
  entries: ConversationEntry[];
  liveText: string | null;
  generation: string | null;
  cursor: number | null;
  working: boolean;
  connected: boolean;
}
export const EMPTY_TRANSCRIPT: TranscriptState = { entries: [], liveText: null, generation: null, cursor: null, working: false, connected: false };
export type TranscriptAction =
  | { type: "stream"; update: ConversationResponseUpdate }
  | { type: "history"; entries: ConversationEntry[]; working: boolean }
  | { type: "disconnected" };

function mergeEntries(current: ConversationEntry[], incoming: ConversationEntry[]): ConversationEntry[] {
  if (incoming.length === 0) return current;
  const entries = new Map(current.map(entry => [entry.id, entry]));
  for (const entry of incoming) entries.set(entry.id, entry);
  return [...entries.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

function nextLiveText(state: TranscriptState, update: ConversationResponseUpdate): string | null {
  if (update.text !== undefined) return update.text;
  if (update.append === undefined) return state.liveText;
  const previous = state.generation === update.generation ? state.liveText ?? "" : "";
  return previous + update.append;
}

export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "disconnected") return { ...state, connected: false };
  if (action.type === "history") {
    const incoming = state.connected ? action.entries.filter(entry => Number(entry.id) <= (state.cursor ?? 0)) : action.entries;
    const completed = !state.connected && incoming.some(entry => entry.role === "assistant" && Number(entry.id) > (state.cursor ?? 0));
    const entries = mergeEntries(state.entries, incoming);
    return { ...state, entries, cursor: entries.length ? Number(entries.at(-1)?.id) : state.cursor, liveText: completed ? null : state.liveText, working: state.connected ? state.working : action.working };
  }
  const update = action.update;
  const entries = mergeEntries(state.entries, update.entries ?? []);
  const savedAhead = entries.some(entry => entry.role === "assistant" && Number(entry.id) > (update.cursor ?? 0));
  if (savedAhead) return { ...state, entries, connected: true };
  const liveText = nextLiveText(state, update);
  return { entries, liveText, generation: update.generation, cursor: Math.max(state.cursor ?? 0, update.cursor ?? 0) || null, working: (update.cursor ?? 0) < (state.cursor ?? 0) ? state.working : update.working, connected: true };
}
