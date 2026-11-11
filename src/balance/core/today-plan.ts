import { selectToday } from "./scheduler";
import type { AppState } from "./types";

export interface TodayPlanDraft {
  readonly date: string;
  readonly ids: readonly string[];
  readonly origin: string;
}

export function todayPlanIds(state: AppState, date: string, draft?: TodayPlanDraft | null): readonly string[] {
  const day = state.dayState?.date === date ? state.dayState : null;
  if (day) return day.confirmed;
  const ids = draft?.date === date && draft.origin === "person" ? draft.ids : selectToday(state, date).map(item => item.task.id);
  return ids.slice(0, state.settings.todayCap);
}
