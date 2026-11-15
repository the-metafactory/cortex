import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MailLoopGrantSchema, loopSelectionFits, type MailLoopAction, type MailLoopGrant, type MailLoopKind, type MailLoopSelection } from "./loop-contract";

export interface MailLoopGrantInput {
  loop: MailLoopKind;
  adapterId: string;
  connectionId: string;
  actions: readonly MailLoopAction[];
  selection: MailLoopSelection;
  authorityGrantId: string | null;
}

/** The standing Mail grants one connection holds per loop, and whether each loop is paused. */
export interface MailLoopGrants {
  issue(input: MailLoopGrantInput, now: number): MailLoopGrant;
  active(loop: MailLoopKind, connectionId: string): MailLoopGrant | null;
  find(grantId: string): MailLoopGrant | null;
  list(loop?: MailLoopKind): MailLoopGrant[];
  revoke(grantId: string, now: number): boolean;
  paused(loop: MailLoopKind): boolean;
  pause(loop: MailLoopKind, now: number): void;
  resume(loop: MailLoopKind): void;
}

interface GrantRow {
  grant_id: string;
  adapter_id: string;
  connection_id: string;
  loop: string;
  actions: string;
  selection: string;
  authority_grant_id: string | null;
  status: string;
  created_at: number;
  revoked_at: number | null;
}

const COLUMNS = "grant_id, adapter_id, connection_id, loop, actions, selection, authority_grant_id, status, created_at, revoked_at";

const toGrant = (row: GrantRow): MailLoopGrant => {
  const actions: unknown = JSON.parse(row.actions);
  const selection: unknown = JSON.parse(row.selection);
  return MailLoopGrantSchema.parse({
    grantId: row.grant_id, adapterId: row.adapter_id, connectionId: row.connection_id, loop: row.loop,
    actions, selection, authorityGrantId: row.authority_grant_id, status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  });
};

export class DeskMailLoopGrants implements MailLoopGrants {
  constructor(private readonly db: Database, private readonly newId: () => string = randomUUID) {}

  issue(input: MailLoopGrantInput, now: number): MailLoopGrant {
    if (!loopSelectionFits(input.loop, input.selection)) throw new Error("The standing Mail grant names a selection this loop cannot use.");
    const actions = [...new Set(input.actions)];
    if (actions.length === 0) throw new Error("A standing Mail grant names at least one action.");
    const grantId = this.newId();
    this.db.transaction(() => {
      this.db.query("UPDATE desk_mail_loop_grants SET status = 'revoked', revoked_at = ? WHERE loop = ? AND connection_id = ? AND status = 'active'")
        .run(now, input.loop, input.connectionId);
      this.db.query(`INSERT INTO desk_mail_loop_grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`)
        .run(grantId, input.adapterId, input.connectionId, input.loop, JSON.stringify(actions), JSON.stringify(input.selection), input.authorityGrantId, now);
    })();
    const stored = this.find(grantId);
    if (!stored) throw new Error("The standing Mail grant was not stored.");
    return stored;
  }

  active(loop: MailLoopKind, connectionId: string): MailLoopGrant | null {
    const row = this.db.query<GrantRow, [string, string]>(`SELECT ${COLUMNS} FROM desk_mail_loop_grants WHERE loop = ? AND connection_id = ? AND status = 'active' ORDER BY created_at DESC, grant_id DESC LIMIT 1`).get(loop, connectionId);
    return row ? toGrant(row) : null;
  }

  find(grantId: string): MailLoopGrant | null {
    const row = this.db.query<GrantRow, [string]>(`SELECT ${COLUMNS} FROM desk_mail_loop_grants WHERE grant_id = ?`).get(grantId);
    return row ? toGrant(row) : null;
  }

  list(loop?: MailLoopKind): MailLoopGrant[] {
    const rows = loop === undefined
      ? this.db.query<GrantRow, []>(`SELECT ${COLUMNS} FROM desk_mail_loop_grants ORDER BY created_at DESC, grant_id DESC`).all()
      : this.db.query<GrantRow, [string]>(`SELECT ${COLUMNS} FROM desk_mail_loop_grants WHERE loop = ? ORDER BY created_at DESC, grant_id DESC`).all(loop);
    return rows.map(toGrant);
  }

  revoke(grantId: string, now: number): boolean {
    return this.db.query("UPDATE desk_mail_loop_grants SET status = 'revoked', revoked_at = ? WHERE grant_id = ? AND status = 'active'").run(now, grantId).changes > 0;
  }

  paused(loop: MailLoopKind): boolean {
    return this.db.query("SELECT 1 FROM desk_mail_loop_state WHERE loop = ? AND paused_at IS NOT NULL").get(loop) !== null;
  }

  pause(loop: MailLoopKind, now: number): void {
    this.db.query("INSERT INTO desk_mail_loop_state (loop, paused_at) VALUES (?, ?) ON CONFLICT(loop) DO UPDATE SET paused_at = excluded.paused_at").run(loop, now);
  }

  resume(loop: MailLoopKind): void {
    this.db.query("UPDATE desk_mail_loop_state SET paused_at = NULL WHERE loop = ?").run(loop);
  }
}
