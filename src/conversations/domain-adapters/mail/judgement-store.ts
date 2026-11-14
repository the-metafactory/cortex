import type { Database } from "bun:sqlite";
import { recordMailCorrection, type ListedMail } from "../../../surface/mc/desk/mail-actions";
import { forgetClassification, readClassifications } from "../../../surface/mc/desk/classify";
import { CORRECTION_MOVES } from "../../../surface/mc/desk/mail-correction-schema";
import { logMailDecision, mailFeatures, senderDomain } from "../../../surface/mc/desk/mail-log";
import { UNDO_WINDOW_MS, type MoveTarget } from "../../../surface/mc/desk/mail-move";
import { cancelSnooze, snoozeMail } from "../../../surface/mc/desk/mail-snooze";
import { suspicionContext, suspicionOf } from "../../../surface/mc/desk/mail-suspicion";
import { dismissSuspicion, undoDismissal } from "../../../surface/mc/desk/mail-trust";
import { actOnWaiting, readWaiting, waitingKey } from "../../../surface/mc/desk/mail-waiting";
import { isVip, listVips, normalizeVip } from "../../../surface/mc/desk/vips";
import type { SourceReading } from "../../../surface/mc/desk/sources/command";
import type { DispatchRequest, Json, OwnerResult } from "../operations/types";
import { snapshotDigest } from "../operations/validation";
import type { MailConnectionBinding } from "../mail-read-source";
import { judgementCapability, judgementHasUndo, MailJudgementInputSchema, type MailJudgementInput, type MailJudgementOutput } from "./judgement-contract";

type Row = Record<string, string | number | null>;
type Undo =
  | { kind: "list"; address: string; token: string }
  | { kind: "trust"; dismissal: string }
  | { kind: "row"; table: "desk_mail_snoozes" | "desk_mail_waiting"; before: Row | null; after: Row | null; token: string; logs: number[] }
  | { kind: "correction"; logId: number; move: Json };
interface SavedChange { input: MailJudgementInput; output: MailJudgementOutput; undo: Undo | null; at: number }
type PreparedMove = Extract<MoveOutcome, { ok: true }> & { mail: ListedMail };
interface SavedRow { operation_id: string; digest: string; request_id: string; scope: string; message_id: string; mail_json: string | null; change_json: string | null; result_json: string | null; undone: number; undo_operation: string | null }
type MoveOutcome = { ok: true; token: Json; message: string } | { ok: false; code: string; message: string; uncertain?: boolean };

export interface MailJudgementMoves {
  readonly replay: "historical-idempotent";
  move(request: DispatchRequest, mail: ListedMail, target: MoveTarget): MoveOutcome | Promise<MoveOutcome>;
  restore(request: DispatchRequest, token: Json): MoveOutcome | Promise<MoveOutcome>;
}

export interface MailJudgementStoreOptions {
  db: Database;
  readings(): readonly SourceReading[];
  authorize(binding: MailConnectionBinding, request: DispatchRequest): Promise<boolean>;
  moves?: MailJudgementMoves;
  ownDomains?: readonly string[];
  now?: () => number;
}

class JudgementRefusal extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
const refuse = (code: string, message: string): never => { throw new JudgementRefusal(code, message); };
const scopeOf = (binding: MailConnectionBinding): string => JSON.stringify([binding.adapterId, binding.connectionId, binding.account, binding.sourceId]);

