/**
 * cortex#232 — `cortex wait-for-review` CLI.
 *
 * Subscribes to `local.{org}.github.>` envelopes via the operator's
 * configured NATS link, filters for a specific PR review event
 * (`(repo, pr_number, reviewer, optional_state)`), and exits with a
 * JSON match envelope OR a timeout. The producer side is the existing
 * `gh-webhook-receiver` (`src/taps/gh-webhook-receiver/server.ts`) —
 * every GitHub webhook delivery already lands on the bus as
 * `github.{event}.{action}`, so this command is a pure consumer.
 *
 * **Why this exists.** The pilot-review-loop skill historically used
 * a bash until-loop with 3 GitHub API endpoints × 30s sleep × ≤15min
 * cap, generating ~90 API calls per wait cycle per agent. Four
 * concurrent agents during 2026-05-15's Phase D push burned ~360 API
 * calls per cycle. This CLI replaces the polling loop with a single
 * NATS subscription — sub-second latency, zero GitHub API cost, and
 * no false-timeout failure mode from over-tight agent budgets (see
 * the-metafactory/pilot @ 40f65ae for the interim mitigation).
 *
 * Same primitive (`wait-for-bus-event`) is the right shape for Phase
 * E §3.6 delegation patterns (orchestrator waits on a
 * `dispatch.task.completed` reply by correlation_id) and D.6-style
 * cross-operator integration tests (currently use 10ms-drain
 * heuristics — a real bus-subscribe primitive eliminates that
 * acknowledged CI-flake vector). Building it generic from the start.
 *
 * **Exit codes:**
 *   - `0` — match found; JSON envelope on stdout
 *   - `1` — runtime error (NATS connect failed, malformed config, …)
 *   - `2` — usage error (bad flags / missing positional / invalid arg)
 *   - `124` — timeout elapsed without a match (matches `timeout(1)`
 *     convention so shell pipelines can branch on `$? -eq 124`)
 *
 * **JSON envelope shape (on match):** matches the
 * `CliJsonEnvelope<ReviewMatch>` shared contract — one `items` entry
 * carrying the matched review's structured fields. `data` carries
 * the NATS subject the envelope arrived on. The raw bus envelope's
 * UUID + ISO timestamp ride through so consumers can correlate.
 */

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import {
  parseSubcommandArgs,
  type SubcommandSpec,
} from "./_shared/parser";
import { boolFlag, valueFlag } from "./_shared/hydrate";
import { loadConfigWithAgents } from "../../../common/config/loader";
import { NatsLink } from "../../../bus/nats/connection";
import { MyelinSubscriber } from "../../../bus/myelin/subscriber";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

// =============================================================================
// Spec + argv hydration
// =============================================================================

const WAIT_SPEC: SubcommandSpec<"wait"> = {
  cliName: "wait-for-review",
  subcommands: {
    wait: {
      flags: {
        "--pr": "value",
        "--reviewer": "value",
        "--timeout": "value",
        "--require": "value",
        "--config": "value",
        "--json": "bool",
      },
    },
  },
  universal: { "--help": "bool", "-h": "bool" },
};

interface ParsedWaitForReviewArgs {
  subcommand: "wait" | "help" | "unknown";
  rawSubcommand: string;
  /** `owner/repo#N` — verbatim from `--pr`. Validated via {@link parsePrRef}. */
  pr?: string;
  /** GitHub login — verbatim from `--reviewer`. */
  reviewer?: string;
  /** Duration string — verbatim from `--timeout`. Validated via {@link parseTimeoutMs}. */
  timeout?: string;
  /** `approved` | `changes_requested` | `commented` | `any` (default `any`). */
  require?: string;
  /** Path to cortex.yaml (default `~/.config/cortex/cortex.yaml`). */
  config?: string;
  /** Emit JSON envelope instead of text (default: text; --json opts in). */
  json: boolean;
  help: boolean;
}

