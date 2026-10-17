import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isContainedIn } from "../common/path-containment";
import { readSomaOutput, somaHome } from "./soma-output";
import type { GoalWordingResolver } from "./goal-wording";
import type { VigilResultRow } from "./results";

export const DEFAULT_RESULT_BASE_URL = "http://127.0.0.1:8767";
export { somaHome } from "./soma-output";

async function firstBodyLine(root: string, relative: string): Promise<string | null> {
  try {
    const base = await realpath(root);
    const path = await realpath(join(base, relative));
    if (!isContainedIn(base, path)) return null;
    const content = await readFile(path, "utf8");
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    return body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim().replace(/^#+\s+/, "") ?? null;
  } catch {
    process.stderr.write("Vigil: local wording unavailable; using reference\n");
    return null;
  }
}

export function somaGoalWording(home = somaHome()): GoalWordingResolver {
  return (id) => /^G\d+$/.test(id) ? firstBodyLine(join(home, "profile", "goals"), `${id}.md`) : null;
}

export interface ResultRenderOptions {
  somaHome?: string;
  resultBaseUrl?: string;
  resolveGoalWording?: GoalWordingResolver;
}

export async function resultPresentation(result: VigilResultRow, options: ResultRenderOptions): Promise<{ label: string; url: string }> {
  const home = options.somaHome ?? somaHome();
  const content = await readSomaOutput(result.result_ref, home);
  const title = content?.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .split(/\r?\n/).find((line) => line.trim() !== "")?.trim().replace(/^#+\s+/, "") ?? result.result_ref;
  let goal: string | null = null;
  if (result.goal_id) {
    try {
      goal = await (options.resolveGoalWording ?? somaGoalWording(home))(result.goal_id) ?? result.goal_id;
    } catch {
      process.stderr.write("Vigil: result goal wording unavailable; using goal ID\n");
      goal = result.goal_id;
    }
  }
  const url = `${(options.resultBaseUrl ?? DEFAULT_RESULT_BASE_URL).replace(/\/$/, "")}/results/${encodeURIComponent(result.result_ref)}`;
  return { label: `${goal ? `${goal} — ` : ""}${result.version > 1 ? "updated: " : ""}${title}`.replace(/[\r\n]+/g, " "), url };
}

export async function renderResult(result: VigilResultRow, options: ResultRenderOptions): Promise<string> {
  const { label, url } = await resultPresentation(result, options);
  return `${label} — ${url}`;
}
