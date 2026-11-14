import type { Database } from "bun:sqlite";
import { listGrants } from "./autonomy";
import type { MailClassification } from "./classify";
import type { EventFacts } from "./event-follow";
import { attachMail, meetingTarget, offDeskIds, recordAutoLinkDone, type LinkReceipt } from "./links";
import type { ListedMail } from "./mail-actions";

export const AUTO_LINK_GRANT = "mail.link-meeting" as const;

export interface AutoLinkContext {
  db: Database;
  events: EventFacts["events"];
  vips: ReadonlySet<string>;
  now: number;
  newId?: () => string;
}


const wasEverLinked = (db: Database, messageId: string): boolean =>
  (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM desk_links WHERE from_kind = 'mail' AND from_key = ?").get(`mail:${messageId}`)?.n ?? 0) > 0;

/**
 * Links a classified mail to its meeting on its own, under the `mail.link-meeting` grant: only when the classifier answered
 * `link-meeting` with a meeting key, the meeting is still listed and has not ended, the sender is the meeting's organizer or
 * one of its attendees when the calendar lists any, and the mail is not suspicious, not a VIP's, not off the Desk and was never
 * linked before. The link has origin `auto`, and one Done for you entry with Undo records it.
 * Returns the link, or null when nothing was linked.
 */
export function autoLinkMeeting(ctx: AutoLinkContext, mail: ListedMail, c: MailClassification): LinkReceipt | null {
  const { db, now } = ctx;
  if (c.suggestedAction !== "link-meeting" || !c.meetingKey || c.suspicious === true) return null;
  if (!listGrants(db).has(AUTO_LINK_GRANT)) return null;
  const sender = mail.from.address.trim().toLowerCase();
  if (ctx.vips.has(sender) || offDeskIds(db).has(mail.id) || wasEverLinked(db, mail.id)) return null;
  const target = meetingTarget(ctx.events, c.meetingKey, { upcoming: true, now });
  if (typeof target === "string") return null;
  const people = ctx.events.get(c.meetingKey)?.organizerAndAttendees;
  if (people && !people.has(sender)) return null;
  const id = (ctx.newId ?? (() => crypto.randomUUID()))();
  return db.transaction((): LinkReceipt | null => {
    const linked = attachMail(db, mail, target, { id, requestId: `auto:${mail.id}`, origin: "auto", now });
    if (!linked.ok || linked.link.id !== id) return null;
    recordAutoLinkDone(db, linked.link, now);
    return linked.link;
  })();
}
