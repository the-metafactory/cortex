export const DMARC_FAIL_ON = ["dmarc", "spf-or-dkim"] as const;
export type DmarcFailOn = (typeof DMARC_FAIL_ON)[number];

export interface DmarcConfig {
  command: string[];
  domains: string[];
  failOn: DmarcFailOn;
  after: "archive" | "trash";
  timeoutSeconds: number;
  maxPerPass: number;
}

export const REFUSED_EXIT = 3;
export const CARD_DAYS = 7;

export const DMARC_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_dmarc (
    message_id TEXT PRIMARY KEY,
    account TEXT,
    source_id TEXT,
    subject TEXT,
    url TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    org TEXT,
    begin_at INTEGER,
    end_at INTEGER,
    domains TEXT,
    filed TEXT,
    acked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_dmarc_time ON desk_mail_dmarc (created_at)",
];
