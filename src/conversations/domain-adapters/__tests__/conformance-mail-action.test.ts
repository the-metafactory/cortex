import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccountRef, mailMessageRef, mailMoveSnapshot, mailReplyDraftSnapshot, type ApprovedSnapshot } from "../../../desk-sdk";
import { runMailActionScenario, type MailActionScenarioContext, type MailActionScenarioReport, type MailActionScenarioStep } from "../../../desk-adapter-sdk/conformance";
import { mailActionState, scenarioMail, SCENARIO_ACCOUNT, SCENARIO_MESSAGE, writeMailActionPackage } from "./fixtures/mail-action-package";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mail-action-scenario-test-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const snapshot = (context: MailActionScenarioContext): ApprovedSnapshot => mailMoveSnapshot({ ...context,
  account: mailAccountRef(context.adapterId, context.connectionId, context.account),
  input: { action: "move", message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), target: "archive" } });

const replySnapshot = (context: MailActionScenarioContext, body = "Reply", policy?: "local" | "cloud"): ApprovedSnapshot => mailReplyDraftSnapshot({ ...context,
  account: mailAccountRef(context.adapterId, context.connectionId, context.account),
  message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), body, ...(policy ? { policy } : {}) });

function unsignedWrongScope(context: MailActionScenarioContext, variant: "empty" | "foreign" | "target") {
  const approved = snapshot(context);
  if (variant === "empty") return { ...approved, destinations: [] };
  if (variant === "foreign") return { ...approved, destinations: [mailAccountRef(context.adapterId, context.connectionId, "other-account")] };
  return { ...approved, target: mailMessageRef(context.adapterId, context.connectionId, "other-message") };
}

function expectNoProviderMutation(dir: string): void {
  expect(mailActionState(dir)?.providerCalls).toBe(0);
  expect(mailActionState(dir)?.effects).toHaveLength(0);
}

function expectNotAdmitted(dir: string, report: MailActionScenarioReport): void {
  expect(report.stages[0]?.state).toBeNull();
  expect(report.ownerCalls.dispatch).toBe(0);
  expectNoProviderMutation(dir);
}

describe("public Mail action lifecycle scenario", () => {
  test("retains one real-journal effect through reopen and repeated dispatch", async () => {
    const dir = writeMailActionPackage(join(root, "move"));
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), snapshot, steps: ["repeat", "reopen", "repeat"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(report.ownerCalls.dispatch).toBe(1);
    expect(mailActionState(dir)?.effects).toEqual([{ messageId: SCENARIO_MESSAGE, folder: "Archive" }]);
    expect(report.stages.every(stage => stage.attemptIds.length === 1 && stage.snapshotDigest === report.snapshot.digest)).toBe(true);
    expect(report.stages.at(-1)?.receipts.length).toBeGreaterThan(0);
    expect(report.networkRequests).toBe(0);
    expect(report.credentialRequests).toBe(0);
  });

  test("reconciles an uncertain operation by admitted lookup after journal reopen", async () => {
    const dir = writeMailActionPackage(join(root, "timeout"), { timeout: true });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), snapshot, steps: ["reopen", "reconcile", "reopen", "repeat"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"]);
    expect(report.stages[2]?.outcome).toBe("settled");
    expect(report.ownerCalls).toMatchObject({ dispatch: 1, lookup: 1 });
    expect(mailActionState(dir)).toMatchObject({ providerCalls: 1, lookups: 1 });
    expect(mailActionState(dir)?.effects).toHaveLength(1);
    expect(report.events.some(event => JSON.stringify(event).includes('"reconciliation"'))).toBe(true);
    expect(report.stages.every(stage => stage.attemptIds.length === 1)).toBe(true);
  });

  test("does not turn a foreign historical result into a settled success", async () => {
    const dir = writeMailActionPackage(join(root, "bad-lookup"), { timeout: true, corruptLookup: true });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), snapshot, steps: ["reconcile"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain"]);
    expect(report.ownerCalls.lookup).toBe(1);
    expect(mailActionState(dir)?.effects).toHaveLength(1);
  });

  test("uses the production reply policy and preserves exact body text", async () => {
    const dir = writeMailActionPackage(join(root, "reply"), { action: "reply" });
    const body = "  First line\nSecond line  ";
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(),
      snapshot: context => replySnapshot(context, body) });
    expect(report.stages[0]?.state).toBe("succeeded");
    expect(mailActionState(dir)?.effects[0]?.body).toBe(body);
    expect(report.snapshot.target?.canonicalId).toBe(SCENARIO_MESSAGE);
    expect(report.snapshot.destinations).toEqual([mailAccountRef("mail", report.snapshot.connectionId, SCENARIO_ACCOUNT)]);
    expect(report.ownerCalls.dispatch).toBe(1);
  });

  for (const variant of ["empty", "foreign", "target"] as const) test(`${variant} move scope is refused at its owning boundary`, async () => {
    const dir = writeMailActionPackage(join(root, variant));
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), snapshot: context => unsignedWrongScope(context, variant) });
    expect(report.stages[0]?.state).toBe(variant === "foreign" ? null : "failed");
    expect(report.ownerCalls.dispatch).toBe(variant === "foreign" ? 0 : 1);
    expectNoProviderMutation(dir);
  });

  test("rejects invalid reply account scope before dispatch", async () => {
    const dir = writeMailActionPackage(join(root, "reply-denied"), { action: "reply" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), snapshot: context => {
      const approved = replySnapshot(context);
      return { ...approved, destinations: [] };
    } });
    expectNotAdmitted(dir, report);
  });

  test("a cloud-policy snapshot is refused in the local Mail scenario", async () => {
    const dir = writeMailActionPackage(join(root, "cloud-snapshot"), { action: "reply" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.reply-draft.create", mail: scenarioMail(), snapshot: context =>
      replySnapshot(context, "Reply", "cloud") });
    expect(report.snapshot.policy).toBe("cloud");
    expectNotAdmitted(dir, report);
  });

  test("does not invent account metadata omitted by the package declaration", async () => {
    const dir = writeMailActionPackage(join(root, "undeclared-account"), { omitAccount: true });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), snapshot });
    expectNotAdmitted(dir, report);
  });

  test("refuses invalid step and wait bounds before loading any package", async () => {
    await expect(runMailActionScenario("unused", { capabilityId: "mail.move", mail: scenarioMail(), snapshot, steps: Array.from({ length: 17 }, () => "repeat" as const) })).rejects.toThrow("sixteen");
    await expect(runMailActionScenario("unused", { capabilityId: "mail.move", mail: scenarioMail(), snapshot, steps: ["invalid" as MailActionScenarioStep] })).rejects.toThrow("Unknown Mail action scenario step: invalid");
    await expect(runMailActionScenario("unused", { capabilityId: "mail.move", mail: scenarioMail(), snapshot, dispatchWaitMs: 0 })).rejects.toThrow("one and ten thousand");
  });
});
