import type { NotifyResult, PlatformAdapter } from "./types";

const warnedAdapters = new WeakSet<PlatformAdapter>();

/** Normalize delivery for Vigil without adapter-side buffering. Timeout does not cancel the send. */
export async function notifyWithResult(
  adapter: PlatformAdapter,
  text: string,
  { timeoutMs = 2000, buffer = false }: { timeoutMs?: number; buffer?: boolean } = {},
): Promise<NotifyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<NotifyResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ delivered: false, kind: "transient", code: "timeout" });
      }, timeoutMs);
    });
    const result = await Promise.race([adapter.notifyPrincipal(text, { buffer }), timeout]);
    if (result !== undefined) return result;

    if (!warnedAdapters.has(adapter)) {
      warnedAdapters.add(adapter);
      console.warn("adapter reports no delivery result; Vigil fallback cannot detect failures");
    }
    return { delivered: true };
  } catch (err) {
    return {
      delivered: false,
      kind: "transient",
      code: "exception",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
