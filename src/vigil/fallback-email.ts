import { runBoundedProcess } from "../bus/process-runner";
import type { VigilSchema } from "../common/types/config";
import type { z } from "zod";

export type VigilFallback = (subject: string, body: string) => Promise<{ ok: boolean; error?: string }>;

export function createVigilEmailFallback(
  config: Partial<Pick<z.infer<typeof VigilSchema>, "fallback">>,
  options: { run?: typeof runBoundedProcess; warn?: (message: string) => void } = {},
): VigilFallback | null {
  const email = config.fallback?.email;
  if (!email) {
    (options.warn ?? console.warn)("Vigil: no vigil.fallback.email configured; undelivered DMs remain pending");
    return null;
  }
  const run = options.run ?? runBoundedProcess;
  return async (subject, body) => {
    try {
      const result = await run([
        email.command, "send", "-a", email.account, "-t", email.to,
        "-s", subject, "-b", body, "--no-markdown",
      ], { timeout_ms: email.timeout_ms });
      if (result.ok) return { ok: true };
      const error = result.reason.startsWith("timeout-") ? "timeout"
        : /^exit-\d+$/.test(result.reason) ? result.reason.replace(/^exit-/, "exit ") : "fallback-failed";
      return { ok: false, error };
    } catch {
      return { ok: false, error: "exception" };
    }
  };
}
