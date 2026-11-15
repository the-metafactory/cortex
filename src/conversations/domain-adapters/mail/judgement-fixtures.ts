import { recordWaiting } from "../../../surface/mc/desk/mail-waiting";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../../../surface/mc/db/init";
import { DomainAdapterRegistry } from "../registry";
import { fixtureBindings } from "../fixtures";
import { AT, openJournalFixture } from "../operations/fixtures";
import type { DispatchRequest, OwnerResult } from "../operations/types";
import type { OperationIndex } from "./legacy-move";
import { fixtureAuthority, prepareDispatch } from "./host-fixtures";
import { mailJudgementDeclaration, type MailJudgementInput } from "./judgement-contract";
import { MailJudgementHost, type JudgementOutcome } from "./judgement-host";
import { MailJudgementStore, type MailJudgementMoves } from "./judgement-store";
import { mailJudgementBridge } from "../mail-read";
import { adaptDeskBackend } from "../package-backend";
import type { SourceReading } from "../../../surface/mc/desk/sources/command";

export const JUDGEMENT_BINDING = { adapterId: "mail", connectionId: "mail-example", account: "account-example", sourceId: "source-example" };
export const JUDGEMENT_PROVENANCE = { conversationId: "conversation-example", proposalId: "mail-judgement", revision: 1, entryId: null, link: "?desk=mail" };
export const judgementMessage = (canonicalId = "message-example") => ({ adapterId: JUDGEMENT_BINDING.adapterId, connectionId: JUDGEMENT_BINDING.connectionId, objectType: "message", canonicalId });
export const judgementReceipt = (outcome: JudgementOutcome) => {
  if (outcome.kind !== "receipt") throw new Error(`Expected a judgement receipt, got ${outcome.kind}.`);
  return outcome.receipt;
};

