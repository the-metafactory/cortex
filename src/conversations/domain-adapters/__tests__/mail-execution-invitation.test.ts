import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailInvitationSnapshot, mailReportSnapshot, mailMessageRef, type InvitationAction } from "../../../desk-sdk";
import { runMailActionScenario, type MailActionScenarioContext, type MailExecutionProvider } from "../../../desk-adapter-sdk/conformance";
import { InvitationInputSchema, InvitationOutputSchema } from "../mail/invitation-contract";
import { scenarioMail, SCENARIO_MESSAGE } from "./fixtures/mail-action-package";
import { writeMailExecutionPackage } from "./fixtures/mail-execution-package";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mail-execution-invitation-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function invitationProvider(options: { omit?: readonly string[] } = {}) {
  const inputs: unknown[] = [];
  const lookups: unknown[] = [];
  const full: MailExecutionProvider = {
    version: 1,
    invitationReply: input => { inputs.push(input); return Promise.resolve({ ref: (input as { invitation: unknown }).invitation, revision: "r2" }); },
    invitationRemove: input => { inputs.push(input); return Promise.resolve({ ref: (input as { invitation: unknown }).invitation, revision: "r2" }); },
    invitationRestore: input => { inputs.push(input); return Promise.resolve({ ref: (input as { invitation: unknown }).invitation, revision: "r3" }); },
    report: () => Promise.resolve({}),
    lookupReport: () => Promise.resolve({}),
    restore: () => Promise.resolve({}),
    lookupInvitation: input => { lookups.push(input); return Promise.resolve({ status: "found", request: inputs[0], result: { ref: (inputs[0] as { invitation: unknown }).invitation, revision: "r2" } }); },
  };
  const provider: Record<string, unknown> = { ...full };
  for (const name of options.omit ?? []) delete provider[name];
  return { inputs, lookups, connection: () => provider as MailExecutionProvider };
}

const snapshotFor = (action: InvitationAction) => (context: MailActionScenarioContext) => mailInvitationSnapshot({ ...context, action, messageId: SCENARIO_MESSAGE, invitationId: "invitation-example", expectedRevision: "r1" });

describe("packaged Mail invitation execution", () => {
  for (const action of ["accept", "decline", "tentative"] as const) test(`${action} reaches invitationReply with the approved invitation and returns a valid output`, async () => {
    const native = invitationProvider();
    const dir = writeMailExecutionPackage(join(root, action), { action: "invitation", invitation: action });
    const report = await runMailActionScenario(dir, { capabilityId: `mail.invitation.${action}`, mail: scenarioMail(), execution: native, snapshot: snapshotFor(action) });
    expect(report.stages[0]?.state).toBe("succeeded");
    expect(native.inputs).toHaveLength(1);
    const { version, requestId, reply, ...approved } = native.inputs[0] as Record<string, unknown>;
    expect(InvitationInputSchema.safeParse(approved).success).toBe(true);
    expect(version).toBe(1);
    expect(reply).toBe(action);
    expect(requestId).toMatch(new RegExp(`^mail\\.invitation\\.${action}:`));
    expect(InvitationOutputSchema.safeParse({ ref: approved.invitation, revision: "r2" }).success).toBe(true);
  });

  test("an approved remove reaches invitationRemove and needs no invitationRestore", async () => {
    const native = invitationProvider({ omit: ["invitationRestore"] });
    const dir = writeMailExecutionPackage(join(root, "remove"), { action: "invitation", invitation: "remove" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.invitation.remove", mail: scenarioMail(), execution: native, snapshot: snapshotFor("remove") });
    expect(report.stages[0]?.state).toBe("succeeded");
    expect(native.inputs).toHaveLength(1);
    expect(native.inputs[0]).not.toHaveProperty("reply");
  });

  test("the lookup is durable across a restart and reaches lookupInvitation", async () => {
    const native = invitationProvider();
    const dir = writeMailExecutionPackage(join(root, "lookup"), { action: "invitation", invitation: "decline" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.invitation.decline", mail: scenarioMail(), execution: native, snapshot: snapshotFor("decline"), steps: ["restart", "reconcile"] });
    expect(report.stages.at(-1)?.state).toBe("succeeded");
    expect(native.lookups.every(lookup => typeof lookup === "string" && lookup.startsWith("mail.invitation.decline:"))).toBe(true);
  });

  test("a reply method under a remove snapshot is refused with the provider uncalled", async () => {
    const native = invitationProvider();
    const dir = writeMailExecutionPackage(join(root, "scope-remove"), { action: "invitation", invitation: "remove", reportMethod: "invitationReply" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.invitation.remove", mail: scenarioMail(), execution: native, snapshot: snapshotFor("remove") });
    expect(report.stages[0]?.state).toBe("uncertain");
    expect(native.inputs).toHaveLength(0);
  });

  test("an invitation method under a report capability is refused with the provider uncalled", async () => {
    const native = invitationProvider();
    const dir = writeMailExecutionPackage(join(root, "scope-report"), { action: "report", reportKind: "spam", reportMethod: "invitationReply" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.report.spam", mail: scenarioMail(), execution: native, snapshot: context => mailReportSnapshot({ ...context, kind: "spam", input: { message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE) } }) });
    expect(report.stages[0]?.state).toBe("uncertain");
    expect(native.inputs).toHaveLength(0);
  });

  test("a reply that differs from the approved one is refused", async () => {
    const native = invitationProvider();
    const dir = writeMailExecutionPackage(join(root, "forged"), { action: "invitation", invitation: "decline", forge: "reply" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.invitation.decline", mail: scenarioMail(), execution: native, snapshot: snapshotFor("decline") });
    expect(report.stages[0]?.state).toBe("uncertain");
    expect(native.inputs).toHaveLength(0);
  });

  test("a connection without lookupInvitation is refused", async () => {
    const native = invitationProvider({ omit: ["lookupInvitation"] });
    const dir = writeMailExecutionPackage(join(root, "unavailable"), { action: "invitation", invitation: "decline" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.invitation.decline", mail: scenarioMail(), execution: native, snapshot: snapshotFor("decline") });
    expect(report.stages[0]?.state).toBe("refused");
    expect(native.inputs).toHaveLength(0);
  });
});
