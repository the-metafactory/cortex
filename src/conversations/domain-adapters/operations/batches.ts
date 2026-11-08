import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Denial, HostContext, ReadScope, ReleaseProjection } from "../../authority";
import type { ReleaseSink } from "../../authority-records";
import type { BoundaryError } from "../types";
import { StoreDoc, StoredSchema, type StoredOperation } from "./journal";
import { receiptStatus } from "./reconciliation";
import { BatchReceiptSchema, parseWire, type BatchReceipt, type Json, type OperationState } from "./types";

export type BatchErrorCode = "invalid_input" | "batch_unknown" | "link_conflict" | "link_mismatch";
export class BatchReceiptError extends Error {
  constructor(readonly code: BatchErrorCode, message: string) { super(message); }
}

const BatchDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.lifecycle-batch", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });
const LinkDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.lifecycle-batch-link", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

const ItemLinkSchema = z.object({ itemId: z.string().min(1), operationId: z.string().min(1) }).strict();
export const BatchIndexSchema = z.object({ format: z.literal("desk-batch-index/1"), batchId: z.uuid(), connectionId: z.string().min(1), items: z.array(ItemLinkSchema).min(1) }).strict();
export type BatchIndex = z.infer<typeof BatchIndexSchema>;
export type BatchRegistration = Pick<BatchIndex, "batchId" | "connectionId" | "items">;

export const InvestigationSchema = z.object({ itemId: z.string(), operationId: z.string(), retryBlocked: z.boolean(), quarantined: z.number().int().nonnegative() }).strict();
export const BatchProjectionSchema = z.object({ receipt: BatchReceiptSchema, investigation: z.array(InvestigationSchema) }).strict();
export type BatchProjection = z.infer<typeof BatchProjectionSchema>;

const asObject = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function summarizeBatch(states: readonly ("unattempted" | OperationState)[]): BatchReceipt["summary"] {
  if (states.length === 0) throw new BatchReceiptError("invalid_input", "A batch needs at least one item.");
  const has = (...wanted: string[]): boolean => states.some(state => wanted.includes(state));
  if (states.every(state => state === "unattempted")) return "unattempted";
  if (states.every(state => state === "succeeded")) return "succeeded";
  if (has("succeeded")) return "partial";
  if (has("uncertain")) return "uncertain";
  if (has("dispatching", "pending", "confirmed")) return "pending";
  if (states.every(state => state === "cancelled")) return "cancelled";
  return "failed";
}

function checkItem(index: BatchIndex, item: BatchIndex["items"][number], stored: StoredOperation | null): void {
  if (!stored) return;
  const { journal } = stored;
  const mismatch = (message: string): never => { throw new BatchReceiptError("link_mismatch", `${message} (${item.operationId})`); };
  if (journal.operationId !== item.operationId) mismatch("Journal identity differs from the batch link.");
  if ("kind" in journal.snapshot) mismatch("A legacy operation cannot be a batch item.");
  const links = journal.links;
  if (links?.compensatesOperationId !== undefined || links?.replacesOperationId !== undefined) mismatch("Compensation and replacement operations are not batch items.");
  if (links?.batchId !== index.batchId || links.itemId !== item.itemId) mismatch("Journal links do not match the batch index.");
  if (!("kind" in journal.snapshot) && journal.snapshot.connectionId !== index.connectionId) mismatch("Journal belongs to a different connection.");
}