export class MailJudgementStore {
  private readonly db: Database;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MailJudgementStoreOptions) {
    this.db = options.db;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS desk_mail_judgement_operations (
        operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, request_id TEXT NOT NULL, scope TEXT NOT NULL,
        message_id TEXT NOT NULL, mail_json TEXT, change_json TEXT, result_json TEXT, undone INTEGER NOT NULL DEFAULT 0, undo_operation TEXT
      );
      CREATE TABLE IF NOT EXISTS desk_mail_judgement_list_versions (address TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desk_mail_judgement_row_versions (table_name TEXT NOT NULL, message_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (table_name, message_id));
      INSERT OR IGNORE INTO desk_mail_judgement_list_versions SELECT address, lower(hex(randomblob(16))) FROM desk_unimportant;
      CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_insert AFTER INSERT ON desk_unimportant BEGIN
        INSERT INTO desk_mail_judgement_list_versions VALUES (NEW.address, lower(hex(randomblob(16)))) ON CONFLICT(address) DO UPDATE SET token = excluded.token;
      END;
      CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_update AFTER UPDATE ON desk_unimportant BEGIN
        INSERT INTO desk_mail_judgement_list_versions VALUES (NEW.address, lower(hex(randomblob(16)))) ON CONFLICT(address) DO UPDATE SET token = excluded.token;
      END;
      CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_delete AFTER DELETE ON desk_unimportant BEGIN
        DELETE FROM desk_mail_judgement_list_versions WHERE address = OLD.address;
      END;
    `);
    for (const table of ["desk_mail_snoozes", "desk_mail_waiting"]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        const row = event === "DELETE" ? "OLD" : "NEW";
        this.db.run(`CREATE TRIGGER IF NOT EXISTS ${table}_judgement_${event} AFTER ${event} ON ${table} BEGIN
          INSERT INTO desk_mail_judgement_row_versions VALUES ('${table}', ${row}.message_id, lower(hex(randomblob(16)))) ON CONFLICT(table_name, message_id) DO UPDATE SET token = excluded.token;
        END;`);
      }
    }
  }

  dispatch(binding: MailConnectionBinding, request: DispatchRequest, published: () => boolean = () => true): Promise<OwnerResult> {
    const run = this.tail.then(() => {
      if (!published()) throw new Error("The Mail judgement adapter generation was fenced before execution.");
      return this.apply(binding, request, published);
    });
    this.tail = run.then(() => undefined, (error: unknown) => { process.stderr.write(`Mail judgement store: ${String(error)}\n`); });
    return run;
  }

  private async apply(binding: MailConnectionBinding, request: DispatchRequest, published: () => boolean): Promise<OwnerResult> {
    const now = (this.options.now ?? Date.now)();
    const envelope = (result: OwnerResult["result"]): OwnerResult => ({ lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `mail-judgement:${request.attemptId}`, reportedAt: new Date(now).toISOString(), result });
    const failure = (error: JudgementRefusal): OwnerResult["result"] => {
      const detail = { code: `${binding.adapterId}.${error.code}`, message: error.message };
      if (error.uncertain) return { kind: "uncertain", error: detail, ownerRequestId: request.ownerRequestId };
      const evidence = { kind: "no-effect" as const, evidenceId: `mail-judgement:${request.operationId}`, ownerRequestId: request.ownerRequestId, observedAt: new Date(now).toISOString(), receipt: { refused: true }, final: true as const };
      return error.code === "judgement_conflict" ? { kind: "conflict", error: detail, currentOwnerRevision: "changed", evidence } : { kind: "failed", error: detail, evidence };
    };
    let reserved = false;
    try {
      const input = MailJudgementInputSchema.parse(request.snapshot.input);
      const snapshot = request.snapshot;
      if (snapshotDigest(snapshot) !== snapshot.digest || snapshot.adapterId !== binding.adapterId || snapshot.connectionId !== binding.connectionId || input.message.adapterId !== binding.adapterId || input.message.connectionId !== binding.connectionId || snapshot.capabilityId !== judgementCapability(input.action)) return envelope(failure(new JudgementRefusal("invalid_request", "The judgement does not match this connection and capability.")));
      const destination = snapshot.destinations[0];
      if (snapshot.destinations.length !== 1 || destination?.objectType !== "account" || destination.canonicalId !== binding.account || destination.adapterId !== binding.adapterId || destination.connectionId !== binding.connectionId) return envelope(failure(new JudgementRefusal("account_denied", "This account is not available to the connection.")));
      if (!judgementHasUndo(input) && input.action !== "undo" && request.authority.basis.kind !== "confirmation") return envelope(failure(new JudgementRefusal("confirmation_required", "This change needs a confirmation every time.")));
      const existing = this.saved(request.operationId);
      if (existing) {
        if (existing.digest !== snapshot.digest || existing.request_id !== request.ownerRequestId || existing.scope !== scopeOf(binding)) return envelope(failure(new JudgementRefusal("judgement_conflict", "This operation identity was already used for another change.")));
        if (existing.result_json) {
          const previous = JSON.parse(existing.result_json) as OwnerResult["result"];
          if (previous.kind !== "uncertain") return envelope(previous);
        }
      } else {
        this.db.query("INSERT INTO desk_mail_judgement_operations (operation_id, digest, request_id, scope, message_id) VALUES (?, ?, ?, ?, ?)").run(request.operationId, snapshot.digest, request.ownerRequestId, scopeOf(binding), input.message.canonicalId);
      }
      reserved = true;
      if (!await this.options.authorize(binding, request) || !published()) {
        const restoreMayHaveRun = input.action === "undo" && this.saved(input.operationId)?.undo_operation === request.operationId;
        if (existing?.mail_json || restoreMayHaveRun) return envelope(failure(new JudgementRefusal("judgement_uncertain", "A previous move or restore may have completed. Its owner receipt awaits reconciliation; current authority permits no new effect.", true)));
        return refuse("account_denied", "Current connection authority no longer permits this judgement. Nothing changed.");
      }
      const moved = await this.prepareMove(binding, request, input, now);
      return this.db.transaction(() => {
        const current = this.saved(request.operationId);
        if (current?.result_json) {
          const previous = JSON.parse(current.result_json) as OwnerResult["result"];
          if (previous.kind !== "uncertain") return envelope(previous);
        }
        const changed = input.action === "undo" ? this.undo(binding, request, input, now) : this.change(binding, input, now, moved);
        const result: OwnerResult["result"] = { kind: "succeeded", output: changed.output, evidence: { kind: "effect", evidenceId: `mail-judgement:${request.operationId}`, ownerRequestId: request.ownerRequestId, observedAt: new Date(now).toISOString(), receipt: { operationId: request.operationId }, refs: [input.message] } };
        this.db.query("UPDATE desk_mail_judgement_operations SET change_json = ?, result_json = ? WHERE operation_id = ?").run(JSON.stringify(changed), JSON.stringify(result), request.operationId);
        return envelope(result);
      })();
    } catch (error) {
      if (!(error instanceof JudgementRefusal)) throw error;
      const result = failure(error);
      if (reserved) this.db.transaction(() => {
        this.db.query("UPDATE desk_mail_judgement_operations SET result_json = ? WHERE operation_id = ?").run(JSON.stringify(result), request.operationId);
        if (!error.uncertain) this.db.query("UPDATE desk_mail_judgement_operations SET undo_operation = NULL WHERE undo_operation = ? AND undone = 0").run(request.operationId);
      })();
      return envelope(result);
    }
  }

  private saved(id: string): SavedRow | null { return this.db.query<SavedRow, [string]>("SELECT * FROM desk_mail_judgement_operations WHERE operation_id = ?").get(id); }
  private listToken(address: string): string | null { return this.db.query<{ token: string }, [string]>("SELECT token FROM desk_mail_judgement_list_versions WHERE address = ?").get(address)?.token ?? null; }
  private row(table: string, messageId: string): Row | null { return this.db.query<Row, [string]>(`SELECT * FROM ${table} WHERE message_id = ?`).get(messageId); }
  private rowToken(table: string, id: string): string { return this.db.query<{ token: string }, [string, string]>("SELECT token FROM desk_mail_judgement_row_versions WHERE table_name = ? AND message_id = ?").get(table, id)?.token ?? ""; }

  private listed(binding: MailConnectionBinding, messageId: string): ListedMail {
    const readings = this.options.readings().filter(reading => reading.id === binding.sourceId);
    const found = readings.flatMap(reading => reading.mail.filter(mail => mail.id === messageId && mail.account === binding.account).map(mail => ({ ...mail, sourceId: reading.id })));
    const [mail] = found;
    if (readings.length !== 1 || found.length !== 1 || !mail) return refuse("message_missing", "The bound Mail source no longer lists this message in this account.");
    const collisions = this.options.readings().some(reading => reading.mail.some(item => item.id === messageId && (item.account !== binding.account || reading.id !== binding.sourceId)));
    if (collisions) return refuse("judgement_conflict", "This Message-ID is listed on another Mail source or account. Nothing changed.");
    return mail;
  }

  private async prepareMove(binding: MailConnectionBinding, request: DispatchRequest, input: MailJudgementInput, now: number): Promise<PreparedMove | undefined> {
    if (input.action === "correct" && CORRECTION_MOVES[input.said]) {
      const stored = this.saved(request.operationId);
      const mail = stored?.mail_json ? JSON.parse(stored.mail_json) as ListedMail : this.listed(binding, input.message.canonicalId);
      const target = CORRECTION_MOVES[input.said];
      if (!target || this.options.moves?.replay !== "historical-idempotent") return refuse("capability_unavailable", "This connection supplies no replay-safe correction move and restore path.");
      this.db.query("UPDATE desk_mail_judgement_operations SET mail_json = ? WHERE operation_id = ? AND mail_json IS NULL").run(JSON.stringify(mail), request.operationId);
      const moved = await this.options.moves.move(request, mail, target);
      if (!moved.ok) throw new JudgementRefusal(moved.code, moved.message, moved.uncertain);
      return { ...moved, mail };
    }
    if (input.action === "undo") {
      const undo = this.undoEvidence(binding, request, input, now);
      if (undo.kind !== "correction") return;
      if (this.options.moves?.replay !== "historical-idempotent") return refuse("capability_unavailable", "This connection supplies no replay-safe restore path.");
      const claimed = this.db.query("UPDATE desk_mail_judgement_operations SET undo_operation = ? WHERE operation_id = ? AND undone = 0 AND (undo_operation IS NULL OR undo_operation = ?)").run(request.operationId, input.operationId, request.operationId).changes;
      if (!claimed) return refuse("judgement_conflict", "This correction is already being undone.");
      const restored = await this.options.moves.restore(request, undo.move);
      if (!restored.ok) throw new JudgementRefusal(restored.code, restored.message, restored.uncertain);
    }
  }

  private change(binding: MailConnectionBinding, input: MailJudgementInput, now: number, moved?: PreparedMove): SavedChange {
    let undo: Undo | null = null;
    let message = "Mail judgement updated.";
    const id = input.message.canonicalId;
    if (input.action === "waiting") {
      const waiting = readWaiting(this.db, id);
      if (waiting?.account !== binding.account || waiting.sourceId !== binding.sourceId) return refuse("message_missing", "Mail no longer tracks this sent message on this connection.");
      undo = this.changeRow("desk_mail_waiting", id, () => actOnWaiting(this.db, waitingKey(id), input.op, now));
    } else {
      const mail = moved?.mail ?? this.listed(binding, id);
      if (input.action === "unimportant" || input.action === "block-domain") {
        const address = mail.from.address.trim().toLowerCase();
        const domain = normalizeVip(`@${senderDomain(address)}`);
        const vips = listVips(this.db).map(vip => vip.address);
        if (isVip(new Set(vips), address) || (input.action === "block-domain" && domain && vips.some(vip => vip.endsWith(domain)))) return refuse("vip_refused", "VIP mail cannot be marked unimportant or blocked. Nothing changed.");
        const entry = input.action === "unimportant" ? normalizeVip(address) : domain;
        if (!entry) return refuse("invalid_sender", "The sender has no address or domain Mail can list.");
        this.db.transaction(() => {
          const inserted = this.db.query("INSERT OR IGNORE INTO desk_unimportant (address, label, added_at) VALUES (?, ?, ?)").run(entry, input.action === "block-domain" ? "Blocked domain" : mail.from.name ?? null, now).changes;
          const token = this.listToken(entry);
          if (inserted && token) undo = { kind: "list", address: entry, token };
          if (inserted) logMailDecision(this.db, mailFeatures(this.db, mail), "unimportant", "desk", now);
        })();
        message = `${entry} is unimportant.`;
      } else if (input.action === "not-phishing") {
        const reasons = suspicionOf(mail, suspicionContext(this.db, this.options.ownDomains), readClassifications(this.db, [id]).get(id)?.suspicious);
        const result = dismissSuspicion(this.db, mail, reasons, now);
        if (!result.ok) return refuse("judgement_conflict", result.error);
        if (result.undo) undo = { kind: "trust", dismissal: result.undo };
        message = result.message;
      } else if (input.action === "snooze" || input.action === "snooze-cancel") {
        const existing = this.row("desk_mail_snoozes", id);
        if (existing && existing.source_id !== binding.sourceId) return refuse("judgement_conflict", "This snooze belongs to another Mail source. Nothing changed.");
        undo = this.changeRow("desk_mail_snoozes", id, () => input.action === "snooze" ? snoozeMail(this.db, mail, input.until, { now, readings: this.options.readings() }) : cancelSnooze(this.db, id));
      } else if (input.action === "correct") {
        const logId = this.db.transaction(() => recordMailCorrection(this.db, mail, input.said, now))();
        if (moved) undo = { kind: "correction", logId, move: moved.token };
        message = moved?.message ?? "Your correction is recorded. Mail will sort this message again.";
      }
    }
    return { input, output: { ref: input.message, message, undo: undo !== null }, undo, at: now };
  }

  private changeRow(table: Extract<Undo, { kind: "row" }>["table"], id: string, run: () => { ok: true } | { ok: false; error: string }): Undo {
    return this.db.transaction(() => {
      const before = this.row(table, id);
      const newest = this.db.query<{ id: number }, []>("SELECT COALESCE(MAX(id), 0) AS id FROM desk_mail_log").get()?.id ?? 0;
      const result = run();
      if (!result.ok) return refuse("judgement_conflict", result.error);
      const after = this.row(table, id);
      const logs = this.db.query<{ id: number }, [number]>("SELECT id FROM desk_mail_log WHERE id > ?").all(newest).map(row => row.id);
      return { kind: "row" as const, table, before, after, token: this.rowToken(table, id), logs };
    })();
  }

  private undoEvidence(binding: MailConnectionBinding, request: DispatchRequest, input: Extract<MailJudgementInput, { action: "undo" }>, now: number): Undo {
    const original = this.saved(input.operationId);
    if (original?.scope !== scopeOf(binding) || original.message_id !== input.message.canonicalId || !original.change_json) return refuse("judgement_conflict", "This connection has no such completed judgement to undo.");
    const saved = JSON.parse(original.change_json) as SavedChange;
    const undo = saved.undo;
    const resumingRestore = original.undo_operation === request.operationId;
    if (original.undone || !undo || (!resumingRestore && now - saved.at > UNDO_WINDOW_MS) || (original.undo_operation && !resumingRestore)) return refuse("judgement_conflict", "This judgement has no available Undo.");
    return undo;
  }

  private undo(binding: MailConnectionBinding, request: DispatchRequest, input: Extract<MailJudgementInput, { action: "undo" }>, now: number): SavedChange {
    const undo = this.undoEvidence(binding, request, input, now);
    this.db.transaction(() => {
      if (undo.kind === "list") {
        if (this.listToken(undo.address) !== undo.token) return refuse("judgement_conflict", "This list entry changed since the judgement. Nothing was removed.");
        this.db.query("DELETE FROM desk_unimportant WHERE address = ?").run(undo.address);
      } else if (undo.kind === "trust") {
        const result = undoDismissal(this.db, undo.dismissal, now);
        if (!result.ok) return refuse("judgement_conflict", result.error);
      } else if (undo.kind === "row") {
        const id = input.message.canonicalId;
        if (this.rowToken(undo.table, id) !== undo.token || JSON.stringify(this.row(undo.table, id)) !== JSON.stringify(undo.after)) return refuse("judgement_conflict", "Mail changed since this judgement. Nothing was overwritten.");
        this.db.query(`DELETE FROM ${undo.table} WHERE message_id = ?`).run(id);
        if (undo.before) {
          const keys = Object.keys(undo.before);
          this.db.query(`INSERT INTO ${undo.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...Object.values(undo.before));
        }
        for (const logId of undo.logs) this.db.query("DELETE FROM desk_mail_log WHERE id = ?").run(logId);
      } else {
        this.db.query("DELETE FROM desk_mail_log WHERE id = ? AND origin = 'correction' AND message_id = ? AND account = ?").run(undo.logId, input.message.canonicalId, binding.account);
        forgetClassification(this.db, input.message.canonicalId);
      }
      this.db.query("UPDATE desk_mail_judgement_operations SET undone = 1 WHERE operation_id = ?").run(input.operationId);
    })();
    return { input, output: { ref: input.message, message: undo.kind === "correction" ? "Moved back. Your correction is withdrawn." : "Undone.", undo: false }, undo: null, at: now };
  }
}
