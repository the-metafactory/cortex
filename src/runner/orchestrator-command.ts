/**
 * Operator-driven dev-loop — S1 (#1206): principal-gated orchestrator command
 * → `dev.implement` dispatch.
 *
 * See `docs/design-operator-driven-dev-loop.md`. This module is the in-process
 * meta-factory orchestrator's command boundary: when the orchestrator agent
 * receives a Discord message from the PRINCIPAL matching `implement {repo}#{N}`,
 * it publishes a `tasks.dev.implement` dispatch through the STACK's own runtime
 * (the [[use-stack-primitives]] rule) instead of spawning a `claude -p` chat
 * turn. The live `dev` consumer then claims it.
 *
 * **Trust-path gate (fail-closed).** The command is honored ONLY when the
 * sender is the principal (`authorIsPrincipal`, the non-spoofable PolicyEngine
 * principal-role check the adapter already computed off the authenticated
 * Discord author id). Every other sender → the command is ignored (no
 * dispatch). Mirrors the openOnboarding / admission gates.
 *
 * **Wire-protocol-native.** The envelope is built with the `dev-events`
 * builder (`createDevImplementRequestEvent`) and published via
 * `runtime.publish(envelope)`. cortex derives
 * `local.{principal}.{stack}.tasks.dev.implement` and zone-routes it — there is
 * NEVER a hand-spliced subject, a raw connection, or a hand-signed envelope
 * here (`compass/sops/federation-wire-protocol.md`).
 *
 * **Scope = S1 only.** This module recognises `implement {repo}#{N}` and
 * publishes the dispatch. The review leg (S2) and the fix-cycle + principal
 * merge gate (S3) are explicitly out of scope; the merge stays a human gate.
 *
 * Pure + injectable: the parser is side-effect-free, and the orchestrator entry
 * point takes the runtime + source + repo roster as inputs so the gate and the
 * publish path are unit-testable without an adapter, a daemon, or a live bus.
 */

import type { Envelope } from "../bus/myelin/envelope-validator";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import {
  createDevImplementRequestEvent,
  type DevEventSource,
  type DevImplementPayload,
  type LogicalResponseRouting,
} from "../bus/dev-events";

/**
 * The capability that marks an agent as the in-process dev-loop orchestrator
 * (e.g. vega). The agent fragment declares it under `runtime.capabilities[]`;
 * cortex surfaces it to the dispatch-handler so the orchestrator command
 * branch only ever activates for the orchestrator agent — never a chat agent.
 *
 * It is a ROUTING MARKER, not a bus-consumed capability: no consumer subscribes
 * to it. The orchestrator dispatches `dev.implement` (which the `dev` agent
 * provides); it does not itself run `claude -p`.
 */
export const ORCHESTRATOR_CAPABILITY = "dev.orchestrate";

/** A parsed `implement {repo}#{N}` command (verb already matched + stripped). */
export interface ImplementCommand {
  /** Repo token exactly as typed — short (`cortex`) or `owner/name`. */
  repoToken: string;
  /** Issue / PR number the work targets. */
  issue: number;
}

/**
 * `implement <repo>#<N>` grammar.
 *
 * The leading @-mention is already stripped by the Discord adapter
 * (`extractContent`) before the handler sees the text, so this anchors on the
 * verb. `repo` accepts either a short name (`cortex`) or an `owner/name`
 * (`the-metafactory/cortex`); the resolver below maps a short name to
 * `owner/name`. Trailing content after `<repo>#<N>` is tolerated (principals
 * follow the command with a comment) and not captured.
 *
 * Charset matches cortex's `github.repos` policy: ASCII letter/digit start,
 * then letters / digits / `_` / `-` / `.`, with an optional single `/owner`
 * split. Case-insensitive verb; the verb must be followed by whitespace so a
 * word like `implementation` does not match.
 */
const IMPLEMENT_PATTERN =
  /^\s*implement\s+([A-Za-z0-9][\w.-]*(?:\/[A-Za-z0-9][\w.-]*)?)#(\d+)\b/i;

/**
 * Parse a message body for the `implement {repo}#{N}` command. Pure — no I/O,
 * no runtime. Returns `null` when the text is not an implement command (the
 * caller then falls through to normal chat handling).
 */
export function parseImplementCommand(text: string): ImplementCommand | null {
  const match = IMPLEMENT_PATTERN.exec(text);
  if (!match) return null;
  const [, repoToken, issueStr] = match;
  if (!repoToken || !issueStr) return null;
  const issue = Number.parseInt(issueStr, 10);
  // The `\d+` capture guarantees a non-negative integer; reject 0 / overflow
  // so the downstream payload's positive-integer invariant holds.
  if (!Number.isInteger(issue) || issue <= 0) return null;
  return { repoToken, issue };
}

