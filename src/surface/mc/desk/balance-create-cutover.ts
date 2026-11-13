import type { Database } from "bun:sqlite";
import type { DestinationArea } from "../../../balance";
import type { AuthorityCheck, HostContext } from "../../../conversations/authority";
import { createBalanceBinding, createBalanceFacade, type BalanceCreateBinding, type BalanceCreateLifecycle, type BalanceCreateContract, type BalanceCreateInput, type BalanceCreateReview } from "../../../conversations/domain-adapters/balance/create-binding";
import type { OperationBridge } from "../../../conversations/domain-adapters/operations/dispatch";
import type { OperationJournalStore } from "../../../conversations/domain-adapters/operations/journal";
import type { ApprovedSnapshot } from "../../../conversations/domain-adapters/operations/types";
import { writerLease, type WriterBinding, type WriterRecord, type WriterState } from "../../../conversations/domain-adapters/operations/writer-authority";
import type { CreateRequest, CreateResult, GrantBinding, OwnerWriter } from "../../../conversations/types";
import { loadBalanceState } from "./balance-store";
import { operationUuid } from "../../../conversations/conversation-ids";
import { canonicalWire } from "../../../conversations/domain-adapters/operations/validation";
import type { DeskOptions } from "./compose";

export interface BalanceCreateCutoverActive {
  readonly kind: "active";
  readonly binding: WriterBinding;
  readonly lease: ReturnType<typeof writerLease>;
  readonly connectionId: string;
  readonly cutoverRef: string;
}

export type BalanceCreateRoute = { readonly kind: "legacy" } | { readonly kind: "disabled"; readonly reason: string } | BalanceCreateCutoverActive;

export interface BalanceCreateCutover {
  route(): Promise<BalanceCreateRoute>;
  writer(route: BalanceCreateCutoverActive): OwnerWriter;
}

const failed = (reason: string): CreateResult => ({ state: "failed", error: `${reason} Nothing was created.` });
const cutover = (record: WriterRecord): BalanceCreateCutoverActive => ({ kind: "active", binding: record.plan.binding, lease: writerLease(record), connectionId: record.plan.binding.connectionId, cutoverRef: `${record.bindingKey}:${record.epoch}` });

export function balanceCreateRouteOf(state: Pick<WriterState, "records"> & Partial<Pick<WriterState, "ownerFences">>, stack: string, owner: "balance-task" | "balance-project"): BalanceCreateRoute {
  const heads = Object.values(state.records).flatMap(history => history.at(-1) ?? []).filter(record => record.plan.binding.stack === stack && record.plan.binding.owner === owner);
  if (heads.length === 0) return state.ownerFences?.includes(canonicalWire([stack, owner])) ? { kind: "disabled", reason: "The Balance legacy owner is fenced and its cutover record is missing." } : { kind: "legacy" };
  if (heads.length > 1) return { kind: "disabled", reason: "More than one Balance creation binding claims this stack, so creation cannot pick one." };
  const [record] = heads;
  if (!record) return { kind: "legacy" };
  if (record.plan.binding.adapterId !== "balance" || record.plan.binding.capabilityId !== `balance.${owner === "balance-task" ? "task" : "project"}.create`) return { kind: "disabled", reason: "The Balance cutover has an unknown capability mapping." };
  if (record.phase !== "active") {
    const failure = record.failures.at(-1);
    return { kind: "disabled", reason: failure ? `The Balance creation cutover stopped at ${failure.stage}: ${failure.message}` : `The Balance creation cutover has not completed; it waits at ${record.stage}.` };
  }
  return cutover(record);
}

export interface BalanceCreateWriterAuthority { inspect(): Promise<Pick<WriterState, "records"> & Partial<Pick<WriterState, "ownerFences">>> }

export async function balanceCreateRoute(writers: BalanceCreateWriterAuthority, stack: string, owner: "balance-task" | "balance-project"): Promise<BalanceCreateRoute> {
  try {
    return balanceCreateRouteOf(await writers.inspect(), stack, owner);
  } catch {
    return { kind: "disabled", reason: "The Balance creation cutover state could not be read." };
  }
}

