import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../../surface/mc/db/init";
import { DomainAdapterRegistry } from "../registry";
import { fixtureBindings } from "../fixtures";
import { AT, openJournalFixture } from "../operations/fixtures";
import { OperationJournalStore } from "../operations/journal";
import type { DispatchRequest, OwnerResult } from "../operations/types";
import type { OperationIndex } from "./legacy-move";
import { mailMoveDeclaration } from "./move-contract";
import { MailMoveHost, type MailMoveAuthority, type MailMoveReceipt } from "./move-host";
import { deliver, fixtureAuthority, prepareDispatch, type FixtureGrant, type PreparedDispatch } from "./host-fixtures";
import { MailLoopHost } from "./loop-host";
import { DeskMailLoopGrants } from "./loop-grant-store";
import type { LoopMail, MailLoopAction, MailLoopGrant, MailLoopKind, MailLoopSelection } from "./loop-contract";

export const LOOP_ADAPTER = "mail";
export const LOOP_CONNECTION = "connection-mail";
export const LOOP_ACCOUNT = "account-example";
export const LOOP_PROVENANCE = { conversationId: "conversation-example", proposalId: "mail-loop", revision: 1, entryId: null, link: "?desk=mail" };

export const loopMail = (id: string, over: Partial<LoopMail> = {}): LoopMail => ({ id, account: LOOP_ACCOUNT, subject: `Subject ${id}`, from: { address: "reports@example.org" }, ...over });

export const dmarcMail = (id: string, heldBy: string, over: Partial<LoopMail> = {}): LoopMail =>
  loopMail(id, { subject: `Report Domain: example.org Submitter: reporter.example.net Report-ID: ${id}`, heldBy, ...over });

