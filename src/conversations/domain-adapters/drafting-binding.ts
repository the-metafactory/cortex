import { z } from "zod";
import { valid } from "semver";
import type { DomainAdapterRegistry, DraftingView } from "./registry";
import { failure, success } from "./schema-validation";
import { SchemaRefSchema, type Result, type SchemaRef } from "./types";

export const DRAFTING_BINDING_VERSION = "1.0.0";
const identifier = z.string().min(1).refine(value => value.trim().length > 0);
const TOP_LEVEL_POINTER = /^\/(?:[^~/]|~[01])+$/;
const HINT_ROLES = ["title", "summary", "destination", "detail"] as const;
const fieldHint = z.object({ pointer: z.string().regex(TOP_LEVEL_POINTER), role: z.enum(HINT_ROLES), resolveWith: identifier.optional(), widget: z.literal("long").optional() }).strict();
export const DraftingBindingSchema = z.object({
  bindingVersion: z.literal(DRAFTING_BINDING_VERSION),
  adapterId: identifier,
  capabilityId: identifier,
  inputSchemaRef: SchemaRefSchema,
  guidance: z.object({ guidanceId: identifier, version: identifier.refine(value => valid(value) !== null), instructions: identifier }).strict(),
  fieldHints: z.array(fieldHint),
}).strict();
export type DraftingBinding = z.infer<typeof DraftingBindingSchema>;
export type FieldHint = DraftingBinding["fieldHints"][number];

export const bindingKey = (adapterId: string, capabilityId: string, ref: SchemaRef): string => JSON.stringify([adapterId, capabilityId, ref.schemaId, ref.version]);
const sameRef = (left: SchemaRef, right: SchemaRef): boolean => left.schemaId === right.schemaId && left.version === right.version;
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

function hintProblem(registry: DomainAdapterRegistry, view: DraftingView, hint: FieldHint): string | null {
  const field = view.field(hint.pointer);
  if (!field) return "A field hint does not resolve to a declared schema path.";
  const relationship = view.relationships.find(item => item.fieldPath === hint.pointer);
  if ((hint.role === "destination") !== (relationship !== undefined)) return "Destination hints must name exactly the declared relationship fields.";
  if (hint.resolveWith !== undefined) {
    const resolver = registry.capability(hint.resolveWith);
    if (hint.role !== "destination" || resolver.support !== "declared" || resolver.capability.kind !== "query") return "resolveWith must name a declared destinations query on a destination hint.";
  }
  if (hint.widget === "long" && field.type !== "string") return "The long widget applies only to string fields.";
  return null;
}

export class DraftingBindings {
  private readonly bindings = new Map<string, DraftingBinding>();

  constructor(private readonly registry: DomainAdapterRegistry) {}

  register(raw: unknown): Result<DraftingBinding> {
    const version = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).bindingVersion : undefined;
    if (version !== DRAFTING_BINDING_VERSION) return failure("unsupported_binding_version", "Drafting binding version is not supported.");
    const parsed = DraftingBindingSchema.safeParse(raw);
    if (!parsed.success) return failure("invalid_binding", "Drafting binding does not match the strict contract.");
    const binding = parsed.data;
    const view = this.registry.draftingView(binding.capabilityId);
    if (view?.kind !== "action" || view.adapterId !== binding.adapterId || !sameRef(view.inputSchemaRef, binding.inputSchemaRef)) return failure("binding_mismatch", "Binding must name a registered action capability and its exact pinned input schema.");
    const pointers = binding.fieldHints.map(hint => hint.pointer);
    if (new Set(pointers).size !== pointers.length) return failure("invalid_binding", "A field may carry only one hint.");
    for (const hint of binding.fieldHints) {
      const problem = hintProblem(this.registry, view, hint);
      if (problem) return failure("invalid_hint", problem);
    }
    const key = bindingKey(binding.adapterId, binding.capabilityId, binding.inputSchemaRef);
    if (this.bindings.has(key)) return failure("duplicate_binding", "A drafting binding already exists for this capability and schema.");
    this.bindings.set(key, deepFreeze(structuredClone(binding)));
    return success(structuredClone(binding));
  }

  lookup(adapterId: string, capabilityId: string, ref: SchemaRef): DraftingBinding | undefined {
    const held = this.bindings.get(bindingKey(adapterId, capabilityId, ref));
    return held && structuredClone(held);
  }
}
