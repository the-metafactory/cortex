import { expect } from "bun:test";
import type { ToolOutcome } from "../../model";

export const toolBody = (outcome: ToolOutcome): Record<string, any> => {
  expect(outcome.outcome).toBe("done");
  return JSON.parse(outcome.text.slice(outcome.text.indexOf("\n") + 1, outcome.text.lastIndexOf("\n</tool-result>"))) as Record<string, any>;
};
