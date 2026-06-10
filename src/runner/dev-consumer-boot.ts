/**
 * F-2.1 (cortex#835) — boot wiring for the `dev.implement` capability
 * consumer + the production shell-backed seams.
 *
 * **THE DORMANCY CONTRACT (the hard safety guarantee).** `wireDevConsumers`
 * returns an EMPTY array when no agent declares a `dev.implement*` capability
 * in `runtime.capabilities[]` — and does so WITHOUT touching the filesystem,
 * spawning anything, or reading any token. Every live stack today declares
 * none, so this entire module is inert on boot for them: byte-identical
 * behaviour to before F-2. Only a stack that explicitly opts an agent into
 * `dev.implement` brings any of this code to life.
 *
 * Extracted from `cortex.ts` (mirroring how complex boot blocks are factored)
 * so the dormancy decision + the seam construction are unit-testable in
 * isolation — see `__tests__/dev-consumer-boot.test.ts`.
 *
 * **Authority model (§3.5b).** The forge seam pushes branches + opens PRs
 * with a SCOPED forge identity, never the principal's ambient PAT. The token
 * is read from the env var named by `dev_gh_token_env` (default
 * `CORTEX_DEV_GH_TOKEN`). When that env var is UNSET the consumer falls back
 * to ambient `gh` auth — and emits a LOUD boot warning citing the design's
 * accepted-risk note, because ambient authority on the principal's own machine
 * is the residual risk F-5b's sandboxing retires. The warning is the honest
 * F-2 caveat made visible at boot, not buried.
 *
 * **Session guardrails — REVIEW PARITY (§3.5b "guardrails from the agent
 * manifest").** The dev CC session is the HIGHER-authority path (it writes
 * code + pushes), so it MUST be at least as guarded as the review session.
 * `buildDevSessionOpts` threads the same `config.claude` guardrails the review
 * path uses (`bashAllowlist` + `allowedTools` + `allowedDirs` + async timeout),
 * and — critically — sets `groveChannel`, the env var (`CORTEX_CHANNEL`) that
 * is `bash-guard.hook.ts`'s Gate-1 ENGAGEMENT precondition. Without a channel
 * the guard `pass()`-es through on every Bash command; the original wiring
 * omitted it, so the guard disengaged on the push path (the review BLOCKER this
 * fixes). When the agent declares no allowlist, a conservative repo-shaped
 * default ({@link DEFAULT_DEV_BASH_ALLOWLIST}) applies — the session is STILL
 * guarded, never unrestricted.
 *
 * **Stream provisioning — FLAGGED for the PR body.** The review path
 * provisions a `CODE_REVIEW` JetStream stream + per-agent durable up-front
 * (`bus/jetstream/provision.ts`). The dev path needs the equivalent for
 * `tasks.dev.implement`. This module wires the consumer's `subscribePull`
 * binding (dormant-safe: null runtime → DORMANT, no bind), but does NOT
 * provision a `DEV_IMPLEMENT` stream — that is deliberately deferred to a
 * sibling slice so this PR stays "one mergeable, dormant-by-default
 * consumer." A dev-capable agent on a live bus therefore needs the stream
 * provisioned alongside (the FLAG). Because no agent declares the capability
 * yet, nothing binds yet, so the deferral changes no live behaviour.
 */

import { spawn } from "child_process";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { DispatchEventSource } from "../bus/dispatch-events";
import type { CCSessionOpts } from "./cc-session";
import { CCSession } from "./cc-session";
import {
  DevConsumer,
  type DevConsumerAgent,
  type DevWorkspace,
  type DevCommandRunner,
  type DevCommandResult,
  type DevForge,
  type DevPrRef,
} from "./dev-consumer";
import { FileDevSessionStore, type DevSessionStore } from "./dev-session-store";

export { DevConsumer } from "./dev-consumer";

