export class CommandTimeout extends Error {}

export interface CommandResult {
  code: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function outputText(stream: ReadableStream<Uint8Array>, limit?: number, signal?: AbortSignal): Promise<string> {
  if (limit === undefined && signal === undefined) return new Response(stream).text();
  let bytes = 0;
  return new Response(stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (limit !== undefined && bytes > limit) throw new Error("Command output exceeds its byte limit");
    controller.enqueue(chunk);
  } }), { signal })).text();
}

export async function runCommand(argv: string[], timeoutMs: number, stdin?: string, env?: Record<string, string | undefined>, ownGroup = false, options: { maxOutputBytes?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const proc = Bun.spawn(argv, { detached: ownGroup && process.platform !== "win32", stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const status = { expired: false, stopping: false };
  const outputAbort = options.signal || options.maxOutputBytes !== undefined ? new AbortController() : undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (ownGroup && process.platform !== "win32") process.kill(-proc.pid, signal);
      else if (proc.exitCode === null) proc.kill(signal);
    } catch { if (proc.exitCode === null) proc.kill(signal); }
  };
  const terminate = () => { if (!status.stopping) { status.stopping = true; signalGroup("SIGTERM"); } };
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => { reject(new Error("Command cancelled")); }; });
  const cancel = () => { terminate(); rejectAbort?.(); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      status.expired = true;
      terminate();
      killTimer = setTimeout(() => { signalGroup("SIGKILL"); reject(new CommandTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`)); }, 500);
    }, timeoutMs);
  });
  const finished = (async (): Promise<CommandResult> => {
    const [stdout, stderr, code] = await Promise.all([outputText(proc.stdout, options.maxOutputBytes, outputAbort?.signal), outputText(proc.stderr, options.maxOutputBytes, outputAbort?.signal), proc.exited]);
    if (status.expired) throw new CommandTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    return { code, signal: proc.signalCode ?? null, stdout, stderr };
  })();
  try {
    const result = await Promise.race([finished, timedOut, aborted]);
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", cancel);
    outputAbort?.abort();
    if (outputAbort && proc.exitCode === null) {
      terminate();
      await Promise.race([proc.exited, new Promise<void>((resolve) => { killTimer = setTimeout(resolve, 200); })]);
      clearTimeout(killTimer);
    }
    signalGroup("SIGKILL");
    if (options.signal || options.maxOutputBytes !== undefined) await proc.exited;
  }
}

export const runModelCommand = (argv: string[], timeoutMs: number, stdin?: string, env?: Record<string, string | undefined>) => runCommand(argv, timeoutMs, stdin, env, true);
