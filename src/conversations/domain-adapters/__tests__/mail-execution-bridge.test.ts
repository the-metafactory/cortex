import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mailAccountRef, mailMessageRef, mailMoveSnapshot, mailReplyDraftSnapshot, mailUnsubscribeSnapshot } from "../../../desk-sdk";
import { runMailActionScenario, type MailActionScenarioContext, type MailExecutionProvider } from "../../../desk-adapter-sdk/conformance";
import { mailExecutionBridge } from "../mail-execution";
import { scenarioMail, SCENARIO_MESSAGE } from "./fixtures/mail-action-package";
import { writeMailExecutionPackage } from "./fixtures/mail-execution-package";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mail-execution-test-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const recordSchema = z.record(z.string(), z.json());

function provider(options: { timeout?: boolean; version?: number; omitVersion?: boolean; folder?: string; corruptLookup?: boolean } = {}) {
  const file = join(root, "native.json");
  const locationFile = join(root, "native-location.json");
  let calls = 0;
  let lookups = 0;
  let instances = 0;
  const effects = () => existsSync(file) ? z.array(recordSchema).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
  const perform = (action: string) => (raw: unknown): Promise<unknown> => {
    calls++;
    const input = recordSchema.parse(raw);
    const saved = effects();
    const previous = saved.find(item => item.requestId === input.requestId);
    if (previous) return Promise.resolve({ ...previous, status: "exists" });
    const location = existsSync(locationFile) ? z.string().parse(JSON.parse(readFileSync(locationFile, "utf8"))) : options.folder ?? "Archive";
    if (action === "restore" && input.from !== location) return Promise.resolve({ status: "conflict", folder: location });
    const folder = action === "restore" ? "Inbox" : input.target === "trash" ? "Trash" : input.target === "junk" ? "Junk" : "Archive";
    const item = { ...input, id: action === "draft" ? "draft-example" : SCENARIO_MESSAGE, folder, previousFolder: location, host: "lists.example.org", status: action === "draft" ? "created" : action === "restore" ? "restored" : "moved" };
    saved.push(item);
    writeFileSync(file, JSON.stringify(saved));
    writeFileSync(locationFile, JSON.stringify(folder));
    return options.timeout ? Promise.reject(new Error("The native provider saved the effect before a timeout.")) : Promise.resolve(item);
  };
  const lookup = (raw: unknown): Promise<unknown> => {
    lookups++;
    const item = effects().find(entry => entry.requestId === raw);
    return Promise.resolve(item ? { ...item, status: "found" } : { status: "not_found" });
  };
  const lookupMove = (raw: unknown): Promise<unknown> => {
    lookups++;
    const item = effects().find(entry => entry.requestId === raw);
    if (!item) return Promise.resolve({ status: "not_found" });
    const original = options.corruptLookup ? { ...item, context: { ...recordSchema.parse(item.context), snapshotDigest: "0".repeat(64) } } : item;
    return Promise.resolve({ status: "found", request: original, result: { status: item.status, id: item.id, account: item.account, folder: item.folder, previousFolder: item.previousFolder } });
  };
  return {
    file, effects,
    get calls() { return calls; }, get lookups() { return lookups; }, get instances() { return instances; },
    connection(): MailExecutionProvider {
      instances++;
      return { ...(options.omitVersion ? {} : { version: options.version ?? 1 }), draft: perform("draft"), move: perform("move"), restore: perform("restore"), unsubscribe: perform("unsubscribe"), lookup, lookupMove, lookupUnsubscribe: lookup };
    },
  };
}

const reply = (context: MailActionScenarioContext) => mailReplyDraftSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), body: "  Exact reply\nwith spacing  " });
const move = (context: MailActionScenarioContext, action: "move" | "trash" | "restore") => mailMoveSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), input: action === "move" ? { action, message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), target: "archive" } : action === "restore" ? { action, message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), from: "Archive" } : { action, message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE) } });
const unsubscribe = (context: MailActionScenarioContext) => mailUnsubscribeSnapshot({ ...context, input: { message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE) } });