// ---------------------------------------------------------------------------
// The narrow agent shape the boot wiring consumes
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a cortex.yaml `Agent` the boot wiring needs — kept
 * structural (not the full Zod `Agent`) so the boot test builds fixtures
 * cheaply, and so `cortex.ts` can pass `mergedAgents` (which satisfies this
 * shape) without a cast.
 */
export interface DevBootAgent {
  id: string;
  displayName?: string;
  runtime?: {
    capabilities?: readonly string[];
    maxConcurrent?: number;
  };
}

/**
 * §3.5b guardrail source — the narrow projection of `AgentConfig.claude` the
 * dev session needs to reach review-path PARITY. Kept structural (not the full
 * Zod config) so `cortex.ts` passes `config.claude` directly and the boot test
 * builds a fixture cheaply. Every field optional: an absent block means "apply
 * the conservative defaults" (worktree-only `allowedDirs`, a repo-conventional
 * bash allowlist) so the higher-authority push session is NEVER less-guarded
 * than the review session.
 */
export interface DevGuardrailConfig {
  /** Bash command allowlist (`bash-guard.hook.ts` shape). */
  bashAllowlist?: {
    rules: { pattern: string; repos?: string[] }[];
    repos: string[];
  };
  /** Tools the session may use (e.g. Bash/Read/Edit/Write/gh). */
  allowedTools?: string[];
  /** Tools to deny (applied on top of `allowedTools`). */
  disallowedTools?: string[];
  /** Read+write dirs. Empty/absent → the consumer defaults to the worktree. */
  allowedDirs?: string[];
  /** Async-task timeout (dev work is long-running). */
  asyncTimeoutMs?: number;
  /** Extra args threaded to `claude`. */
  additionalArgs?: string[];
}

/** Inputs `cortex.ts` threads into the boot wiring. */
export interface WireDevConsumersOpts {
  agents: readonly DevBootAgent[];
  runtime: MyelinRuntime;
  source: DispatchEventSource;
  /** `{principal}` subject segment — for the durable name. */
  principalId: string;
  /** `{stack}` subject segment — for the subscribe pattern. */
  stack: string;
  /**
   * §3.5b guardrail config (review parity). `cortex.ts` passes `config.claude`;
   * the boot test passes a fixture. Omitted → conservative defaults only.
   */
  guardrails?: DevGuardrailConfig;
  /** Repo-root worktrees are cut from; defaults to `process.cwd()`. */
  repoRoot?: string;
  /**
   * Warm-session store path. Defaults to
   * `~/.config/cortex/dev-warm-sessions.json`. The file-backed store is the
   * §3.6b durability bridge until F-3's agent-state store lands.
   */
  sessionStorePath?: string;
  /** Env var name carrying the scoped forge token. Default `CORTEX_DEV_GH_TOKEN`. */
  devGhTokenEnv?: string;
  /** Test seam — env lookup. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Test seam — fully override the seams so the boot test asserts wiring +
   * dormancy WITHOUT real git/gh/CC. Production omits this; the shell-backed
   * seams below are used.
   */
  seamsOverride?: {
    workspace: DevWorkspace;
    commandRunner: DevCommandRunner;
    forge: DevForge;
    sessionStore: DevSessionStore;
  };
  /** Optional logger. Defaults to `console`. */
  log?: { info: (m: string) => void; warn: (m: string) => void };
}

const DEFAULT_TOKEN_ENV = "CORTEX_DEV_GH_TOKEN";

/** True when the agent claims `dev.implement` (exact) or the bare `dev` family. */
function claimsDevImplement(agent: DevBootAgent): boolean {
  const caps = agent.runtime?.capabilities ?? [];
  return caps.includes("dev.implement") || caps.includes("dev");
}

/**
 * Build (but do NOT start) the dev consumers for every dev-implement-capable
 * agent. Returns an EMPTY array — touching nothing — when none qualify (the
 * dormancy contract). The caller (`cortex.ts`) then `start()`s each and lands
 * them in the shutdown-drain list.
 */