/**
 * Resolve a repo token to a canonical `owner/name` string against the known
 * repo roster (`getAllRepos(config)` — every `owner/name` the stack is
 * configured to act on).
 *
 *   - An `owner/name` token is accepted only when it is in the roster
 *     (fail-closed: the orchestrator never dispatches work against a repo the
 *     stack isn't configured for).
 *   - A short token (`cortex`) resolves to the single roster entry whose name
 *     half equals it; an ambiguous short name (two `{owner}/cortex` entries)
 *     resolves to `null` rather than guessing.
 *
 * Returns `null` when the token cannot be resolved unambiguously.
 */
export function resolveRepo(repoToken: string, knownRepos: readonly string[]): string | null {
  if (repoToken.includes("/")) {
    return knownRepos.includes(repoToken) ? repoToken : null;
  }
  const matches = knownRepos.filter((r) => {
    const name = r.slice(r.indexOf("/") + 1);
    return name === repoToken;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Build the canonical `dev.implement` brief for an issue-targeted command.
 *
 * The brief is INTENT + REFS, never a context bundle (design DD-P3 / the
 * `dev-events` payload contract): it names the issue and points the dev agent
 * at `gh` + the repo's own SOPs. The dev agent pulls the actual slice (issue
 * body, design §, acceptance criteria) with its own tools inside the CC
 * session.
 */
function buildBrief(repo: string, issue: number): string {
  return (
    `Implement ${repo}#${issue}. ` +
    `Read the issue for the full spec and acceptance criteria ` +
    `(\`gh issue view ${issue} --repo ${repo}\`), follow the repo's CONTEXT.md ` +
    `and Standard Operating Procedures, and work in your worktree. ` +
    `When the implementation is done you MUST COMMIT your work with a ` +
    `conventional-commit message (e.g. \`feat: … (closes #${issue})\`) before ` +
    `you finish — the dev-loop pushes your branch and opens the PR for you, so ` +
    `you only need to COMMIT (do NOT push or open the PR yourself, and do NOT ` +
    `merge — the merge is a human gate).`
  );
}

/**
 * Construct the {@link DevImplementPayload} for a parsed command, or `null`
 * when the repo token can't be resolved against the roster.
 *
 * Branch / base are derived deterministically (no `gh` round-trip at dispatch
 * time): the dev agent reads the issue itself. `base` is `main`; `branch` is
 * `feat/{N}-{name}` (matches the consumer's conservative `BRANCH_RE`). No
 * `gates` are set — the orchestrator does not hardcode a repo's gate commands;
 * the dev agent follows the repo SOPs and the review leg (S2) catches issues.
 */
export function buildImplementPayload(
  cmd: ImplementCommand,
  knownRepos: readonly string[],
): DevImplementPayload | null {
  const repo = resolveRepo(cmd.repoToken, knownRepos);
  if (repo === null) return null;
  const name = repo.slice(repo.indexOf("/") + 1);
  return {
    repo,
    branch: `feat/${cmd.issue}-${name}`,
    base: "main",
    brief: buildBrief(repo, cmd.issue),
    issue: cmd.issue,
  };
}

/**
 * The surface stamped on the run-thread routing when a caller predates the
 * `surface` input (back-compat). Discord is the only live dev-loop surface.
 */
export const DEFAULT_RUN_SURFACE = "discord";

/**
 * Build the LOGICAL run-thread routing for a dispatched implement (cortex#1206
 * S2 — dev-loop thread consolidation).
 *
 * A run is ONE thread, keyed on the ENTITY (the issue), addressed the
 * channel-routing-SOP way:
 *   - `channel` = the repo SHORT name — "repos get channels".
 *   - `thread`  = `{repo-short}/issue/{N}` — "GitHub entities get threads".
 *
 * Keying on the issue (not the eventual PR) is deliberate: the dev consumer
 * echoes THIS routing onto every `dispatch.task.*` lifecycle envelope, and the
 * review-sink resolves it via the idempotent `findOrCreateThreadByName`, so
 * vega's ack, the dev agent's progress + PR-opened, and echo's verdict all
 * collapse into the single `{repo-short}/issue/{N}` thread — the run is one
 * thread start-to-finish, never split issue→PR into two (cortex#1206 brief).
 *
 * Pure — no I/O. The native thread snowflake is created lazily by the surface
 * (`resolveLogicalTarget`), keeping this boundary unit-testable.
 */
export function buildRunThreadRouting(
  repo: string,
  issue: number,
  surface: string,
): LogicalResponseRouting {
  const repoShort = repo.slice(repo.indexOf("/") + 1);
  return {
    surface,
    channel: repoShort,
    thread: `${repoShort}/issue/${issue}`,
  };
}

/** The decision the orchestrator command boundary returns to the handler. */
export type OrchestratorOutcome =
  /** Not an orchestrator command — the caller falls through to normal chat. */
  | { kind: "pass-through" }
  /** Command matched but the gate refused (non-principal sender). Dropped. */
  | { kind: "ignored"; reason: string }
  /**
   * Command matched + dispatched. `ack` is the principal-facing confirmation;
   * `routing` is the run's LOGICAL thread address (cortex#1206 S2) stamped on
   * the dispatch — the handler resolves it to post the ack into the SAME thread
   * the dev-agent lifecycle + review verdict render to.
   */
  | {
      kind: "dispatched";
      envelope: Envelope;
      repo: string;
      issue: number;
      ack: string;
      routing: LogicalResponseRouting;
    }
  /** Command matched but could not be actioned. `ack` explains why. */
  | { kind: "error"; ack: string };

/** Inputs to {@link handleOrchestratorCommand}. */
export interface OrchestratorCommandInput {
  /** The inbound message text (the @-mention is already stripped). */
  text: string;
  /**
   * Whether the receiving agent is the dev-loop orchestrator (declares
   * {@link ORCHESTRATOR_CAPABILITY}). When false the outcome is always
   * `pass-through` — the command branch never activates for a chat agent.
   */
  isOrchestrator: boolean;
  /**
   * The non-spoofable principal-role signal the adapter computed from the
   * authenticated Discord author id (PolicyEngine). The trust-path gate.
   */
  authorIsPrincipal: boolean;
  /** The known repo roster (`getAllRepos(config)`). */
  knownRepos: readonly string[];
  /**
   * The STACK runtime. Optional only so a misconfigured (NATS-less) deployment
   * degrades to an `error` ack rather than throwing; production always has it.
   */
  runtime: MyelinRuntime | undefined;
  /**
   * The `{principal}.{agent}.{instance}` source stamped on the dispatch. The
   * `agent` segment names the orchestrator (e.g. `vega`).
   */
  source: DevEventSource | undefined;
  /**
   * cortex#1206 (S2) — the inbound surface (`msg.platform`, e.g. `"discord"`)
   * the command arrived on. Stamped as the run-thread routing's `surface` so
   * the lifecycle + ack consolidate on the right platform. Optional for
   * back-compat with callers that predate run-thread consolidation; defaults to
   * {@link DEFAULT_RUN_SURFACE}.
   */
  surface?: string;
}

/**
 * The principal-gated orchestrator command boundary.
 *
 * Decision order (fail-closed):
 *   1. not the orchestrator agent      → `pass-through`
 *   2. not an `implement` command       → `pass-through` (normal chat)
 *   3. sender is NOT the principal       → `ignored` (DROPPED — no dispatch)
 *   4. runtime/source unavailable        → `error` (bus not wired)
 *   5. repo token unresolvable           → `error`
 *   6. otherwise                          → build envelope + `runtime.publish` → `dispatched`
 *
 * Only step 6 publishes. The envelope is built by the `dev-events` builder and
 * published via the runtime — cortex derives the subject + signs.
 */
export async function handleOrchestratorCommand(
  input: OrchestratorCommandInput,
): Promise<OrchestratorOutcome> {
  if (!input.isOrchestrator) return { kind: "pass-through" };

  const cmd = parseImplementCommand(input.text);
  if (cmd === null) return { kind: "pass-through" };

  // Trust-path gate — honor the command ONLY from the principal.
  if (!input.authorIsPrincipal) {
    return { kind: "ignored", reason: "non-principal sender" };
  }

  if (!input.runtime || !input.source) {
    return {
      kind: "error",
      ack: `Can't dispatch \`${cmd.repoToken}#${cmd.issue}\` — the dev-loop bus runtime isn't available on this stack.`,
    };
  }

  const payload = buildImplementPayload(cmd, input.knownRepos);
  if (payload === null) {
    return {
      kind: "error",
      ack: `Can't dispatch — I don't recognise the repo \`${cmd.repoToken}\`. Use a configured repo short name or its \`owner/name\`.`,
    };
  }

  // cortex#1206 (S2) — the run-thread address. Stamped on the dispatch so the
  // dev consumer echoes it onto every lifecycle envelope and the review-sink
  // resolves it to the ONE run thread; ALSO returned so the handler posts the
  // ack into that same thread (not the flat channel the command came from).
  const routing = buildRunThreadRouting(
    payload.repo,
    cmd.issue,
    input.surface ?? DEFAULT_RUN_SURFACE,
  );

  const envelope = createDevImplementRequestEvent({
    source: input.source,
    payload,
    responseRouting: routing,
  });

  await input.runtime.publish(envelope);

  return {
    kind: "dispatched",
    envelope,
    repo: payload.repo,
    issue: cmd.issue,
    routing,
    ack:
      `On it — dispatched \`dev.implement\` for **${payload.repo}#${cmd.issue}** ` +
      `(branch \`${payload.branch}\`). The dev agent will pick it up, open a PR, ` +
      `and I'll hold at the merge gate for you.`,
  };
}
