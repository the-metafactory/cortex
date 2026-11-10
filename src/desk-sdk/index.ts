// glossary-ignore: host
export { DESK_ADAPTER_SDK_VERSION } from "./version";
import type { CancelRequest, DispatchRequest, LookupRequest, OwnerSupport, ReadbackRequest } from "../conversations/domain-adapters/operations/types";
import type { ObservationRequest } from "../conversations/domain-adapters/reads/observation-types";
import type { QueryFetchRequest } from "../conversations/domain-adapters/reads/query-types";
import type { AdapterDeclaration } from "../conversations/domain-adapters/types";
export type {
  AdapterDeclaration,
  BoundaryError,
  CapabilityDeclaration,
  ObjectReference,
  Result,
  SchemaRef,
} from "../conversations/domain-adapters/types";
export type { CancelRequest, DispatchRequest, Json, LookupRequest, ObjectReadback, OperationLookup, OwnerResult, OwnerSupport, ReadbackRequest } from "../conversations/domain-adapters/operations/types";
export type { ObservationBatch, ObservationRequest } from "../conversations/domain-adapters/reads/observation-types";
export type { QueryFetchRequest, QueryPage } from "../conversations/domain-adapters/reads/query-types";

/**
 * The call a package's module supplies for one query capability. The host passes the validated fetch request for
 * the capability and releases the result only after it parses as a `QueryPage`.
 */
export type DeskQueryHandler = (request: QueryFetchRequest, signal: AbortSignal) => unknown;

/**
 * The calls a package's module supplies for one observation capability. `fetch` resolves to an `ObservationBatch`;
 * the host validates it against the capability's read binding before storing anything.
 */
export interface DeskObservationBinding {
  readonly modes: readonly ("poll" | "subscription")[];
  readonly ordering?: { readonly id: string; compare(left: string, right: string): "older" | "same" | "newer" | "incomparable" };
  fetch(request: ObservationRequest, signal: AbortSignal): unknown;
}

/** The untyped 1.0.0 binding shape; the host treats one without `fetch` and `modes` as an unavailable observation path. */
export type DeskLegacyObservationBinding = object;

/** The bindings a package's module supplies for its declared query and observation capabilities. */
export interface DeskAdapterBindings {
  readonly handlers: Record<string, DeskQueryHandler>;
  readonly observations: Record<string, DeskObservationBinding | DeskLegacyObservationBinding>;
}

/** The connection identity the host binds when it constructs a connector for one configured connection. */
export interface DeskAdapterConnection {
  readonly adapterId: string;
  readonly connectionId: string;
}

/**
 * The trusted connector a package's module returns for one connection and one action capability; it carries no
 * credentials itself. Every call is optional: a call the package omits makes that path unavailable, and the host
 * never substitutes another implementation.
 *
 * - `dispatch` needs `writerOwner` and `support`; `support` must name this adapter, connection and capability.
 * - `readback` needs `readbackCapabilityId`, which must name a declared query capability of the same adapter.
 * - The host owns credential and account checks; a package cannot report a connection as available.
 */
export interface DeskActionConnector {
  readonly kind: "action";
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilityId: string;
  readonly writerOwner?: string;
  readonly support?: OwnerSupport;
  dispatch?(request: DispatchRequest, signal: AbortSignal): unknown;
  cancel?(request: CancelRequest, signal: AbortSignal): unknown;
  lookup?(request: LookupRequest, signal: AbortSignal): unknown;
  readonly readbackCapabilityId?: string;
  readback?(request: ReadbackRequest, signal: AbortSignal): unknown;
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
  readonly bindings: DeskAdapterBindings;
}

/** The factory a package's ESM entry exports; it runs with no credentials and starts no provider effect. */
export type CreateDeskAdapter = (host: DeskAdapterHost) => DeskAdapterDefinition;

/** The exact module shape a `desk-adapter.json` backend entry must export. */
export interface DeskAdapterModule {
  readonly createDeskAdapter: CreateDeskAdapter;
}
