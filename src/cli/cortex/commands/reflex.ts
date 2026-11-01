import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { loadProcessSpec } from "../../../bus/process-runner";
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

export async function reflexRemovalTargets(configPath: string): Promise<ExitResult> {
  try {
    const loaded = loadConfigWithAgents(configPath);
    const directory = process.env.CORTEX_PROCESSES_DIR ?? join(dirname(configPath), "processes");
    const targets: { target: string; flowRoot: string }[] = [];
    for (const entry of loaded.reflexActivation?.targets ?? []) {
      if (entry.handler !== "process" || !entry.process) continue;
      try {
        const spec = await loadProcessSpec(directory, entry.process);
        const root = spec.snapshot_inputs?.flow;
        if (root && spec.argv.some((argument) => argument === "{flow}")) targets.push({ target: entry.target, flowRoot: root });
      } catch { continue; }
    }
    return { exitCode: 0, stdout: `${JSON.stringify({ targets })}\n`, stderr: "" };
  } catch { return { exitCode: 1, stdout: "", stderr: "Unable to verify configured execution input lifetime\n" }; }
}

export function registerReflexCommand(program: Command): void {
  program.command("reflex").description("Inspect configured Reflex execution targets")
    .command("targets")
    .description("Read target references from the composed stack config without starting the runtime")
    .option("--config <path>", "Stack config file or split-config pointer", resolveConfigFilePath("cortex.yaml"))
    .option("--json", "Print only the target references as JSON")
    .option("--removal-safe", "Verify targets that snapshot owned flow inputs")
    .action(async (options: { config: string; json?: boolean; removalSafe?: boolean }) => {
      const configPath = options.config.startsWith("~/") ? join(homedir(), options.config.slice(2)) : options.config;
      const result = options.removalSafe ? await reflexRemovalTargets(configPath) : reflexTargets(configPath, Boolean(options.json));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
