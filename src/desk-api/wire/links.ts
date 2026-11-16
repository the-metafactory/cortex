export const LINK_FROM_KINDS = ["mail", "task", "thread", "note"] as const;

export type LinkFromKind = (typeof LINK_FROM_KINDS)[number];

export const LINK_TO_KINDS = ["task", "meeting", "thread"] as const;

export type LinkToKind = (typeof LINK_TO_KINDS)[number];

/** Who made a link: the principal on the Desk, an approved rule, or the Desk on its own under the `mail.link-meeting` grant. */
export type LinkOrigin = "desk" | "rule" | "auto";

/** What a mail link keeps of the mail, so the link still reads after the mail leaves the inbox. */
export interface MailSnapshot {
  sourceId?: string;
  sender: string;
  senderName: string | null;
  receivedAt: string;
  url: string | null;
  account: string | null;
}

/** The link as a response returns it. */
export interface LinkReceipt {
  id: string;
  from: { kind: LinkFromKind; key: string; title: string };
  to: { kind: LinkToKind; key: string; title: string; at?: number; end?: number };
  origin: LinkOrigin;
  at: number;
}

/** A link as My day lists it with its task, with the mail snapshot for a mail link. */
export interface DeskLinkView extends LinkReceipt {
  mail: MailSnapshot | null;
}

export interface EventLink {
  id: string;
  kind: LinkFromKind;
  key: string;
  title: string;
  origin: LinkOrigin;
}
