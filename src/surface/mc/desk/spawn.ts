export class CommandTimeout extends Error {}

export interface CommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export async function runCommand(argv: string[], timeoutMs: number, stdin?: string, env?: Record<string, string | undefined>): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new CommandTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const finished = (async (): Promise<CommandResult> => {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, signal: proc.signalCode ?? null, stdout, stderr };
  })();
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