export function parseWaitForReviewArgs(argv: string[]): ParsedWaitForReviewArgs {
  // The CLI has a single conceptual operation; we still route through
  // the subcommand parser so the universal `--help` flow is consistent
  // with the rest of `cortex *` commands. The implicit subcommand is
  // `wait` — if the user types `cortex wait-for-review --pr foo` we
  // synthesise it; if they type `cortex wait-for-review wait --pr foo`
  // we accept that too.
  const synthesised = synthesiseImplicitSubcommand(argv);
  const parsed = parseSubcommandArgs(WAIT_SPEC, synthesised);
  return {
    subcommand: parsed.subcommand,
    rawSubcommand: parsed.rawSubcommand,
    pr: valueFlag(parsed.flags, "--pr"),
    reviewer: valueFlag(parsed.flags, "--reviewer"),
    timeout: valueFlag(parsed.flags, "--timeout"),
    require: valueFlag(parsed.flags, "--require"),
    config: valueFlag(parsed.flags, "--config"),
    json: boolFlag(parsed.flags, "--json"),
    help: parsed.help,
  };
}

/**
 * Single-subcommand CLI ergonomics — let the user omit the verb and
 * type flags directly. If argv starts with a flag (or is empty), we
 * synthesise `wait` so the parser routes correctly without forcing
 * `cortex wait-for-review wait --pr ...`. A leading `--help`/`-h`
 * stays untouched so the universal help path fires.
 */
function synthesiseImplicitSubcommand(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const first = argv[0];
  if (first === "--help" || first === "-h") return argv;
  if (first?.startsWith("-")) return ["wait", ...argv];
  // Bare positional that isn't our `wait` token: pass through and let
  // the parser surface `unknown subcommand`.
  return argv;
}

// =============================================================================
// Pure helpers — PR ref + timeout + matcher
// =============================================================================

export interface PrRef {
  /** GitHub owner (e.g. `the-metafactory`). */
  owner: string;
  /** GitHub repo name without owner (e.g. `cortex`). */
  repo: string;
  /** PR number. */
  number: number;
  /** Full `owner/repo` form — matches the receiver's `envelope.payload.repo`. */
  fullName: string;
}

/**
 * Parse `owner/repo#N` into a structured PR ref. Used by the matcher
 * and the help output. Conservative grammar — owner/repo follow
 * GitHub's own identifier rules (alphanumeric + dash + underscore +
 * dot; first char letter/digit), PR number is a positive integer.
 */
export function parsePrRef(input: string): PrRef {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)$/.exec(
    input,
  );
  if (!m) {
    throw new CliArgsError(
      "wait-for-review",
      `--pr must be in "owner/repo#N" form — got "${input}"`,
    );
  }
  // Regex captures are guaranteed defined when match succeeds, but the
  // lint rule forbids non-null assertions — destructure instead and
  // pattern-narrow via length so each capture stays a plain string.
  const [, owner = "", repo = "", numStr = ""] = m;
  const number = Number.parseInt(numStr, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new CliArgsError(
      "wait-for-review",
      `--pr PR number must be a positive integer — got "${numStr}"`,
    );
  }
  return { owner, repo, number, fullName: `${owner}/${repo}` };
}

/**
 * Parse a duration string into milliseconds. Accepts `<n>s` / `<n>m`
 * / `<n>h` (no decimals, no compound forms — operators write `30m`
 * not `1h30m`). Bare integers are treated as seconds for shell
 * compatibility with `timeout(1)` and `sleep(1)`.
 *
 * Rejects zero/negative durations — a zero-second wait would
 * race the subscription startup and report `no match` even when a
 * matching envelope is already on the wire.
 */
export function parseTimeoutMs(input: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(input);
  if (!m) {
    throw new CliArgsError(
      "wait-for-review",
      `--timeout must be <n>(s|m|h) — got "${input}"`,
    );
  }
  const [, digits = "0", unit] = m;
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliArgsError(
      "wait-for-review",
      `--timeout must be a positive integer — got "${input}"`,
    );
  }
  const suffix = unit ?? "s";
  const unitMs = suffix === "h" ? 3_600_000 : suffix === "m" ? 60_000 : 1_000;
  return n * unitMs;
}

