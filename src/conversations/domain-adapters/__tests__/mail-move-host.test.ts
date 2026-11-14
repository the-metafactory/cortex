import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DomainAdapterRegistry } from "../registry";
import { fixtureBindings } from "../fixtures";
import { OperationJournalStore } from "../operations/journal";
import type { Authority, DispatchRequest, OwnerResult, OwnerSupport } from "../operations/types";
import { MAIL_MOVE_CAPABILITIES, mailMoveDeclaration, type MailMoveAction } from "../mail/move-contract";
import { GRANT_OPTIONS, MailMoveHost, type MailMoveAuthority, type PressOutcome } from "../mail/move-host";
import { importLegacyMoves, loadLegacyMoveRows, type LegacyMoveRow, type OperationIndex } from "../mail/legacy-move";
import { UNDO_WINDOW_MS } from "../../../surface/mc/desk/mail-move";

const ADAPTER = "mail";
const CONNECTION = "connection-mail";
const ACCOUNT = "account-example";
const AT = "2026-11-01T00:00:00.000Z";
const NOW = Date.parse(AT) + 60_000;
const authority: Authority = { principalRef: "principal-example", basis: { kind: "confirmation", confirmationId: "confirmation-example", transport: "web" }, connectionRevision: "1", policyRevision: "policy-1", decisionRef: "decision-example", authorizedAt: AT };
const provenance = { conversationId: "desk-mail", proposalId: "press", revision: 1, entryId: null, link: "?desk=mail" };