interface PackageAudit { constructions: number; bridgeCount: number; release?(): void; late?: Promise<unknown> }
const audit = (dir: string): PackageAudit => Reflect.get(globalThis, Symbol.for(dir)) as PackageAudit;
const eligibleMail = () => {
  const mail = scenarioMail();
  const listings = mail.listings().map(listing => ({ ...listing, mail: listing.mail.map(item => ({ ...item, headers: { listUnsubscribe: "<https://lists.example.org/leave?private=fixture>", listUnsubscribePost: "List-Unsubscribe=One-Click" } })) }));
  return { ...mail, listings: () => listings };
};

describe("packaged host-selected Mail execution", () => {
  test("reconstructs the package and host, settling one draft from native lookup and durable context", async () => {
    const native = provider({ timeout: true });
    const dir = writeMailExecutionPackage(join(root, "reply"));
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), execution: native, snapshot: reply, steps: ["restart", "reconcile", "restart", "repeat"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"]);
    expect(report.reconstructions).toBe(2);
    expect(audit(dir).constructions).toBe(3);
    expect(audit(dir).bridgeCount).toBe(3);
    expect(native.calls).toBe(1);
    expect(native.lookups).toBe(1);
    expect(native.effects()).toHaveLength(1);
    expect(native.effects()[0]).toMatchObject({ body: "  Exact reply\nwith spacing  ", recipient: "sender@example.test", subject: "Re: Synthetic mail", account: "account-example", messageId: SCENARIO_MESSAGE });
    expect(native.effects()[0]?.context).toBeUndefined();
    expect(report.stages.every(stage => stage.attemptIds.length === 1 && stage.snapshotDigest === report.snapshot.digest)).toBe(true);
    expect(report.ownerCalls).toMatchObject({ dispatch: 1, lookup: 1 });
    expect(report.events.some(event => JSON.stringify(event).includes('"confirmation"'))).toBe(true);
    expect(report.networkRequests).toBe(0);
    expect(report.credentialRequests).toBe(0);
  });

  for (const action of ["move", "trash", "restore"] as const) test(`${action} uses the same packaged bridge and preserves approved preconditions`, async () => {
    const native = provider({ timeout: true });
    const dir = writeMailExecutionPackage(join(root, action), { action });
    const report = await runMailActionScenario(dir, { capabilityId: `mail.${action}`, mail: scenarioMail(), execution: native, snapshot: context => move(context, action), steps: ["restart", "reconcile", "repeat"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded", "succeeded"]);
    expect(native.effects()).toHaveLength(1);
    expect(native.effects()[0]).toMatchObject(action === "restore" ? { action: "restore", from: "Archive" } : { action, target: action === "trash" ? "trash" : "archive" });
    expect(native.calls).toBe(1);
    expect(native.lookups).toBe(1);
  });

  test("one-click eligibility is bounded metadata and unsubscribe recovers without a duplicate effect", async () => {
    const native = provider({ timeout: true });
    const dir = writeMailExecutionPackage(join(root, "unsubscribe"), { action: "unsubscribe" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.unsubscribe", mail: eligibleMail(), execution: native, snapshot: unsubscribe, steps: ["restart", "reconcile", "repeat"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded", "succeeded"]);
    expect(native.calls).toBe(1);
    expect(native.lookups).toBe(1);
    expect(native.effects()).toHaveLength(1);
    expect(native.effects()[0]).not.toHaveProperty("url");
  });

  test("a message without one-click headers cannot reach the unsubscribe provider", async () => {
    const native = provider();
    const dir = writeMailExecutionPackage(join(root, "no-headers"), { action: "unsubscribe" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.unsubscribe", mail: scenarioMail(), execution: native, snapshot: unsubscribe });
    expect(report.stages[0]?.state).toBe("uncertain");
    expect(native.calls).toBe(0);
    expect(native.effects()).toHaveLength(0);
  });

  for (const action of ["reply", "unsubscribe"] as const) test(`unapproved extra ${action} fields never reach the native connection`, async () => {
    const native = provider();
    const dir = writeMailExecutionPackage(join(root, `extra-${action}`), { action, forge: "extra" });
    await runMailActionScenario(dir, { capabilityId: action === "reply" ? "mail.reply-draft.create" : "mail.unsubscribe", mail: eligibleMail(), execution: native, snapshot: action === "reply" ? reply : unsubscribe });
    expect(native.calls).toBe(0);
    expect(native.effects()).toHaveLength(0);
  });

  for (const forge of ["account", "message", "body", "method", "connection"] as const) test(`forged ${forge} never reaches a native effect`, async () => {
    const native = provider();
    const dir = writeMailExecutionPackage(join(root, forge), { forge });
    await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), execution: native, snapshot: reply });
    expect(native.calls).toBe(0);
    expect(native.lookups).toBe(0);
    expect(native.effects()).toHaveLength(0);
  });

  for (const forge of ["lookup", "lookupOperation", "lookupConnection", "lookupMethod"] as const) test(`forged historical ${forge} cannot obtain another context or call the provider`, async () => {
    const native = provider({ timeout: true });
    const dir = writeMailExecutionPackage(join(root, forge), { forge });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), execution: native, snapshot: reply, steps: ["restart", "reconcile"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(native.lookups).toBe(0);
    expect(native.effects()).toHaveLength(1);
  });

  test("a corrupt historical move identity remains uncertain after reconstruction", async () => {
    const native = provider({ timeout: true, corruptLookup: true });
    const dir = writeMailExecutionPackage(join(root, "corrupt"), { action: "move" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), execution: native, snapshot: context => move(context, "move"), steps: ["restart", "reconcile"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(native.effects()).toHaveLength(1);
    expect(native.lookups).toBe(1);
  });

  test("a restore refuses a changed native location without an effect", async () => {
    const native = provider({ folder: "Other" });
    const dir = writeMailExecutionPackage(join(root, "conflict"), { action: "restore" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.restore", mail: scenarioMail(), execution: native, snapshot: context => move(context, "restore") });
    expect(report.stages[0]?.state).toBe("conflict");
    expect(native.effects()).toHaveLength(0);
  });

  test("a delayed continuation cannot reuse the completed dispatch's admission", async () => {
    const native = provider();
    const dir = writeMailExecutionPackage(join(root, "late"), { late: true });
    await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), execution: native, snapshot: reply });
    const state = audit(dir);
    state.release?.();
    await expect(state.late).rejects.toThrow("admitted");
    expect(native.calls).toBe(1);
  });

  for (const variant of ["unsupported", "missing"] as const) test(`${variant} provider versions remain unavailable before dispatch`, async () => {
    const native = provider(variant === "missing" ? { omitVersion: true } : { version: 2 });
    const dir = writeMailExecutionPackage(join(root, "version"));
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), execution: native, snapshot: reply });
    expect(report.ownerCalls.dispatch).toBe(0);
    expect(native.calls).toBe(0);
  });

  test("trash never falls back when the native connection cannot restore", async () => {
    const native = provider();
    const dir = writeMailExecutionPackage(join(root, "no-restore"), { action: "trash" });
    await runMailActionScenario(dir, { capabilityId: "mail.trash", mail: scenarioMail(), execution: { connection() {
      const connection = native.connection();
      Reflect.deleteProperty(connection, "restore");
      return connection;
    } }, snapshot: context => move(context, "trash") });
    expect(native.calls).toBe(0);
    expect(native.effects()).toHaveLength(0);
  });

  test("unadmitted and fenced bridge calls cannot touch the provider", async () => {
    const native = provider();
    const connection = { adapterId: "mail", connectionId: "conformance-connection" };
    const source = scenarioMail();
    let published = true;
    const bridge = mailExecutionBridge(source, { ...native, journal() { throw new Error("No journal may be reached outside an admitted call."); } }, "mail", () => published);
    await expect(bridge.invoke(connection, "draft", {})).rejects.toThrow("admitted");
    await expect(bridge.lookupContext(connection, { lifecycleVersion: "1.0.0", operationId: "other", ownerRequestId: "other" })).rejects.toThrow("admitted");
    published = false;
    expect(() => bridge.connection(connection)).toThrow("not published");
    await expect(bridge.invoke(connection, "draft", {})).rejects.toThrow("not published");
    expect(native.calls).toBe(0);
    expect(native.lookups).toBe(0);
  });
});
