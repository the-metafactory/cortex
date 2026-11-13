import type { Database } from "bun:sqlite";
import { flushVigilResolutions, resolveVigilAttention, type ResolutionLedger } from "./resolution";

export type ResultReadLedger = ResolutionLedger;

export function readResult(db: Database, ref: string, ledger?: ResultReadLedger): void {
  resolveVigilAttention(db, `att:vigil:result:${ref}`, "read");
  if (ledger) void flushVigilResolutions(db, ledger);
}
