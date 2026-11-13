import type { DomainAdapterRegistry } from "../domain-adapters/registry";
import type { Availability, CapabilityDeclaration, DeclaredCapability } from "../domain-adapters/types";
import { CommunicationFailure, type CommunicationAction, type CommunicationConnector, type CommunicationOperation, type CommunicationPage, type CommunicationScope, type ConnectorStatus, type UnavailableOperation } from "./communications";
import { z } from "zod/v4";

export interface AdapterCommunicationOptions {
  registry: DomainAdapterRegistry;
  adapterId: string;
  connectorId: string;
  family: string;
  service: string;
  availability: () => Readonly<Record<string, Availability>>;
  scopes: () => readonly CommunicationScope[];
  authorize: (principal: string, scope: string) => Promise<boolean>;
  status: (signal: AbortSignal) => Promise<ConnectorStatus>;
  run: (capabilityId: string, scope: string, input: object, signal: AbortSignal) => Promise<CommunicationPage>;
}

const ADAPTER_ACTION_FOLLOW_UP = "The adapter declares this action. The host authorizes and runs it, never this tool.";
const declaredByAdapter = (options: AdapterCommunicationOptions): readonly DeclaredCapability[] =>
  options.registry.discover(options.availability()).filter(entry => entry.adapterId === options.adapterId);
const availabilityOf = (options: AdapterCommunicationOptions, capabilityId: string): Availability =>
  declaredByAdapter(options).find(entry => entry.capability.capabilityId === capabilityId)?.availability ?? UNDECLARED;
const UNDECLARED: Availability = { state: "unavailable", code: "undeclared", message: "The adapter does not declare this capability." };

export function adapterCommunicationConnector(options: AdapterCommunicationOptions): CommunicationConnector | null {
  if (declaredByAdapter(options).length === 0) return null;
  const queries = (): CapabilityDeclaration[] => declaredByAdapter(options).map(entry => entry.capability).filter(capability => capability.kind === "query");
  const operationOf = (capability: CapabilityDeclaration): CommunicationOperation => ({
    id: capability.capabilityId,
    summary: capability.label,
    effect: "read",
    input: z.custom<object>(value => typeof value === "object" && value !== null && options.registry.validateInput({ capabilityId: capability.capabilityId, inputSchemaRef: capability.inputSchemaRef, input: value }, null).ok),
    inputJsonSchema: options.registry.publishedInputSchema(capability.capabilityId) ?? {},
  });
  const connector: CommunicationConnector = {
    id: options.connectorId,
    service: options.service,
    family: options.family,
    get operations() { return queries().filter(capability => availabilityOf(options, capability.capabilityId).state === "available").map(operationOf); },
    get actions(): CommunicationAction[] {
      return declaredByAdapter(options).map(entry => entry.capability).filter(capability => capability.kind === "action" && availabilityOf(options, capability.capabilityId).state === "available").map(capability => ({ id: capability.capabilityId, summary: capability.label, proposalType: null, followUp: ADAPTER_ACTION_FOLLOW_UP }));
    },
    unavailable: (): UnavailableOperation[] => declaredByAdapter(options).map(entry => entry.capability).flatMap(capability => {
      const availability = availabilityOf(options, capability.capabilityId);
      return availability.state === "unavailable" ? [{ id: capability.capabilityId, summary: capability.label, reason: availability.message }] : [];
    }),
    scopes: options.scopes,
    status: options.status,
    authorize: options.authorize,
    read: async (operation, scope, input, signal) => {
      const capability = queries().find(candidate => candidate.capabilityId === operation);
      if (!capability || availabilityOf(options, operation).state !== "available") throw new CommunicationFailure("not-installed");
      if (!options.registry.validateInput({ capabilityId: operation, inputSchemaRef: capability.inputSchemaRef, input }, null).ok) throw new CommunicationFailure("provider-failure");
      return options.run(operation, scope, input, signal);
    },
  };
  return connector;
}
