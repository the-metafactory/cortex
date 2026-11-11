import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { canonicalSchema } from "./schema-validation";
import type { DomainAdapterRegistry, DraftingView } from "./registry";
import type { DraftingBinding, DraftingBindings } from "./drafting-binding";
import type { ObjectReference, SchemaRef } from "./types";
import { DestinationRefSchema, DraftConflict, DraftSchema, IndexSchema, ModelOutputSchema, type Blocking, type DraftDestinations, type DraftField, type DraftModel, type DraftPolicy, type DraftSources, type DraftView, type EditChange, type Handoff, type HandoffResult, type Lane, type Limitation, type MakeResult, type Manifest, type ModelOutput, type OutdatedReason, type RefreshResult, type SourceItem, type StoredDraft } from "./drafting-types";

export * from "./drafting-types";
export { DraftingBindings, DraftingBindingSchema, DRAFTING_BINDING_VERSION, type DraftingBinding as DraftingBindingDocument } from "./drafting-binding";

const DraftDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.desk-draft", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });
const IndexDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.desk-draft-index", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });
const DEFAULT_CONTEXT_CHARS = 12000;
const BLOCKING_OUTDATED = new Set<OutdatedReason>(["schema-changed", "source-unavailable", "policy-changed", "destination-changed"]);
const SIMPLE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const KIND_RANK: Record<SourceItem["kind"], number> = { outcome: 0, selected: 1, linked: 2, turn: 3 };

export interface DraftServiceDeps {
  registry: DomainAdapterRegistry; bindings: DraftingBindings; sources: DraftSources; policy: DraftPolicy; model: DraftModel;
  destinations?: DraftDestinations; now?: () => Date; newId?: () => string; contextChars?: number; timeZone?: string;
}
interface MakeInput { conversationId: string; entryId: string; capabilityId: string; connectionId: string; newDraft?: boolean; selectDraftId?: string; selectedSources?: readonly string[] }
interface RefreshOptions { selectedSources?: readonly string[]; only?: readonly string[]; release?: boolean }
interface Prepared { fields: Map<string, DraftField>; limitations: Limitation[] }