export class BatchReceiptStore {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly context: Context = BACKGROUND_CONTEXT) {}

  async register(raw: BatchRegistration): Promise<BatchIndex> {
    const parsed = BatchIndexSchema.safeParse({ format: "desk-batch-index/1", ...raw });
    if (!parsed.success) throw new BatchReceiptError("invalid_input", raw.items.length === 0 ? "A batch needs at least one item." : "The batch registration is malformed.");
    const index = parsed.data;
    if (new Set(index.items.map(item => item.itemId)).size !== index.items.length) throw new BatchReceiptError("link_conflict", "Item identities must be unique within a batch.");
    if (new Set(index.items.map(item => item.operationId)).size !== index.items.length) throw new BatchReceiptError("link_conflict", "Operation identities must be unique within a batch.");
    return this.engine.commit(async tx => {
      const batchDoc = await tx.doc(BatchDoc, index.batchId, index.batchId);
      if (batchDoc.record) {
        const prior = BatchIndexSchema.parse(batchDoc.record);
        if (!same(prior, index)) throw new BatchReceiptError("link_conflict", "The batch is already registered with different links.");
        return prior;
      }
      for (const item of index.items) {
        const link = await tx.doc(LinkDoc, item.operationId, item.operationId);
        if (link.record) throw new BatchReceiptError("link_conflict", `Operation ${item.operationId} already belongs to a batch.`);
        const journal = await tx.doc(StoreDoc, item.operationId, item.operationId);
        checkItem(index, item, journal.record ? StoredSchema.parse(journal.record) : null);
        link.record = asObject({ batchId: index.batchId, itemId: item.itemId });
      }
      batchDoc.record = asObject(index);
      return index;
    }, this.context);
  }

  async index(batchId: string): Promise<BatchIndex | null> {
    const doc = await this.engine.snapshot(BatchDoc, batchId, this.context);
    return doc?.record ? BatchIndexSchema.parse(doc.record) : null;
  }

  async itemScopes(batchId: string): Promise<ReadScope[]> {
    const index = await this.index(batchId);
    if (!index) return [];
    const scopes: ReadScope[] = [];
    for (const item of index.items) {
      const doc = await this.engine.snapshot(StoreDoc, item.operationId, this.context);
      const stored = doc?.record ? StoredSchema.parse(doc.record) : null;
      checkItem(index, item, stored);
      if (stored && !("kind" in stored.journal.snapshot)) scopes.push({ capabilityId: stored.journal.snapshot.capabilityId, destinations: stored.journal.snapshot.destinations });
    }
    return scopes;
  }

  async derive(batchId: string): Promise<BatchProjection> {
    return this.engine.commit(async tx => {
      const batchDoc = await tx.doc(BatchDoc, batchId, batchId);
      if (!batchDoc.record) throw new BatchReceiptError("batch_unknown", "The batch does not exist.");
      const index = BatchIndexSchema.parse(batchDoc.record);
      const items: BatchReceipt["items"] = [];
      const investigation: BatchProjection["investigation"] = [];
      for (const item of index.items) {
        const doc = await tx.doc(StoreDoc, item.operationId, item.operationId);
        const stored = doc.record ? StoredSchema.parse(doc.record) : null;
        checkItem(index, item, stored);
        items.push({ itemId: item.itemId, operationId: item.operationId, state: stored ? stored.journal.state : "unattempted" });
        const status = stored ? receiptStatus(stored) : null;
        if (status?.investigation) investigation.push({ itemId: item.itemId, operationId: item.operationId, retryBlocked: status.retryBlocked, quarantined: status.quarantined });
      }
      const receipt = parseWire(BatchReceiptSchema, { lifecycleVersion: "1.0.0", batchId: index.batchId, atomic: false, items, summary: summarizeBatch(items.map(item => item.state)) });
      return { receipt, investigation };
    }, this.context);
  }
}

export interface BatchReadAuthority {
  projectHostData(context: HostContext, connectionId: string, sink: ReleaseSink, derive: () => Promise<Json>, scopes: ReadScope[]): Promise<ReleaseProjection<Json>>;
}
export type BatchReadOutcome =
  | { kind: "released"; projection: BatchProjection; decisionRef: string }
  | { kind: "withheld"; reason: BoundaryError; recovery: Denial["recovery"] };

const NOT_FOUND: BatchReadOutcome = { kind: "withheld", reason: { code: "not_found", message: "The requested result is unavailable." }, recovery: "reauthorize" };

export class BatchReceiptReader {
  constructor(private readonly store: BatchReceiptStore, private readonly authority: BatchReadAuthority) {}

  async read(context: HostContext, batchId: string, sink: ReleaseSink): Promise<BatchReadOutcome> {
    const index = await this.store.index(batchId);
    if (!index) return NOT_FOUND;
    const scopes = await this.store.itemScopes(batchId);
    const released = await this.authority.projectHostData(context, index.connectionId, sink, async () => asObject(await this.store.derive(batchId)), scopes);
    if (released.kind === "withheld") return { kind: "withheld", reason: released.reason, recovery: released.recovery };
    return { kind: "released", projection: parseWire(BatchProjectionSchema, released.value), decisionRef: released.decisionRef };
  }
}

export interface LegacyBatchRoute { route: "upgrade-required"; reason: BoundaryError }
export function legacyBatchProjection(): LegacyBatchRoute {
  return { route: "upgrade-required", reason: { code: "upgrade_required", message: "Batch receipts need a lifecycle-aware client; upgrade the client." } };
}
