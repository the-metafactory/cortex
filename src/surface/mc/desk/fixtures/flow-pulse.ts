import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WriterResult, WriterRunner } from "../create";

export interface FlowPulseRig {
  readonly dir: string;
  readonly home: string;
  readonly flowsDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pulse: string[];
  run(argv: readonly string[], stdin: string, timeout: number): Promise<WriterResult>;
  command(args: string[]): Promise<WriterResult>;
  savedCount(): Promise<number>;
  close(): Promise<void>;
}

export async function openFlowPulseRig(prefix = "desk-flow-pulse-"): Promise<FlowPulseRig> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const flowsDir = join(dir, "flows");
  await mkdir(home);
  await mkdir(bin);
  const arc = join(bin, "arc");
  await writeFile(arc, "#!/bin/sh\nprintf '%s\\n' '{\"packages\":[]}'\n");
  await chmod(arc, 0o700);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), PATH: bin };
  const pulse = [process.execPath, fileURLToPath(new URL("src/cli.ts", import.meta.resolve("pulse/package.json")))];
  const run: WriterRunner = (argv, _stdin, timeout) => new Promise((resolve, reject) => {
    const [binary, ...rest] = argv;
    if (binary === undefined) { reject(new Error("The Pulse command is empty.")); return; }
    execFile(binary, [...rest, "--flows-dir", flowsDir], { env, timeout, maxBuffer: 1048576 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(new Error(error.message, { cause: error })); return; }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
  const command = (args: string[]): Promise<WriterResult> => run([...pulse, "flow", ...args, "--json"], "", 8000);
  return {
    dir, home, flowsDir, env, pulse, run, command,
    savedCount: async () => (JSON.parse((await command(["list", "--saved"])).stdout) as { flows: unknown[] }).flows.length,
    async close() { await rm(dir, { recursive: true, force: true }); },
  };
}
