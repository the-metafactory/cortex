import type { VigilSubjectRow } from "./db";
import type { StateDirection, StateVocab } from "./state-subject";

export type SubjectClass = StateVocab | "goal-sensor" | "run";

export function subjectClass(row: Pick<VigilSubjectRow, "subject_kind" | "goal_id" | "vocab">): SubjectClass {
  if (row.subject_kind === "run") return row.goal_id !== null ? "goal-sensor" : "run";
  return row.vocab ?? "unknown";
}

const WORSE_SEVERITY = {
  goal: "high",
  "goal-sensor": "high",
  escalation: "normal",
  check: "normal",
  unknown: "normal",
  run: "normal",
} as const satisfies Record<SubjectClass, "high" | "normal">;

export function vigilSeverity(subject: SubjectClass, toValue: string, direction: StateDirection): "high" | "normal" | null {
  if (direction === "better") return null;
  if (subject === "escalation" && toValue === "overdue") return "high";
  return WORSE_SEVERITY[subject];
}
