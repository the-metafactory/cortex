export const LINKS_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_links (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    from_kind TEXT NOT NULL,
    from_key TEXT NOT NULL,
    from_title TEXT NOT NULL,
    from_detail TEXT,
    to_kind TEXT NOT NULL,
    to_key TEXT NOT NULL,
    to_title TEXT NOT NULL,
    to_at INTEGER,
    to_end INTEGER,
    origin TEXT NOT NULL,
    rule_run TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS desk_links_one_mail ON desk_links (from_key) WHERE from_kind = 'mail' AND state = 'linked'",
  "CREATE UNIQUE INDEX IF NOT EXISTS desk_links_one_pair ON desk_links (from_kind, from_key, to_kind, to_key) WHERE state = 'linked'",
  "CREATE INDEX IF NOT EXISTS desk_links_from ON desk_links (from_kind, from_key, state)",
  "CREATE INDEX IF NOT EXISTS desk_links_to ON desk_links (to_kind, to_key, state)",
];

export const LINK_FROM_KINDS = ["mail", "task", "thread", "note"] as const;
export type LinkFromKind = (typeof LINK_FROM_KINDS)[number];

export const LINK_TO_KINDS = ["task", "meeting", "thread"] as const;
export type LinkToKind = (typeof LINK_TO_KINDS)[number];

/** Who made a link: the principal on the Desk, an approved rule, or the Desk on its own under the `mail.link-meeting` grant. */
export type LinkOrigin = "desk" | "rule" | "auto";
export type LinkState = "linked" | "undone" | "lost";

/** What a mail link keeps of the mail, so the link still reads after the mail leaves the inbox. */
export interface MailSnapshot {
  sender: string;
  senderName: string | null;
  receivedAt: string;
  url: string | null;
  account: string | null;
}

export interface LinkRow {
  id: string;
  requestId: string;
  fromKind: LinkFromKind;
  fromKey: string;
  fromTitle: string;
  mail: MailSnapshot | null;
  toKind: LinkToKind;
  toKey: string;
  toTitle: string;
  toAt: number | null;
  toEnd: number | null;
  origin: LinkOrigin;
  ruleRun: string | null;
  state: LinkState;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
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
