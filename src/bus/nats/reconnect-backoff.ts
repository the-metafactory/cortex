export interface ReconnectBackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
}

export class ReconnectBackoff {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  private delayMs: number;

  constructor(options?: ReconnectBackoffOptions) {
    this.initialMs = options?.initialMs ?? 1_000;
    this.maxMs = options?.maxMs ?? 30_000;
    this.factor = options?.factor ?? 2;
    this.delayMs = this.initialMs;
  }

  nextDelay(): number {
    const delay = this.delayMs;
    this.delayMs = Math.min(delay * this.factor, this.maxMs);
    return delay;
  }
}

export function initialConnectDelayHandler(backoff: ReconnectBackoff): () => number {
  let attemptAt: number | undefined;
  let retryAt: number | undefined;
  return () => {
    const now = Date.now();
    if (attemptAt === undefined || (retryAt !== undefined && now >= retryAt)) {
      attemptAt = now;
      retryAt = undefined;
      return 0;
    }
    retryAt ??= now + backoff.nextDelay();
    return retryAt - attemptAt;
  };
}
