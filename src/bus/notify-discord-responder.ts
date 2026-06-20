/**
 * F-6 downstream — `notify.discord` code capability.
 *
 * An in-runtime, code-only responder (the probe-responder pattern) that
 * fulfils the `notify.discord` capability the F-6 reflex-activation bridge
 * dispatches to. It posts a GitHub-issue summary to a **per-repo Discord
 * webhook URL** (URL embeds the channel + token — no bot token, no Claude
 * session). Deterministic plumbing: parse → resolve repo → POST.
 *
 * ## Coexistence with the CC dispatch-listener
 *
 * Both this responder and `createDispatchListener` register `onEnvelope`
 * fan-out handlers, so BOTH receive every `tasks.*` envelope. This responder
 * filters to `notify.discord`; the dispatch-listener is told (via
 * `codeCapabilities`) to YIELD `notify.discord` so it neither spawns a Claude
 * session nor mis-traces the prompt-less dispatch as malformed. The two are
 * disjoint by capability, not by subject scope.
 *
 * ## Contract
 *
 * The bridge's re-emitted dispatch carries the structured activation payload
 * as `payload.reflex_payload` (the raw GitHub `issues` webhook body). This
 * responder reads `reflex_payload` as DATA — it never interprets it as
 * instructions (there is no LLM here, so injection is moot; we still treat it
 * as untrusted input and only extract typed fields).
 *
 * Fire-and-forget: `onEnvelope` has no ack channel, so the handler catches all
 * errors and emits a `system.bus.notify_discord` visibility event
 * (posted/failed/skipped) rather than throwing into the fan-out.
 */

import type { DiscordNotifyTarget } from "../common/types/cortex-config";
import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import {
  createSystemBusNotifyDiscordEvent,
  type SystemEventSource,
} from "./system-events";

/** Default capability the responder claims. */
export const NOTIFY_DISCORD_CAPABILITY = "notify.discord";

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
interface ParsedIssueActivation {
  repo: string;
  number: number | undefined;
  title: string | undefined;
  url: string | undefined;
  action: string | undefined;
}

export interface NotifyDiscordResponderOpts {
  runtime: MyelinRuntime;
  /** Source attribution for the emitted `system.bus.notify_discord` events. */
  source: SystemEventSource;
  /** Cortex principal — first subject segment the responder binds. */
  principal: string;
  /** Cortex stack — second subject segment. */
  stack: string;
  /** repo → webhook_url mappings (from `notify.discord` config). */
  targets: readonly DiscordNotifyTarget[];
  /** Capability claimed. Default `notify.discord`. */
  capability?: string;
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
  // Discord content cap is 2000 chars; keep well under.
  const body = issue.url !== undefined ? `${head}\n${issue.url}` : head;
  return body.length > 1900 ? `${body.slice(0, 1897)}...` : body;
}

/** Read `payload.reflex_payload` (structured activation data) off a dispatch. */
function reflexPayloadOf(envelope: Envelope): unknown {
  const p = envelope.payload as Record<string, unknown> | undefined;
  return p?.reflex_payload;
}

function decisionIdOf(envelope: Envelope): string | undefined {
  const p = envelope.payload as Record<string, unknown> | undefined;
  return typeof p?.reflex_decision_id === "string"
    ? p.reflex_decision_id
    : undefined;
}

