import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { DomainAdapterRegistry } from "../../registry";
import type { HostContext, TrustedConnector, WriterLease } from "../../../authority";
import { OperationJournalStore } from "../../operations/journal";
import { OperationBridge, type DispatchAuthority } from "../../operations/dispatch";
import type { Authority, OwnerSupport } from "../../operations/types";
import { writerBindingKey, type WriterBinding } from "../../operations/writer-authority";

export const confirmationAuthority = (now: number): Authority => ({
  principalRef: "principal-example",
  basis: { kind: "confirmation", confirmationId: "confirmation-example", transport: "web" },
  connectionRevision: "1",
  policyRevision: "1",
  decisionRef: "decision-example",
  authorizedAt: new Date(now).toISOString(),
});

export interface LiveBinding {
  readonly support: OwnerSupport;
  readonly writerBinding: WriterBinding;
  readonly connector: Pick<TrustedConnector, "dispatch">;
}

export function lifecycleRig(options: { journal: OperationJournalStore; live: () => LiveBinding; now: number; clock?: () => Date; label: string }) {
  const { journal, live, now } = options;
  const context = {} as HostContext;
  const lease: WriterLease = { bindingKey: writerBindingKey(live().writerBinding), epoch: 1, instanceId: "instance-example", supervisorReceiptRef: "receipt-example" };
  const authority: DispatchAuthority = {
    preflight: () => Promise.resolve({ kind: "allowed" }),
    async dispatch(_context, request) {
      const response = await live().connector.dispatch(request, new AbortController().signal);
      const stored = await journal.read(request.operationId);
      if (!stored) throw new Error(`${options.label} operation vanished before evidence.`);
      await journal.receive(request.operationId, stored.revision, response, new Date(now + 1_000).toISOString());
      return { kind: "admitted" };
    },
    cancel: () => Promise.resolve({ kind: "denied", reason: { code: "authority_denied", message: "Cancellation is not declared." }, recovery: "reauthorize" }),
  };
  const bridge = new OperationBridge({ journal, authority, writers: { current: () => Promise.resolve(true), legacyAllowed: () => Promise.resolve(true) }, supportFor: () => live().support, now: options.clock ?? (() => new Date(now)) });
  const lifecycle = () => ({ activate: () => bridge.activate(live().writerBinding, lease), dispatch: (operationId: string) => bridge.dispatch(context, operationId, lease) });
  return { context, lease, bridge, lifecycle };
}

export async function openJournal(dir: string, registry: DomainAdapterRegistry): Promise<{ journal: OperationJournalStore; closeEngine: () => Promise<void> }> {
  const engine = await Harness.open(await openNodeSqliteStorage(join(dir, "operations.sqlite")), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  return { journal: new OperationJournalStore(engine, registry, BACKGROUND_CONTEXT), closeEngine: () => engine.close(BACKGROUND_CONTEXT) };
}
