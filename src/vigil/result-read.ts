import type { Database } from "bun:sqlite";
import { flushVigilResolutions, resolveVigilAttention, type ResolutionLedger } from "./resolution";

export type ResultReadLedger = ResolutionLedger;

export async function readResult(db: Database, ref: string, ledger?: ResultReadLedger): Promise<void> {
  resolveVigilAttention(db, `att:vigil:result:${ref}`, "read");
  if (ledger) await flushVigilResolutions(db, ledger);
}