export function wireDevConsumers(opts: WireDevConsumersOpts): DevConsumer[] {
  const log = opts.log ?? console;
  const capable = opts.agents.filter(claimsDevImplement);
  if (capable.length === 0) {
    // DORMANCY: no dev-capable agent → no seams, no token read, no FS, no
    // consumers. Byte-identical boot. Silent — there is nothing to warn about
    // (a stack with no dev agent is the normal, expected shape today).
    return [];
  }

  const env = opts.env ?? process.env;
  const tokenEnv = opts.devGhTokenEnv ?? DEFAULT_TOKEN_ENV;
  const scopedToken = env[tokenEnv];

  // §3.5b authority — loud boot warning when the dev agent will push with
  // AMBIENT authority instead of a scoped forge identity. This is the honest
  // F-2 caveat surfaced, not hidden.
  if (scopedToken === undefined || scopedToken.length === 0) {
    log.warn(
      `cortex: dev.implement consumer wired WITHOUT a scoped forge token ` +
        `(${tokenEnv} unset) — it will push branches + open PRs using AMBIENT gh ` +
        `authority. Per docs/design-agentic-dev-pipeline.md §3.5b this residual ` +
        `risk is accepted for v1 on the principal's OWN stacks (identical to the ` +
        `in-session posture) and is what F-5b sandboxing retires. Set ${tokenEnv} ` +
        `to a repo-scoped machine-user token to bound it.`,
    );
  } else {
    log.info(
      `cortex: dev.implement consumer using scoped forge identity from ${tokenEnv} (§3.5b)`,
    );
  }

  const repoRoot = opts.repoRoot ?? process.cwd();
  const seams =
    opts.seamsOverride ??
    buildShellSeams({
      repoRoot,
      sessionStorePath:
        opts.sessionStorePath ??
        `${env.HOME ?? "."}/.config/cortex/dev-warm-sessions.json`,
      scopedToken,
      env,
    });

  const consumers: DevConsumer[] = [];
  for (const agent of capable) {
    const consumerAgent: DevConsumerAgent = {
      id: agent.id,
      capabilities: agent.runtime?.capabilities ?? [],
      ...(agent.runtime?.maxConcurrent !== undefined && {
        maxConcurrent: agent.runtime.maxConcurrent,
      }),
    };
    const sessionOpts = buildDevSessionOpts(agent, opts.guardrails);
    consumers.push(
      new DevConsumer({
        agent: consumerAgent,
        source: opts.source,
        runtime: opts.runtime,
        // Real CC session — spawns `claude` in the worktree. Only reached when
        // a `dev.implement` task actually arrives for this agent.
        ccSessionFactory: (o) => new CCSession(o),
        promptBuilder: ({ payload }) =>
          // Dispatch INTENT, not method (DD-P3): hand the brief; the agent's
          // persona owns HOW. The brief already carries the issue/design refs.
          payload.brief,
        workspace: seams.workspace,
        commandRunner: seams.commandRunner,
        forge: seams.forge,
        sessionStore: seams.sessionStore,
        sessionOpts,
      }),
    );
  }
  return consumers;
}

/**
 * The conservative repo-shaped bash allowlist applied when the agent's config
 * declares none. Mirrors the shape `bash-guard.hook.ts` enforces: read-only +
 * dev-loop commands (git, gh, bun, tsc/eslint/test gates) are matched; anything
 * else is denied. NOT permissive — a dev session with no declared allowlist is
 * STILL guarded (the security-first default), it just gets a sensible baseline
 * instead of an empty one (which would deny everything and stall the session).
 *
 * `repos: []` means the gh-repo restriction is "any repo the push target names"
 * — the dev agent legitimately pushes to whatever repo the task addressed; the
 * forge identity (scoped token, §3.5b) is the authority bound, not this list.
 */
export const DEFAULT_DEV_BASH_ALLOWLIST: {
  rules: { pattern: string; repos?: string[] }[];
  repos: string[];
} = {
  rules: [
    { pattern: "^git( |$)" },
    { pattern: "^gh( |$)" },
    { pattern: "^bun( |x)?( |$)" },
    { pattern: "^(npx |)tsc( |$)" },
    { pattern: "^(npx |bunx |)eslint( |$)" },
    { pattern: "^(ls|cat|head|tail|rg|grep|find|pwd|echo|test|true|mkdir|cd)( |$)" },
  ],
  repos: [],
};

