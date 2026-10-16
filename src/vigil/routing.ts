import type { SubjectClass } from "./policy";
import type { StateDirection } from "./state-subject";

export type VigilRoute = "text" | "digest";

export function routeFor(subject: SubjectClass, toValue: string, direction: StateDirection): VigilRoute {
  if (direction === "better") return "digest";
  if (subject === "goal" || subject === "goal-sensor") return "text";
  if (subject === "escalation" && toValue === "overdue") return "text";
  return "digest";
}
