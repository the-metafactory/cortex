import type { Database } from "bun:sqlite";
import type { DispatchRequest } from "../operations/types";
import type { OperationJournalStore } from "../operations/journal";
import type { FixtureGrant } from "./host-fixtures";
import { LOOP_ACCOUNT, LOOP_ADAPTER, LOOP_CONNECTION, LOOP_PROVENANCE, openMailLoopRig } from "./loop-fixtures";
import type { MailMoveHost } from "./move-host";
import type { MailSweepRule, SweepMail } from "./sweep-contract";
import { DeskMailSweepGrants } from "./sweep-grant-store";
import { MailSweepHost } from "./sweep-host";
import { DeskMailSweepSets } from "./sweep-set-store";

export const SWEEP_PROVENANCE = { ...LOOP_PROVENANCE, proposalId: "mail-sweep" };
export const SWEEP_SENDER = "boss@example.org";
export const SWEEP_AT = "2026-10-01T00:00:00.000Z";

export const sweepMail = (id: string, over: Partial<SweepMail> = {}): SweepMail => ({
  id,
  account: LOOP_ACCOUNT,
  subject: `Subject ${id}`,
  from: { address: SWEEP_SENDER },
  receivedAt: SWEEP_AT,
  unread: true,
  ...over,
});

export const senderRule = (address = SWEEP_SENDER): MailSweepRule => ({ kind: "sender", address });
export const ageRule = (olderThanDays = 7): MailSweepRule => ({ kind: "age", olderThanDays });

export interface MailSweepRig {
  readonly host: MailSweepHost;
  readonly moves: MailMoveHost;
  readonly journal: OperationJournalStore;
  readonly db: Database;
  readonly folders: Map<string, string>;
  readonly calls: DispatchRequest[];
  readonly authorityGrants: FixtureGrant[];
  readonly grants: DeskMailSweepGrants;
  seed(ids: readonly string[], folder?: string): void;
  advance(ms: number): void;
  close(): Promise<void>;
}

export async function openMailSweepRig(): Promise<MailSweepRig> {
  const loop = await openMailLoopRig();
  const grants = new DeskMailSweepGrants(loop.db);
  const host = new MailSweepHost({
    adapterId: LOOP_ADAPTER,
    connectionId: LOOP_CONNECTION,
    account: LOOP_ACCOUNT,
    moves: loop.moves,
    journal: loop.journal,
    grants,
    sets: new DeskMailSweepSets(loop.db),
    authority: loop.authority,
    now: loop.now,
  });
  return {
    host,
    get moves() { return loop.moves; },
    get journal() { return loop.journal; },
    get db() { return loop.db; },
    folders: loop.folders,
    calls: loop.calls,
    authorityGrants: loop.authorityGrants,
    grants,
    seed: (ids, folder) => { loop.seed(ids, folder); },
    advance: ms => { loop.advance(ms); },
    close: () => loop.close(),
  };
}
