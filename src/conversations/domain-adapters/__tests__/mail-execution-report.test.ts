import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccountRef, mailMessageRef, mailMoveSnapshot, mailReportSnapshot, type MailReportKind } from "../../../desk-sdk";
import { runMailActionScenario, type MailActionScenarioContext, type MailExecutionProvider } from "../../../desk-adapter-sdk/conformance";
import { MailReportInputSchema, MailReportOutputSchema } from "../mail/report-contract";
import { scenarioMail, SCENARIO_MESSAGE } from "./fixtures/mail-action-package";
import { writeMailExecutionPackage } from "./fixtures/mail-execution-package";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mail-execution-report-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function reportProvider(options: { omit?: readonly string[]; timeout?: boolean } = {}) {
  const inputs: unknown[] = [];
  const lookups: unknown[] = [];
  const full: MailExecutionProvider = {
    version: 1,
    report: input => { inputs.push(input); const parsed = MailReportInputSchema.parse(input); if (options.timeout) return Promise.reject(new Error("The provider reported before a timeout.")); return Promise.resolve({ ref: parsed.message, folder: "Junk" }); },
    lookupReport: input => { lookups.push(input); return Promise.resolve({ status: "found", request: {}, result: { status: "reported", folder: "Junk" } }); },
    restore: () => Promise.resolve({ status: "restored", folder: "Inbox" }),
    move: () => Promise.resolve({}),
  };
  const provider = Object.fromEntries(Object.entries(full).filter(([key]) => !options.omit?.includes(key)));
  return { inputs, lookups, connection: (): MailExecutionProvider => provider };
}

const reportSnapshot = (kind: MailReportKind) => (context: MailActionScenarioContext) => mailReportSnapshot({ ...context, kind, input: { message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE) } });
const moveSnapshot = (context: MailActionScenarioContext) => mailMoveSnapshot({ ...context, account: mailAccountRef(context.adapterId, context.connectionId, context.account), input: { action: "move", message: mailMessageRef(context.adapterId, context.connectionId, SCENARIO_MESSAGE), target: "archive" } });

describe("packaged Mail report execution", () => {
  for (const kind of ["spam", "phishing", "draft"] as const) test(`${kind} report reaches the provider with the approved message and returns a valid output`, async () => {
    const native = reportProvider();
    const dir = writeMailExecutionPackage(join(root, kind), { action: "report", reportKind: kind });
    const report = await runMailActionScenario(dir, { capabilityId: `mail.report.${kind}`, mail: scenarioMail(), execution: native, snapshot: reportSnapshot(kind) });
    expect(report.stages[0]?.state).toBe("succeeded");
    expect(native.inputs).toHaveLength(1);
    expect(MailReportInputSchema.safeParse(native.inputs[0]).success).toBe(true);
    const output = report.events.map(event => JSON.stringify(event)).join("\n");
    expect(output).toContain("Junk");
    expect(MailReportOutputSchema.safeParse({ ref: mailMessageRef("mail", "conformance-connection", SCENARIO_MESSAGE), folder: "Junk" }).success).toBe(true);
  });

  test("the lookup context is durable across a restart and reaches lookupReport", async () => {
    const native = reportProvider({ timeout: true });
    const dir = writeMailExecutionPackage(join(root, "lookup"), { action: "report", reportKind: "spam" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.report.spam", mail: scenarioMail(), execution: native, snapshot: reportSnapshot("spam"), steps: ["restart", "reconcile"] });
    expect(report.stages.map(stage => stage.state)).toEqual(["uncertain", "uncertain", "succeeded"]);
    expect(native.lookups.length).toBeGreaterThan(0);
    expect(native.lookups.every(lookup => typeof lookup === "string" && lookup.startsWith("mail.report.spam:"))).toBe(true);
  });

  test("report on another approved capability is refused with the provider uncalled", async () => {
    const native = reportProvider();
    const dir = writeMailExecutionPackage(join(root, "scope"), { action: "move", reportMethod: "report" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.move", mail: scenarioMail(), execution: native, snapshot: moveSnapshot });
    expect(report.stages[0]?.state).toBe("uncertain");
    expect(native.inputs).toHaveLength(0);
  });

  test("a connection without report fails and is not listed", async () => {
    const native = reportProvider({ omit: ["report"] });
    const dir = writeMailExecutionPackage(join(root, "unavailable"), { action: "report", reportKind: "spam" });
    const report = await runMailActionScenario(dir, { capabilityId: "mail.report.spam", mail: scenarioMail(), execution: native, snapshot: reportSnapshot("spam") });
    expect(report.stages[0]?.state).toBe("refused");
    expect(native.inputs).toHaveLength(0);
  });

  test("a provider report without restore is refused because Undo needs it", async () => {
    const native = reportProvider({ omit: ["restore"] });
    const dir = writeMailExecutionPackage(join(root, "no-restore"), { action: "report", reportKind: "phishing" });
    await runMailActionScenario(dir, { capabilityId: "mail.report.phishing", mail: scenarioMail(), execution: native, snapshot: reportSnapshot("phishing") });
    expect(native.inputs).toHaveLength(0);
  });
});
