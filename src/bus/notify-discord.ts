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

export interface DiscordNotifierOpts {
  runtime: MyelinRuntime;
  source: SystemEventSource;
  /** repo → webhook_url mappings (from `notify.discord` config). */
  targets: readonly DiscordNotifyTarget[];
  /** Injectable HTTP poster (default: `fetch`). */
  post?: WebhookPoster;
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
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

/** Render the Discord message `content` for an issue activation. */
export function renderIssueMessage(issue: ParsedIssueActivation): string {
  const ref =
    issue.number !== undefined ? `${issue.repo}#${issue.number}` : issue.repo;
  const title = issue.title ?? "(no title)";
  const head = `🟢 New issue **${ref}** — ${title}`;
  const body = issue.url !== undefined ? `${head}\n${issue.url}` : head;
  // Discord content cap is 2000 chars; keep well under.
  return body.length > 1900 ? `${body.slice(0, 1897)}...` : body;
}

/**
 * Build the `notify.discord` handler. The returned function:
 *  - parses the issue + resolves repo → webhook_url; on no-repo / no-mapping it
 *    emits a `skipped` visibility and RETURNS (deterministic — re-firing won't
 *    help).
 *  - POSTs `{content, allowed_mentions:{parse:[]}}`; on 2xx emits `posted` and
 *    returns; on non-2xx or a thrown fetch it emits `failed` and THROWS so the
 *    bridge leaves the activation re-fireable.
 */
export function createDiscordNotifier(opts: DiscordNotifierOpts): ReflexActivationHandler {
  const post = opts.post ?? defaultPoster;
  const log = opts.log ?? console;
  const webhookByRepo = new Map(
    opts.targets.map((t) => [t.repo, t.webhook_url] as const),
  );

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
      // Transient — throw so the bridge does not mark the Decision id.
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
