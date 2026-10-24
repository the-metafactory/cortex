import { ErrorCode, type JetStreamOptions } from "nats";
import { ReconnectBackoff } from "../nats/reconnect-backoff";

export const DEFAULT_JETSTREAM_API_TIMEOUT_MS = 10_000;

export interface JetstreamBootRetryOptions {
  budget?: { deadline?: number; exhausted: boolean };
  maxAttempts?: number;
  maxElapsedMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: { warn(line: string): void };
}

export function jetstreamClientOptions(
  timeoutMs = DEFAULT_JETSTREAM_API_TIMEOUT_MS,
  domain?: string,
): JetStreamOptions {
  return { timeout: timeoutMs, ...(domain !== undefined && { domain }) };
}

export function createJetstreamBootRetryOptions(
  options: JetstreamBootRetryOptions = {},
): JetstreamBootRetryOptions {
  return { ...options, budget: { exhausted: false } };
}

export function isJetstreamTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === ErrorCode.Timeout;
}

export class JetstreamBootTimeoutError extends Error {
  constructor(step: string, cause: unknown) {
    super(`JetStream boot step "${step}" exhausted timeout retries`, { cause });
    this.name = "JetstreamBootTimeoutError";
  }
}

export async function retryJetstreamBootStep<T>(
  step: string,
  action: () => Promise<T>,
  options: JetstreamBootRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8;
  const maxElapsedMs = options.maxElapsedMs ?? 180_000;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  const startedAt = now();
  const budget = options.budget;
  const deadline = budget
    ? (budget.deadline ??= startedAt + maxElapsedMs)
    : startedAt + maxElapsedMs;
  const backoff = new ReconnectBackoff();
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!isJetstreamTimeout(error)) throw error;
      const delay = backoff.nextDelay();
      if (budget?.exhausted || attempt >= maxAttempts || now() + delay >= deadline) {
        if (budget) budget.exhausted = true;
        log.warn(`cortex: degraded: ${step} — JetStream TIMEOUT after ${attempt} attempt(s); timeout retries exhausted; step unavailable`);
        throw new JetstreamBootTimeoutError(step, error);
      }
      log.warn(`cortex: ${step} — JetStream TIMEOUT; retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

export async function runJetstreamBootStep<T>(
  step: string,
  action: () => Promise<T>,
  options?: JetstreamBootRetryOptions,
): Promise<T | null> {
  try {
    return await retryJetstreamBootStep(step, action, options);
  } catch (error) {
    if (error instanceof JetstreamBootTimeoutError) return null;
    throw error;
  }
}
