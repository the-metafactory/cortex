import { expect, test } from "bun:test";
import { EMPTY_TRANSCRIPT, transcriptReducer } from "../conversation-stream";
import { visibleEntries, entryViews } from "../conversations";
import { TOOL_STARTED_KIND, TOOL_ACTIVITY_KIND, type ConversationEntry, type ConversationResponseUpdate } from "../../../../../conversations/types";

const user: ConversationEntry = { id: "1", kind: "cortex.input", role: "user", text: "Hello" };
const saved: ConversationEntry = { id: "2", kind: "pi.assistant", role: "assistant", text: "Hello there" };
const partial: ConversationResponseUpdate = { cursor: 1, generation: "turn-1", working: true, text: "Hello there", entries: [user] };

test("completion commits the saved answer and retires live text in one update", () => {
  const live = transcriptReducer(EMPTY_TRANSCRIPT, { type: "stream", update: partial });
  const polled = transcriptReducer(live, { type: "history", entries: [user, saved], working: false });
  expect(polled.liveText).toBe("Hello there");
  expect(polled.entries).toEqual([user]);
  const done = transcriptReducer(polled, { type: "stream", update: { cursor: 2, generation: null, working: false, text: null, entries: [saved] } });
  expect(done.liveText).toBeNull();
  expect(done.entries.filter(entry => entry.role === "assistant")).toEqual([saved]);
  expect(done.working).toBe(false);
});

test("disconnect preserves live text until fallback history contains its saved answer", () => {
  const live = transcriptReducer(EMPTY_TRANSCRIPT, { type: "stream", update: partial });
  const disconnected = transcriptReducer(live, { type: "disconnected" });
  expect(disconnected.liveText).toBe("Hello there");
  const refreshed = transcriptReducer(disconnected, { type: "history", entries: [user, saved], working: false });
  expect(refreshed.liveText).toBeNull();
  expect(refreshed.entries).toEqual([user, saved]);
});

test("history completing before stream attachment cannot resurrect an earlier partial", () => {
  const history = transcriptReducer(EMPTY_TRANSCRIPT, { type: "history", entries: [user, saved], working: false });
  const stale = transcriptReducer(history, { type: "stream", update: partial });
  expect(stale.liveText).toBeNull();
  expect(stale.entries).toEqual([user, saved]);
});

test("a new generation with the same text prefix resets instead of mixing replies", () => {
  const live = transcriptReducer(EMPTY_TRANSCRIPT, { type: "stream", update: partial });
  const next = transcriptReducer(live, { type: "stream", update: { cursor: 3, generation: "turn-2", working: true, text: "Hello there again", entries: [saved, { ...user, id: "3" }] } });
  expect(next.liveText).toBe("Hello there again");
  expect(next.entries.filter(entry => entry.role === "assistant")).toHaveLength(1);
});

test("tool starts appear for the current generation and are replaced by completed calls", () => {
  const start: ConversationEntry = { id: "3", kind: TOOL_STARTED_KIND, data: { turn: "turn-1", callId: "tool-1", tool: "repo_read" } };
  const end: ConversationEntry = { id: "4", kind: TOOL_ACTIVITY_KIND, data: { turn: "turn-1", callId: "tool-1", tool: "repo_read", outcome: "done", args: {} } };
  expect(visibleEntries([start], "turn-1").flatMap(entryViews)).toEqual([{ kind: "activity", text: "Using repo_read…" }]);
  expect(visibleEntries([start, end], "turn-1")).toEqual([end]);
  expect(visibleEntries([start], "turn-2")).toEqual([]);
  expect(visibleEntries([start], null)).toEqual([]);
});
