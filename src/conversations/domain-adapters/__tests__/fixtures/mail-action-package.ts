import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailReadSource } from "../../../../desk-adapter-sdk/conformance";
import { CONFORMANCE_CONNECTION_ID } from "../../../../desk-adapter-sdk/conformance/connection";
import { mailMoveDeclaration, type MailMoveAction } from "../../mail/move-contract";
import { mailReplyDraftDeclaration } from "../../mail/reply-draft-contract";
import { conformanceDomain, writeConformancePackage } from "./conformance-build";

export const SCENARIO_ACCOUNT = "account-example";
export const SCENARIO_MESSAGE = "message-example";

export const scenarioMail = (): MailReadSource => ({
  connections: () => [{ adapterId: "mail", connectionId: CONFORMANCE_CONNECTION_ID, sourceId: "source-example", account: SCENARIO_ACCOUNT, dataPolicy: "local" }],
  listings: () => [{ id: "source-example", readAt: Date.now(), error: null, mail: [{ id: SCENARIO_MESSAGE, account: SCENARIO_ACCOUNT, from: { address: "sender@example.test" }, subject: "Synthetic mail", receivedAt: "2026-11-15T00:00:00.000Z", unread: true }] }],
});

interface MailActionFixtureState {
  effects: { messageId: string; body?: string; folder?: string }[];
  providerCalls: number;
  lookups: number;
}

export const mailActionState = (dir: string): MailActionFixtureState | undefined => Reflect.get(globalThis, Symbol.for(dir)) as MailActionFixtureState | undefined;

export function writeMailActionPackage(dir: string, options: { action?: MailMoveAction | "reply"; timeout?: boolean; corruptLookup?: boolean; network?: boolean; stateKey?: string; omitAccount?: boolean } = {}): string {
  const action = options.action ?? "move";
  const declared = action === "reply" ? mailReplyDraftDeclaration() : mailMoveDeclaration("mail", [action]);
  if (options.omitAccount) declared.objectTypes = declared.objectTypes.filter(type => type.objectType !== "account");
  const capabilityId = declared.capabilities[0]?.capabilityId;
  if (!capabilityId) throw new Error("The fixture requires an action.");
  const built = writeConformancePackage(dir, { ...conformanceDomain("greenhouse"), adapterId: "mail" });
  const source = `const declaration = ${JSON.stringify(declared)};
export function createDeskAdapter(host) {
  const state = { effects: [], providerCalls: 0, lookups: 0, saved: null };
  globalThis[Symbol.for(${JSON.stringify(options.stateKey ?? dir)})] = state;
  host.registerConnector(${JSON.stringify(capabilityId)}, connection => ({
    kind: "action", ...connection, capabilityId: ${JSON.stringify(capabilityId)}, writerOwner: "mail-fixture",
    support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: ${JSON.stringify(capabilityId)}, declarationId: "mail-scenario-fixture", dedup: { kind: "guaranteed", scope: "connection-capability", retentionMs: 60000, bindsSnapshot: true, concurrent: true }, operationLookup: "historical", conditionalUpdate: "none", cancellation: "none" },
    async dispatch(request) {
      const listing = await host.mail.listed(connection);
      const snapshot = request.snapshot, message = snapshot.input.message;
      const base = { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: snapshot.digest, reportedAt: new Date().toISOString() };
      if (!listing || !snapshot.target || JSON.stringify(snapshot.target) !== JSON.stringify(message) || snapshot.destinations.length !== 1 || snapshot.destinations[0].canonicalId !== listing.account) {
        return { ...base, resultId: "denied", result: { kind: "failed", error: { code: "mail.denied", message: "Invalid scope" }, evidence: { kind: "no-effect", evidenceId: "denied", observedAt: base.reportedAt, ownerRequestId: request.ownerRequestId, receipt: {}, final: true } } };
      }
      state.providerCalls++;
      ${options.network ? 'await fetch("https://example.invalid/blocked");' : ""}
      const ref = { ...connection, objectType: ${JSON.stringify(action === "reply" ? "draft" : "message")}, canonicalId: ${JSON.stringify(action === "reply" ? "draft-example" : SCENARIO_MESSAGE)} };
      const output = ${action === "reply" ? "{ ref }" : '{ ref, folder: "Archive" }'};
      state.effects.push({ messageId: message.canonicalId, ${action === "reply" ? "body: snapshot.input.body" : 'folder: "Archive"'} });
      state.saved = { ...base, resultId: "effect", result: { kind: "succeeded", output, evidence: { kind: "effect", evidenceId: "fixture-effect", observedAt: base.reportedAt, ownerRequestId: request.ownerRequestId, receipt: output, refs: [ref] } } };
      return ${options.timeout ? '{ ...base, resultId: "uncertain", result: { kind: "uncertain", error: { code: "mail.timeout", message: "Unknown until lookup" }, ownerRequestId: request.ownerRequestId } }' : "state.saved"};
    },
    async lookup(request) {
      const listed = await host.mail.listed(connection);
      if (!listed) throw new Error("Lookup must have admitted Mail context.");
      state.lookups++;
      const response = ${options.corruptLookup ? '{ ...state.saved, snapshotDigest: "0".repeat(64) }' : "state.saved"};
      return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: new Date().toISOString(), result: { kind: "known", response } };
    }
  }));
  return { declaration, bindings: { handlers: {}, observations: {} } };
}
`;
  writeFileSync(join(dir, "backend.mjs"), source);
  writeFileSync(join(dir, "desk-adapter.json"), JSON.stringify({ ...built.manifest, declaration: declared, draftingBindings: [], readBindings: [],
    backend: { entry: "backend.mjs", sha256: createHash("sha256").update(source).digest("hex") } }, null, 2));
  return dir;
}
