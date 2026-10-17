import { runBoundedProcess } from "../bus/process-runner";

export interface ProposalCommandOptions {
  timeout_ms: number;
  env: Record<string, string>;
}

export type ProposalCommandRunner = (
  argv: string[], options: ProposalCommandOptions,
) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>;

export interface ProposalFilingOptions {
  proposal_token_env?: string;
  proposal_timeout_ms?: number;
  somaHome?: string;
  env?: Record<string, string | undefined>;
  run?: ProposalCommandRunner;
}

export const runProposalCommand: ProposalCommandRunner = async (argv, options) => {
  let stdout = Promise.resolve("");
  let cancelOutput: (() => Promise<void>) | undefined;
  const result = await runBoundedProcess(argv, {
    timeout_ms: options.timeout_ms,
    sigkillGraceMs: 0,
    spawn: (cmd) => {
      const proc = Bun.spawn(cmd, { env: options.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const reader = proc.stdout.getReader();
      cancelOutput = async () => { await reader.cancel(); };
      stdout = (async () => {
        const decoder = new TextDecoder();
        let output = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return output + decoder.decode();
          output += decoder.decode(chunk.value, { stream: true });
        }
      })();
      return { exited: proc.exited, kill: (signal) => { proc.kill(signal as never); } };
    },
  });
  if (!result.ok) await cancelOutput?.();
  const output = await stdout;
  return result.ok ? { ok: true, stdout: output } : result;
};

export async function fileProposal(
  ref: string, options: ProposalFilingOptions,
): Promise<{ filed: string } | { error: string; status: number }> {
  const path = ref.slice("soma:".length);
  if (!ref.startsWith("soma:") || !path || path.startsWith("/")
    || path.split("/").includes("..") || path.includes("\\") || path.includes("\0")) {
    return { error: "invalid proposal_ref", status: 400 };
  }
  const parentEnv = options.env ?? process.env;
  const token = options.proposal_token_env ? parentEnv[options.proposal_token_env] : undefined;
  if (!token?.trim()) return { error: "no proposal token configured", status: 503 };
  const env: Record<string, string> = { GH_TOKEN: token };
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "SOMA_HOME"]) {
    const value = parentEnv[key];
    if (value !== undefined && key !== options.proposal_token_env) env[key] = value;
  }
  if (options.somaHome) env.SOMA_HOME = options.somaHome;
  try {
    const result = await (options.run ?? runProposalCommand)(["soma", "graph", "file-proposal", ref, "--json"], {
      timeout_ms: options.proposal_timeout_ms ?? 30_000, env,
    });
    if (!result.ok) {
      const error = result.reason.startsWith("timeout-") ? "proposal filing timed out"
        : /^exit-\d+$/.test(result.reason) ? "proposal filing exited non-zero" : "proposal filing failed";
      return { error, status: error === "proposal filing timed out" ? 504 : 502 };
    }
    if (result.stdout.includes(token)) return { error: "invalid proposal filing JSON", status: 502 };
    const output: unknown = JSON.parse(result.stdout);
    if (typeof output !== "object" || output === null || !("ref" in output) || typeof output.ref !== "string"
      || !("created" in output) || typeof output.created !== "boolean") {
      return { error: "invalid proposal filing JSON", status: 502 };
    }
    return { filed: output.ref };
  } catch {
    return { error: "proposal filing failed or returned invalid JSON", status: 502 };
  }
}
