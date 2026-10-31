import type { Command } from "commander";
import { parseSourceOutput } from "../../../surface/mc/desk/sources/command";
import type { ExitResult } from "./_shared/exit-result";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function checkSourceOutput(text: string): ExitResult {
  try {
    const parsed = parseSourceOutput(text);
    const kept = `The Desk reads ${plural(parsed.events.length, "event", "events")} and ${plural(parsed.mail.length, "mail item", "mail items")}.`;
    if (parsed.problems.length === 0) return { exitCode: 0, stdout: `${kept}\n`, stderr: "" };
    const dropped = parsed.dropped > 0 ? ` It drops ${plural(parsed.dropped, "entry", "entries")}:` : " It reports:";
    return { exitCode: 1, stdout: "", stderr: `${kept}${dropped}\n${parsed.problems.map((p) => `  ${p}\n`).join("")}` };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `The source ${error instanceof Error ? error.message : String(error)}.\n` };
  }
}

async function readInput(file: string | undefined): Promise<string> {
  if (file && file !== "-") return Bun.file(file).text();
  return new Response(Bun.stdin.stream()).text();
}

export function registerDeskCommand(program: Command): void {
  program
    .command("desk")
    .description("Tools for the Mission Control Desk")
    .command("check-source")
    .description("Check a Desk source's output against the source contract; reads a file, or stdin when no file or - is given")
    .argument("[file]", "a file holding the source's output")
    .action(async (file: string | undefined) => {
      let result: ExitResult;
      try {
        result = checkSourceOutput(await readInput(file));
      } catch (error) {
        result = { exitCode: 1, stdout: "", stderr: `Could not read ${file ?? "stdin"}: ${error instanceof Error ? error.message : String(error)}\n` };
      }
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
