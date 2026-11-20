import { z } from "zod";
import type { ThreadType } from "./format";

const QuestionStandSchema = z.string().min(1).refine(text => !/[\r\n\u0085\u2028\u2029]/.test(text));

export function newStandProblem(type: ThreadType, text: string): string | null {
  return type === "question" && !QuestionStandSchema.safeParse(text).success
    ? "A question stand must be a single-line answer so far. Keep full reasoning in notes and the draft. Nothing was written."
    : null;
}