export function routedBalanceCreateWriter(options: { legacy: OwnerWriter; cutover: BalanceCreateCutover }): OwnerWriter {
  const choose = async (): Promise<{ writer: OwnerWriter } | { route: { kind: "legacy" } | { kind: "disabled"; reason: string } }> => {
    try {
      const route = await options.cutover.route();
      return route.kind === "active" ? { writer: options.cutover.writer(route) } : { route };
    } catch {
      return { route: { kind: "disabled", reason: "The Balance creation cutover state could not be read." } };
    }
  };
  return {
    lifecycleManaged: true,
    async create(request) {
      const chosen = await choose();
      if (!("writer" in chosen)) return chosen.route.kind === "legacy" ? options.legacy.create(request) : failed(chosen.route.reason);
      return chosen.writer.create(request);
    },
    async readback(request) {
      const chosen = await choose();
      if (!("writer" in chosen)) return chosen.route.kind === "legacy" ? options.legacy.readback(request) : null;
      return chosen.writer.readback(request);
    },
    async grantBinding(fields): Promise<GrantBinding | null> {
      const chosen = await choose();
      if (!("writer" in chosen)) return chosen.route.kind === "legacy" ? await options.legacy.grantBinding?.(fields) ?? null : null;
      return await chosen.writer.grantBinding?.(fields) ?? null;
    },
  };
}

export interface BalanceCreateLifecycleOptions {
  stack: string;
  db: Database;
  desk: () => DeskOptions | undefined;
  areas: () => readonly DestinationArea[];
  journal: OperationJournalStore;
  bridge: OperationBridge;
  writers: BalanceCreateWriterAuthority;
  supportDeclarationId: string;
  context: (request: CreateRequest, route: BalanceCreateCutoverActive) => Promise<HostContext | null>;
  approve: (context: HostContext, approval: { operationId: string; idempotencyKey: string; ownerRequestId: string; snapshot: ApprovedSnapshot }) => Promise<AuthorityCheck>;
  binding?: (route: BalanceCreateCutoverActive) => BalanceCreateBinding;
  now?: () => number;
}

export function createBalanceLifecycleWriter<I extends BalanceCreateInput, R extends BalanceCreateReview<I>>(options: BalanceCreateLifecycleOptions, contract: BalanceCreateContract<I, R>): OwnerWriter {
  const build = (route: BalanceCreateCutoverActive) => {
    const binding = options.binding?.(route) ?? createBalanceBinding({ stack: options.stack, connectionId: route.connectionId, db: options.db, desk: options.desk, areas: options.areas, journal: options.journal, supportDeclarationId: options.supportDeclarationId, ...(options.now ? { now: options.now } : {}) }, contract);
    const facade = createBalanceFacade({ binding, journal: options.journal, areas: options.areas, state: () => loadBalanceState(options.db), ...(options.now ? { now: options.now } : {}) }, contract);
    return { binding, facade };
  };
  return {
    async create(request) {
      const route = await balanceCreateRoute(options.writers, options.stack, contract.owner);
      if (route.kind !== "active") return failed(route.kind === "legacy" ? "The Balance creation binding is not cut over." : route.reason);
      if (request.writerRevision !== route.cutoverRef) return failed("The Balance writer changed since review. Review the proposal again after the verified cutover.");
      const context = await options.context(request, route);
      if (!context) return failed("The Balance creation binding has no authenticated session for this conversation.");
      const { binding, facade } = build(route);
      const review = facade.review(request.fields);
      if (review.kind !== "resolved") return failed(review.reason);
      const snapshot = contract.snapshot({
        connectionId: route.connectionId,
        provenance: { conversationId: request.provenance.conversationId, proposalId: request.provenance.proposalId, revision: request.provenance.revision, entryId: request.provenance.entryId, link: request.provenance.link },
        input: review.input,
      });
      const approval = await options.approve(context, { operationId: request.operationId, idempotencyKey: request.operationId, ownerRequestId: operationUuid(request.operationId), snapshot });
      if (approval.kind !== "allowed") return failed(approval.reason.message);
      const lifecycle: BalanceCreateLifecycle = {
        activate: () => options.bridge.activate(binding.writerBinding, route.lease),
        dispatch: operationId => options.bridge.dispatch(context, operationId, route.lease),
      };
      return (await facade.create(request, approval.authority, lifecycle)).result;
    },
    async readback(operation) {
      const route = await balanceCreateRoute(options.writers, options.stack, contract.owner);
      if (route.kind !== "active") return null;
      return build(route).binding.readback(operation);
    },
    async grantBinding(fields) {
      const route = await balanceCreateRoute(options.writers, options.stack, contract.owner);
      if (route.kind !== "active") return null;
      const review = build(route).facade.review(fields);
      if (review.kind !== "resolved") return null;
      const refs = [review.input.area, ...(review.input.project ? [review.input.project] : [])];
      return { connectionId: route.connectionId, destinations: refs.map(ref => ({ objectType: ref.objectType, canonicalId: ref.canonicalId })) };
    },
  };
}
