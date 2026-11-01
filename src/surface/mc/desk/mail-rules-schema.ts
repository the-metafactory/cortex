export const RULE_MATCHES = ["sender", "domain", "list", "subject"] as const;
export type RuleMatch = (typeof RULE_MATCHES)[number];

export const RULE_ACTIONS = ["archive", "junk", "trash", "digest"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const RULE_STATES = ["on", "off"] as const;
export type RuleState = (typeof RULE_STATES)[number];

export const PROPOSAL_ANSWERS = ["later", "never"] as const;
export type ProposalAnswer = (typeof PROPOSAL_ANSWERS)[number];

export interface MailRulesConfig {
  proposeAfter: number;
  maxPerPass: number;
  windowDays: number;
}

export const DEFAULT_MAIL_RULES: MailRulesConfig = { proposeAfter: 8, maxPerPass: 20, windowDays: 90 };

export const MAIL_RULES_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_rules (
    id TEXT PRIMARY KEY,
    match TEXT NOT NULL,
    value TEXT NOT NULL,
    action TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_run_at INTEGER,
    count INTEGER NOT NULL DEFAULT 0,
    held INTEGER,
    released INTEGER NOT NULL DEFAULT 0,
    UNIQUE (match, value)
  )`,
  `CREATE TABLE IF NOT EXISTS desk_mail_rule_answers (
    match TEXT NOT NULL,
    value TEXT NOT NULL,
    action TEXT NOT NULL,
    answer TEXT NOT NULL,
    until INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (match, value)
  )`,
  `CREATE TABLE IF NOT EXISTS desk_mail_rule_runs (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    account TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_rule_runs_rule ON desk_mail_rule_runs (rule_id, created_at)",
  "CREATE INDEX IF NOT EXISTS desk_mail_rule_runs_time ON desk_mail_rule_runs (created_at)",
];