interface Rig {
  host: MailMoveHost;
  journal: OperationJournalStore;
  index: OperationIndex & { ids: string[] };
  folders: Map<string, string>;
  calls: DispatchRequest[];
  grants: { id: string; capabilityIds: string[] }[];
  approvals: { grantId: string | null }[];
  advance(ms: number): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const noEffect = (request: DispatchRequest, code: string, message: string): OwnerResult["result"] => ({ kind: "failed", error: { code, message }, evidence: { kind: "no-effect", evidenceId: `no-effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { refused: true }, final: true } });

async function openRig(only: readonly MailMoveAction[] = ["move", "trash", "restore"]): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "mail-move-"));
  const engine = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.sqlite")), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  cleanups.push(async () => { await engine.close(BACKGROUND_CONTEXT); await rm(dir, { recursive: true, force: true }); });
  const registry = new DomainAdapterRegistry();
  const declaration = mailMoveDeclaration(ADAPTER, only);
  const registered = registry.register(declaration, fixtureBindings(declaration));
  if (!registered.ok) throw new Error(registered.error.code);
  const journal = new OperationJournalStore(engine, registry);
  const ids: string[] = [];
  const index = { ids, add: (id: string) => { if (!ids.includes(id)) ids.push(id); return Promise.resolve(); }, list: () => Promise.resolve([...ids]) };
  const folders = new Map<string, string>([["m1", "INBOX"], ["m2", "INBOX"], ["m3", "INBOX"]]);
  const calls: DispatchRequest[] = [];
  const grants: Rig["grants"] = [];
  const approvals: Rig["approvals"] = [];
  let clock = NOW;
  const ownerSupport = (request: DispatchRequest): OwnerSupport => ({ lifecycleVersion: "1.0.0", adapterId: ADAPTER, connectionId: CONNECTION, capabilityId: request.snapshot.capabilityId, declarationId: "mail-support", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" });

  const binding = (request: DispatchRequest): OwnerResult["result"] => {
    const input = request.snapshot.input as { message: { canonicalId: string }; target?: string; from?: string };
    const id = input.message.canonicalId;
    const message = { adapterId: ADAPTER, connectionId: CONNECTION, objectType: "message", canonicalId: id };
    const account = request.snapshot.destinations[0]?.canonicalId;
    if (account !== ACCOUNT) return noEffect(request, "mail.account_denied", "This account is not available to the connection.");
    const current = folders.get(id);
    if (current === undefined) return noEffect(request, "mail.message_missing", "The message no longer exists.");
    const capability = request.snapshot.capabilityId;
    let folder = "INBOX";
    if (capability === "mail.restore") {
      if (current !== input.from) return { kind: "conflict", error: { code: "mail.location_conflict", message: `The message is now in ${current}, not ${input.from}.` }, currentOwnerRevision: current, evidence: { kind: "no-effect", evidenceId: `conflict:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { current }, final: true } };
    } else folder = capability === "mail.trash" ? "Trash" : input.target === "junk" ? "Junk" : "Archive";
    folders.set(id, folder);
    return { kind: "succeeded", output: { ref: message, folder }, evidence: { kind: "effect", evidenceId: `effect:${request.attemptId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { moved: folder }, refs: [message] } };
  };

  const authorityPort: MailMoveAuthority = {
    findGrant: capabilityId => Promise.resolve(grants.find(grant => grant.capabilityIds.includes(capabilityId))?.id ?? null),
    grant: capabilityIds => { const id = randomUUID(); grants.push({ id, capabilityIds: [...capabilityIds] }); return Promise.resolve(id); },
    approve: async (input, grantId) => {
      approvals.push({ grantId });
      const basis = grantId ? { kind: "grant" as const, grantId, grantRevision: "1" } : authority.basis;
      const approved: Authority = { ...authority, basis };
      await journal.approve({ ...input, authority: approved, at: AT });
      return { kind: "allowed", authority: approved };
    },
  };

  const dispatch = async (operationId: string): Promise<void> => {
    const stored = await journal.read(operationId);
    if (!stored || "kind" in stored.journal.snapshot) throw new Error("Expected an approved operation.");
    const attempt = { attemptId: randomUUID(), number: 1, kind: "initial" as const, preparedAt: AT, deadlineAt: "2026-11-01T00:00:30.000Z", authority, supportDeclarationId: "mail-support" };
    const request: DispatchRequest = { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, idempotencyKey: operationId, ownerRequestId: stored.journal.ownerRequestId, snapshot: stored.journal.snapshot, authority, supportDeclarationId: "mail-support", deadlineAt: attempt.deadlineAt };
    const prepared = await journal.append(operationId, stored.revision, { sequence: stored.journal.sequence + 1, eventId: randomUUID(), at: AT, event: { kind: "attempt-prepared", attempt } }, { support: ownerSupport(request) });
    calls.push(request);
    const result = binding(request);
    await journal.receive(operationId, prepared.revision, { lifecycleVersion: "1.0.0", operationId, attemptId: attempt.attemptId, snapshotDigest: request.snapshot.digest, resultId: `result:${attempt.attemptId}`, reportedAt: AT, result }, AT);
  };

  const host = new MailMoveHost({ adapterId: ADAPTER, connectionId: CONNECTION, account: ACCOUNT, journal, index, authority: authorityPort, capability: id => registry.capability(id), dispatch, now: () => clock });
  return { host, journal, index, folders, calls, grants, approvals, advance: ms => { clock += ms; } };
}

const archive = (messageId: string, choice?: "always" | "once" | "cancel") => ({ action: "move" as const, messageId, target: "archive" as const, provenance, ...(choice ? { choice } : {}) });
function expectNothingRan(rig: Rig): void {
  expect(rig.calls).toHaveLength(0);
  expect(rig.index.ids).toHaveLength(0);
  expect(rig.grants).toHaveLength(0);
  expect(rig.folders.get("m1")).toBe("INBOX");
}
const receiptOf = (outcome: PressOutcome) => { if (outcome.kind !== "receipt") throw new Error(`Expected a receipt, got ${outcome.kind}.`); return outcome.receipt; };

describe("Mail move host: the grant prompt", () => {
  test("with no grant, Archive asks beside the button and runs nothing", async () => {
    const rig = await openRig();
    const outcome = await rig.host.press(archive("m1"));
    if (outcome.kind !== "needs-grant") throw new Error("Expected the grant prompt.");
    expect(outcome.prompt.options.map(option => option.label)).toEqual(["Use one click from now on", "Just this once", "Cancel"]);
    expect(outcome.prompt.options).toEqual(GRANT_OPTIONS);
    expect(outcome.prompt.covers).toEqual([...MAIL_MOVE_CAPABILITIES]);
    expect(rig.calls).toHaveLength(0);
    expect(rig.index.ids).toHaveLength(0);
    expect(rig.folders.get("m1")).toBe("INBOX");
  });

  test("Cancel runs nothing and writes nothing", async () => {
    const rig = await openRig();
    expect(await rig.host.press(archive("m1", "cancel"))).toEqual({ kind: "cancelled" });
    expectNothingRan(rig);
  });

  test("Just this once runs one move on a confirmation and leaves no grant, so the next click asks again", async () => {
    const rig = await openRig();
    const receipt = receiptOf(await rig.host.press(archive("m1", "once")));
    expect(receipt).toMatchObject({ state: "done", basis: "confirmation", target: "archive", folder: "Archive", undo: { kind: "available" } });
    expect(rig.grants).toHaveLength(0);
    expect((await rig.host.press(archive("m2"))).kind).toBe("needs-grant");
  });
});

describe("Mail move host: a one-click grant", () => {
  test("names the move actions on the connection; each approved attempt writes a receipt with an Undo", async () => {
    const rig = await openRig();
    const first = receiptOf(await rig.host.press(archive("m1", "always")));
    expect(rig.grants).toEqual([{ id: expect.any(String), capabilityIds: ["mail.move", "mail.trash", "mail.restore"] }]);
    const second = receiptOf(await rig.host.press({ action: "trash", messageId: "m2", provenance }));
    const third = receiptOf(await rig.host.press({ action: "move", messageId: "m3", target: "junk", provenance }));
    for (const receipt of [first, second, third]) expect(receipt).toMatchObject({ state: "done", basis: "grant", undo: { kind: "available" }, undone: false });
    expect([first.folder, second.folder, third.folder]).toEqual(["Archive", "Trash", "Junk"]);
    expect(rig.approvals.every(entry => entry.grantId === rig.grants[0]?.id)).toBe(true);
    expect(await rig.host.receipts()).toHaveLength(3);
  });

  test("an Undo the binding completes marks the receipt undone, and it stays undone", async () => {
    const rig = await openRig();
    const moved = receiptOf(await rig.host.press(archive("m1", "always")));
    const undone = await rig.host.undo(moved.operationId, provenance);
    if (undone.kind !== "receipt") throw new Error("Expected an Undo receipt.");
    expect(undone.receipt).toMatchObject({ action: "restore", state: "done", compensates: moved.operationId, basis: "grant" });
    expect(undone.original).toMatchObject({ undone: true, undo: { kind: "unavailable", reason: "undone" } });
    expect(rig.folders.get("m1")).toBe("INBOX");
    expect((await rig.host.undo(moved.operationId, provenance)).kind).toBe("unavailable");
    expect(rig.calls.filter(call => call.snapshot.capabilityId === "mail.restore")).toHaveLength(1);
  });

  test("an Undo the binding reports as a conflict leaves the receipt not undone and moves nothing", async () => {
    const rig = await openRig();
    const moved = receiptOf(await rig.host.press(archive("m1", "always")));
    rig.folders.set("m1", "Projects");
    const outcome = await rig.host.undo(moved.operationId, provenance);
    if (outcome.kind !== "receipt") throw new Error("Expected an Undo receipt.");
    expect(outcome.receipt).toMatchObject({ action: "restore", state: "conflict" });
    expect(outcome.original).toMatchObject({ undone: false, undo: { kind: "available" } });
    expect(rig.folders.get("m1")).toBe("Projects");
  });

  test("an Undo names the folder the move reported", async () => {
    const rig = await openRig();
    const moved = receiptOf(await rig.host.press(archive("m1", "always")));
    await rig.host.undo(moved.operationId, provenance);
    const restore = rig.calls.find(call => call.snapshot.capabilityId === "mail.restore");
    expect(restore?.snapshot.input).toMatchObject({ from: "Archive" });
  });

  test("an Undo after the native window is not offered", async () => {
    const rig = await openRig();
    const moved = receiptOf(await rig.host.press(archive("m1", "always")));
    rig.advance(UNDO_WINDOW_MS + 1);
    expect((await rig.host.receipt(moved.operationId))?.undo).toEqual({ kind: "unavailable", reason: "expired" });
    expect((await rig.host.undo(moved.operationId, provenance)).kind).toBe("unavailable");
  });
});

describe("Mail move host: refused attempts", () => {
  test("a missing message writes a receipt and is not retried", async () => {
    const rig = await openRig();
    rig.folders.delete("m1");
    const receipt = receiptOf(await rig.host.press(archive("m1", "always")));
    expect(receipt).toMatchObject({ state: "missing", undo: { kind: "unavailable", reason: "not-done" } });
    expect(rig.calls).toHaveLength(1);
    const stored = await rig.journal.read(receipt.operationId);
    expect(stored?.journal.events.filter(entry => entry.event.kind === "attempt-prepared")).toHaveLength(1);
    expect((await rig.host.undo(receipt.operationId, provenance)).kind).toBe("unavailable");
    expect(rig.calls).toHaveLength(1);
  });

  test("a denied account writes a receipt and is not retried", async () => {
    const rig = await openRig();
    const other = new MailMoveHost({ ...(rig.host as unknown as { options: ConstructorParameters<typeof MailMoveHost>[0] }).options, account: "account-other" });
    const receipt = receiptOf(await other.press(archive("m1", "always")));
    expect(receipt).toMatchObject({ state: "denied", account: "account-other" });
    expect(rig.calls).toHaveLength(1);
    expect(rig.folders.get("m1")).toBe("INBOX");
  });
});

describe("Mail move host: an unavailable capability", () => {
  test("Trash is unavailable when the connection cannot restore, and no trash command runs", async () => {
    const rig = await openRig(["move", "trash"]);
    expect(rig.host.available("trash")).toBe(false);
    const outcome = await rig.host.press({ action: "trash", messageId: "m1", provenance, choice: "always" });
    expect(outcome).toMatchObject({ kind: "unavailable", reason: { code: "mail.capability_unavailable" } });
    expectNothingRan(rig);
  });

  test("Trash is unavailable when the binding declares no trash action", async () => {
    const rig = await openRig(["move", "restore"]);
    expect((await rig.host.press({ action: "trash", messageId: "m1", provenance, choice: "always" })).kind).toBe("unavailable");
    expect(rig.calls).toHaveLength(0);
    expect(rig.host.available("move")).toBe(true);
  });
});

describe("the legacy move importer", () => {
  const legacyRow = (over: Partial<LegacyMoveRow> = {}): LegacyMoveRow => ({ id: "legacy-1", account: ACCOUNT, messageId: "m1", target: "archive", sender: "sender@example.test", folder: "Archive", createdAt: NOW - 1000, undoneAt: null, correctionId: null, ...over });
  const mapped = (account: string) => account === ACCOUNT ? { adapterId: ADAPTER, connectionId: CONNECTION } : undefined;

  test("keeps each native move as a receipt with an Undo that runs through the binding", async () => {
    const rig = await openRig();
    rig.folders.set("m1", "Archive");
    const result = await importLegacyMoves(rig.journal, rig.index, [legacyRow()], mapped);
    expect(result).toEqual({ imported: ["mail-move:legacy-1"], unchanged: [], changed: [] });
    const receipt = await rig.host.receipt("mail-move:legacy-1");
    expect(receipt).toMatchObject({ basis: "legacy", state: "done", action: "move", target: "archive", undone: false, undo: { kind: "available" } });
    const undone = await rig.host.undo("mail-move:legacy-1", provenance);
    if (undone.kind !== "receipt") throw new Error("Expected an Undo receipt.");
    expect(undone.original.undone).toBe(true);
    expect(rig.folders.get("m1")).toBe("INBOX");
    expect(rig.calls[0]?.snapshot.input).toMatchObject({ from: "Archive" });
  });

  test("imports twice without duplicating, and reports a row whose source changed", async () => {
    const rig = await openRig();
    await importLegacyMoves(rig.journal, rig.index, [legacyRow()], mapped);
    expect(await importLegacyMoves(rig.journal, rig.index, [legacyRow()], mapped)).toEqual({ imported: [], unchanged: ["mail-move:legacy-1"], changed: [] });
    expect(await importLegacyMoves(rig.journal, rig.index, [legacyRow({ undoneAt: NOW })], mapped)).toEqual({ imported: [], unchanged: [], changed: ["mail-move:legacy-1"] });
    expect(rig.index.ids).toEqual(["mail-move:legacy-1"]);
    expect((await rig.host.receipt("mail-move:legacy-1"))?.undone).toBe(false);
  });

  test("an already undone move imports as undone; an unmapped account offers no Undo", async () => {
    const rig = await openRig();
    await importLegacyMoves(rig.journal, rig.index, [legacyRow({ id: "a", undoneAt: NOW - 10 }), legacyRow({ id: "b", account: "account-unmapped" })], mapped);
    expect(await rig.host.receipt("mail-move:a")).toMatchObject({ undone: true, undo: { kind: "unavailable", reason: "undone" } });
    expect(await rig.host.receipt("mail-move:b")).toMatchObject({ undone: false, undo: { kind: "unavailable", reason: "other-connection" } });
  });

  test("reads the native move log and keeps a trash move as Trash", async () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE desk_mail_moves (id TEXT PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL, target TEXT NOT NULL, sender TEXT NOT NULL, folder TEXT, created_at INTEGER NOT NULL, undone_at INTEGER, correction_id INTEGER)");
    db.query("INSERT INTO desk_mail_moves (id, account, message_id, target, sender, folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("t1", ACCOUNT, "m2", "trash", "s@example.test", null, NOW - 5);
    const rows = loadLegacyMoveRows(db);
    expect(rows).toHaveLength(1);
    const rig = await openRig();
    await importLegacyMoves(rig.journal, rig.index, rows, mapped);
    expect(await rig.host.receipt("mail-move:t1")).toMatchObject({ action: "trash", target: "trash", state: "done" });
  });
});
