/**
 * G-1113.E.4 — attention notification routing (design §5.5 / §7.4).
 *
 * Builds `system.attention.{opened,resolved}` envelopes from AttentionItems so
 * the bus can route them to stack surfaces (Discord/Slack/Mattermost). The
 * message is rendered HERE, in code, into a deterministic `presentation` string
 * (the deterministic-surface model: surfaces render `presentation` verbatim,
 * never an LLM token). The envelope carries the structured attention data + a
 * deep-link so a surface can also build a richer rendering if it wants.
 *
 * Layering: this is the M7 surface domain (it owns AttentionItem); it uses the
 * bus's `buildBaseEnvelope` primitive + the `system.*` source/sovereignty
 * helpers (M2) — the correct M7→M2 direction. Reusing `defaultSystemSovereignty`
 * (rather than re-stating the posture) keeps attention on the same audited
 * principal-only/never-frontier posture as the other `system.*` emitters.
 *
 * Emit wiring is the DEFERRED integration step (same mechanism-vs-trigger split
 * as the D.2/D.5b/E.2 ingestion + reconcile mechanisms): a caller publishes the
 * deltas a reconcile produces, and a Discord surface adapter would subscribe to
 * `system.attention.*` and render `payload.presentation` — that adapter branch
 * does NOT exist yet (it mirrors the `review.verdict.*` branch in
 * adapters/review-sink). `publishAttentionNotifications` below is the publish
 * seam (injected publisher) so the emit path is testable now.
 */
import type { Envelope } from "../../bus/myelin/envelope-validator";
import { buildBaseEnvelope } from "../../bus/envelope-builder";
import { buildSource, defaultSystemSovereignty } from "../../bus/system-events";
import type { AttentionItem } from "./types";

export type AttentionAction = "opened" | "resolved";

export interface AttentionNotifySource {
  /** Boot-resolved principal slug — first source segment. */
  principal: string;
  /** Logical agent — defaults to "cortex". */
  agent?: string;
  /** Instance — defaults to "local". */
  instance?: string;
  /** Data-residency code stamped into sovereignty. Defaults to "NZ". */
  dataResidency?: string;
}

export interface AttentionNotifyOptions {
  source: AttentionNotifySource;
  /** Canonical deep-link URL to the item's target (caller builds from its surface base). */
  deepLinkUrl?: string | null;
}

/**
 * Deterministic one-liner — built in code, never an LLM token. Shape:
 * `[severity] kind needs attention — <url>` / `[severity] kind cleared`.
 */
export function attentionPresentation(
  item: AttentionItem,
  action: AttentionAction,
  deepLinkUrl: string | null,
): string {
  const verb = action === "opened" ? "needs attention" : "cleared";
  const where = action === "opened" && deepLinkUrl ? ` — ${deepLinkUrl}` : "";
  return `[${item.severity}] ${item.kind} ${verb}${where}`;
}

/**
 * Build a `system.attention.{action}` envelope for one item. `action` is the
 * caller-asserted lifecycle transition (the reconcile delta — newly-opened vs
 * newly-resolved), NOT derived from `item.status`; the caller owns that
 * decision so a single item can be re-notified across transitions.
 */
export function attentionNotificationEnvelope(
  item: AttentionItem,
  action: AttentionAction,
  opts: AttentionNotifyOptions,
): Envelope {
  // Reuse the system.* source + sovereignty helpers (no duplicated posture).
  const sysSource = {
    principal: opts.source.principal,
    agent: opts.source.agent ?? "cortex",
    instance: opts.source.instance ?? "local",
    dataResidency: opts.source.dataResidency,
  };
  const deepLinkUrl = opts.deepLinkUrl ?? null;
  return buildBaseEnvelope({
    type: `system.attention.${action}`,
    source: buildSource(sysSource),
    sovereignty: defaultSystemSovereignty(sysSource),
    payload: {
      attention: {
        id: item.id,
        stack_id: item.stackId,
        kind: item.kind,
        severity: item.severity,
        work_item_id: item.workItemId,
        session_id: item.sessionId,
      },
      deep_link_url: deepLinkUrl,
      // Code-rendered message the surface displays verbatim.
      presentation: attentionPresentation(item, action, deepLinkUrl),
    },
  });
}

/** A publisher seam — the bus client's publish, injected for testability. */
export type EnvelopePublisher = (envelope: Envelope) => void | Promise<void>;

/**
 * Publish `system.attention.{action}` envelopes for a batch of items via the
 * injected publisher. The caller supplies the reconcile delta (newly-opened →
 * "opened", newly-resolved → "resolved") + a deep-link builder.
 */
export async function publishAttentionNotifications(
  items: AttentionItem[],
  action: AttentionAction,
  opts: AttentionNotifyOptions & { deepLinkFor?: (item: AttentionItem) => string | null },
  publish: EnvelopePublisher,
): Promise<number> {
  let count = 0;
  for (const item of items) {
    const deepLinkUrl = opts.deepLinkFor ? opts.deepLinkFor(item) : (opts.deepLinkUrl ?? null);
    await publish(attentionNotificationEnvelope(item, action, { ...opts, deepLinkUrl }));
    count += 1;
  }
  return count;
}