/**
 * Build the dev CC session opts at REVIEW PARITY (§3.5b — guardrails from the
 * agent manifest). Exported so `__tests__/dev-consumer-boot.test.ts` can assert
 * the guardrails are wired without standing up `startCortex`.
 *
 * **The load-bearing field is `groveChannel`.** `cc-session.ts` maps it to the
 * `CORTEX_CHANNEL` env var, which is `bash-guard.hook.ts`'s Gate-1 ENGAGEMENT
 * precondition: without it the guard `pass()`-es through on every Bash command
 * (the disengagement the review found). We set it to the agent id so the guard
 * actually runs on this higher-authority push session.
 *
 * **`bashAllowlist` is always set** — to the config value when present, else
 * {@link DEFAULT_DEV_BASH_ALLOWLIST}. This is double-duty: it gives the guard
 * its rules AND it sets `CORTEX_BASH_GUARD`, which keeps the session OUT of
 * bash-guard Gate-2's CLI-bypass (`AGENT_ID && !CORTEX_BASH_GUARD` → pass).
 * We MUST NOT set `bashGuardDisabled`.
 *
 * `allowedDirs` is left to the config (when declared); when absent the CONSUMER
 * defaults it to the per-task worktree (the worktree path isn't known at boot).
 */
export function buildDevSessionOpts(
  agent: DevBootAgent,
  guardrails: DevGuardrailConfig | undefined,
): Partial<Omit<CCSessionOpts, "prompt" | "cwd" | "resumeSessionId">> {
  const g = guardrails ?? {};
  const opts: Partial<Omit<CCSessionOpts, "prompt" | "cwd" | "resumeSessionId">> = {
    agentId: agent.id,
    // bash-guard Gate-1 engagement precondition — without a channel the guard
    // disengages. The agent id is a stable, non-PII channel label for the
    // headless dev session (it has no Discord/Mattermost surface).
    groveChannel: agent.id,
    // Always guarded: config allowlist or the conservative repo-shaped default.
    // Setting this ALSO keeps the session out of the Gate-2 CLI-bypass.
    bashAllowlist: g.bashAllowlist ?? DEFAULT_DEV_BASH_ALLOWLIST,
    ...(agent.displayName !== undefined && { agentName: agent.displayName }),
    ...(g.allowedTools !== undefined && g.allowedTools.length > 0 && {
      allowedTools: g.allowedTools,
    }),
    ...(g.disallowedTools !== undefined && g.disallowedTools.length > 0 && {
      disallowedTools: g.disallowedTools,
    }),
    ...(g.allowedDirs !== undefined && g.allowedDirs.length > 0 && {
      allowedDirs: g.allowedDirs,
    }),
    ...(g.asyncTimeoutMs !== undefined && { timeoutMs: g.asyncTimeoutMs }),
    ...(g.additionalArgs !== undefined && g.additionalArgs.length > 0 && {
      additionalArgs: g.additionalArgs,
    }),
  };
  return opts;
}

/** Subscribe pattern for a dev consumer: `local.{principal}.{stack}.tasks.dev.implement`. */
export function devSubjectPattern(principalId: string, stack: string): string {
  return `local.${principalId}.${stack}.tasks.dev.implement`;
}

/** Durable name for a dev consumer: `cortex-dev-consumer-{principal}-{agent}`. */
export function devDurableName(principalId: string, agentId: string): string {
  return `cortex-dev-consumer-${principalId}-${agentId}`;
}

// ---------------------------------------------------------------------------
// Shell-backed production seams
// ---------------------------------------------------------------------------

interface ShellSeamsOpts {
  repoRoot: string;
  sessionStorePath: string;
  scopedToken: string | undefined;
  env: Record<string, string | undefined>;
}