export interface NotifyDiscordResponder {
  readonly subjects: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Construct the responder. Subscribes the principal/stack's
 * `tasks.*.{capability}` and handles each matching dispatch inline. Dormant /
 * no-throw when the runtime is disabled or lacks `subscribe`.
 */
export function createNotifyDiscordResponder(
  opts: NotifyDiscordResponderOpts,
): NotifyDiscordResponder {
  const capability = opts.capability ?? NOTIFY_DISCORD_CAPABILITY;
  const post = opts.post ?? defaultPoster;
  const log = opts.log ?? console;
  // The `*` matches the `@{did-encoded-assistant}` segment; the trailing
  // capability is matched in the handler (a dotted capability like
  // `notify.discord` spans two `>`-tail tokens).
  const pattern = `local.${opts.principal}.${opts.stack}.tasks.*.>`;
  const webhookByRepo = new Map(
    opts.targets.map((t) => [t.repo, t.webhook_url] as const),
  );

  let registration: { unregister: () => void } | undefined;
  const subscribers: { stop(): Promise<void> }[] = [];

  const emit = (
    outcome: "posted" | "failed" | "skipped",
    envelope: Envelope,
    repo: string | undefined,
    reason?: string,
  ): void => {
    void runtimePublish(envelope, outcome, repo, reason);
  };
  const runtimePublish = async (
    envelope: Envelope,
    outcome: "posted" | "failed" | "skipped",
    repo: string | undefined,
    reason?: string,
  ): Promise<void> => {
    try {
      await opts.runtime.publish(
        createSystemBusNotifyDiscordEvent({
          source: opts.source,
          outcome,
          ...(repo !== undefined && { repo }),
          ...(decisionIdOf(envelope) !== undefined && {
            decisionId: decisionIdOf(envelope),
          }),
          ...(reason !== undefined && { reason }),
          ...(envelope.correlation_id !== undefined && {
            correlationId: envelope.correlation_id,
          }),
        }),
      );
    } catch (err) {
      log.error(`notify-discord-responder: visibility publish failed: ${errMsg(err)}`);
    }
  };

  const handle = (envelope: Envelope, subject: string): void => {
    // Capability filter — only `…tasks.@{did}.{capability}` for OUR capability.
    if (!subject.includes(".tasks.@") || !subject.endsWith(`.${capability}`)) {
      return;
    }
    const issue = parseIssueActivation(reflexPayloadOf(envelope));
    if (issue === undefined) {
      log.warn(
        `notify-discord-responder: dispatch ${envelope.id} has no resolvable repo in reflex_payload — skipped`,
      );
      emit("skipped", envelope, undefined, "unparseable-payload");
      return;
    }
    const webhookUrl = webhookByRepo.get(issue.repo);
    if (webhookUrl === undefined) {
      log.warn(
        `notify-discord-responder: no Discord webhook configured for repo "${issue.repo}" — skipped`,
      );
      emit("skipped", envelope, issue.repo, "no-webhook-for-repo");
      return;
    }
    // Fire-and-forget POST; never throw into the onEnvelope fan-out.
    void (async () => {
      try {
        const body = JSON.stringify({ content: renderIssueMessage(issue) });
        const res = await post(webhookUrl, body);
        if (res.ok) {
          emit("posted", envelope, issue.repo);
        } else {
          log.warn(
            `notify-discord-responder: webhook POST for "${issue.repo}" returned HTTP ${res.status}`,
          );
          emit("failed", envelope, issue.repo, `http-${res.status}`);
        }
      } catch (err) {
        log.error(
          `notify-discord-responder: webhook POST for "${issue.repo}" failed: ${errMsg(err)}`,
        );
        emit("failed", envelope, issue.repo, errMsg(err));
      }
    })();
  };

  return {
    subjects: [pattern],
    async start() {
      if (registration !== undefined) return;
      if (!opts.runtime.enabled) {
        log.info("notify-discord-responder: runtime disabled — dormant");
        return;
      }
      registration = opts.runtime.onEnvelope((envelope, subject) => {
        handle(envelope, subject);
      });
      // Self-subscribe the pattern so the responder is independent of the
      // dispatch-listener's subscription (idempotent — myelin dedupes).
      if (opts.runtime.subscribe) {
        const sub = await opts.runtime.subscribe(pattern);
        if (sub) subscribers.push(sub);
      }
      log.info(
        `notify-discord-responder: started — capability=${capability} repos=${webhookByRepo.size} pattern=${pattern}`,
      );
    },
    async stop() {
      if (registration !== undefined) {
        registration.unregister();
        registration = undefined;
      }
      while (subscribers.length > 0) {
        const sub = subscribers.pop();
        if (sub) await sub.stop();
      }
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
