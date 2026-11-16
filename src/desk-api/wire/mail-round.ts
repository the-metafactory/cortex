import type { MoveTarget } from "./mail";

export const MAIL_ROUND_GROUP_KINDS = ["bundle", "sweep", "digest"] as const;

export type MailRoundGroupKind = (typeof MAIL_ROUND_GROUP_KINDS)[number];

export interface MailRoundGroupView {
  id: string;
  kind: MailRoundGroupKind;
  label: string;
  title: string;
  target: MoveTarget;
  area: string | null;
  mails: string[];
}

export interface MailRoundMailView {
  key: string;
  subject: string;
  from: string;
  at: string;
  unread: boolean;
  area: string | null;
  url?: string;
  groupId?: string;
}

export interface MailRoundUnavailable {
  mail: string[];
  calendar: string[];
}

export interface MailRoundView {
  id: string | null;
  revision: number;
  due: boolean;
  scheduledFor: string | null;
  nextScheduledAt: string;
  waiting: number;
  groups: MailRoundGroupView[];
  mails: MailRoundMailView[];
  unavailable: MailRoundUnavailable;
}
