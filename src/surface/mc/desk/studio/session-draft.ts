import type { StudioSession } from "./session-schema";

export function draftWasRecorded(session: StudioSession, draft: string): boolean {
  const text = draft.trim();
  return session.phase.kind === "ended" && (!text || session.draft === text || session.turns.some(turn => turn.text === text));
}
