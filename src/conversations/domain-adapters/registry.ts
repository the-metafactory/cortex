import { z } from "zod";
import { satisfies, validRange } from "semver";
import { AdapterDeclarationSchema, BoundaryErrorSchema, InputRequestSchema, type AdapterBindings, type AdapterDeclaration, type Availability, type CapabilityDeclaration, type CapabilityDiscovery, type DeclaredCapability, type Result } from "./types";
import { canonicalSchema, failure, jsonBoundCode, SchemaBundle, schemaKey, success, validatePayload } from "./schema-validation";

export const DOMAIN_ADAPTER_CONTRACT_VERSION = "1.0.0";
interface RegisteredAdapter { declaration: AdapterDeclaration; bundle: SchemaBundle; bindings: AdapterBindings }
interface RegisteredCapability { adapter: RegisteredAdapter; declaration: CapabilityDeclaration }
const Available: Availability = { state: "available" };
const distinct = (values: string[]): boolean => new Set(values).size === values.length;
const acceptsRange = (range: string): boolean => validRange(range) !== null && satisfies(DOMAIN_ADAPTER_CONTRACT_VERSION, range);
const namespace = (id: string, adapterId: string): boolean => id.startsWith(`${adapterId}.`) && id.length > adapterId.length + 1;
const bindingsSchema = z.object({ handlers: z.record(z.string(), z.custom<AdapterBindings["handlers"][string]>(value => typeof value === "function")), observations: z.record(z.string(), z.custom<object>(value => value !== null && typeof value === "object")) }).strict();

const allowsType = (field: Record<string, unknown>, type: string): boolean => field.type === type || Array.isArray(field.type) && field.type.includes(type) && field.type.every(value => value === type || value === "null");

function referenceField(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  return field.type === "string" && (typeof field.minLength === "number" && field.minLength >= 1 || typeof field.const === "string" && field.const.length > 0);
}

