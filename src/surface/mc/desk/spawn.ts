export class CommandTimeout extends Error {}

export interface CommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export async function runCommand(argv: string[], timeoutMs: number, stdin?: string, env?: Record<string, string | undefined>, ownGroup = false): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { detached: ownGroup && process.platform !== "win32", stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const status = { expired: false };
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (ownGroup && process.platform !== "win32") process.kill(-proc.pid, signal);
      else if (proc.exitCode === null) proc.kill(signal);
    } catch { if (proc.exitCode === null) proc.kill(signal); }
  };
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      status.expired = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => { signalGroup("SIGKILL"); reject(new CommandTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, 500);
    }, timeoutMs);
  });
  const finished = (async (): Promise<CommandResult> => {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (status.expired) throw new CommandTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    return { code, signal: proc.signalCode ?? null, stdout, stderr };
  })();
  try {
    const result = await Promise.race([finished, timedOut]);
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signalGroup("SIGKILL");
  }
}

export const runModelCommand = (argv: string[], timeoutMs: number, stdin?: string, env?: Record<string, string | undefined>) => runCommand(argv, timeoutMs, stdin, env, true);
