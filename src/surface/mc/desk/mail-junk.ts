import type { Database } from "bun:sqlite";
import type { ListedMail } from "./mail-actions";
import { isRestoredSinceListed, restoredJunk } from "./mail-move";
import { recentJunk, type SourceMail, type SourceReading } from "./sources/command";
import type { DeskItem, JunkReviewMail } from "./types";

const junkKey = (source: string, mail: SourceMail): string => `junk:${JSON.stringify([source, mail.account ?? null, mail.id])}`;

export function listedJunk(readings: SourceReading[], now: number): (ListedMail & { key: string; listedAt: number })[] {
  return readings.flatMap(r => recentJunk(r.junk ?? [], now).map(m => ({ ...m, sourceId: r.id, key: junkKey(r.id, m), listedAt: r.junkReadAt ?? r.readAt })));
}

export function junkReviewItems(db: Database, readings: SourceReading[], now: number, canMove: boolean): DeskItem[] {
  const reported = listedJunk(readings, now);
  if (reported.length === 0) return [];
  const restored = restoredJunk(db);
  const mail = reported.filter(m => !isRestoredSinceListed(restored, m));
  return readings.flatMap(r => {
    const listed = mail.filter(m => m.sourceId === r.id);
    if (listed.length === 0) return [];
    const mails: JunkReviewMail[] = listed.map(m => ({ key: m.key, from: m.from, subject: m.subject, receivedAt: m.receivedAt, action: { id: "mail.notspam", label: "Not spam", role: "secondary", wired: canMove, target: m.key } }));
    const accounts = [...new Set(listed.flatMap(m => m.account ? [m.account] : []))];
    const label = accounts.length === 1 ? accounts[0] : r.id;
    return [{
      key: `mail-junk:${r.id}`, kind: "mail-junk", source: r.id, area: r.area, urgency: "this-week", score: 15,
      title: `Review Junk in ${label}`, why: `${mails.length} recent ${mails.length === 1 ? "mail" : "mails"} in Junk.`,
      actions: [{ id: "detail", label: "Review junk", role: "primary", wired: true }],
      detail: { summary: "Junk mail from the last seven days. Mark a mail as Not spam to move it back to INBOX.", history: [], refs: [], links: [] },
      junkReview: { mails },
    }];
  });
}