const pointerOf = (key: string): string => `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
const keyOf = (pointer: string): string => pointer.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
const sameRef = (left: SchemaRef, right: SchemaRef): boolean => left.schemaId === right.schemaId && left.version === right.version;
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const digestOf = (value: unknown): string => createHash("sha256").update(canonicalSchema(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const properties = (view: DraftingView): Record<string, unknown> => record(view.root.properties);
const requiredKeys = (view: DraftingView): string[] => Array.isArray(view.root.required) ? view.root.required.filter((key): key is string => typeof key === "string") : [];
const limit = (code: string, message: string): Limitation => ({ code, message });
const isDestinationEdited = (item: Limitation): boolean => item.code === "destination_changed";
const destinationEdited = (draft: StoredDraft): boolean => draft.limitations.some(isDestinationEdited);
const markDestinationEdited = (draft: StoredDraft): void => {
  if (!destinationEdited(draft)) draft.limitations.push(limit("destination_changed", "The destination needs review. Refresh explicitly before confirming; references must still be available and unambiguous."));
};
export const draftOperationId = (draft: Pick<StoredDraft, "conversationId" | "draftId" | "revision">): string => `${draft.conversationId}:${draft.draftId}:${draft.revision}`;

function representable(node: unknown): boolean {
  const schema = record(node);
  if (["oneOf", "anyOf", "allOf", "not", "if", "$ref"].some(keyword => keyword in schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.every(type => typeof type === "string" && SIMPLE_TYPES.has(type))) return false;
  return !types.includes("array") || representable(schema.items);
}

export class DraftService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;

  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly deps: DraftServiceDeps, private readonly context: Context = BACKGROUND_CONTEXT) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.timeZone = new Intl.DateTimeFormat("en", { timeZone: deps.timeZone }).resolvedOptions().timeZone;
  }

  private async load(draftId: string): Promise<StoredDraft | null> {
    const doc = await this.engine.snapshot(DraftDoc, draftId, this.context);
    return doc?.record ? DraftSchema.parse(doc.record) : null;
  }

  private async mutate(draftId: string, expected: number, change: (draft: StoredDraft) => void, bump = true): Promise<StoredDraft | null> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(DraftDoc, draftId, draftId);
      const draft = doc.record ? DraftSchema.parse(doc.record) : null;
      if (!draft) throw new DraftConflict("Draft does not exist.");
      if (draft.revision !== expected) return null;
      change(draft);
      if (bump) draft.revision++;
      draft.updatedAt = this.now().toISOString();
      doc.record = asJson(draft);
      return draft;
    }, this.context);
  }

  private async mutateOrThrow(draftId: string, expected: number, change: (draft: StoredDraft) => void): Promise<DraftView> {
    const draft = await this.mutate(draftId, expected, change);
    if (!draft) throw new DraftConflict("Draft revision changed; reload and retry.");
    return this.view(draft);
  }

  async make(input: MakeInput): Promise<MakeResult> {
    const view = this.deps.registry.draftingView(input.capabilityId);
    if (view?.kind !== "action") throw new DraftConflict("The capability is not registered for drafting.");
    const matchKey = digestOf([input.conversationId, input.entryId, input.capabilityId]);
    const outcome = await this.engine.commit(async tx => {
      const index = await tx.doc(IndexDoc, matchKey, matchKey);
      const ids = index.record ? IndexSchema.parse(index.record).draftIds : [];
      if (!input.newDraft && ids.length > 0) {
        const chosen = ids.length === 1 ? ids[0] : ids.find(id => id === input.selectDraftId);
        if (chosen) return { kind: "reopen" as const, draftId: chosen };
        return { kind: "select" as const, ids };
      }
      const draft = this.create(input, view);
      (await tx.doc(DraftDoc, draft.draftId, draft.draftId)).record = asJson(draft);
      index.record = asJson({ draftIds: [...ids, draft.draftId] });
      return { kind: "created" as const, draftId: draft.draftId };
    }, this.context);
    if (outcome.kind === "select") {
      const candidates = await Promise.all(outcome.ids.map(async id => this.load(id)));
      return { kind: "select", candidates: candidates.flatMap(draft => draft ? [{ draftId: draft.draftId, revision: draft.revision, updatedAt: draft.updatedAt }] : []) };
    }
    const stored = await this.load(outcome.draftId);
    if (!stored) throw new DraftConflict("Draft disappeared.");
    if (outcome.kind === "reopen") return { kind: "draft", view: await this.view(stored), reopened: true };
    const refreshed = await this.refresh(stored.draftId, stored.revision, input.selectedSources ? { selectedSources: input.selectedSources } : {});
    return { kind: "draft", view: refreshed.kind === "stale" ? await this.view(await this.requireDraft(stored.draftId)) : refreshed.view, reopened: false };
  }

  private create(input: MakeInput, view: DraftingView): StoredDraft {
    const at = this.now().toISOString();
    const binding = this.deps.bindings.lookup(view.adapterId, input.capabilityId, view.inputSchemaRef);
    const draft: StoredDraft = {
      format: "desk-draft/1", draftId: this.newId(), revision: 1, conversationId: input.conversationId, entryId: input.entryId, adapterId: view.adapterId, connectionId: input.connectionId, capabilityId: input.capabilityId,
      schemaRef: view.inputSchemaRef, binding: binding ? { guidanceId: binding.guidance.guidanceId, version: binding.guidance.version } : null, fields: {}, manifest: null, limitations: [], createdAt: at, updatedAt: at,
    };
    this.addDefaults(draft, view);
    return draft;
  }

  private addDefaults(draft: StoredDraft, view: DraftingView): void {
    for (const [key, node] of Object.entries(properties(view))) {
      const defaultValue = record(node).default;
      const pointer = pointerOf(key);
      if (defaultValue !== undefined && !draft.fields[pointer]) draft.fields[pointer] = { pointer, presence: "present", value: defaultValue as DraftField["value"], origin: "default", citations: [], generationId: null, alternatives: [], unresolved: null };
    }
  }

  private async requireDraft(draftId: string): Promise<StoredDraft> {
    const draft = await this.load(draftId);
    if (!draft) throw new DraftConflict("Draft does not exist.");
    return draft;
  }

  async read(draftId: string, audience?: Lane): Promise<DraftView | null> {
    const draft = await this.load(draftId);
    return draft ? this.view(draft, audience) : null;
  }

  async edit(draftId: string, expected: number, pointer: string, change: EditChange): Promise<DraftView> {
    const current = await this.requireDraft(draftId);
    const view = this.deps.registry.draftingView(current.capabilityId);
    const known = view && sameRef(view.inputSchemaRef, current.schemaRef) ? keyOf(pointer) in properties(view) : pointer in current.fields;
    if (!known || !/^\/[^/]/.test(pointer)) throw new DraftConflict("The field is not declared by the pinned schema.");
    return this.mutateOrThrow(draftId, expected, draft => {
      if (view?.relationships.some(item => item.fieldPath === pointer)) markDestinationEdited(draft);
      draft.fields[pointer] = { pointer, presence: change.kind === "set" ? "present" : change.kind === "null" ? "null" : "absent", ...(change.kind === "set" ? { value: change.value as DraftField["value"] } : change.kind === "null" ? { value: null } : {}), origin: "principal", citations: [], generationId: null, alternatives: [], unresolved: null };
    });
  }

  async editReferences(draftId: string, expected: number, pointer: string, labels: string[]): Promise<DraftView> {
    const current = await this.requireDraft(draftId);
    const view = this.deps.registry.draftingView(current.capabilityId);
    const binding = this.deps.bindings.lookup(current.adapterId, current.capabilityId, current.schemaRef);
    const relationship = view?.relationships.find(item => item.fieldPath === pointer);
    if (!view || !binding || !relationship || !sameRef(view.inputSchemaRef, current.schemaRef)) throw new DraftConflict("Reference resolution is unavailable for this field.");
    const destinations = this.destinationBatch();
    const resolved = await this.resolveReference(current, binding, relationship, labels, { pointer, generationId: null, citations: [], alternatives: [], unresolved: null }, destinations);
    if (!resolved.ok) throw new DraftConflict("Reference resolution is unavailable.");
    return this.mutateOrThrow(draftId, expected, draft => { draft.fields[pointer] = { ...resolved.field, origin: "principal" }; markDestinationEdited(draft); });
  }

  async chooseAlternative(draftId: string, expected: number, pointer: string, index: number): Promise<DraftView> {
    const current = await this.requireDraft(draftId);
    const alternative = current.fields[pointer]?.alternatives[index];
    if (!alternative) throw new DraftConflict("No such alternative.");
    return this.edit(draftId, expected, pointer, { kind: "set", value: alternative.value });
  }

  regenerateField(draftId: string, expected: number, pointer: string): Promise<RefreshResult> {
    return this.refresh(draftId, expected, { only: [pointer], release: true });
  }

  async changeDestination(draftId: string, expected: number, destination: { connectionId: string; capabilityId?: string }): Promise<DraftView> {
    const current = await this.requireDraft(draftId);
    const capabilityId = destination.capabilityId ?? current.capabilityId;
    const view = this.deps.registry.draftingView(capabilityId);
    if (view?.kind !== "action") throw new DraftConflict("The destination capability is not registered for drafting.");
    return this.mutateOrThrow(draftId, expected, draft => {
      const binding = this.deps.bindings.lookup(view.adapterId, capabilityId, view.inputSchemaRef);
      Object.assign(draft, { connectionId: destination.connectionId, capabilityId, adapterId: view.adapterId, schemaRef: view.inputSchemaRef, binding: binding ? { guidanceId: binding.guidance.guidanceId, version: binding.guidance.version } : null });
    });
  }

  async migrate(draftId: string, expected: number, review: { acknowledged: boolean }): Promise<DraftView> {
    if (!review.acknowledged) throw new DraftConflict("Schema migration requires explicit review.");
    const current = await this.requireDraft(draftId);
    const view = this.deps.registry.draftingView(current.capabilityId);
    if (!view || sameRef(view.inputSchemaRef, current.schemaRef)) throw new DraftConflict("There is no schema migration to review.");
    return this.mutateOrThrow(draftId, expected, draft => {
      const binding = this.deps.bindings.lookup(view.adapterId, draft.capabilityId, view.inputSchemaRef);
      draft.schemaRef = view.inputSchemaRef;
      draft.binding = binding ? { guidanceId: binding.guidance.guidanceId, version: binding.guidance.version } : null;
      this.addDefaults(draft, view);
    });
  }

  async refresh(draftId: string, expected: number, options: RefreshOptions = {}): Promise<RefreshResult> {
    const draft = await this.requireDraft(draftId);
    if (draft.revision !== expected) return { kind: "stale" };
    const view = this.deps.registry.draftingView(draft.capabilityId);
    const binding = draft.binding ? this.deps.bindings.lookup(draft.adapterId, draft.capabilityId, draft.schemaRef) : undefined;
    if (!view || !sameRef(view.inputSchemaRef, draft.schemaRef)) return this.noteFailure(draft, limit("schema_changed", "The pinned schema changed; review and migrate before refreshing."));
    if (!binding || binding.guidance.guidanceId !== draft.binding?.guidanceId || binding.guidance.version !== draft.binding.version) return this.noteFailure(draft, limit("automatic_drafting_unavailable", "Automatic drafting is unavailable; manual editing remains available."));
    const targets = Object.keys(properties(view)).map(pointerOf).filter(pointer => this.eligible(draft.fields[pointer], pointer, options));
    if (targets.length === 0) {
      const needsDestinationReview = destinationEdited(draft) || Boolean(draft.manifest && draft.manifest.connectionId !== draft.connectionId);
      if (!needsDestinationReview) return { kind: "kept", view: await this.view(draft) };
      const valid = await this.validDestinations(draft, view, binding);
      const reviewed = await this.mutate(draftId, expected, target => {
        this.reviewDestinations(target, valid);
      });
      return reviewed ? { kind: "kept", view: await this.view(reviewed) } : { kind: "stale" };
    }
    return this.generate(draft, view, binding, targets, options);
  }

  private reviewDestinations(draft: StoredDraft, valid: boolean): void {
    if (!valid) { markDestinationEdited(draft); return; }
    if (draft.manifest) draft.manifest.connectionId = draft.connectionId;
    draft.limitations = draft.limitations.filter(item => !isDestinationEdited(item));
  }

  private destinationBatch(): DraftDestinations | undefined {
    return this.deps.destinations?.batch?.() ?? this.deps.destinations;
  }

  private resolveWithFor(binding: DraftingBinding | undefined, pointer: string): string | undefined {
    return binding?.fieldHints.find(hint => hint.pointer === pointer)?.resolveWith;
  }

  private async stillCanonical(draft: StoredDraft, resolveWith: string | undefined, value: unknown, destinations: DraftDestinations | undefined): Promise<boolean> {
    const ref = DestinationRefSchema.safeParse(value);
    if (!resolveWith || !ref.success || !destinations) return false;
    const match = await destinations.resolve({ capabilityId: resolveWith, connectionId: draft.connectionId, conversationId: draft.conversationId, objectType: ref.data.objectType, label: ref.data.canonicalId });
    return match.kind === "unique" && canonicalSchema(match.ref) === canonicalSchema(ref.data);
  }

  private async validDestinations(draft: StoredDraft, view: DraftingView, binding: DraftingBinding, destinations = this.destinationBatch()): Promise<boolean> {
    const valid = await Promise.all(view.relationships.map(async relationship => {
      const field = draft.fields[relationship.fieldPath];
      if (field?.unresolved) return false;
      if (!field || field.presence === "absent") return true;
      if (!this.validValue(draft.capabilityId, view, relationship.fieldPath, field.value)) return false;
      if (field.presence === "null") return true;
      const resolveWith = this.resolveWithFor(binding, relationship.fieldPath);
      if (!resolveWith || !destinations) return false;
      const values = Array.isArray(field.value) ? field.value : [field.value];
      const matches = await Promise.all(values.map(async value => {
        const ref = DestinationRefSchema.safeParse(value);
        if (!ref.success || ref.data.adapterId !== relationship.targetAdapterId || ref.data.objectType !== relationship.targetObjectType || ref.data.connectionId !== draft.connectionId) return false;
        return this.stillCanonical(draft, resolveWith, ref.data, destinations);
      }));
      return matches.every(Boolean);
    }));
    return valid.every(Boolean);
  }

  private eligible(existing: DraftField | undefined, pointer: string, options: RefreshOptions): boolean {
    if (options.only && !options.only.includes(pointer)) return false;
    if (!existing || options.release && options.only) return true;
    return existing.origin === "generated" || existing.origin === "suggested";
  }

  private async noteFailure(draft: StoredDraft, ...limitations: Limitation[]): Promise<RefreshResult> {
    const noted = await this.mutate(draft.draftId, draft.revision, target => { target.limitations = [...target.limitations.filter(isDestinationEdited), ...limitations]; }, false);
    return noted ? { kind: "kept", view: await this.view(noted) } : { kind: "stale" };
  }

  private async capture(draft: StoredDraft, selected: readonly string[]): Promise<{ items: SourceItem[]; omissions: Manifest["omissions"]; truncated: boolean; boundary: Manifest["boundary"] }> {
    const captured = await this.deps.sources.capture({ conversationId: draft.conversationId, entryId: draft.entryId, selected });
    const omissions: Manifest["omissions"] = Array.from({ length: captured.unavailable }, () => ({ reason: "unavailable" as const }));
    const permitted: SourceItem[] = [];
    const readable = await Promise.all(captured.items.map(item => this.deps.policy.readable(item.id)));
    captured.items.forEach((item, index) => {
      if (readable[index]) permitted.push(item);
      else omissions.push({ reason: "not-permitted" });
    });
    const rank = (item: SourceItem): number => item.id === draft.entryId ? -1 : KIND_RANK[item.kind];
    permitted.sort((left, right) => rank(left) - rank(right) || right.at.localeCompare(left.at));
    const items: SourceItem[] = [];
    let used = 0;
    const budget = this.deps.contextChars ?? DEFAULT_CONTEXT_CHARS;
    for (const item of permitted) {
      if (items.length > 0 && used + item.text.length > budget) omissions.push({ reason: "context-limit", id: item.id });
      else { items.push(item); used += item.text.length; }
    }
    return { items, omissions, truncated: omissions.some(omission => omission.reason === "context-limit"), boundary: captured.boundary };
  }

  private async generate(draft: StoredDraft, view: DraftingView, binding: DraftingBinding, targets: string[], options: RefreshOptions): Promise<RefreshResult> {
    const policyRevision = await this.deps.policy.revision();
    const context = await this.capture(draft, options.selectedSources ?? []);
    if (context.items.length === 0) return this.noteFailure(draft, limit("no_permitted_context", "No permitted conversation context is available for drafting."));
    const ids = context.items.map(item => item.id);
    const needsLocal = context.items.some(item => item.restriction === "local");
    const available = await this.deps.model.lanes();
    const lane = (needsLocal ? ["local" as const] : ["local" as const, "cloud" as const]).find(candidate => available.includes(candidate));
    if (!lane) return this.noteFailure(draft, limit("model_unavailable", "No permitted model is available; the manual draft is unchanged."));
    if (!await this.deps.policy.releasable(ids, lane)) return this.noteFailure(draft, limit("release_denied", "Policy does not permit these sources to reach the model."));
    const raw = await this.callModel(binding, view, lane, context.items, targets);
    if (!raw.ok) return this.noteFailure(draft, raw.limitation);
    const released = await this.deps.policy.revision() === policyRevision && await this.deps.policy.releasable(ids, lane) && (await Promise.all(ids.map(id => this.deps.policy.readable(id)))).every(Boolean);
    if (!released) return this.noteFailure(draft, limit("release_denied", "Policy changed; the generated output was not released."));
    const generationId = this.newId();
    const manifest: Manifest = {
      generationId, capturedAt: this.now().toISOString(), boundary: context.boundary, policyRevision, lane, modelId: raw.modelId, connectionId: draft.connectionId, schemaRef: draft.schemaRef,
      guidance: { guidanceId: binding.guidance.guidanceId, version: binding.guidance.version },
      timeZone: raw.timeZone,
      items: context.items.map(item => ({ id: item.id, kind: item.kind, revision: item.revision, digest: item.digest, restriction: item.restriction, at: item.at })), omissions: context.omissions, truncated: context.truncated,
    };
    const destinations = this.destinationBatch();
    const prepared = await this.prepare(draft, view, binding, raw.output, manifest, targets, destinations);
    const fields = Object.fromEntries(Object.entries(draft.fields).filter(([pointer]) => !prepared.fields.has(pointer)));
    const valid = await this.validDestinations({ ...draft, fields }, view, binding, destinations);
    const applied = await this.mutate(draft.draftId, draft.revision, target => {
      for (const [pointer, field] of prepared.fields) target.fields[pointer] = field;
      const refreshed = new Set(prepared.fields.keys());
      const kept = new Set(Object.values(target.fields).filter(field => !refreshed.has(field.pointer)).flatMap(field => [...field.citations, ...field.alternatives.flatMap(alternative => alternative.citations)]));
      const fresh = new Set(manifest.items.map(item => item.id));
      const carried = (target.manifest?.items ?? []).filter(item => kept.has(item.id) && !fresh.has(item.id));
      target.manifest = { ...manifest, items: [...manifest.items, ...carried] };
      target.limitations = [...prepared.limitations, ...(manifest.truncated ? [limit("context_truncated", "Context was truncated; omitted sources are listed in the manifest.")] : [])];
      this.reviewDestinations(target, valid);
    });
    return applied ? { kind: "applied", view: await this.view(applied) } : { kind: "stale" };
  }

  private async callModel(binding: DraftingBinding, view: DraftingView, lane: Lane, items: SourceItem[], targets: string[]): Promise<{ ok: true; modelId: string; output: ModelOutput; timeZone: string } | { ok: false; limitation: Limitation }> {
    let result: Awaited<ReturnType<DraftModel["generate"]>>;
    const timeZone = this.timeZone;
    try {
      result = await this.deps.model.generate({
        lane, timeZone, guidance: binding.guidance, schemaRef: view.inputSchemaRef, schema: view.root, targets,
        fieldHints: binding.fieldHints.map(hint => ({ pointer: hint.pointer, role: hint.role, ...(hint.widget ? { widget: hint.widget } : {}) })),
        sources: items.map(item => ({ id: item.id, kind: item.kind, text: item.text, at: item.at })),
      });
    } catch (_err) { return { ok: false, limitation: limit("model_failed", "The model did not complete; the manual draft is unchanged.") }; }
    const parsed = ModelOutputSchema.safeParse(result.output);
    return parsed.success ? { ok: true, modelId: result.modelId, output: parsed.data, timeZone } : { ok: false, limitation: limit("invalid_output", "The model returned output that does not match the drafting contract.") };
  }

  private validValue(capabilityId: string, view: DraftingView, pointer: string, value: unknown): boolean {
    const checked = this.deps.registry.validateInput({ capabilityId, inputSchemaRef: view.inputSchemaRef, input: { [keyOf(pointer)]: value } }, null);
    if (checked.ok) return true;
    return !(checked.error.issues ?? []).some(issue => issue.path === pointer || issue.path.startsWith(`${pointer}/`));
  }

  private async prepare(draft: StoredDraft, view: DraftingView, binding: DraftingBinding, output: ModelOutput, manifest: Manifest, targets: string[], destinations: DraftDestinations | undefined): Promise<Prepared> {
    const cited = new Set(manifest.items.map(item => item.id));
    const result: Prepared = { fields: new Map(), limitations: [] };
    for (const candidate of output.fields) {
      if (!targets.includes(candidate.pointer)) { result.limitations.push(limit("ignored_field", "A generated field was not a draftable target and was ignored.")); continue; }
      const field = await this.candidateField(draft, view, binding, candidate, manifest.generationId, cited, destinations);
      if (field.ok) { result.fields.set(candidate.pointer, field.field); continue; }
      result.limitations.push(limit(field.code, `A generated value for ${candidate.pointer} was not usable.`));
      if (!draft.fields[candidate.pointer]) result.fields.set(candidate.pointer, { pointer: candidate.pointer, presence: "absent", origin: "suggested", citations: [], generationId: manifest.generationId, alternatives: [], unresolved: field.code });
    }
    return result;
  }

  private async candidateField(draft: StoredDraft, view: DraftingView, binding: DraftingBinding, candidate: ModelOutput["fields"][number], generationId: string, cited: Set<string>, destinations: DraftDestinations | undefined): Promise<{ ok: true; field: DraftField } | { ok: false; code: string }> {
    const { pointer } = candidate;
    const citations = candidate.citations.filter(id => cited.has(id));
    if (citations.length === 0) return { ok: false, code: "unsupported_citation" };
    const base = { pointer, generationId, citations, alternatives: [] as DraftField["alternatives"], unresolved: null as string | null };
    const relationship = view.relationships.find(item => item.fieldPath === pointer);
    if (relationship) return this.resolveReference(draft, binding, relationship, candidate.labels ?? [], base, destinations);
    const alternatives = (candidate.alternatives ?? []).filter(item => this.validValue(draft.capabilityId, view, pointer, item.value)).map(item => ({ value: item.value, citations: item.citations.filter(id => cited.has(id)) })).filter(item => item.citations.length > 0);
    if (alternatives.length >= 2) return { ok: true, field: { ...base, presence: "absent", origin: "suggested", alternatives, unresolved: "conflict" } };
    if (candidate.value === undefined || !this.validValue(draft.capabilityId, view, pointer, candidate.value)) return { ok: false, code: "invalid_candidate" };
    const node = record(view.field(pointer));
    const structured = node.type !== "string" || node.format !== undefined || node.enum !== undefined;
    return { ok: true, field: { ...base, presence: candidate.value === null ? "null" : "present", value: candidate.value, origin: structured ? "suggested" : "generated" } };
  }

  private async resolveReference(draft: StoredDraft, binding: DraftingBinding, relationship: DraftingView["relationships"][number], labels: string[], base: Omit<DraftField, "presence" | "origin">, destinations: DraftDestinations | undefined): Promise<{ ok: true; field: DraftField } | { ok: false; code: string }> {
    const resolveWith = this.resolveWithFor(binding, relationship.fieldPath);
    const unresolved = (reason: string, alternatives: DraftField["alternatives"] = []): { ok: true; field: DraftField } => ({ ok: true, field: { ...base, presence: "absent", origin: "suggested", alternatives, unresolved: reason } });
    if (labels.length === 0 || !resolveWith || !destinations) return unresolved("unresolved_reference");
    const matches = await Promise.all(labels.map(label => destinations.resolve({ capabilityId: resolveWith, connectionId: draft.connectionId, label, conversationId: draft.conversationId, objectType: relationship.targetObjectType })));
    const refs: ObjectReference[] = [];
    for (const match of matches) {
      if (match.kind === "multiple") return unresolved("ambiguous_reference", match.refs.slice(0, 10).map(ref => ({ value: ref, citations: base.citations })));
      if (match.kind !== "unique") return unresolved(match.kind === "none" ? "missing_reference" : "unresolved_reference");
      if (match.ref.adapterId !== relationship.targetAdapterId || match.ref.objectType !== relationship.targetObjectType || match.ref.connectionId !== draft.connectionId) return unresolved("wrong_target");
      refs.push(match.ref);
    }
    const unique = [...new Map(refs.map(ref => [canonicalSchema(ref), ref])).values()];
    if (relationship.cardinality === "one" && unique.length > 1) return unresolved("ambiguous_reference", unique.map(ref => ({ value: ref, citations: base.citations })));
    const value = relationship.cardinality === "one" ? unique[0] : unique;
    return value === undefined ? unresolved("unresolved_reference") : { ok: true, field: { ...base, presence: "present", value, origin: "suggested" } };
  }

  private async outdated(draft: StoredDraft, view: DraftingView | undefined): Promise<OutdatedReason[]> {
    const reasons: OutdatedReason[] = [];
    const manifest = draft.manifest;
    if (!view || !sameRef(view.inputSchemaRef, draft.schemaRef) || manifest && !sameRef(manifest.schemaRef, draft.schemaRef)) reasons.push("schema-changed");
    if (destinationEdited(draft) || manifest && manifest.connectionId !== draft.connectionId) reasons.push("destination-changed");
    if (!manifest) return reasons;
    if (await this.deps.sources.head(draft.conversationId) !== manifest.boundary.revision) reasons.push("conversation-changed");
    if (await this.deps.policy.revision() !== manifest.policyRevision) reasons.push("policy-changed");
    if (!(await Promise.all(manifest.items.map(item => this.deps.policy.readable(item.id)))).every(Boolean)) reasons.push("source-unavailable");
    return reasons;
  }

  private blocking(draft: StoredDraft, view: DraftingView | undefined): { blocking: Blocking[]; unsupported: string[] } {
    if (!view || !sameRef(view.inputSchemaRef, draft.schemaRef)) return { blocking: [{ pointer: "", code: "schema_unavailable" }], unsupported: [] };
    const declared = properties(view);
    const blocking: Blocking[] = [];
    const input: Record<string, unknown> = {};
    const unsupported: string[] = [];
    for (const field of Object.values(draft.fields)) {
      const key = keyOf(field.pointer);
      if (!(key in declared)) { unsupported.push(field.pointer); continue; }
      if (field.unresolved) blocking.push({ pointer: field.pointer, code: "unresolved" });
      else if (field.presence !== "absent") input[key] = field.value;
    }
    for (const key of requiredKeys(view)) {
      if (!representable(declared[key])) blocking.push({ pointer: pointerOf(key), code: "unsupported_editor" });
      else if (!(key in input) && !blocking.some(item => item.pointer === pointerOf(key))) blocking.push({ pointer: pointerOf(key), code: "required_missing" });
    }
    const checked = this.deps.registry.validateInput({ capabilityId: draft.capabilityId, inputSchemaRef: view.inputSchemaRef, input }, null);
    if (!checked.ok) for (const issue of checked.error.issues ?? []) {
      const pointer = `/${issue.path.split("/")[1] ?? ""}`;
      if (issue.code !== "required" && issue.path !== "" && !blocking.some(item => item.pointer === pointer)) blocking.push({ pointer, code: "invalid_value" });
    }
    return { blocking, unsupported };
  }

  private async view(draft: StoredDraft, audience?: Lane): Promise<DraftView> {
    const registryView = this.deps.registry.draftingView(draft.capabilityId);
    const { blocking, unsupported } = this.blocking(draft, registryView);
    const outdated = await this.outdated(draft, registryView);
    const hidden = audience && draft.manifest && !await this.deps.policy.releasable(draft.manifest.items.map(item => item.id), audience);
    const shown: StoredDraft = structuredClone(draft);
    const withheld: string[] = [];
    if (hidden && shown.manifest) {
      const derived = (field: DraftField): boolean => field.origin === "generated" || field.origin === "suggested";
      withheld.push(...Object.values(shown.fields).filter(derived).map(field => field.pointer));
      shown.fields = Object.fromEntries(Object.entries(shown.fields).filter(([, field]) => !derived(field)));
      shown.manifest = { ...shown.manifest, items: [], omissions: shown.manifest.omissions.map(omission => ({ reason: omission.reason })) };
    }
    const automatic: DraftView["automaticDrafting"] = !draft.binding ? { available: false, reason: "automatic-drafting-unavailable" } : blocking.some(item => item.code === "schema_unavailable") ? { available: false, reason: "schema-unavailable" } : blocking.some(item => item.code === "unsupported_editor") ? { available: false, reason: "editor-unsupported" } : { available: true };
    return { draft: shown, status: blocking.length === 0 ? "ready-for-confirmation" : "needs-input", blocking, outdated, unsupported, withheld, automaticDrafting: automatic };
  }

  async details(draftId: string, pointer: string, audience?: Lane): Promise<{ pointer: string; origin: DraftField["origin"]; reason: string | null; sources: { id: string; kind: string; revision: string; digest: string }[]; hiddenSources: number; alternatives: DraftField["alternatives"] } | null> {
    const draft = await this.load(draftId);
    const field = draft?.fields[pointer];
    if (!draft || !field) return null;
    const items = draft.manifest?.items.filter(item => field.citations.includes(item.id)) ?? [];
    const shown: typeof items = [];
    for (const item of items) if (await this.deps.policy.readable(item.id) && (!audience || await this.deps.policy.releasable([item.id], audience))) shown.push(item);
    const visible = new Set(shown.map(item => item.id));
    const fullyReleasable = (citations: string[]): boolean => citations.length > 0 && citations.every(id => visible.has(id));
    const binding = this.deps.bindings.lookup(draft.adapterId, draft.capabilityId, draft.schemaRef);
    const resolveWith = this.resolveWithFor(binding, pointer);
    const destinations = this.destinationBatch();
    const alternatives = (await Promise.all(field.alternatives.map(async alternative => {
      if (field.origin === "principal" && alternative.citations.length === 0) {
        return await this.stillCanonical(draft, resolveWith, alternative.value, destinations) ? [alternative] : [];
      }
      return !audience || fullyReleasable(alternative.citations) ? [{ value: alternative.value, citations: alternative.citations.filter(id => visible.has(id)) }] : [];
    }))).flat();
    return { pointer, origin: field.origin, reason: field.unresolved, sources: shown.map(item => ({ id: item.id, kind: item.kind, revision: item.revision, digest: item.digest })), hiddenSources: items.length - shown.length, alternatives };
  }

  async handoff(draftId: string, expected: number, existing?: Handoff["existing"]): Promise<HandoffResult> {
    const draft = await this.requireDraft(draftId);
    if (draft.revision !== expected) throw new DraftConflict("Draft revision changed; the approval snapshot must be rebuilt.");
    const view = await this.view(draft);
    const registryView = this.deps.registry.draftingView(draft.capabilityId);
    const outdated = view.outdated.filter(reason => BLOCKING_OUTDATED.has(reason));
    if (view.blocking.length > 0 || outdated.length > 0 || !registryView) return { ok: false, blocking: view.blocking, outdated };
    const input: Record<string, unknown> = {};
    for (const field of Object.values(draft.fields)) if (!view.unsupported.includes(field.pointer) && field.presence !== "absent") input[keyOf(field.pointer)] = field.value;
    const checked = this.deps.registry.validateInput({ capabilityId: draft.capabilityId, inputSchemaRef: registryView.inputSchemaRef, input }, null);
    if (!checked.ok) return { ok: false, blocking: [{ pointer: "", code: "invalid_value" }], outdated };
    const destinations = registryView.relationships.flatMap(relationship => [record(input)[keyOf(relationship.fieldPath)]].flat().filter((value): value is ObjectReference => value !== undefined && value !== null));
    const items = draft.manifest?.items ?? [];
    const body = { draftId, draftRevision: draft.revision, adapterId: draft.adapterId, connectionId: draft.connectionId, capabilityId: draft.capabilityId, inputSchemaRef: registryView.inputSchemaRef, outputSchemaRef: registryView.outputSchemaRef, errorSchemaRef: registryView.errorSchemaRef, input: checked.value.input, destinations, sources: items.map(item => ({ id: item.id, revision: item.revision, digest: item.digest })), policy: items.some(item => item.restriction === "local") ? "local" as const : "cloud" as const };
    return { ok: true, handoff: { ...body, digest: digestOf(body), ...(existing ? { existing } : {}) } };
  }
}