interface BuiltSeams {
  workspace: DevWorkspace;
  commandRunner: DevCommandRunner;
  forge: DevForge;
  sessionStore: DevSessionStore;
}

/**
 * Construct the production seams that drive real `git worktree`, gate
 * commands, and `gh pr create`. Constructed ONLY when a dev-capable agent
 * exists (the dormancy contract) — `buildShellSeams` itself does no I/O; the
 * I/O happens inside the seam methods when a task arrives.
 */
function buildShellSeams(opts: ShellSeamsOpts): BuiltSeams {
  const slugify = (branch: string): string =>
    branch.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "dev";

  const workspace: DevWorkspace = {
    create: async ({ branch, base, chainId }) => {
      // Worktree-discipline SOP: `../Cortex-{slug}` cut from origin/{base}.
      const slug = `${slugify(branch)}-${chainId.slice(0, 8)}`;
      const path = `${opts.repoRoot}/../Cortex-${slug}`;
      await run(
        "git",
        ["worktree", "add", path, "-b", branch, `origin/${base}`],
        { cwd: opts.repoRoot, env: opts.env },
      );
      return { path };
    },
    remove: async ({ path }) => {
      await run("git", ["worktree", "remove", "--force", path], {
        cwd: opts.repoRoot,
        env: opts.env,
      });
    },
  };

  const commandRunner: DevCommandRunner = {
    run: async ({ command, cwd }): Promise<DevCommandResult> => {
      // Gate commands are full shell strings (e.g. `bunx tsc --noEmit`);
      // run via the shell so pipes/globs in a gate string work.
      const res = await run("bash", ["-lc", command], {
        cwd,
        env: opts.env,
        allowFailure: true,
      });
      return res.code === 0
        ? { ok: true }
        : { ok: false, output: `${res.stdout}\n${res.stderr}`.trim() };
    },
  };

  const forge: DevForge = {
    openPr: async ({ branch, base, cwd, title, issue, brief }): Promise<DevPrRef> => {
      // §3.5b — push + PR with the SCOPED token when provided (injected into
      // the child env as GH_TOKEN), never the principal's ambient PAT unless
      // the scoped token is absent (the warned ambient-fallback path).
      const childEnv: Record<string, string | undefined> = { ...opts.env };
      if (opts.scopedToken !== undefined && opts.scopedToken.length > 0) {
        childEnv.GH_TOKEN = opts.scopedToken;
      }
      await run("git", ["push", "-u", "origin", branch], { cwd, env: childEnv });
      const body = issue !== undefined ? `${brief}\n\nCloses #${issue}` : brief;
      const args = [
        "pr",
        "create",
        "--base",
        base,
        "--head",
        branch,
        "--title",
        title ?? branch,
        "--body",
        body,
      ];
      const res = await run("gh", args, { cwd, env: childEnv });
      const url = res.stdout.trim().split("\n").pop() ?? "";
      const number = parsePrNumber(url);
      // `gh repo view` is avoided; derive `owner/name` from the PR URL.
      const repo = parseRepoFromUrl(url) ?? "";
      return { repo, number, url };
    },
  };

  const sessionStore = new FileDevSessionStore(opts.sessionStorePath);
  return { workspace, commandRunner, forge, sessionStore };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process, capturing stdout/stderr. Rejects on a non-zero exit
 * UNLESS `allowFailure` (gate commands resolve with the code instead). Uses
 * `child_process.spawn` (not `Bun.spawn`) so the seam stays portable and the
 * boot test never needs Bun-specific stubbing — though the seam is only ever
 * reached when a dev task actually arrives.
 */
function run(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    allowFailure?: boolean;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      const result: RunResult = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited ${result.code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

/** Parse the PR number from a `gh pr create` URL (`.../pull/57`). */
function parsePrNumber(url: string): number {
  const m = /\/pull\/(\d+)\/?$/.exec(url.trim());
  return m ? Number(m[1]) : 0;
}

/** Derive `owner/name` from a GitHub PR URL. */
function parseRepoFromUrl(url: string): string | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
