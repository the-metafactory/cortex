import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MailSweepGrantSchema, MailSweepRuleSchema, MailSweepTargetSchema, sameSweepRule, type MailSweepGrant, type MailSweepRule, type MailSweepTarget } from "./sweep-contract";

export interface MailSweepGrantInput {
  adapterId: string;
  connectionId: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
}

export interface MailSweepGrants {
  issue(input: MailSweepGrantInput, now: number): MailSweepGrant;
  active(connectionId: string, target: MailSweepTarget): MailSweepGrant | null;
  find(grantId: string): MailSweepGrant | null;
  list(connectionId?: string): MailSweepGrant[];
  revoke(grantId: string, now: number): boolean;
}

interface GrantRow {
  grant_id: string;
  adapter_id: string;
  connection_id: string;
  target: string;
  rule: string;
  status: string;
  created_at: number;
  revoked_at: number | null;
}

const COLUMNS = "grant_id, adapter_id, connection_id, target, rule, status, created_at, revoked_at";

const toGrant = (row: GrantRow): MailSweepGrant => MailSweepGrantSchema.parse({
  grantId: row.grant_id,
  adapterId: row.adapter_id,
  connectionId: row.connection_id,
  target: MailSweepTargetSchema.parse(row.target),
  rule: MailSweepRuleSchema.parse(JSON.parse(row.rule)),
  status: row.status,
  createdAt: new Date(row.created_at).toISOString(),
  revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
});

/** The one-click sweep permissions a connection holds: each names its target and the exact selection rule it covers. A run mints one exact authority grant per message from it. */
export class DeskMailSweepGrants implements MailSweepGrants {
  constructor(private readonly db: Database, private readonly newId: () => string = randomUUID) {}

  issue(input: MailSweepGrantInput, now: number): MailSweepGrant {
    const target = MailSweepTargetSchema.parse(input.target);
    const rule = MailSweepRuleSchema.parse(input.rule);
    const grantId = this.newId();
    this.db.transaction(() => {
      this.db.query("UPDATE desk_mail_sweep_grants SET status = 'revoked', revoked_at = ? WHERE connection_id = ? AND target = ? AND status = 'active'")
        .run(now, input.connectionId, target);
      this.db.query(`INSERT INTO desk_mail_sweep_grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`)
        .run(grantId, input.adapterId, input.connectionId, target, JSON.stringify(rule), now);
    })();
    const stored = this.find(grantId);
    if (!stored) throw new Error("The sweep permission was not stored.");
    return stored;
  }

  active(connectionId: string, target: MailSweepTarget): MailSweepGrant | null {
    const row = this.db.query<GrantRow, [string, string]>(`SELECT ${COLUMNS} FROM desk_mail_sweep_grants WHERE connection_id = ? AND target = ? AND status = 'active' ORDER BY created_at DESC, grant_id DESC LIMIT 1`).get(connectionId, target);
    return row ? toGrant(row) : null;
  }

  find(grantId: string): MailSweepGrant | null {
    const row = this.db.query<GrantRow, [string]>(`SELECT ${COLUMNS} FROM desk_mail_sweep_grants WHERE grant_id = ?`).get(grantId);
    return row ? toGrant(row) : null;
  }

  list(connectionId?: string): MailSweepGrant[] {
    const rows = connectionId === undefined
      ? this.db.query<GrantRow, []>(`SELECT ${COLUMNS} FROM desk_mail_sweep_grants ORDER BY created_at DESC, grant_id DESC`).all()
      : this.db.query<GrantRow, [string]>(`SELECT ${COLUMNS} FROM desk_mail_sweep_grants WHERE connection_id = ? ORDER BY created_at DESC, grant_id DESC`).all(connectionId);
    return rows.map(toGrant);
  }

  revoke(grantId: string, now: number): boolean {
    return this.db.query("UPDATE desk_mail_sweep_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ? AND status = 'active'").run(now, grantId).changes > 0;
  }
}

export const sweepGrantCovers = (grant: MailSweepGrant | null, target: MailSweepTarget, rule: MailSweepRule): grant is MailSweepGrant =>
  grant !== null && grant.status === "active" && grant.target === target && sameSweepRule(grant.rule, rule);
