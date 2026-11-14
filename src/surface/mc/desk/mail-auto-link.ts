import type { Database } from "bun:sqlite";
import { listGrants } from "./autonomy";
import type { MailClassification } from "./classify";
import type { EventFacts } from "./event-follow";
import { attachMail, AUTO_LINK_DONE, autoLinkDoneKey, meetingTarget, offDeskIds, type LinkReceipt } from "./links";
import type { ListedMail } from "./mail-actions";

export const AUTO_LINK_GRANT = "mail.link-meeting";

export interface AutoLinkContext {
  db: Database;
  events: EventFacts["events"];
  vips: ReadonlySet<string>;
  now: number;
  newId?: () => string;
}

const quoted = (title: string): string => `“${title}”`;

const wasEverLinked = (db: Database, messageId: string): boolean =>
  (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM desk_links WHERE from_kind = 'mail' AND from_key = ?").get(`mail:${messageId}`)?.n ?? 0) > 0;

/**
 * Links a classified mail to its meeting on its own, under the `mail.link-meeting` grant: only when the classifier answered
 * `link-meeting` with a meeting key, the meeting is still listed and has not ended, and the mail is not suspicious, not a VIP's,
 * not off the Desk and was never linked before. The link has origin `auto`, and one Done for you entry with Undo records it.
 * Returns the link, or null when nothing was linked.
 */
export function autoLinkMeeting(ctx: AutoLinkContext, mail: ListedMail, c: MailClassification): LinkReceipt | null {
  const { db, now } = ctx;
  if (c.suggestedAction !== "link-meeting" || !c.meetingKey || c.suspicious === true) return null;
  if (!listGrants(db).has(AUTO_LINK_GRANT)) return null;
  if (ctx.vips.has(mail.from.address.toLowerCase()) || offDeskIds(db).has(mail.id) || wasEverLinked(db, mail.id)) return null;
  const target = meetingTarget(ctx.events, c.meetingKey, { upcoming: true, now });
  if (typeof target === "string") return null;
  const id = (ctx.newId ?? (() => crypto.randomUUID()))();
  return db.transaction((): LinkReceipt | null => {
    const linked = attachMail(db, mail, target, { id, requestId: `auto:${mail.id}`, origin: "auto", now });
    if (!linked.ok || linked.link.id !== id) return null;
    db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?) ON CONFLICT(attempt_key) DO NOTHING").run(
      autoLinkDoneKey(id), AUTO_LINK_DONE, id, `Linked ${quoted(linked.link.from.title)} to ${quoted(target.title)}`, "It stays in your mailbox and shows with the meeting.", now, now,
    );
    return linked.link;
  })();
}
