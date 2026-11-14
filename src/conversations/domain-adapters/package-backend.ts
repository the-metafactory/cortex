import { AsyncLocalStorage } from "node:async_hooks";
import type { TrustedConnector } from "../authority";
import type { DeskActionConnector, DeskAdapterBindings, DeskAdapterConnection, DeskObservationBinding } from "../../desk-sdk";
import { OwnerSupportSchema, type OwnerSupport } from "./operations/types";
import type { ObservationConnector } from "./reads/observation-types";
import { QueryPageSchema } from "./reads/query-types";
import type { AdapterDeclaration, BoundaryError } from "./types";

export const DESK_BACKEND_PATHS = ["query", "observation", "dispatch", "cancel", "lookup", "readback"] as const;
export type DeskBackendPath = (typeof DESK_BACKEND_PATHS)[number];
export type DeskBackendPathState = { available: true } | { available: false; error: BoundaryError };

export interface DeskBackendConnector {
  connector: TrustedConnector;
  paths: Record<DeskBackendPath, DeskBackendPathState>;
}

export interface DeskBackendInput {
  adapterId: string;
  connection: DeskAdapterConnection;
  declaration: AdapterDeclaration;
  bindings: DeskAdapterBindings;
  action: DeskActionConnector | undefined;
  authorizeConnection: TrustedConnector["authorizeConnection"];
  gate(): BoundaryError | null;
}

const unavailable = (code: string, message: string): DeskBackendPathState => ({ available: false, error: { code, message } });
const OMITTED = (path: DeskBackendPath): DeskBackendPathState => unavailable(`${path}_unavailable`, `This package supplies no ${path} call; the ${path} path is unavailable.`);
const NO_DISPATCH_CAPABILITY = "desk.dispatch.unavailable";

const settled = <T>(run: () => T): Promise<Awaited<T>> => new Promise(resolve => { resolve(run() as Awaited<T>); });

const admittedCalls = new AsyncLocalStorage<string>();
/** The adapter-and-connection key of a backend call. */
export const connectionKey = (connection: DeskAdapterConnection): string => JSON.stringify([connection.adapterId, connection.connectionId]);
/** The key of the connection whose admitted backend call is running now, if any. */
export const admittedCallKey = (): string | undefined => admittedCalls.getStore();

/** Runs one admitted backend call for a connection; host reads such as listed mail serve only that connection inside it. */
export function withAdmittedCall<T>(connection: DeskAdapterConnection, run: () => T): T {
  return admittedCalls.run(connectionKey(connection), run);
}

export class DeskBackendUnavailableError extends Error {
  constructor(readonly error: BoundaryError) {
    super(error.message);
    this.name = "DeskBackendUnavailableError";
  }
}

const unsupported = (input: DeskBackendInput): OwnerSupport => OwnerSupportSchema.parse({
  lifecycleVersion: "1.0.0", adapterId: input.adapterId, connectionId: input.connection.connectionId, capabilityId: NO_DISPATCH_CAPABILITY, declarationId: NO_DISPATCH_CAPABILITY,
  dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none",
});

function supportOf(input: DeskBackendInput): { support: OwnerSupport; state: DeskBackendPathState } {
  const action = input.action;
  if (!action) return { support: unsupported(input), state: unavailable("dispatch_unavailable", "This package registers no action connector; the dispatch path is unavailable.") };
  if (typeof action.dispatch !== "function") return { support: unsupported(input), state: OMITTED("dispatch") };
  if (typeof action.writerOwner !== "string" || action.writerOwner === "") return { support: unsupported(input), state: unavailable("dispatch_unavailable", "The action connector names no writer owner; the dispatch path is unavailable.") };
  const parsed = OwnerSupportSchema.safeParse(action.support);
  const mismatch = !parsed.success || parsed.data.adapterId !== input.adapterId || parsed.data.connectionId !== input.connection.connectionId || parsed.data.capabilityId !== action.capabilityId;
  if (!parsed.success || mismatch) {
    return { support: unsupported(input), state: unavailable("dispatch_unavailable", "The action connector's owner support is missing or does not name this adapter, connection and capability; the dispatch path is unavailable.") };
  }
  return { support: parsed.data, state: { available: true } };
}

function isObservationBinding(binding: object): binding is DeskObservationBinding {
  const candidate = binding as Partial<DeskObservationBinding>;
  return typeof candidate.fetch === "function" && Array.isArray(candidate.modes) && candidate.modes.length > 0;
}