function relationshipMatches(bundle: SchemaBundle, object: AdapterDeclaration["objectTypes"][number], relation: AdapterDeclaration["objectTypes"][number]["relationships"][number]): boolean {
  let field = bundle.field(object.schemaRef, relation.fieldPath);
  if (!field) return false;
  if (relation.cardinality === "many") {
    if (!allowsType(field, "array") || !field.items || typeof field.items !== "object" || Array.isArray(field.items)) return false;
    field = field.items as Record<string, unknown>;
  }
  const required = field.required;
  const properties = field.properties;
  if (!allowsType(field, "object") || field.additionalProperties !== false || !Array.isArray(required) || !properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const fields = properties as Record<string, unknown>;
  const keys = ["adapterId", "connectionId", "objectType", "canonicalId"];
  if (Object.keys(fields).length !== keys.length || !keys.every(key => required.includes(key) && referenceField(fields[key]))) return false;
  const adapterId = fields.adapterId as Record<string, unknown>;
  const objectType = fields.objectType as Record<string, unknown>;
  return adapterId.const === relation.targetAdapterId && objectType.const === relation.targetObjectType;
}

function prepare(declaration: AdapterDeclaration, bindings: AdapterBindings): Result<RegisteredAdapter> {
  if (!distinct(declaration.objectTypes.map(object => object.objectType)) || !distinct(declaration.capabilities.map(capability => capability.capabilityId)) || !distinct(declaration.schemas.map(schemaKey))) return failure("duplicate_id", "Declaration contains a duplicate identity.");
  const declared = new Map(declaration.capabilities.map(capability => [capability.capabilityId, capability]));
  if (Object.keys(bindings.handlers).some(id => declared.get(id)?.kind !== "action" && declared.get(id)?.kind !== "query") || Object.keys(bindings.observations).some(id => declared.get(id)?.kind !== "observation")) return failure("invalid_registration", "Bindings must match declared capability kinds.");
  for (const capability of declaration.capabilities) {
    if (!namespace(capability.capabilityId, declaration.adapterId)) return failure("invalid_registration", "Capability identity must belong to the adapter namespace.");
    if (capability.kind === "observation" ? !Object.hasOwn(bindings.observations, capability.capabilityId) : !Object.hasOwn(bindings.handlers, capability.capabilityId)) return failure("missing_handler", "A declared capability has no matching handler or observation binding.");
    if (!distinct(capability.objectTypes) || capability.objectTypes.some(type => !declaration.objectTypes.some(object => object.objectType === type))) return failure("invalid_registration", "Capability refers to an undeclared object type.");
  }
  let bundle: SchemaBundle;
  try { bundle = new SchemaBundle(declaration.schemas); }
  catch (error) { return failure("invalid_registration", "Schema bundle contains an invalid, unsupported or unresolved schema.", [{ path: "/schemas", code: "invalid_schema", message: error instanceof Error && error.name === "MissingRefError" ? "A schema reference is not bundled." : "Schema bundle cannot be validated." }]); }
  for (const capability of declaration.capabilities) {
    if ([capability.inputSchemaRef, capability.outputSchemaRef, capability.errorSchemaRef].some(ref => !bundle.validator(ref))) return failure("invalid_registration", "Capability schema reference is not bundled.");
  }
  for (const object of declaration.objectTypes) {
    if (!bundle.validator(object.schemaRef)) return failure("invalid_registration", "Object schema reference is not bundled.");
    if (!distinct(object.relationships.map(relation => relation.fieldPath))) return failure("duplicate_id", "Object contains duplicate relationship fields.");
    for (const relation of object.relationships) {
      if (relation.targetAdapterId === declaration.adapterId && !declaration.objectTypes.some(target => target.objectType === relation.targetObjectType)) return failure("invalid_registration", "Relationship target type is not declared.");
      if (!relationshipMatches(bundle, object, relation)) return failure("invalid_registration", "Relationship declaration does not match its schema field.");
    }
  }
  return success({ declaration, bundle, bindings });
}

export class DomainAdapterRegistry {
  private readonly adapters = new Map<string, RegisteredAdapter>();
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private readonly schemas = new Map<string, string>();

  register(raw: unknown, rawBindings: unknown): Result<AdapterDeclaration> {
    try { canonicalSchema(raw); }
    catch (error) {
      const code = jsonBoundCode(error);
      return failure("invalid_registration", "Declaration exceeds supported JSON bounds.", [{ path: "", code, message: "Supply a bounded JSON declaration." }]);
    }
    const parsed = AdapterDeclarationSchema.safeParse(raw);
    const bindings = bindingsSchema.safeParse(rawBindings);
    if (!parsed.success || !bindings.success) return failure("invalid_registration", "Adapter declaration or bindings do not match the contract.");
    const declaration = structuredClone(parsed.data);
    if (this.adapters.has(declaration.adapterId) || declaration.capabilities.some(capability => this.capabilities.has(capability.capabilityId))) return failure("duplicate_id", "Adapter or capability identity is already registered.");
    if (!acceptsRange(declaration.contractRange)) return failure("incompatible_contract", "Adapter contract range does not include the host contract version.");
    for (const schema of declaration.schemas) {
      const held = this.schemas.get(schemaKey(schema));
      if (held !== undefined && held !== canonicalSchema(schema.schema)) return failure("invalid_registration", "A published schema identity and version cannot be redefined.");
    }
    const prepared = prepare(declaration, bindings.data);
    if (!prepared.ok) return prepared;
    for (const object of declaration.objectTypes) {
      for (const relation of object.relationships) {
        if (relation.targetAdapterId !== declaration.adapterId && !this.adapters.get(relation.targetAdapterId)?.declaration.objectTypes.some(target => target.objectType === relation.targetObjectType)) return failure("invalid_registration", "Relationship target adapter and type must be registered.");
      }
    }
    this.adapters.set(declaration.adapterId, prepared.value);
    for (const capability of declaration.capabilities) this.capabilities.set(capability.capabilityId, { adapter: prepared.value, declaration: capability });
    for (const schema of declaration.schemas) this.schemas.set(schemaKey(schema), canonicalSchema(schema.schema));
    return success(structuredClone(declaration));
  }

  discover(availability: Readonly<Record<string, Availability>> = {}): DeclaredCapability[] {
    return [...this.capabilities].map(([id, entry]) => this.describe(entry, availability[id] ?? Available));
  }

  capability(capabilityId: string, availability: Availability = Available): CapabilityDiscovery {
    const entry = this.capabilities.get(capabilityId);
    return entry ? this.describe(entry, availability) : { support: "unsupported", capabilityId };
  }

  private describe(entry: RegisteredCapability, availability: Availability): DeclaredCapability {
    return { support: "declared", adapterId: entry.adapter.declaration.adapterId, capability: structuredClone(entry.declaration), availability: structuredClone(availability) };
  }

  validateInput<T>(request: unknown, context: T): Result<{ input: unknown; context: T }> {
    try { canonicalSchema(request); }
    catch (error) { return failure("invalid_input", "Invocation exceeds supported JSON bounds.", [{ path: "", code: jsonBoundCode(error), message: "Supply a bounded JSON invocation." }]); }
    const parsed = InputRequestSchema.safeParse(request);
    if (!parsed.success) return failure("invalid_input", "Invocation envelope does not match the contract.");
    const entry = this.capabilities.get(parsed.data.capabilityId);
    if (!entry) return failure("unknown_capability", "Capability is not declared.");
    const ref = parsed.data.inputSchemaRef;
    const validate = ref.schemaId === entry.declaration.inputSchemaRef.schemaId ? entry.adapter.bundle.validator(ref) : undefined;
    if (!validate) return failure("incompatible_schema", "The exact pinned input schema is not supported.");
    const checked = validatePayload(validate, parsed.data.input, "invalid_input");
    return checked.ok ? success({ input: checked.value, context }) : checked;
  }

  validateOutput(capabilityId: string, output: unknown): Result<unknown> { return this.validateResponse(capabilityId, output, false); }
  validateError(capabilityId: string, error: unknown): Result<unknown> { return this.validateResponse(capabilityId, error, true); }

  private validateResponse(capabilityId: string, response: unknown, isError: boolean): Result<unknown> {
    const entry = this.capabilities.get(capabilityId);
    if (!entry) return failure("unknown_capability", "Capability is not declared.");
    if (isError) {
      const parsed = BoundaryErrorSchema.safeParse(response);
      if (!parsed.success || !namespace(parsed.data.code, entry.adapter.declaration.adapterId)) return failure("invalid_output", "Adapter error does not match the namespaced error envelope.");
    }
    const validate = entry.adapter.bundle.validator(isError ? entry.declaration.errorSchemaRef : entry.declaration.outputSchemaRef);
    return validate ? validatePayload(validate, response, "invalid_output") : failure("incompatible_schema", "Response schema is unavailable.");
  }
}
