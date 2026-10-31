import { Command } from "commander";
import { loadConfigWithAgents } from "../../../common/config/loader";
import { resolveConfigFilePath } from "../../../common/config/config-path";
import type { ExitResult } from "./_shared/exit-result";

export function reflexTargets(configPath: string, json: boolean): ExitResult {
  try {
    const loaded = loadConfigWithAgents(configPath);
    const targets = [...new Set((loaded.reflexActivation?.targets ?? []).map((entry) => entry.target))].sort();
    return { exitCode: 0, stdout: json ? `${JSON.stringify({ targets })}\n` : `${targets.join("\n")}\n`, stderr: "" };
  } catch {
    return { exitCode: 1, stdout: "", stderr: "reflex targets: unable to load configured target registry; validate the selected Cortex config\n" };
  }
}

export function registerReflexCommand(program: Command): void {
  program.command("reflex").description("Inspect configured Reflex execution targets")
    .command("targets")
    .description("Read target references from the composed stack config without starting the runtime")
    .option("--config <path>", "Stack config file or split-config pointer", resolveConfigFilePath("cortex.yaml"))
    .option("--json", "Print only the target references as JSON")
    .action((options: { config: string; json?: boolean }) => {
      const result = reflexTargets(options.config, Boolean(options.json));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
