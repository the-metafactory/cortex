import { DEFAULT_RESULT_BASE_URL } from "../common/result-base-url";
import type { GoalWordingResolver } from "./goal-wording";
import type { VigilResultRow } from "./results";
import { readSomaGoalTitle, readSomaOutputTitle, somaHome } from "./soma-output";

async function goalWording(id: string, home: string): Promise<string | null> {
  const wording = await readSomaGoalTitle(id, home);
  if (wording !== null) return wording;
  process.stderr.write("Vigil: local wording unavailable; using reference\n");
  return null;
}

export function somaGoalWording(homes: Readonly<Record<string, string>>): GoalWordingResolver {
  return (id, stack) => {
    const home = Object.hasOwn(homes, stack) ? homes[stack] : undefined;
    return home && /^G\d+$/.test(id) ? goalWording(id, home) : null;
  };
}

export interface ResultRenderOptions {
  somaHome?: string;
  resultBaseUrl?: string;
  resolveGoalWording?: GoalWordingResolver;
}

export async function resultPresentation(result: VigilResultRow, options: ResultRenderOptions): Promise<{ label: string; url: string }> {
  const home = options.somaHome ?? somaHome();
  const title = (await readSomaOutputTitle(result.result_ref, home)) ?? result.result_ref;
  let goal: string | null = null;
  if (result.goal_id) {
    try {
      const resolver = options.resolveGoalWording ?? somaGoalWording(options.somaHome ? { default: options.somaHome } : {});
      goal = await resolver(result.goal_id, result.source_stack ?? "") ?? result.goal_id;
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