export interface MailLoopRig {
  readonly loop: MailLoopHost;
  readonly moves: MailMoveHost;
  readonly journal: OperationJournalStore;
  readonly db: Database;
  readonly folders: Map<string, string>;
  readonly calls: DispatchRequest[];
  readonly authorityGrants: FixtureGrant[];
  readonly authority: MailMoveAuthority;
  readonly now: () => number;
  grant(loop: MailLoopKind, actions: readonly MailLoopAction[], selection: MailLoopSelection): Promise<MailLoopGrant>;
  revoke(grantId: string): boolean;
  pause(loop: MailLoopKind): void;
  resume(loop: MailLoopKind): void;
  receipt(operationId: string): Promise<MailMoveReceipt | null>;
  receipts(): Promise<MailMoveReceipt[]>;
  seed(ids: readonly string[], folder?: string): void;
  hold(ids: readonly string[]): void;
  settle(messageId: string): Promise<void>;
  beforeEachMove(hook: (request: DispatchRequest) => void | Promise<void>): void;
  deny(on: boolean): void;
  advance(ms: number): void;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

const folderOf = (request: DispatchRequest): string => {
  if (request.snapshot.capabilityId === "mail.trash") return "Trash";
  const input = request.snapshot.input as { target?: string };
  return input.target === "junk" ? "Junk" : "Archive";
};

const refused = (request: DispatchRequest, code: string, message: string): OwnerResult["result"] => ({
  kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `no-effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { refused: true }, final: true },
});

export async function openMailLoopRig(): Promise<MailLoopRig> {
  const directory = await mkdtemp(join(tmpdir(), "mail-loop-"));
  const databasePath = join(directory, "mail.sqlite");
  const journalPath = join(directory, "journal.sqlite");
  let db = initDatabase(databasePath);
  const registry = new DomainAdapterRegistry();
  const declaration = mailMoveDeclaration(LOOP_ADAPTER);
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  let fixture = await openJournalFixture(journalPath, registry);
  let now = Date.parse(AT) + 60_000;
  const folders = new Map<string, string>();
  const calls: DispatchRequest[] = [];
  const operations: string[] = [];
  const compensations = new Map<string, string[]>();
  let denied = false;
  const auth = fixtureAuthority(() => fixture.journal, () => now, () => denied);

  const index: OperationIndex = {
    add(operationId, compensates) {
      if (!operations.includes(operationId)) operations.push(operationId);
      if (compensates) compensations.set(compensates, [...(compensations.get(compensates) ?? []), operationId]);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...operations]),
    compensations: original => Promise.resolve([...(compensations.get(original) ?? [])]),
  };

  const binding = (request: DispatchRequest): OwnerResult["result"] => {
    const input = request.snapshot.input as { message: { canonicalId: string }; from?: string };
    const id = input.message.canonicalId;
    const ref = { adapterId: LOOP_ADAPTER, connectionId: LOOP_CONNECTION, objectType: "message", canonicalId: id };
    if (request.snapshot.destinations[0]?.canonicalId !== LOOP_ACCOUNT) return refused(request, "mail.account_denied", "This account is not available to the connection.");
    const current = folders.get(id);
    if (current === undefined) return refused(request, "mail.message_missing", "The message no longer exists.");
    if (request.snapshot.capabilityId === "mail.restore") {
      if (current !== input.from) return { kind: "conflict", error: { code: "mail.location_conflict", message: `The message is now in ${current}, not ${input.from}.` }, currentOwnerRevision: current, evidence: { kind: "no-effect", evidenceId: `conflict:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { current }, final: true } };
      folders.set(id, "INBOX");
    } else folders.set(id, folderOf(request));
    const folder = folders.get(id) ?? "INBOX";
    return { kind: "succeeded", output: { ref, folder }, evidence: { kind: "effect", evidenceId: `effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { moved: folder }, refs: [ref] } };
  };

  let beforeEachMove: ((request: DispatchRequest) => void | Promise<void>) | null = null;
  const holds = new Set<string>();
  const held = new Map<string, PreparedDispatch>();

  const dispatch = async (operationId: string): Promise<void> => {
    const prepared = await prepareDispatch(fixture.journal, operationId, { connectionId: LOOP_CONNECTION, declarationId: "mail-loop-owner", expected: "an approved move", now });
    calls.push(prepared.request);
    if (beforeEachMove) await beforeEachMove(prepared.request);
    const messageId = (prepared.request.snapshot.input as { message: { canonicalId: string } }).message.canonicalId;
    if (holds.has(messageId)) { held.set(messageId, prepared); return; }
    await deliver(fixture.journal, prepared, binding(prepared.request));
  };

  const movesOf = (): MailMoveHost => new MailMoveHost({ adapterId: LOOP_ADAPTER, connectionId: LOOP_CONNECTION, account: LOOP_ACCOUNT, journal: fixture.journal, index, authority: auth.port, capability: id => registry.capability(id), dispatch, now: () => now });
  let moves = movesOf();

  const loopOf = (moves_: MailMoveHost): MailLoopHost => new MailLoopHost({ adapterId: LOOP_ADAPTER, connectionId: LOOP_CONNECTION, account: LOOP_ACCOUNT, moves: moves_, grants: new DeskMailLoopGrants(db), authority: auth.port, now: () => now });
  let loop = loopOf(moves);

  return {
    get loop() { return loop; }, get moves() { return moves; }, get journal() { return fixture.journal; }, get db() { return db; },
    folders, calls, authorityGrants: auth.grants, authority: auth.port, now: () => now,
    grant: (kind, actions, selection) => loop.grant({ loop: kind, actions, selection }).then(grant => {
      if (!grant) throw new Error("The fake authority refused the standing Mail grant.");
      return grant;
    }),
    revoke: grantId => loop.revoke(grantId),
    pause: kind => { loop.pause(kind); },
    resume: kind => { loop.resume(kind); },
    receipt: operationId => loop.receipt(operationId),
    receipts: () => loop.receipts(),
    seed: (ids, folder = "INBOX") => { for (const id of ids) if (!folders.has(id)) folders.set(id, folder); },
    hold: ids => { for (const id of ids) holds.add(id); },
    async settle(messageId) {
      const prepared = held.get(messageId);
      if (!prepared) throw new Error(`No held move for ${messageId}.`);
      held.delete(messageId);
      holds.delete(messageId);
      await deliver(fixture.journal, prepared, binding(prepared.request));
    },
    beforeEachMove: hook => { beforeEachMove = hook; },
    deny: on => { denied = on; },
    advance: ms => { now += ms; },
    async reopen() {
      await fixture.close();
      db.close();
      db = initDatabase(databasePath);
      fixture = await openJournalFixture(journalPath, registry);
      moves = movesOf();
      loop = loopOf(moves);
    },
    async close() {
      await fixture.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