/** Output payload — one `items` entry on the match envelope. */
export interface ReviewMatch {
  /** Event kind the matcher fired on. Each maps 1:1 to a GitHub event type. */
  kind:
    | "pull_request_review"
    | "pull_request_review_comment"
    | "issue_comment";
  /** GitHub action (`submitted`, `created`, `edited`, …). */
  action: string;
  /** `owner/repo`. */
  repo: string;
  /** PR number. */
  pr: number;
  /** Reviewer login (the `sender` field on the underlying GitHub event). */
  reviewer: string;
  /**
   * Review state when `kind === "pull_request_review"`:
   *   - `approved` / `changes_requested` / `commented` / `dismissed`.
   *
   * `undefined` for the comment surfaces — comments don't carry a
   * review-state discriminator; consumers branch on `kind`.
   */
  state?: string;
  /**
   * Review/comment body, truncated to 240 chars. Preserves leading
   * verdict lines (e.g. `recommend: merge`) without dragging the
   * full review prose into the JSON payload.
   */
  body_summary: string;
  /** UUID — the bus envelope id (deduplication key for consumers). */
  envelope_id: string;
  /** ISO-8601 — when the bus emitted the envelope. */
  envelope_timestamp: string;
  /** GitHub delivery ID (UUID per GitHub's contract). */
  delivery_id?: string;
}

interface ReviewFilter {
  prRef: PrRef;
  reviewer: string;
  /** `any` matches every state including the comment surfaces. */
  requireState: "approved" | "changes_requested" | "commented" | "any";
}

/**
 * Pure matcher: does this envelope satisfy the filter? Returns a
 * structured match payload on success, `null` on miss. The matcher
 * is the only piece of logic that has to understand the github.*
 * envelope shape — the rest of the CLI is plumbing around it.
 *
 * **Envelope shape (from `src/bus/github-events.ts`):**
 *   - `envelope.type === "github.{event}.{action}"`
 *   - `envelope.payload.event` — the raw `X-GitHub-Event` header value
 *     (`pull_request_review`, `issue_comment`, …)
 *   - `envelope.payload.action` — the raw `payload.action` field
 *   - `envelope.payload.repo` — `owner/repo` (receiver pre-extracts)
 *   - `envelope.payload.sender` — sender login (receiver pre-extracts)
 *   - `envelope.payload.body` — the raw GitHub webhook payload
 *
 * The matcher reads the pre-extracted top-level fields (`repo`,
 * `sender`) where possible; it only drills into `payload.body` for
 * fields the receiver doesn't promote (PR number, review state,
 * body text).
 */
export function matchesReview(
  envelope: Envelope,
  filter: ReviewFilter,
): ReviewMatch | null {
  const payload = envelope.payload;

  // 1. Event kind gate — only the three review-related GitHub events
  //    are interesting. The match is on `payload.event` (raw header
  //    value) so we don't have to defend against `envelope.type`
  //    sanitization (the github-events helper maps `_` → `-`, which
  //    would turn `pull_request_review` into `pull-request-review`).
  const event = typeof payload.event === "string" ? payload.event : undefined;
  if (event === undefined) return null;
  const kind = mapEventToKind(event);
  if (kind === null) return null;

  // 2. Repo gate.
  const repo = typeof payload.repo === "string" ? payload.repo : undefined;
  if (repo !== filter.prRef.fullName) return null;

  // 3. Reviewer gate.
  const sender = typeof payload.sender === "string" ? payload.sender : undefined;
  if (sender !== filter.reviewer) return null;

  // 4. PR-number gate. Different surfaces nest the number differently:
  //    - pull_request_review_*       → body.pull_request.number
  //    - pull_request_review_comment → body.pull_request.number
  //    - issue_comment               → body.issue.number (PR comments
  //      land on the issue surface in GitHub's API — issue.pull_request
  //      is present iff the issue IS a PR).
  const number = extractPrNumber(payload, kind);
  if (number !== filter.prRef.number) return null;

  // 5. State gate (only meaningful for pull_request_review).
  const state = extractReviewState(payload, kind);
  if (filter.requireState !== "any" && kind === "pull_request_review") {
    if (state !== filter.requireState) return null;
  }
  // For comment surfaces, a non-`any` state filter is a strict no-match.
  // The intent of `--require approved` is "wait for an explicit approval
  // review" — a top-level PR comment with `recommend: merge` text isn't
  // a structural approval, even if the prose says so.
  if (filter.requireState !== "any" && kind !== "pull_request_review") {
    return null;
  }

  // 6. Build the match payload.
  const bodySummary = truncateForSummary(extractBody(payload, kind));
  const action = typeof payload.action === "string" ? payload.action : "received";
  const deliveryId = typeof payload.delivery_id === "string"
    ? payload.delivery_id
    : undefined;

  return {
    kind,
    action,
    repo,
    pr: number,
    reviewer: sender,
    ...(state !== undefined && { state }),
    body_summary: bodySummary,
    envelope_id: envelope.id,
    envelope_timestamp: envelope.timestamp,
    ...(deliveryId !== undefined && { delivery_id: deliveryId }),
  };
}

