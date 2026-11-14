import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { OperationJournalStore, type StoredOperation } from "../operations/journal";
import { parseWire, type OperationJournal } from "../operations/types";
import { canonicalWire } from "../operations/validation";

export const LEGACY_MOVE_TARGETS = ["archive", "junk", "trash"] as const;
export type LegacyMoveTarget = (typeof LEGACY_MOVE_TARGETS)[number];

export const LegacyMoveRowSchema = z.object({
  id: z.string().min(1), account: z.string().min(1), messageId: z.string().min(1), target: z.enum(LEGACY_MOVE_TARGETS), sender: z.string(),
  folder: z.string().nullable(), createdAt: z.number().int().nonnegative(), undoneAt: z.number().int().nonnegative().nullable(), correctionId: z.number().int().nullable(),
}).strict();
export type LegacyMoveRow = z.infer<typeof LegacyMoveRowSchema>;

export const LegacyMoveEvidenceSchema = z.object({ kind: z.literal("mail-move"), row: LegacyMoveRowSchema, connection: z.object({ adapterId: z.string().min(1), connectionId: z.string().min(1) }).strict().nullable() }).strict();
export type LegacyMoveEvidence = z.infer<typeof LegacyMoveEvidenceSchema>;
export interface LegacyMoveConnection { adapterId: string; connectionId: string }

export interface LegacyMoveImportResult { imported: string[]; unchanged: string[]; changed: string[] }
export interface OperationIndex { add(operationId: string, compensates?: string): Promise<void>; list(): Promise<string[]>; compensations(originalOperationId: string): Promise<string[]> }

export const legacyMoveOperationId = (id: string): string => `mail-move:${id}`;
const IMPORT_REASON = "A legacy Desk move has no lifecycle approval; its Undo runs as a new linked operation.";
const hash = (value: unknown): string => createHash("sha256").update(canonicalWire(value)).digest("hex");

interface RawMoveRow { id: string; account: string; message_id: string; target: string; sender: string; folder: string | null; created_at: number; undone_at: number | null; correction_id: number | null }

/** Reads every logged native move, oldest first. */
export function loadLegacyMoveRows(db: Database): LegacyMoveRow[] {
  const rows = db.query<RawMoveRow, []>("SELECT id, account, message_id, target, sender, folder, created_at, undone_at, correction_id FROM desk_mail_moves ORDER BY created_at, id").all();
  return rows.map(row => LegacyMoveRowSchema.parse({ id: row.id, account: row.account, messageId: row.message_id, target: row.target, sender: row.sender, folder: row.folder, createdAt: row.created_at, undoneAt: row.undone_at, correctionId: row.correction_id }));
}

function journalOf(row: LegacyMoveRow, connection: LegacyMoveConnection | null): { journal: OperationJournal; digest: string } {
  const evidence: LegacyMoveEvidence = { kind: "mail-move", row, connection };
  const digest = hash(evidence);
  const operationId = legacyMoveOperationId(row.id);
  const journal: OperationJournal = {
    lifecycleVersion: "1.0.0", operationId, sequence: 1, state: "succeeded", idempotencyKey: operationId, ownerRequestId: operationId,
    snapshot: { kind: "legacy-unavailable", reason: IMPORT_REASON },
    events: [{ sequence: 1, eventId: `legacy-import:${digest}`, at: new Date(row.createdAt).toISOString(), event: { kind: "legacy-import", rawRecord: parseWire(z.json(), evidence), sourceDigest: digest } }],
  };
  return { journal, digest };
}

/**
 * Imports native Desk moves into the lifecycle journal as read-only evidence, so each keeps its receipt and its Undo.
 * Re-importing an unchanged row adds nothing; a row whose source changed since import is reported, not overwritten.
 */
export async function importLegacyMoves(store: OperationJournalStore, index: OperationIndex, rows: readonly LegacyMoveRow[], connectionFor: (account: string) => LegacyMoveConnection | undefined): Promise<LegacyMoveImportResult> {
  const result: LegacyMoveImportResult = { imported: [], unchanged: [], changed: [] };
  for (const raw of rows) {
    const row = LegacyMoveRowSchema.parse(raw);
    const { journal } = journalOf(row, connectionFor(row.account) ?? null);
    const prior = await store.read(journal.operationId);
    try {
      await store.importLegacy(journal);
    } catch (error) {
      if (error instanceof Error && error.message.includes("source changed")) { result.changed.push(journal.operationId); continue; }
      throw error;
    }
    await index.add(journal.operationId);
    (prior ? result.unchanged : result.imported).push(journal.operationId);
  }
  return result;
}

/** The native move behind an imported operation, or null when the operation is not a legacy Mail move. */
export function readLegacyMove(stored: StoredOperation): LegacyMoveEvidence | null {
  const entry = stored.journal.events[0]?.event;
  if (entry?.kind !== "legacy-import") return null;
  const parsed = LegacyMoveEvidenceSchema.safeParse(entry.rawRecord);
  return parsed.success && hash(parsed.data) === entry.sourceDigest ? parsed.data : null;
}
