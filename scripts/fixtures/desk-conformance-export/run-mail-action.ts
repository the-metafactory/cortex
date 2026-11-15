import { readFileSync } from "node:fs";
import { mailAccountRef, mailMessageRef, mailMoveSnapshot, mailReplyDraftSnapshot, DESK_ADAPTER_SDK_VERSION } from "@the-metafactory/cortex/desk-sdk";
import { CONFORMANCE_CONNECTION_ID, runMailActionScenario, type MailReadSource } from "@the-metafactory/cortex/desk-adapter-conformance";

const manifest = JSON.parse(readFileSync("desk-adapter.json", "utf8")) as { declaration: { capabilities: { capabilityId: string }[] } };
const capabilityId = manifest.declaration.capabilities[0]?.capabilityId;
if (capabilityId !== "mail.move" && capabilityId !== "mail.reply-draft.create") throw new Error("The external fixture must offer one Mail action.");
const account = "account-example";
const messageId = "message-example";
const body = "  Public reply\nwith exact spacing  ";
const mail: MailReadSource = {
  connections: () => [{ adapterId: "mail", connectionId: CONFORMANCE_CONNECTION_ID, account, sourceId: "source-example", dataPolicy: "local" }],
  listings: () => [{ id: "source-example", readAt: Date.now(), error: null, mail: [{ id: messageId, account, from: { address: "sender@example.test" }, subject: "Synthetic mail", receivedAt: "2026-11-15T00:00:00.000Z", unread: true }] }],
};
const report = await runMailActionScenario(".", { capabilityId, mail, steps: ["reopen", "reconcile", "reopen", "repeat"], snapshot: context => {
  const accountRef = mailAccountRef(context.adapterId, context.connectionId, context.account);
  const message = mailMessageRef(context.adapterId, context.connectionId, messageId);
  return capabilityId === "mail.move"
    ? mailMoveSnapshot({ ...context, account: accountRef, input: { action: "move", message, target: "archive" } })
    : mailReplyDraftSnapshot({ ...context, account: accountRef, message, body });
} });
const provider = Reflect.get(globalThis, Symbol.for("public-mail-action-proof")) as { providerCalls: number; lookups: number; effects: { body?: string }[] } | undefined;
if (JSON.stringify(report.stages.map(stage => stage.state)) !== JSON.stringify(["uncertain", "uncertain", "succeeded", "succeeded", "succeeded"])) throw new Error("The real journal did not settle and remain settled.");
if (report.ownerCalls.dispatch !== 1 || report.ownerCalls.lookup !== 1 || provider?.providerCalls !== 1 || provider.lookups !== 1 || provider.effects.length !== 1) throw new Error("The provider call, effect or lookup count changed.");
if (capabilityId === "mail.reply-draft.create" && provider.effects[0]?.body !== body) throw new Error("Reply text changed.");
if (report.stages.some(stage => stage.attemptIds.length !== 1 || stage.snapshotDigest !== report.snapshot.digest)) throw new Error("Attempt or snapshot identity changed.");
if (!report.stages.at(-1)?.receipts.length || report.networkRequests !== 0 || report.credentialRequests !== 0) throw new Error("Missing receipts or unexpected external access.");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const approval = report.events.map(event => record(record(event)?.event)).find(event => event?.kind === "approved");
const basis = record(record(approval?.authority)?.basis);
if (basis?.kind !== "confirmation") throw new Error("The local scenario did not record exact confirmation authority.");
console.log(JSON.stringify({ sdkVersion: DESK_ADAPTER_SDK_VERSION, report, provider }));