function mapEventToKind(event: string): ReviewMatch["kind"] | null {
  if (event === "pull_request_review") return "pull_request_review";
  if (event === "pull_request_review_comment") return "pull_request_review_comment";
  if (event === "issue_comment") return "issue_comment";
  return null;
}

function extractPrNumber(
  payload: Record<string, unknown>,
  kind: ReviewMatch["kind"],
): number | null {
  const body = payload.body;
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (kind === "issue_comment") {
    const issue = b.issue;
    if (typeof issue !== "object" || issue === null) return null;
    const i = issue as Record<string, unknown>;
    // Filter out non-PR issues — `issue.pull_request` is present iff
    // the issue is a PR. Drop comments on plain issues so a comment
    // on issue #229 doesn't masquerade as a review on PR #229.
    if (i.pull_request === undefined || i.pull_request === null) return null;
    const num = i.number;
    return typeof num === "number" ? num : null;
  }

  // pull_request_review and pull_request_review_comment both nest
  // the PR under `pull_request`.
  const pr = b.pull_request;
  if (typeof pr !== "object" || pr === null) return null;
  const p = pr as Record<string, unknown>;
  const num = p.number;
  return typeof num === "number" ? num : null;
}

function extractReviewState(
  payload: Record<string, unknown>,
  kind: ReviewMatch["kind"],
): string | undefined {
  if (kind !== "pull_request_review") return undefined;
  const body = payload.body;
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const review = b.review;
  if (typeof review !== "object" || review === null) return undefined;
  const r = review as Record<string, unknown>;
  const state = r.state;
  return typeof state === "string" ? state : undefined;
}

function extractBody(
  payload: Record<string, unknown>,
  kind: ReviewMatch["kind"],
): string {
  const body = payload.body;
  if (typeof body !== "object" || body === null) return "";
  const b = body as Record<string, unknown>;

  if (kind === "pull_request_review") {
    const review = b.review;
    if (typeof review !== "object" || review === null) return "";
    const r = review as Record<string, unknown>;
    const text = r.body;
    return typeof text === "string" ? text : "";
  }

  // Both comment surfaces nest the comment body under `comment.body`.
  const comment = b.comment;
  if (typeof comment !== "object" || comment === null) return "";
  const c = comment as Record<string, unknown>;
  const text = c.body;
  return typeof text === "string" ? text : "";
}

function truncateForSummary(text: string): string {
  const MAX = 240;
  if (text.length <= MAX) return text;
  return text.slice(0, MAX - 1) + "…";
}

// =============================================================================
// runWaitForReview — the NATS subscribe + race-against-timeout body
// =============================================================================

/**
 * Test seam for `runWaitForReview` — production callers pass nothing
 * and the real `NatsLink` / `MyelinSubscriber` are used. Tests inject
 * stubs so the matcher logic can be exercised without standing up a
 * `nats-server`.
 */
export interface WaitForReviewDeps {
  connect?: typeof NatsLink.connect;
  subscriberStart?: typeof MyelinSubscriber.start;
  loadConfig?: typeof loadConfigWithAgents;
}

const DEFAULT_CONFIG_PATH = "~/.config/cortex/cortex.yaml";

