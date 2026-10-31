import { Option, type Command } from "commander";
import { MyelinAgentProvider, NatsAgentTransport, type AgentTransport, type NatsAgentTransportOptions } from "pulse";
import { executeRoutineFlow, readRoutineFlow } from "../../../runner/pulse-flow";

export function registerPulseFlowCommand(program: Command, dependencies: {
  connect?: (options: NatsAgentTransportOptions) => Promise<AgentTransport & { close: () => Promise<void> }>;
  inventory?: () => Promise<unknown>;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): void {
  program.command("pulse-flow")
    .description("Execute a validated routine from a configured flow directory")
    .requiredOption("--flows-dir <path>", "Absolute allowed flow directory")
    .requiredOption("--flow <path>", "Absolute routine flow file")
    .addOption(new Option("--agent-provider <provider>", "Explicit agent routing provider").choices(["myelin"]))
    .action(async (options: { flowsDir: string; flow: string; agentProvider?: string }) => {
      try {
        if (!options.agentProvider) {
          await executeRoutineFlow({ ...options, inventory: dependencies.inventory });
          return;
        }
        await readRoutineFlow(options.flowsDir, options.flow);
        const env = dependencies.env ?? process.env;
        const principal = env.PULSE_PRINCIPAL;
        if (!principal) throw new Error("myelin agent provider requires PULSE_PRINCIPAL");
        const transport = await (dependencies.connect ?? NatsAgentTransport.connect)({
          servers: env.PULSE_NATS_URL, credentials: env.PULSE_NATS_CREDS, name: "cortex-pulse-flow",
        });
        try {
          const agentProvider = new MyelinAgentProvider({ transport, principal, stack: env.PULSE_STACK });
          await executeRoutineFlow({ ...options, inventory: dependencies.inventory, runtime: { agentProvider } });
        } finally {
          await transport.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`pulse-flow: ${message.replace(/[\r\n]+/g, " ")}\n`);
        process.exitCode = 1;
      }
    });
}
