import type { Database } from "bun:sqlite";
import { z } from "zod";
import { MailSweepRuleSchema, MailSweepTargetSchema, type MailSweepRule, type MailSweepTarget } from "./sweep-contract";

export interface MailSweepSetItem {
  messageId: string;
  subject: string;
  operationId: string;
  authorityGrantId: string | null;
}

export interface MailSweepSetInput {
  sweepId: string;
  adapterId: string;
  connectionId: string;
  account: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
  digest: string;
  count: number;
  items: readonly MailSweepSetItem[];
}

export interface MailSweepSet {
  sweepId: string;
  adapterId: string;
  connectionId: string;
  account: string;
  target: MailSweepTarget;
  rule: MailSweepRule;
  digest: string;
  count: number;
  createdAt: number;
  undoneAt: number | null;
  items: MailSweepSetItem[];
}

export interface MailSweepSets {
  register(input: MailSweepSetInput, now: number): MailSweepSet;
  find(sweepId: string): MailSweepSet | null;
  list(connectionId: string, limit: number): MailSweepSet[];
  discard(sweepId: string): void;
  markUndone(sweepId: string, now: number): void;
}

const ItemSchema = z.object({ messageId: z.string().min(1), subject: z.string(), operationId: z.string().min(1), authorityGrantId: z.string().min(1).nullable() }).strict();
const SetSchema = z.object({
  sweepId: z.uuid(),
  adapterId: z.string().min(1),
  connectionId: z.string().min(1),
  account: z.string().min(1),
  target: MailSweepTargetSchema,
  rule: MailSweepRuleSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  count: z.number().int().nonnegative(),
  items: z.array(ItemSchema).min(1),
}).strict();

interface SetRow {
  sweep_id: string;
  adapter_id: string;
  connection_id: string;
  account: string;
  target: string;
  rule: string;
  digest: string;
  count: number;
  created_at: number;
  undone_at: number | null;
}

interface ItemRow {
  message_id: string;
  subject: string;
  operation_id: string;
  authority_grant_id: string | null;
}

/** The exact messages one sweep set out to move, and the authority each one ran under, so its Undo names each without rereading the mailbox. */
export class DeskMailSweepSets implements MailSweepSets {
  constructor(private readonly db: Database) {}

  register(input: MailSweepSetInput, now: number): MailSweepSet {
    const parsed = SetSchema.parse({ ...input, items: [...input.items] });
    if (parsed.items.length !== parsed.count) throw new Error("The sweep names a count that differs from its messages.");
    if (this.find(parsed.sweepId)) throw new Error("That sweep is already recorded.");
    this.db.transaction(() => {
      this.db.query("INSERT INTO desk_mail_sweep_sets (sweep_id, adapter_id, connection_id, account, target, rule, digest, count, created_at, undone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
        .run(parsed.sweepId, parsed.adapterId, parsed.connectionId, parsed.account, parsed.target, JSON.stringify(parsed.rule), parsed.digest, parsed.count, now);
      for (const [position, item] of parsed.items.entries()) {
        this.db.query("INSERT INTO desk_mail_sweep_set_mails (sweep_id, position, message_id, subject, operation_id, authority_grant_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(parsed.sweepId, position, item.messageId, item.subject, item.operationId, item.authorityGrantId);
      }
    })();
    const stored = this.find(parsed.sweepId);
    if (!stored) throw new Error("The sweep was not stored.");
    return stored;
  }

  find(sweepId: string): MailSweepSet | null {
    const row = this.db.query<SetRow, [string]>("SELECT sweep_id, adapter_id, connection_id, account, target, rule, digest, count, created_at, undone_at FROM desk_mail_sweep_sets WHERE sweep_id = ?").get(sweepId);
    if (!row) return null;
    const items = this.db.query<ItemRow, [string]>("SELECT message_id, subject, operation_id, authority_grant_id FROM desk_mail_sweep_set_mails WHERE sweep_id = ? ORDER BY position").all(row.sweep_id);
    return {
      sweepId: row.sweep_id, adapterId: row.adapter_id, connectionId: row.connection_id, account: row.account,
      target: MailSweepTargetSchema.parse(row.target), rule: MailSweepRuleSchema.parse(JSON.parse(row.rule)),
      digest: row.digest, count: row.count, createdAt: row.created_at, undoneAt: row.undone_at,
      items: items.map(item => ({ messageId: item.message_id, subject: item.subject, operationId: item.operation_id, authorityGrantId: item.authority_grant_id })),
    };
  }

  list(connectionId: string, limit: number): MailSweepSet[] {
    const rows = this.db.query<{ sweep_id: string }, [string, number]>("SELECT sweep_id FROM desk_mail_sweep_sets WHERE connection_id = ? ORDER BY created_at DESC, sweep_id DESC LIMIT ?").all(connectionId, limit);
    return rows.flatMap(row => { const set = this.find(row.sweep_id); return set ? [set] : []; });
  }

  discard(sweepId: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM desk_mail_sweep_set_mails WHERE sweep_id = ?").run(sweepId);
      this.db.query("DELETE FROM desk_mail_sweep_sets WHERE sweep_id = ? AND undone_at IS NULL").run(sweepId);
    })();
  }

  markUndone(sweepId: string, now: number): void {
    this.db.query("UPDATE desk_mail_sweep_sets SET undone_at = ? WHERE sweep_id = ?").run(now, sweepId);
  }
}