export async function runWaitForReview(
  args: ParsedWaitForReviewArgs,
  deps: WaitForReviewDeps = {},
): Promise<ExitResult> {
  if (args.help) {
    return { exitCode: 0, stdout: waitHelp(), stderr: "" };
  }

  // -------------------------------------------------------------------
  // 1. Validate args.
  // -------------------------------------------------------------------
  if (!args.pr) return usageMissing("--pr");
  if (!args.reviewer) return usageMissing("--reviewer");
  if (!args.timeout) return usageMissing("--timeout");
  if (args.reviewer.length === 0) {
    return usage(`--reviewer must be a non-empty GitHub login`);
  }

  let prRef: PrRef;
  let timeoutMs: number;
  let requireState: ReviewFilter["requireState"];
  try {
    prRef = parsePrRef(args.pr);
    timeoutMs = parseTimeoutMs(args.timeout);
    requireState = parseRequireState(args.require);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: 2, stdout: "", stderr: `cortex wait-for-review: ${err.message}\n` };
    }
    throw err;
  }

  const filter: ReviewFilter = { prRef, reviewer: args.reviewer, requireState };

  // -------------------------------------------------------------------
  // 2. Load config — need the NATS URL + creds + operator id for the
  //    subscription subject pattern.
  // -------------------------------------------------------------------
  const loadConfig = deps.loadConfig ?? loadConfigWithAgents;
  const configPath = args.config ?? DEFAULT_CONFIG_PATH;
  let config;
  try {
    config = loadConfig(configPath).config;
  } catch (err) {
    return runtimeError(
      `failed to load cortex config from "${configPath}": ${formatError(err)}`,
    );
  }

  const natsUrl = config.nats?.url;
  if (!natsUrl) {
    return runtimeError(
      `cortex.yaml has no nats.url configured — wait-for-review requires NATS to subscribe`,
    );
  }

  const org = config.agent.operatorId ?? "default";
  const subjectPattern = `local.${org}.github.>`;

  // -------------------------------------------------------------------
  // 3. Connect + subscribe.
  // -------------------------------------------------------------------
  // Bind static methods to their class so the lint `unbound-method`
  // rule passes — both NatsLink.connect and MyelinSubscriber.start
  // are class statics that do not reference `this`, but the linter
  // can't prove that.
  const connect = deps.connect ?? ((opts) => NatsLink.connect(opts));
  const subscriberStart =
    deps.subscriberStart ?? ((link, opts) => MyelinSubscriber.start(link, opts));

  let link: NatsLink;
  try {
    link = await connect({
      url: natsUrl,
      ...(config.nats?.token !== undefined && { token: config.nats.token }),
      ...(config.nats?.credsPath !== undefined && { credsPath: config.nats.credsPath }),
      name: `cortex-wait-for-review`,
    });
  } catch (err) {
    return runtimeError(
      `failed to connect to NATS at ${safeUrl(natsUrl)}: ${formatError(err)}`,
    );
  }

  // -------------------------------------------------------------------
  // 4. Race the matcher against the timeout. We resolve `firstMatch`
  //    on the first envelope that satisfies the filter; if the
  //    timeout fires first we resolve `null` and short-circuit.
  // -------------------------------------------------------------------
  let resolveMatch!: (m: ReviewMatch | null) => void;
  const matchPromise = new Promise<ReviewMatch | null>((resolve) => {
    resolveMatch = resolve;
  });

  // First-match short-circuit (Echo cortex#234 round 1). Even though
  // the second `resolveMatch` call is a no-op on a settled promise,
  // skipping additional matcher work after the first hit makes the
  // intent obvious and avoids silently swallowing later matching
  // envelopes — if more arrive between match and `stop()`, the
  // skipped-matcher branch makes the drop visible to a future reader.
  let matched = false;
  const subscriber = subscriberStart(link, {
    pattern: subjectPattern,
    onEnvelope: (envelope) => {
      if (matched) return;
      const m = matchesReview(envelope, filter);
      if (m !== null) {
        matched = true;
        resolveMatch(m);
      }
    },
  });

  const timeoutHandle = setTimeout(() => {
    resolveMatch(null);
  }, timeoutMs);

  const match = await matchPromise;
  clearTimeout(timeoutHandle);

  // -------------------------------------------------------------------
  // 5. Cleanup.
  // -------------------------------------------------------------------
  try {
    await subscriber.stop();
  } catch (err) {
    // Stop errors are operational, not user-facing — log once and
    // continue. The match (or timeout) result is what the caller cares
    // about; an unclean drain isn't a reason to fail the exit code.
    console.error(
      `cortex wait-for-review: subscriber.stop() failed: ${formatError(err)}`,
    );
  }
  try {
    await link.close();
  } catch (err) {
    console.error(
      `cortex wait-for-review: link.close() failed: ${formatError(err)}`,
    );
  }

  // -------------------------------------------------------------------
  // 6. Render result.
  // -------------------------------------------------------------------
  if (match === null) {
    return {
      exitCode: 124,
      stdout: args.json
        ? renderJson(
            envelopeError<ReviewMatch>("timeout", {
              pr: prRef.fullName + "#" + String(prRef.number),
              reviewer: args.reviewer,
              timeout_ms: String(timeoutMs),
            }),
          )
        : "",
      stderr: args.json
        ? ""
        : `cortex wait-for-review: timeout after ${args.timeout} waiting for ${prRef.fullName}#${prRef.number} from ${args.reviewer}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: args.json
      ? renderJson(
          envelopeOk<ReviewMatch>([match], {
            subject_pattern: subjectPattern,
          }),
        )
      : formatMatchText(match) + "\n",
    stderr: "",
  };
}

function parseRequireState(input: string | undefined): ReviewFilter["requireState"] {
  if (input === undefined || input === "any") return "any";
  if (input === "approved" || input === "changes_requested" || input === "commented") {
    return input;
  }
  throw new CliArgsError(
    "wait-for-review",
    `--require must be one of: approved, changes_requested, commented, any — got "${input}"`,
  );
}

function usageMissing(flag: string): ExitResult {
  return usage(`missing required flag ${flag}`);
}

function usage(message: string): ExitResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `cortex wait-for-review: ${message}\n${topLevelHelp()}`,
  };
}

function runtimeError(message: string): ExitResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `cortex wait-for-review: ${message}\n`,
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//***@");
}

function formatMatchText(m: ReviewMatch): string {
  const stateLine = m.state ? ` (state=${m.state})` : "";
  // Collapse any internal whitespace (newlines, tabs, runs of spaces)
  // in the body summary so the text path stays one event = one line
  // for shell pipelines (Echo cortex#234 round 1). JSON path keeps the
  // raw body_summary verbatim.
  const oneLineBody = m.body_summary.replace(/\s+/g, " ");
  return `${m.kind}.${m.action}${stateLine}  ${m.repo}#${m.pr}  by ${m.reviewer}\nbody: ${oneLineBody}`;
}

// =============================================================================
// dispatchWaitForReview + help
// =============================================================================

export async function dispatchWaitForReview(
  argv: string[],
  deps: WaitForReviewDeps = {},
): Promise<ExitResult> {
  let args: ParsedWaitForReviewArgs;
  try {
    args = parseWaitForReviewArgs(argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex wait-for-review: ${err.message}\n${topLevelHelp()}`,
      };
    }
    throw err;
  }

  switch (args.subcommand) {
    case "wait":
      return runWaitForReview(args, deps);
    case "help":
      return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
    case "unknown":
      if (args.rawSubcommand === "") {
        // Route the help hint through `usage()` directly so the
        // "missing flag" slot doesn't carry prose (Echo cortex#234
        // round 1 nit).
        return usage(
          "no args given; --pr / --reviewer / --timeout required. Run `cortex wait-for-review --help` for details",
        );
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex wait-for-review: unknown subcommand "${args.rawSubcommand}".\n${topLevelHelp()}`,
      };
  }
}

function topLevelHelp(): string {
  return `cortex wait-for-review — block until a GitHub PR review event arrives on the bus

Usage:
  cortex wait-for-review --pr <owner/repo#N> --reviewer <login> --timeout <duration> [options]

Required flags:
  --pr <owner/repo#N>     PR to watch (e.g. the-metafactory/cortex#229)
  --reviewer <login>      GitHub login of the reviewer (e.g. mellanon)
  --timeout <duration>    Wait budget — <n>s | <n>m | <n>h (e.g. 30m, 900s, 1h)

Optional flags:
  --require <state>       approved | changes_requested | commented | any (default: any)
                          Note: non-"any" values match only on pull_request_review.submitted —
                          a top-level PR comment with "recommend: merge" prose is NOT a
                          structural approval, so it's a strict no-match under --require approved.
  --config <path>         cortex.yaml path (default: ~/.config/cortex/cortex.yaml)
  --json                  Emit structured JSON (default: text)
  --help, -h              Show this help

Exit codes:
  0      match — JSON envelope (or text line) on stdout
  1      runtime error (NATS connect failure, config load failure, …)
  2      usage error (bad flags / invalid values)
  124    timeout — no matching review arrived within --timeout

Replaces the bash polling loop in pilot-review-loop (the-metafactory/pilot)
for cortex#232. Bus is the wake signal; consumers can still call \`gh pr view\`
for the full review content.
`;
}

function waitHelp(): string {
  return topLevelHelp();
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchWaitForReview(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
