/**
 * F-6 downstream — `notify.discord` code handler.
 *
 * A pure, in-process handler the F-6 `ReflexActivationListener` invokes
 * DIRECTLY for a target whose config declares `handler: "discord-webhook"`.
 * It posts a GitHub-issue summary to a **per-repo Discord webhook URL** (URL
 * embeds the channel + token — no bot token, no Claude session).
 *
 * ## Why direct invocation (not a bus re-emit + subscriber)
 *
 * An earlier design re-emitted `tasks.@…notify.discord` onto the bus for a
 * code responder to consume. Sage review (cortex#1180 cycle 1) showed that to
 * be wrong: the responder saw every fan-out subject (cross-principal/stack
 * scope leak), it posted without the dispatch-listener's verify/policy gates
 * (forged-envelope → webhook post), and an outbound HTTP sink subscribing NATS
 * in `src/bus` breaks the surface-router architecture. Invoking the handler
 * directly from the bridge dissolves all three: the bridge is the single,
 * already-gated entry point (it durably consumes reflex `fired` events, which
 * reflex policy-gated), so there is no second bus hop and no ungated
 * subscriber.
 *
 * ## Trust
 *
 * `activation.payload` is the webhook-controlled GitHub `issues` body — DATA,
 * never instructions (there is no LLM here). We extract typed fields only and
 * send `allowed_mentions: { parse: [] }` so an issue title containing
 * `@everyone` / `@here` / role mentions cannot ping the channel.
 */

import type { DiscordNotifyTarget } from "../common/types/cortex-config";
import type { MyelinRuntime } from "./myelin/runtime";
import type {
  FiredActivation,
  ReflexActivationHandler,
} from "./reflex-activation-listener";
import {
  createSystemBusNotifyDiscordEvent,
  type SystemEventSource,
} from "./system-events";

/** Result of an HTTP POST to a Discord webhook (injectable for tests). */
export interface WebhookPostResult {
  ok: boolean;
  status: number;
}

export type WebhookPoster = (
  url: string,
  body: string,
) => Promise<WebhookPostResult>;

/** Default poster — bare `fetch` with a bounded timeout (Bun/Node WHATWG). */
const defaultPoster: WebhookPoster = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status };
};

/** Typed view of the GitHub `issues` webhook fields we render. */
export interface ParsedIssueActivation {
  repo: string;
  number: number | undefined;
  title: string | undefined;
  url: string | undefined;
  action: string | undefined;
}

/**
 * Discord webhook URL shape — host-locked so a resolved secret cannot turn this
 * capability into an arbitrary outbound POST sink (SSRF). Accepts canonical
 * `discord.com` (+ `canary`/`ptb`) and legacy `discordapp.com`, with or without
 * an `/api/vN` version segment.
 */
export const DISCORD_WEBHOOK_URL_RE =
  /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api(\/v\d+)?\/webhooks\/\d+\/[\w-]+$/;

