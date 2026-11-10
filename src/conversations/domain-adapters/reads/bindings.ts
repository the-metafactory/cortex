import type { DomainAdapterRegistry } from "../registry";
import { failure, success } from "../schema-validation";
import type { Result, SchemaRef } from "../types";
import { READ_BINDING_VERSION, ReadBindingSchema, type ReadBinding, type ReadBindingLookup, type ReadConnectorDeclaration } from "./types";

const bindingKey = (adapterId: string, connectionId: string, capabilityId: string): string => JSON.stringify([adapterId, connectionId, capabilityId]);
const sameRef = (left: SchemaRef, right: SchemaRef): boolean => left.schemaId === right.schemaId && left.version === right.version;
const KIND_OF_MODE = { query: "query", destinations: "query", poll: "observation" } as const;

export function verifyReadBinding(registry: DomainAdapterRegistry, binding: ReadBinding): Result<ReadBinding> {
  const found = registry.capability(binding.capabilityId);
  if (found.support !== "declared" || found.adapterId !== binding.adapterId || found.capability.kind !== KIND_OF_MODE[binding.mode]) return failure("binding_mismatch", "Binding must name a registered capability of the matching kind.");
  const capability = found.capability;
  if (!sameRef(capability.inputSchemaRef, binding.inputSchemaRef) || !sameRef(capability.outputSchemaRef, binding.outputSchemaRef)) return failure("binding_mismatch", "Binding must name the exact pinned capability schemas.");
  if (!capability.objectTypes.includes(binding.objectType) || binding.destinationType !== undefined && !registry.declaresObjectType(binding.adapterId, binding.destinationType)) return failure("binding_mismatch", "Binding must name declared object types.");
  return success(structuredClone(binding));
}

export class ReadBindings {
  private readonly bindings = new Map<string, ReadBinding>();

  constructor(private readonly registry: DomainAdapterRegistry) {}

  register(raw: unknown, connector: ReadConnectorDeclaration): Result<ReadBinding> {
    const version = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).version : undefined;
    if (version !== READ_BINDING_VERSION) return failure("unsupported_binding_version", "Read binding version is not supported.");
    const parsed = ReadBindingSchema.safeParse(raw);
    if (!parsed.success) return failure("invalid_binding", "Read binding does not match the strict contract.");
    const binding = parsed.data;
    const verified = verifyReadBinding(this.registry, binding);
    if (!verified.ok) return verified;
    if (connector.adapterId !== binding.adapterId || !connector.readCapabilityIds.includes(binding.capabilityId)) return failure("connector_mismatch", "The trusted connector does not declare this read capability.");
    const key = bindingKey(binding.adapterId, connector.connectionId, binding.capabilityId);
    if (this.bindings.has(key)) return failure("duplicate_binding", "A read binding already exists for this connection and capability.");
    this.bindings.set(key, structuredClone(binding));
    return success(structuredClone(binding));
  }

  lookup(adapterId: string, connectionId: string, capabilityId: string): ReadBindingLookup {
    const held = this.bindings.get(bindingKey(adapterId, connectionId, capabilityId));
    return held ? { state: "available", binding: structuredClone(held) } : { state: "unavailable", code: "binding_missing" };
  }
}
