import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mailMoveDeclaration, type MailMoveAction } from "../../mail/move-contract";
import { MAIL_REPORT_CAPABILITY, mailReportDeclaration, type MailReportKind } from "../../mail/report-contract";
import { mailReplyDraftDeclaration } from "../../mail/reply-draft-contract";
import { mailUnsubscribeDeclaration } from "../../mail/unsubscribe-contract";
import { conformanceDomain, writeConformancePackage } from "./conformance-build";

export function writeMailExecutionPackage(dir: string, options: { action?: MailMoveAction | "reply" | "unsubscribe" | "report"; reportKind?: MailReportKind; reportMethod?: string; forge?: "account" | "message" | "body" | "method" | "lookup" | "connection" | "context" | "extra" | "lookupMethod" | "lookupConnection" | "lookupOperation"; late?: boolean; stateKey?: string } = {}): string {
  const action = options.action ?? "reply";
  const reportKind = options.reportKind ?? "spam";
  const reportDeclaration = mailReportDeclaration("mail", [reportKind]);
  const declaration = action === "report" ? { ...reportDeclaration, capabilities: reportDeclaration.capabilities.filter(capability => capability.capabilityId === MAIL_REPORT_CAPABILITY[reportKind]) } : action === "reply" ? mailReplyDraftDeclaration() : action === "unsubscribe" ? mailUnsubscribeDeclaration("mail") : mailMoveDeclaration("mail", [action]);
  const capabilityId = action === "report" ? MAIL_REPORT_CAPABILITY[reportKind] : declaration.capabilities[0]?.capabilityId;
  if (!capabilityId) throw new Error("The execution package requires an action.");
  const built = writeConformancePackage(dir, { ...conformanceDomain("greenhouse"), adapterId: "mail" });
  mkdirSync(join(dir, "node_modules", "@the-metafactory"), { recursive: true });
  symlinkSync(new URL("../../../../../", import.meta.url).pathname, join(dir, "node_modules", "@the-metafactory", "cortex"));
  const key = options.stateKey ?? dir;
  const source = `import { mailReplySubject } from "@the-metafactory/cortex/desk-sdk";
const declaration = ${JSON.stringify(declaration)};
export function createDeskAdapter(host) {
  const audit = globalThis[Symbol.for(${JSON.stringify(key)})] ??= { constructions: 0, bridgeCount: 0, bridges: new WeakSet() };
  audit.constructions++;
  if (!audit.bridges.has(host.mailExecution)) { audit.bridges.add(host.mailExecution); audit.bridgeCount++; }
  host.registerConnector(${JSON.stringify(capabilityId)}, connection => {
    const bridge = host.mailExecution;
    const bound = bridge?.connection(connection);
    const identity = { kind: "action", ...connection, capabilityId: ${JSON.stringify(capabilityId)} };
    if (!bound || bound.version !== 1) return identity;
    ${action === "report" ? 'if (!bound.methods.includes("report") || !bound.methods.includes("lookupReport")) return identity;' : ""}
    const contextFor = request => ({ operationId: request.operationId, attemptId: request.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: request.snapshot.digest, snapshot: request.snapshot });
    const result = (context, value) => {
      const at = new Date().toISOString(), snapshot = context.snapshot;
      const ref = { ...connection, objectType: ${JSON.stringify(action === "reply" ? "draft" : "message")}, canonicalId: ${action === "reply" ? "value.id" : "snapshot.target.canonicalId"} };
      const output = ${action === "reply" ? "{ ref }" : action === "unsubscribe" ? "{ ref, host: value.host }" : "{ ref, folder: value.folder }"};
      const base = { lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, reportedAt: at, resultId: context.attemptId + ":found" };
      if (value.status === "conflict") return { ...base, result: { kind: "conflict", error: { code: "mail.location_conflict", message: "Location changed" }, currentOwnerRevision: value.folder, evidence: { kind: "no-effect", evidenceId: context.ownerRequestId, observedAt: at, ownerRequestId: context.ownerRequestId, receipt: value, final: true } } };
      return { ...base, result: { kind: "succeeded", output, evidence: { kind: "effect", evidenceId: context.ownerRequestId, observedAt: at, ownerRequestId: context.ownerRequestId, receipt: value, refs: [ref] } } };
    };
    return { ...identity, writerOwner: "mail-execution-fixture", support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: identity.capabilityId, declarationId: "mail-execution-fixture-1", dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: 60000, bindsSnapshot: true, concurrent: true }, operationLookup: "historical", conditionalUpdate: ${JSON.stringify(action === "restore" ? "owner-enforced" : "none")}, cancellation: "none" },
      async dispatch(request) {
        const context = contextFor(request), snapshot = request.snapshot, listing = await host.mail.listed(connection);
        const mail = listing?.mail.find(item => item.ref.messageId === snapshot.target.canonicalId);
        const requestId = identity.capabilityId + ":" + request.ownerRequestId;
        const native = ${action === "report" ? `{ version: 1, requestId, kind: ${JSON.stringify(reportKind)}, ` : "{ version: 1, requestId, account: listing.account, messageId: snapshot.target.canonicalId, "}
          ${action === "report" ? "message: snapshot.target" : action === "reply" ? "recipient: mail.from.address, subject: mailReplySubject(mail.subject), body: snapshot.input.body" : "context: { operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest }"}
          ${action === "move" ? ', action: "move", target: snapshot.input.target' : action === "trash" ? ', action: "trash", target: "trash"' : action === "restore" ? ', action: "restore", from: snapshot.input.from' : ""} };
        ${options.forge === "account" ? 'native.account = "other-account";' : options.forge === "message" ? 'native.messageId = "other-message";' : options.forge === "body" ? 'native.body = "changed";' : options.forge === "context" ? 'native.context = { operationId: "other", attemptId: "other", snapshotDigest: "0".repeat(64) };' : ""}
        ${options.forge === "extra" ? action === "reply" ? 'native.bcc = "other@example.org";' : 'native.url = "https://other.example.org/unapproved";' : ""}
        ${options.late ? 'audit.late = new Promise(resolve => { audit.release = resolve; }).then(() => bridge.invoke(connection, "draft", native));' : ""}
        try {
          const value = await bridge.invoke(${options.forge === "connection" ? '{ ...connection, connectionId: "other" }' : "connection"}, ${JSON.stringify(options.reportMethod ?? (options.forge === "method" ? "unsubscribe" : action === "report" ? "report" : action === "reply" ? "draft" : action === "move" || action === "trash" ? "move" : action === "restore" ? "restore" : "unsubscribe"))}, native);
          return result(context, value);
        } catch (error) {
          return { lifecycleVersion: "1.0.0", operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest, reportedAt: new Date().toISOString(), resultId: context.attemptId + ":uncertain", result: { kind: "uncertain", error: { code: "mail.uncertain", message: error instanceof Error ? error.message : "Unknown provider outcome" }, ownerRequestId: request.ownerRequestId } };
        }
      },
      async lookup(request) {
        const lookup = ${options.forge === "lookup" ? '{ ...request, ownerRequestId: "other-request" }' : options.forge === "lookupOperation" ? '{ ...request, operationId: "other-operation" }' : "request"};
        const target = ${options.forge === "lookupConnection" ? '{ ...connection, connectionId: "other" }' : "connection"};
        const context = await bridge.lookupContext(target, lookup);
        const found = await bridge.invoke(target, ${JSON.stringify(options.forge === "lookupMethod" ? "lookupMove" : action === "report" ? "lookupReport" : action === "reply" ? "lookup" : action === "unsubscribe" ? "lookupUnsubscribe" : "lookupMove")}, identity.capabilityId + ":" + lookup.ownerRequestId);
        const value = found.request ? { ...found.result, status: "found" } : found;
        return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: new Date().toISOString(), result: value.status === "found" ? { kind: "known", response: result(context, value) } : { kind: "unknown", reason: { code: "mail.not_found", message: "No effect found" } } };
      }
    };
  });
  return { declaration, bindings: { handlers: {}, observations: {} } };
}
`;
  writeFileSync(join(dir, "backend.mjs"), source);
  writeFileSync(join(dir, "desk-adapter.json"), JSON.stringify({ ...built.manifest, declaration, draftingBindings: [], readBindings: [], backend: { entry: "backend.mjs", sha256: createHash("sha256").update(source).digest("hex") } }, null, 2));
  return dir;
}
