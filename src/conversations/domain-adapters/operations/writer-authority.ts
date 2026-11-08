import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { z } from "zod";
import { AuthorityPublication } from "../../authority-publication";
import type { WriterLease } from "../../authority";
import { canonicalWire } from "./validation";
import type { ApprovedSnapshot } from "./types";

const text = z.string().min(1);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WriterBindingSchema = z.object({ stack: text, owner: text, adapterId: text, connectionId: text, capabilityId: text }).strict();
export type WriterBinding = z.infer<typeof WriterBindingSchema>;
export const WriterImplementationSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ManagedEntrySchema = z.object({ kind: z.enum(["launchd", "systemd", "unmanaged"]), label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/), definition: text, pids: z.array(z.number().int().positive()), connectionQualified: z.boolean() }).strict();
export const ImportSourceSchema = z.object({ operationId: text, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const WriterPlanSchema = z.object({ cutoverId: text, binding: WriterBindingSchema, implementation: WriterImplementationSchema, entries: z.array(ManagedEntrySchema).min(1), inventoryRef: text, knownCalls: z.array(text), sources: z.array(ImportSourceSchema) }).strict();
export type WriterPlan = z.infer<typeof WriterPlanSchema>;
export const CommandEvidenceSchema = z.object({ argv: z.array(text).min(1), exitCode: z.literal(0), stdout: z.string() }).strict();
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;
export const SupervisorReceiptSchema = z.object({ receiptRef: text, inventoryRef: text, stoppedLabels: z.array(text), commands: z.array(CommandEvidenceSchema).min(1), remainingPids: z.array(z.number().int().positive()).length(0), remainingJobs: z.array(text).length(0) }).strict();
export type SupervisorReceipt = z.infer<typeof SupervisorReceiptSchema>;
export const ImportWatermarkSchema = z.object({ version: z.literal(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sources: z.array(ImportSourceSchema) }).strict().refine(value => createHash("sha256").update(canonicalWire(value.sources)).digest("hex") === value.sourceHash);
export type ImportWatermark = z.infer<typeof ImportWatermarkSchema>;
const RecordSchema = z.object({ version: z.literal(1), revision: counter, bindingKey: text, plan: WriterPlanSchema, epoch: counter, instanceId: text, phase: z.enum(["disabled", "draining", "active", "stopped"]), stage: z.enum(["disable", "stop", "drain", "verify", "import", "acquire", "enable", "active"]), receipt: SupervisorReceiptSchema.nullable(), watermark: ImportWatermarkSchema.nullable(), failures: z.array(z.object({ stage: text, message: text }).strict()), commands: z.array(CommandEvidenceSchema), drained: z.array(text), uncertain: z.array(text), retiredDigests: z.array(text) }).strict();
export type WriterRecord = z.infer<typeof RecordSchema>;
const StateSchema = z.object({ version: z.literal(1), records: z.record(text, z.array(RecordSchema)), ownerFences: z.array(text) }).strict();
const WriterDoc = defineDoc<{ state: JsonObject }>({ kind: "cortex.writer-authority", version: 1, scope: "session", initial: () => ({ state: { version: 1, records: {}, ownerFences: [] } }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });
export interface WriterCutoverSteps {
  disable(record: WriterRecord): Promise<CommandEvidence[]>;
  stop(record: WriterRecord): Promise<CommandEvidence[]>;
  drain(record: WriterRecord): Promise<{ drained: string[]; uncertain: string[] }>;
  verify(record: WriterRecord): Promise<SupervisorReceipt>;
  import(record: WriterRecord): Promise<ImportWatermark>;
  watermark(record: WriterRecord): Promise<ImportWatermark>;
  prepare(record: WriterRecord): Promise<void>;
  enable(record: WriterRecord): Promise<CommandEvidence[]>;
}
export const writerBindingKey = (binding: WriterBinding): string => canonicalWire(WriterBindingSchema.parse(binding));
const ownerKey = (binding: WriterBinding): string => canonicalWire([binding.stack, binding.owner]);
export function compareWriterVersions(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) { const difference = (left[index] ?? 0) - (right[index] ?? 0); if (difference) return Math.sign(difference); }
  return 0;
}
export const writerLease = (record: WriterRecord): WriterLease => ({ bindingKey: record.bindingKey, epoch: record.epoch, instanceId: record.instanceId, supervisorReceiptRef: record.receipt?.receiptRef ?? "unverified" });
export class WriterConflict extends Error {}
const requireWriter = (condition: boolean, reason: string): void => { if (!condition) throw new WriterConflict(reason); };
const receiptCoversInventory = (receipt: z.infer<typeof SupervisorReceiptSchema>, record: WriterRecord): boolean => receipt.inventoryRef === record.plan.inventoryRef && canonicalWire([...receipt.stoppedLabels].sort()) === canonicalWire(record.plan.entries.map(item => item.label).sort());

export class WriterAuthority {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly publication: AuthorityPublication, private readonly context: Context = BACKGROUND_CONTEXT) {}

  async inspect(): Promise<z.infer<typeof StateSchema>> {
    const doc = await this.engine.snapshot(WriterDoc, this.context);
    return StateSchema.parse(doc?.state ?? { version: 1, records: {}, ownerFences: [] });
  }

  async read(bindingKey: string): Promise<WriterRecord | null> { return (await this.inspect()).records[bindingKey]?.at(-1) ?? null; }

  private async save(record: WriterRecord, expected: number, fenceOwner = false): Promise<WriterRecord> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(WriterDoc);
      const state = StateSchema.parse(doc.state);
      const history = state.records[record.bindingKey] ?? [];
      requireWriter((history.at(-1)?.revision ?? 0) === expected, "Writer revision changed; stale cutover or lease.");
      const next = RecordSchema.parse({ ...record, revision: expected + 1 });
      state.records[record.bindingKey] = [...history, next];
      if (fenceOwner && !state.ownerFences.includes(ownerKey(record.plan.binding))) state.ownerFences.push(ownerKey(record.plan.binding));
      doc.state = JSON.parse(JSON.stringify(state)) as JsonObject;
      return next;
    }, this.context);
  }

  async begin(raw: WriterPlan, expectedRevision: number): Promise<WriterRecord> {
    const plan = WriterPlanSchema.parse(raw);
    requireWriter(new Set(plan.entries.map(item => item.label)).size === plan.entries.length && new Set(plan.knownCalls).size === plan.knownCalls.length && new Set(plan.sources.map(item => item.operationId)).size === plan.sources.length, "Inventory, calls and import sources must be unique.");
    return this.publication.publish(async () => {
      const bindingKey = writerBindingKey(plan.binding);
      const prior = await this.read(bindingKey);
      if (prior?.plan.cutoverId === plan.cutoverId) { requireWriter(canonicalWire(prior.plan) === canonicalWire(plan), "Cutover identity changed."); return prior; }
      requireWriter((prior?.revision ?? 0) === expectedRevision, "Writer revision changed.");
      if (prior) requireWriter(compareWriterVersions(plan.implementation.version, prior.plan.implementation.version) >= 0 && !prior.retiredDigests.includes(plan.implementation.sha256), "Mutation downgrade requires explicit reconciliation; implementation floor cannot be lowered.");
      const record: WriterRecord = { version: 1, revision: expectedRevision, bindingKey, plan, epoch: prior?.epoch ?? 0, instanceId: randomUUID(), phase: "disabled", stage: "disable", receipt: null, watermark: null, failures: [], commands: [], drained: [], uncertain: [], retiredDigests: [...new Set([...(prior?.retiredDigests ?? []), ...(prior && prior.plan.implementation.sha256 !== plan.implementation.sha256 ? [prior.plan.implementation.sha256] : [])])] };
      return this.save(record, expectedRevision, plan.entries.some(entry => !entry.connectionQualified));
    });
  }

  resume(bindingKey: string, steps: WriterCutoverSteps): Promise<WriterRecord> {
    return this.publication.publish(() => this.resumeExclusive(bindingKey, steps));
  }

  private async resumeExclusive(bindingKey: string, steps: WriterCutoverSteps): Promise<WriterRecord> {
    const stored = await this.read(bindingKey);
    if (!stored) throw new WriterConflict("Unknown writer; inventory and explicit cutover are required.");
    let record: WriterRecord = stored;
    while (record.stage !== "active") {
      const next: WriterRecord = structuredClone(record);
      const checkedCommands = (commands: CommandEvidence[]): CommandEvidence[] => z.array(CommandEvidenceSchema).min(1).parse(commands);
      try {
      switch (record.stage) {
        case "disable": next.commands.push(...checkedCommands(await steps.disable(record))); next.stage = "stop"; break;
        case "stop":
          requireWriter(!record.plan.entries.some(entry => entry.kind === "unmanaged"), "Unmanaged writer cannot be fenced. Stop it and reconcile its process/startup inventory explicitly before activating this binding.");
          next.commands.push(...checkedCommands(await steps.stop(record))); next.phase = "draining"; next.stage = "drain"; break;
        case "drain": {
          const result = await steps.drain(record);
          const accounted = [...result.drained, ...result.uncertain];
          requireWriter(new Set(accounted).size === accounted.length && canonicalWire([...accounted].sort()) === canonicalWire([...record.plan.knownCalls].sort()), "Every known call must drain or be durably imported uncertain.");
          requireWriter(result.uncertain.every(id => record.plan.sources.some(source => source.operationId === id)), "Uncertain calls must be present in the durable source-hashed import inventory.");
          next.drained = result.drained; next.uncertain = result.uncertain; next.stage = "verify"; break;
        }
        case "verify": {
          const receipt = SupervisorReceiptSchema.parse(await steps.verify(record));
          requireWriter(receiptCoversInventory(receipt, record), "Supervisor evidence does not cover the complete retired inventory.");
          next.receipt = receipt; next.phase = "stopped"; next.stage = "import"; break;
        }
        case "import": {
          const imported = ImportWatermarkSchema.parse(await steps.import(record));
          const watermark = ImportWatermarkSchema.parse(await steps.watermark(record));
          requireWriter(canonicalWire(imported) === canonicalWire(watermark) && canonicalWire(watermark.sources) === canonicalWire(record.plan.sources), "Importer watermark missing, changed or incomplete.");
          next.watermark = watermark; next.stage = "acquire"; break;
        }
        case "acquire":
          requireWriter(record.epoch < Number.MAX_SAFE_INTEGER, "Writer epoch exhausted.");
          next.epoch++; next.phase = "disabled"; next.stage = "enable"; break;
        case "enable": {
          const receipt = SupervisorReceiptSchema.parse(await steps.verify(record));
          requireWriter(receiptCoversInventory(receipt, record), "Retired supervisor evidence changed.");
          requireWriter(canonicalWire(ImportWatermarkSchema.parse(await steps.watermark(record))) === canonicalWire(record.watermark), "Durable importer watermark changed before activation.");
          await steps.prepare(record);
          next.commands.push(...checkedCommands(await steps.enable(record)));
          next.phase = "active"; next.stage = "active"; break;
        }
      }
      } catch (error) {
        next.failures.push({ stage: record.stage, message: error instanceof Error ? error.message : "Unknown cutover failure; activation remains disabled." });
        await this.save(next, next.revision);
        throw error;
      }
      record = await this.publication.publish(() => this.save(next, next.revision));
    }
    return record;
  }

  async current(lease: WriterLease, binding: WriterBinding): Promise<boolean> {
    const key = writerBindingKey(binding);
    const record = await this.read(key);
    return lease.bindingKey === key && record?.phase === "active" && canonicalWire(writerLease(record)) === canonicalWire(lease);
  }

  async admits(lease: WriterLease, stack: string, owner: string, snapshot: ApprovedSnapshot): Promise<boolean> {
    return this.current(lease, { stack, owner, adapterId: snapshot.adapterId, connectionId: snapshot.connectionId, capabilityId: snapshot.capabilityId });
  }

  async legacyOwnerAllowed(stack: string, owner: string): Promise<boolean> {
    const state = await this.inspect();
    return !Object.values(state.records).some(history => { const record = history.at(-1); return record?.plan.binding.stack === stack && record.plan.binding.owner === owner; });
  }

  async legacyAllowed(binding: WriterBinding, connectionQualified: boolean): Promise<boolean> {
    const state = await this.inspect();
    if (state.ownerFences.includes(ownerKey(binding))) return false;
    const heads = Object.values(state.records).flatMap(history => history.at(-1) ?? []);
    return !heads.some(record => record.plan.binding.stack === binding.stack && record.plan.binding.owner === binding.owner && (!connectionQualified || record.bindingKey === writerBindingKey(binding)));
  }
}
