import { Command } from "commander";
import { loadConfigWithAgents } from "../../../common/config/loader";
import { resolveConfigFilePath } from "../../../common/config/config-path";
import { buildNatsTlsOptions } from "../../../common/config/transport-mtls";
import { NatsLink } from "../../../bus/nats/connection";
import { jetstreamClientOptions } from "../../../bus/jetstream/boot-retry";
import { createLedgerStream } from "../../../bus/jetstream/ledger-stream";
import { errorMessage, ledgerArchiveDir, readLedgerArchive, verifyLedgerArchive } from "../../../bus/jetstream/ledger-archive";
import type { ExitResult } from "./_shared/exit-result";

export async function verifyArchiveCommand(configPath: string): Promise<ExitResult> {
  try {
    const { config } = loadConfigWithAgents(configPath);
    if (!config.nats?.url) throw new Error("Stack has no NATS URL configured");
    const directory = ledgerArchiveDir(config.ledger.archive_dir);
    const archived = readLedgerArchive(directory);
    const link = await NatsLink.connect({
      url: config.nats.url,
      token: config.nats.token,
      credsPath: config.nats.credsPath,
      tls: buildNatsTlsOptions(config.security.transport.mtls, config.security.transport.tls, { site: "ledger archive verify" }),
      name: "cortex-ledger-archive-verify",
      maxReconnectAttempts: 0,
    });
    try {
      const options = jetstreamClientOptions(config.nats.jetstreamTimeoutMs);
      const stream = createLedgerStream(link.raw.jetstream(options), await link.raw.jetstreamManager(options));
      const result = verifyLedgerArchive(archived, await stream.sequences());
      const lines = [
        `Archive: ${directory}`,
        `First archived sequence: ${result.first ?? "none"}`,
        `Last archived sequence: ${result.last ?? "none"}`,
        ...result.missing.map((range) => `Missing ${range.first}-${range.last} (${range.retained ? "still held by stream" : "no longer held by stream"})`),
      ];
      if (result.missing.length === 0) lines.push("No missing range.");
      return { exitCode: result.ok ? 0 : 1, stdout: `${lines.join("\n")}\n`, stderr: "" };
    } finally {
      await link.close();
    }
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `ledger archive verify: ${errorMessage(error)}\n` };
  }
}

export function registerLedgerCommand(program: Command): void {
  program.command("ledger")
    .description("Inspect the durable LEDGER archive")
    .command("archive")
    .description("Inspect archived LEDGER history")
    .command("verify")
    .description("Report archive bounds and missing sequence ranges against the stream")
    .option("--config <path>", "Stack config YAML", resolveConfigFilePath("cortex.yaml"))
    .action(async (options: { config: string }) => {
      const result = await verifyArchiveCommand(options.config);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
