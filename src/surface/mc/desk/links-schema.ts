import type { LinkFromKind, LinkToKind, LinkOrigin, MailSnapshot, LinkReceipt, DeskLinkView } from "../../../desk-api/wire/links";
export type { LinkFromKind, LinkToKind, LinkOrigin, MailSnapshot, LinkReceipt, DeskLinkView };

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

export type LinkState = "linked" | "undone" | "lost";

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

