export { DESK_ADAPTER_SDK_VERSION } from "./version";
import type { AdapterBindings, AdapterDeclaration } from "../conversations/domain-adapters/types";
export type {
  AdapterBindings,
  AdapterDeclaration,
  BoundaryError,
  CapabilityDeclaration,
  Handler,
  ObjectReference,
  Result,
  SchemaRef,
} from "../conversations/domain-adapters/types";

/** The connection identity the host binds when it constructs a connector for one configured connection. */
export interface DeskAdapterConnection {
  readonly adapterId: string;
  readonly connectionId: string;
}

/** The trusted connector a package's module returns for one connection; it carries no credentials itself. */
export interface DeskActionConnector {
  readonly kind: "action";
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilityId: string;
}

/** Builds one connector per connection; the host calls it only after a connection exists. */
export type DeskConnectorFactory = (connection: DeskAdapterConnection) => DeskActionConnector;

/** The only host seam a package module receives: its SDK version and protected action-connector registration. */
export interface DeskAdapterHost {
  readonly sdkVersion: string;
  registerConnector(capabilityId: string, createConnector: DeskConnectorFactory): void;
}

/** What a package's `createDeskAdapter` returns; the loader compares the declaration to the verified manifest. */
export interface DeskAdapterDefinition {
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
}

/** The factory a package's ESM entry exports; it runs with no credentials and starts no provider effect. */
export type CreateDeskAdapter = (host: DeskAdapterHost) => DeskAdapterDefinition;

/** The exact module shape a `desk-adapter.json` backend entry must export. */
export interface DeskAdapterModule {
  readonly createDeskAdapter: CreateDeskAdapter;
}
