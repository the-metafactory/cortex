import { oneLine } from "./actions";
import { runRoutineCommand, type RoutineRunner } from "./routine-command";

export function splitNodeRef(ref: string): { repo: string; id: string } | null {
  const at = ref.lastIndexOf("#");
  const repo = ref.slice(0, at);
  const id = ref.slice(at + 1);
  return at <= 0 || !/^[1-9]\d*$/.test(id) ? null : { repo, id };
}

export function expandNodeCommand(argv: string[], ref: string, map: string): string[] | null {
  const parts = splitNodeRef(ref);
  if (!parts) return null;
  const values: Record<string, string> = { ref, repo: parts.repo, id: parts.id, map };
  return argv.map((arg) => arg.replaceAll(/\{(ref|repo|id|map)\}/g, (_match, key: string) => values[key] ?? ""));
}

export type NodeCommandResult = { ok: true; stdout: string } | { ok: false; error: string };

export async function runNodeCommand(input: { argv: string[]; ref: string; map: string; label: string; timeoutMs: number; run: RoutineRunner }): Promise<NodeCommandResult> {
  const argv = expandNodeCommand(input.argv, input.ref, input.map);
  if (!argv) return { ok: false, error: `the node reference ${input.ref} cannot be passed to the ${input.label} command.` };
  let result;
  try {
    result = await runRoutineCommand(input.run, argv, input.timeoutMs);
  } catch (error) {
    return { ok: false, error: `the ${input.label} command did not finish: ${error instanceof Error ? error.message : String(error)}` };
  }
  return result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false, error: oneLine(result.stderr || result.stdout, `the ${input.label} command exited with code ${result.code}.`) };
}
