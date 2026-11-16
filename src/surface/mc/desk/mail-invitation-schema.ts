import { INVITE_REPLIES } from "../../../desk-api/wire/mail";
import type { InviteReply, InviteStatus } from "../../../desk-api/wire/mail";
export { INVITE_REPLIES };
export type { InviteReply, InviteStatus };

export interface InvitationSlotsConfig {
  days: number;
  dayStart: string;
  dayEnd: string;
  max: number;
}

export type InvitationCalendar = string | { account: string; calendar?: string | undefined };

export interface InvitationsConfig {
  command: string[];
  timeoutSeconds: number;
  calendarWriter?: string[] | undefined;
  addToCalendar: InvitationCalendar[];
  removeOnDecline?: { account: string; command: string[] }[] | undefined;
  slots: InvitationSlotsConfig;
}

export const DEFAULT_SLOTS: InvitationSlotsConfig = { days: 5, dayStart: "09:00", dayEnd: "18:00", max: 5 };

export const INVITATIONS_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_invitations (
    request_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    account TEXT NOT NULL,
    source_id TEXT NOT NULL,
    uid TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    reply TEXT NOT NULL,
    commitment TEXT,
    status TEXT NOT NULL,
    result TEXT,
    calendar TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_invitations_message ON desk_mail_invitations (message_id, created_at)",
];