function observationOf(input: DeskBackendInput, call: <T>(run: () => T) => T): { observation?: ObservationConnector; state: DeskBackendPathState } {
  const entries = Object.entries(input.bindings.observations).filter(([id]) => input.declaration.capabilities.some(capability => capability.capabilityId === id && capability.kind === "observation"));
  if (entries.length === 0) return { state: unavailable("observation_unavailable", "This package declares no observation capability; the observation path is unavailable.") };
  const bindings = new Map<string, DeskObservationBinding>();
  for (const [id, binding] of entries) {
    if (!isObservationBinding(binding)) return { state: unavailable("observation_unavailable", `The observation binding for ${id} supplies no fetch call or modes; the observation path is unavailable.`) };
    bindings.set(id, binding);
  }
  const orderings = new Set([...bindings.values()].map(binding => binding.ordering?.id ?? ""));
  if (orderings.size > 1) return { state: unavailable("observation_ordering_conflict", "The observation bindings of one adapter must share one ordering; the observation path is unavailable.") };
  const first = [...bindings.values()].find(binding => binding.ordering)?.ordering;
  const modes = [...new Set([...bindings.values()].flatMap(binding => binding.modes))];
  return {
    state: { available: true },
    observation: {
      modes,
      ...(first ? { ordering: { id: first.id, compare: (left: string, right: string) => first.compare(left, right) } } : {}),
      fetch: (request, signal) => {
        const binding = bindings.get(request.source.capabilityId);
        const mode = request.mode === "subscription" ? "subscription" : "poll";
        if (!binding?.modes.includes(mode)) return Promise.reject(new DeskBackendUnavailableError({ code: "observation_unavailable", message: "This package supplies no observation for that capability and mode." }));
        return settled(() => call(() => binding.fetch(structuredClone(request), signal)));
      },
    },
  };
}

export function adaptDeskBackend(input: DeskBackendInput): DeskBackendConnector {
  const call = <T>(run: () => T): T => {
    const gated = input.gate();
    if (gated) throw new DeskBackendUnavailableError(gated);
    return withAdmittedCall(input.connection, run);
  };
  const action = input.action;
  const queryIds = new Set(input.declaration.capabilities.filter(capability => capability.kind === "query").map(capability => capability.capabilityId));
  const handlers = Object.fromEntries(Object.entries(input.bindings.handlers).filter(([id, handler]) => queryIds.has(id) && typeof handler === "function"));
  const hasQuery = Object.keys(handlers).length > 0;
  const { support, state: dispatchState } = supportOf(input);
  const observed = observationOf(input, call);
  const dispatchable = dispatchState.available && action;
  const readbackTarget = action?.readbackCapabilityId;
  const readbackDeclared = typeof readbackTarget === "string" && queryIds.has(readbackTarget);
  const readbackReady = action && typeof action.readback === "function" && readbackDeclared;

  const connector: TrustedConnector = {
    ...(observed.observation ? { observation: observed.observation } : {}),
    writerOwner: dispatchable && action.writerOwner ? action.writerOwner : NO_DISPATCH_CAPABILITY,
    support,
    authorizeConnection: current => {
      const gated = input.gate();
      return gated ? Promise.resolve({ version: 1, available: false, revision: "unavailable" }) : input.authorizeConnection(current);
    },
    dispatch: (request, signal) => {
      if (!dispatchable || typeof action.dispatch !== "function") return Promise.reject(new DeskBackendUnavailableError(dispatchState.available ? { code: "dispatch_unavailable", message: "The dispatch path is unavailable." } : dispatchState.error));
      return settled(() => call(() => action.dispatch?.(structuredClone(request), signal)));
    },
    ...(action && typeof action.cancel === "function" ? { cancel: (request, signal) => settled(() => call(() => action.cancel?.(structuredClone(request), signal))) } : {}),
    ...(action && typeof action.lookup === "function" ? { lookup: (request, signal) => settled(() => call(() => action.lookup?.(structuredClone(request), signal))) } : {}),
    ...(readbackReady ? { readbackCapabilityId: readbackTarget, readback: (request, signal) => settled(() => call(() => action.readback?.(structuredClone(request), signal))) } : {}),
    ...(hasQuery ? {
      query: async (request, signal) => {
        const handler = Object.hasOwn(handlers, request.capabilityId) ? handlers[request.capabilityId] : undefined;
        if (!handler) throw new DeskBackendUnavailableError({ code: "query_unavailable", message: "This package supplies no query call for that capability." });
        return QueryPageSchema.parse(await call(() => handler(structuredClone(request), signal)));
      },
    } : {}),
  };

  const readback: DeskBackendPathState = readbackReady ? { available: true }
    : !action ? OMITTED("readback")
    : typeof action.readback !== "function" ? OMITTED("readback")
    : unavailable("readback_unavailable", "The action connector's readbackCapabilityId does not name a declared query capability; the readback path is unavailable.");
  const paths: Record<DeskBackendPath, DeskBackendPathState> = {
    query: hasQuery ? { available: true } : unavailable("query_unavailable", "This package supplies no query call; the query path is unavailable."),
    observation: observed.state,
    dispatch: dispatchState,
    cancel: action && typeof action.cancel === "function" ? { available: true } : OMITTED("cancel"),
    lookup: action && typeof action.lookup === "function" ? { available: true } : OMITTED("lookup"),
    readback,
  };
  return { connector, paths };
}