export interface DiscordNotifierOpts {
  runtime: MyelinRuntime;
  source: SystemEventSource;
  /** repo → `webhook_url_env` mappings (from `notify.discord` config). */
  targets: readonly DiscordNotifyTarget[];
  /** Env source the `webhook_url_env` bindings resolve against. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable HTTP poster (default: `fetch`). */
  post?: WebhookPoster;
  log?: { warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Extract the repo + issue fields from a fired activation payload (the raw
 * GitHub `issues` webhook body). Returns undefined when the repo can't be
 * determined (nothing to route on).
 */
export function parseIssueActivation(
  payload: unknown,
): ParsedIssueActivation | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const repository = p.repository as { full_name?: unknown } | undefined;
  const repo =
    typeof repository?.full_name === "string" ? repository.full_name : undefined;
  if (repo === undefined || repo.length === 0) return undefined;
  const issue = p.issue as
    | { number?: unknown; title?: unknown; html_url?: unknown }
    | undefined;
  return {
    repo,
    number: typeof issue?.number === "number" ? issue.number : undefined,
    title: typeof issue?.title === "string" ? issue.title : undefined,
    url: typeof issue?.html_url === "string" ? issue.html_url : undefined,
    action: typeof p.action === "string" ? p.action : undefined,
  };
}

/**
 * Backslash-escape Discord markdown control characters so an untrusted issue
 * title can't inject formatting / masked links (`[text](url)`) / fences into
 * the internal message. Pairs with `allowed_mentions:{parse:[]}` (which stops
 * pings) — this stops visual/link spoofing.
 */
export function escapeDiscordMarkdown(text: string): string {
  // Only true markdown/link controls — bold/italic/strike/spoiler/code (`*_~|``),
  // blockquote (`>`), masked links (`[]()`), and the escape char itself.
  return text.replace(/[\\*_~`|>[\]()]/g, "\\$&");
}

/** Render the Discord message `content` for an issue activation. */
export function renderIssueMessage(issue: ParsedIssueActivation): string {
  const ref =
    issue.number !== undefined ? `${issue.repo}#${issue.number}` : issue.repo;
  const title = escapeDiscordMarkdown(issue.title ?? "(no title)");
  const head = `🟢 New issue **${ref}** — ${title}`;
  const body = issue.url !== undefined ? `${head}\n${issue.url}` : head;
  // Discord content cap is 2000 chars; keep well under.
  return body.length > 1900 ? `${body.slice(0, 1897)}...` : body;
}

/**
 * Build the `notify.discord` handler. The returned function:
 *  - parses the issue + resolves repo → webhook URL; on no-repo (unparseable
 *    payload) or no-mapping (no env binding resolved at startup) it emits a
 *    `skipped` visibility and RETURNS. Re-firing within THIS process won't help
 *    (bindings resolve once at construction); fixing the env/config and
 *    restarting cortex will.
 *  - POSTs `{content, allowed_mentions:{parse:[]}}`; on 2xx emits `posted` and
 *    returns; on non-2xx or a thrown fetch it emits `failed` and THROWS. The
 *    bridge then does NOT mark the Decision id as seen, so a later reflex
 *    re-fire of the same Decision is not deduped away (whether reflex re-fires
 *    is reflex's concern, not shown here).
 */
export function createDiscordNotifier(opts: DiscordNotifierOpts): ReflexActivationHandler {
  const post = opts.post ?? defaultPoster;
  const log = opts.log ?? console;
  const env = opts.env ?? process.env;
  // Resolve each target's `webhook_url_env` binding at construction. A binding
  // that is unset, or resolves to a non-Discord URL, is dropped + warned (that
  // repo simply gets no notification) — the bearer-token URL never lives in
  // config, and a mis-set secret can't become an arbitrary POST sink.
  const webhookByRepo = new Map<string, string>();
  for (const t of opts.targets) {
    const url = env[t.webhook_url_env];
    if (url === undefined || url.length === 0) {
      log.warn(
        `notify-discord: webhook env "${t.webhook_url_env}" for repo "${t.repo}" is unset — repo will not be notified`,
      );
      continue;
    }
    if (!DISCORD_WEBHOOK_URL_RE.test(url)) {
      log.warn(
        `notify-discord: webhook env "${t.webhook_url_env}" for repo "${t.repo}" is not a Discord webhook URL — ignored`,
      );
      continue;
    }
    webhookByRepo.set(t.repo, url);
  }

  const emit = (
    outcome: "posted" | "failed" | "skipped",
    activation: FiredActivation,
    repo: string | undefined,
    reason?: string,
  ): void => {
    void opts.runtime
      .publish(
        createSystemBusNotifyDiscordEvent({
          source: opts.source,
          outcome,
          ...(repo !== undefined && { repo }),
          decisionId: activation.decisionId,
          ...(reason !== undefined && { reason }),
          ...(activation.correlationId !== undefined && {
            correlationId: activation.correlationId,
          }),
        }),
      )
      .catch((err: unknown) =>
        { log.error(`notify-discord: visibility publish failed: ${errMsg(err)}`); },
      );
  };

  return async (activation) => {
    const issue = parseIssueActivation(activation.payload);
    if (issue === undefined) {
      log.warn(
        `notify-discord: activation ${activation.decisionId} has no resolvable repo — skipped`,
      );
      emit("skipped", activation, undefined, "unparseable-payload");
      return;
    }
    const webhookUrl = webhookByRepo.get(issue.repo);
    if (webhookUrl === undefined) {
      log.warn(`notify-discord: no webhook configured for repo "${issue.repo}" — skipped`);
      emit("skipped", activation, issue.repo, "no-webhook-for-repo");
      return;
    }
    const body = JSON.stringify({
      content: renderIssueMessage(issue),
      // Untrusted issue text must never ping the channel.
      allowed_mentions: { parse: [] },
    });
    let res: WebhookPostResult;
    try {
      res = await post(webhookUrl, body);
    } catch (err) {
      emit("failed", activation, issue.repo, errMsg(err));
      // Transient — throw so the bridge does not mark the Decision id as seen.
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      emit("failed", activation, issue.repo, `http-${res.status}`);
      throw new Error(`discord webhook POST for "${issue.repo}" returned HTTP ${res.status}`);
    }
    emit("posted", activation, issue.repo);
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