export async function openMailJudgementRig() {
  const directory = await mkdtemp(join(tmpdir(), "mail-judgement-"));
  const path = join(directory, "mail.sqlite");
  let db = initDatabase(path);
  const declaration = mailJudgementDeclaration("mail");
  const registry = new DomainAdapterRegistry();
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  let fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry);
  let now = Date.parse(AT);
  const readings: SourceReading[] = [{ id: JUDGEMENT_BINDING.sourceId, area: "example", readAt: now, error: null, events: [], dropped: 0, problems: [], mail: [{ kind: "mail", id: "message-example", from: { address: "sender@example.org", name: "Example sender" }, subject: "Example message", receivedAt: AT, unread: true, account: JUDGEMENT_BINDING.account, headers: { replyTo: "other@elsewhere.example" } }] }];
  const folders = new Map([["message-example", "INBOX"]]);
  const moveHistory = new Map<string, Awaited<ReturnType<MailJudgementMoves["move"]>>>();
  let denied = false;
  const moves: MailJudgementMoves = {
    replay: "historical-idempotent",
    move(request, mail, target) {
      const previous = moveHistory.get(request.operationId);
      if (previous) return previous;
      const before = folders.get(mail.id);
      if (!before) return { ok: false, code: "message_missing", message: "The message is missing." };
      const after = target === "archive" ? "Archive" : target === "junk" ? "Junk" : "Trash";
      folders.set(mail.id, after);
      const result = { ok: true as const, token: { id: mail.id, before, after }, message: `Moved to ${after}.` };
      moveHistory.set(request.operationId, result);
      return result;
    },
    restore(request, token) {
      const previous = moveHistory.get(request.operationId);
      if (previous) return previous;
      const { id, before, after } = token as { id: string; before: string; after: string };
      if (folders.get(id) !== after) return { ok: false, code: "judgement_conflict", message: "The message moved again. Nothing changed." };
      folders.set(id, before);
      const result = { ok: true as const, token, message: "Moved back." };
      moveHistory.set(request.operationId, result);
      return result;
    },
  };
  const makeStore = () => new MailJudgementStore({ db, readings: () => readings, authorize: () => Promise.resolve(!denied), moves, now: () => now });
  let owner = makeStore();
  db.run("CREATE TABLE IF NOT EXISTS fixture_operation_index (id TEXT PRIMARY KEY, compensates TEXT)");
  const index: OperationIndex = {
    add(id, compensates) { db.query("INSERT OR IGNORE INTO fixture_operation_index VALUES (?, ?)").run(id, compensates ?? null); return Promise.resolve(); },
    list() { return Promise.resolve(db.query<{ id: string }, []>("SELECT id FROM fixture_operation_index").all().map(row => row.id)); },
    compensations(original) { return Promise.resolve(db.query<{ id: string }, [string]>("SELECT id FROM fixture_operation_index WHERE compensates = ?").all(original).map(row => row.id)); },
  };
  const auth = fixtureAuthority(() => fixture.journal, () => now, () => denied);
  const calls: DispatchRequest[] = [];
  let published = true;
  const bridge = mailJudgementBridge({ connections: () => [JUDGEMENT_BINDING], listings: () => readings }, "mail", () => published, { dispatch: (...args) => owner.dispatch(...args) });
  const judgementCall = bridge.changeJudgement.bind(bridge);
  let adapterCall = (request: DispatchRequest) => judgementCall(request);
  const dispatch = async (operationId: string) => {
    const { request, support, at, revision } = await prepareDispatch(fixture.journal, operationId, { connectionId: JUDGEMENT_BINDING.connectionId, declarationId: "mail-judgement-owner", expected: "a judgement", now });
    const backend = adaptDeskBackend({ adapterId: "mail", connection: JUDGEMENT_BINDING, declaration, bindings: { handlers: {}, observations: {} }, action: { ...JUDGEMENT_BINDING, kind: "action", capabilityId: support.capabilityId, writerOwner: "mail-owner", support, dispatch: request => adapterCall(request) }, authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "1" }), gate: () => null });
    calls.push(request);
    const result = await backend.connector.dispatch(request, new AbortController().signal) as OwnerResult;
    await fixture.journal.receive(operationId, revision, result, at);
  };
  const makeHost = () => new MailJudgementHost({ ...JUDGEMENT_BINDING, journal: fixture.journal, index, authority: auth.port, capability: id => registry.capability(id), dispatch, now: () => now });
  let host = makeHost();
  return {
    get host() { return host; }, get db() { return db; }, get owner() { return owner; }, get journal() { return fixture.journal; },
    readings, folders, grants: auth.grants, approvals: auth.approvals, calls, index, bridge, registry,
    press(input: MailJudgementInput, choice?: "always" | "once" | "cancel") { return host.press(input, JUDGEMENT_PROVENANCE, choice); },
    failReceipts(operationId?: string) {
      db.run(`CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE OF result_json ON desk_mail_judgement_operations
        ${operationId ? `WHEN NEW.operation_id = '${operationId.replaceAll("'", "''")}'` : ""}
        BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`);
      return () => db.run("DROP TRIGGER fixture_receipt_failure");
    },
    recordSentWaiting() {
      const reading = readings.find(item => item.id === JUDGEMENT_BINDING.sourceId);
      if (!reading) throw new Error("The fixture Mail source is missing.");
      recordWaiting(db, [{ ...reading, sent: [{ kind: "sent", id: "sent-example", from: { address: "me@example.net" }, to: [{ address: "sender@example.org" }], subject: "Example question?", text: "Can you answer?", sentAt: AT, account: JUDGEMENT_BINDING.account }] }], now);
    },
    advance(ms: number) { now += ms; }, deny() { denied = true; }, allow() { denied = false; }, fence() { published = false; },
    adapter(call: typeof adapterCall) { adapterCall = call; },
    async reopen() { await fixture.close(); db.close(); db = initDatabase(path); owner = makeStore(); fixture = await openJournalFixture(join(directory, "journal.sqlite"), registry); host = makeHost(); },
    async close() { await fixture.close(); db.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
