import { z } from "zod";
import { validRange, satisfies } from "semver";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { DESK_ADAPTER_SDK_VERSION } from "../../desk-sdk/version";
import { DESK_ADAPTER_GENERATION_FORMAT, exactVersion as version, hex64, identifier } from "./package-primitives";
import { DOMAIN_ADAPTER_CONTRACT_VERSION } from "./registry";

const generation = z.object({
  format: z.literal(DESK_ADAPTER_GENERATION_FORMAT),
  generationId: identifier,
  packageId: identifier,
  packageVersion: version,
  adapterId: identifier,
  origin: identifier,
  releaseDigest: hex64,
  deskSdkRange: identifier,
  domainContractVersion: version,
  uiProtocolVersion: version.optional(),
  selectedAt: z.iso.datetime(),
}).strict();
export { DESK_ADAPTER_GENERATION_FORMAT } from "./package-primitives";
export const DESK_ADAPTER_GENERATION_RECORD_FORMAT = "desk-adapter-generation-record/1";
export const DESK_UI_PROTOCOL_VERSION = "1.0.0";
export const DeskAdapterGenerationSchema = generation;
export type DeskAdapterGeneration = z.infer<typeof generation>;
export const DeskAdapterGenerationRecordSchema = z.object({
  format: z.literal(DESK_ADAPTER_GENERATION_RECORD_FORMAT),
  adapterId: identifier,
  revision: z.number().int().nonnegative(),
  active: generation.nullable(),
  lastValid: generation.nullable(),
  disabled: z.boolean(),
  uninstalled: z.boolean(),
  history: z.array(generation),
}).strict();
export type DeskAdapterGenerationRecord = z.infer<typeof DeskAdapterGenerationRecordSchema>;
export type DeskGenerationFence = "disabled" | "uninstalled";
export const FENCE_MESSAGE: Record<"adapter_disabled" | "adapter_uninstalled", string> = {
  adapter_disabled: "The adapter is disabled; no new admission is granted.",
  adapter_uninstalled: "The adapter package is uninstalled; stored evidence stays protected until a managed restart removes the generation.",
};
export type DeskGenerationAdmission =
  | { state: "available"; generation: DeskAdapterGeneration }
  | { state: "unavailable"; code: "generation_missing" | "adapter_disabled" | "adapter_uninstalled"; message: string }
  | { state: "upgrade_required"; code: "upgrade_required"; message: string; activeReleaseDigest: string; requiredReleaseDigest: string };

const State = z.object({ version: z.literal(1), records: z.record(identifier, DeskAdapterGenerationRecordSchema) }).strict();
const GenerationDoc = defineDoc<{ state: JsonObject }>({
  kind: "cortex.desk-adapter-generations",
  version: 1,
  scope: "session",
  initial: () => ({ state: { version: 1, records: {} } }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
const HISTORY_LIMIT = 50;

export class DeskGenerationConflict extends Error {}

export function generationId(generation: Pick<DeskAdapterGeneration, "packageId" | "packageVersion" | "releaseDigest">): string {
  return `${generation.packageId}@${generation.packageVersion}+${generation.releaseDigest.slice(0, 16)}`;
}

export class DeskGenerationFencedError extends Error {
  constructor(readonly code: "adapter_disabled" | "adapter_uninstalled") {
    super(code);
  }
}

export class DeskGenerationStore {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly context: Context = BACKGROUND_CONTEXT) {}

  private async state(): Promise<z.infer<typeof State>> {
    const doc = await this.engine.snapshot(GenerationDoc, this.context);
    return State.parse(doc?.state ?? { version: 1, records: {} });
  }

  async read(adapterId: string): Promise<DeskAdapterGenerationRecord | null> {
    return (await this.state()).records[adapterId] ?? null;
  }

  async all(): Promise<DeskAdapterGenerationRecord[]> {
    return Object.values((await this.state()).records).sort((left, right) => left.adapterId.localeCompare(right.adapterId));
  }

  private async mutate(adapterId: string, change: (record: DeskAdapterGenerationRecord) => void): Promise<DeskAdapterGenerationRecord> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(GenerationDoc);
      const state = State.parse(doc.state);
      const prior = state.records[adapterId];
      const record = prior ?? { format: DESK_ADAPTER_GENERATION_RECORD_FORMAT, adapterId, revision: 0, active: null, lastValid: null, disabled: false, uninstalled: false, history: [] };
      const next = structuredClone(record);
      change(next);
      const checked = DeskAdapterGenerationRecordSchema.parse({ ...next, revision: next.revision + 1, history: next.history.slice(-HISTORY_LIMIT) });
      state.records[adapterId] = checked;
      doc.state = JSON.parse(JSON.stringify(state)) as JsonObject;
      return structuredClone(checked);
    }, this.context);
  }

  select(selected: DeskAdapterGeneration, options: { refuseFenced?: boolean } = {}): Promise<DeskAdapterGenerationRecord> {
    const checked = DeskAdapterGenerationSchema.parse(selected);
    return this.mutate(checked.adapterId, record => {
      if (options.refuseFenced && record.uninstalled) throw new DeskGenerationFencedError("adapter_uninstalled");
      if (options.refuseFenced && record.disabled) throw new DeskGenerationFencedError("adapter_disabled");
      record.disabled = false;
      record.uninstalled = false;
      if (record.active?.generationId === checked.generationId) return;
      record.lastValid = record.active ?? record.lastValid;
      record.active = checked;
      if (!record.history.some(entry => entry.generationId === checked.generationId)) record.history.push(checked);
    });
  }

  fence(adapterId: string, mode: DeskGenerationFence): Promise<DeskAdapterGenerationRecord> {
    return this.mutate(adapterId, record => {
      if (mode === "disabled") record.disabled = true;
      else record.uninstalled = true;
    });
  }

  async admit(adapterId: string, required: { releaseDigest: string }): Promise<DeskGenerationAdmission> {
    const record = await this.read(adapterId);
    if (record?.uninstalled) return { state: "unavailable", code: "adapter_uninstalled", message: FENCE_MESSAGE.adapter_uninstalled };
    if (record?.disabled) return { state: "unavailable", code: "adapter_disabled", message: FENCE_MESSAGE.adapter_disabled };
    const active = record?.active;
    if (!active) return { state: "unavailable", code: "generation_missing", message: "No validated generation is active for this adapter." };
    if (active.releaseDigest !== required.releaseDigest) {
      return {
        state: "upgrade_required",
        code: "upgrade_required",
        message: "Stored data belongs to a different generation; it is preserved raw and needs the matching package generation.",
        activeReleaseDigest: active.releaseDigest,
        requiredReleaseDigest: required.releaseDigest,
      };
    }
    const compatible = validRange(active.deskSdkRange) !== null && satisfies(DESK_ADAPTER_SDK_VERSION, active.deskSdkRange) && active.domainContractVersion === DOMAIN_ADAPTER_CONTRACT_VERSION && (active.uiProtocolVersion === undefined || active.uiProtocolVersion === DESK_UI_PROTOCOL_VERSION);
    if (!compatible) {
      return {
        state: "upgrade_required",
        code: "upgrade_required",
        message: "The stored generation was validated against a different SDK, domain contract or UI protocol version.",
        activeReleaseDigest: active.releaseDigest,
        requiredReleaseDigest: active.releaseDigest,
      };
    }
    return { state: "available", generation: structuredClone(active) };
  }
}
