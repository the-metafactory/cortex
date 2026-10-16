import type { VigilEventRow, VigilSubjectRow } from "./db";
import { idOnlyGoalWording, type GoalWordingResolver } from "./goal-wording";
import { subjectClass } from "./policy";

export interface VigilRendererOptions {
  resolveGoalWording?: GoalWordingResolver;
  warn?: (message: string) => void;
}

export function createVigilRenderer(options: VigilRendererOptions = {}) {
  const resolve = options.resolveGoalWording ?? idOnlyGoalWording;
  const warn = options.warn ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  let warned = false;

  async function goalWording(goalId: string): Promise<string> {
    try {
      return await resolve(goalId) ?? goalId;
    } catch {
      if (!warned) {
        warned = true;
        warn("Vigil: goal wording resolver failed; using goal IDs for unavailable wording");
      }
      return goalId;
    }
  }

  return async (
    event: Pick<VigilEventRow, "from_value" | "to_value">,
    subject: Pick<VigilSubjectRow, "subject_kind" | "vocab" | "goal_id" | "ref">,
  ): Promise<string> => {
    const classification = subjectClass(subject);
    let label: string;
    if (classification === "goal") {
      label = `goal ${await goalWording(subject.goal_id ?? subject.ref)}`;
    } else if (classification === "goal-sensor" && subject.goal_id !== null) {
      label = `${subject.ref} (serves ${await goalWording(subject.goal_id)})`;
    } else {
      label = subject.subject_kind === "run" ? subject.ref : `${classification} ${subject.ref}`;
    }
    const change = event.from_value === null ? event.to_value : `${event.from_value} → ${event.to_value}`;
    return `Vigil: ${label} — ${change}`;
  };
}
