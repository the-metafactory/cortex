import type { TrustedConnector } from "../../conversations/authority";
import type { ObservationRequest } from "../../conversations/domain-adapters/reads/observation-types";
import type { QueryFetchRequest } from "../../conversations/domain-adapters/reads/query-types";
import { emptyOwnerCalls, type OwnerCalls } from "./report";

export interface RecordedQuery { request: QueryFetchRequest; raw?: unknown; failure?: string }
export interface RecordedObservation { request: ObservationRequest; raw?: unknown; failure?: string }

export interface Recorded {
  queries: RecordedQuery[];
  observations: RecordedObservation[];
  ownerCalls: OwnerCalls;
  dispatches: unknown[];
}

const failureText = (error: unknown): string => (error instanceof Error ? error.message : "The package call failed.");

async function recordCall(entry: { raw?: unknown; failure?: string }, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const raw = await run();
    entry.raw = raw;
    return raw;
  } catch (error) {
    entry.failure = failureText(error);
    throw error;
  }
}

function countedOwner<A extends unknown[], R>(call: ((...args: A) => R) | undefined, bump: () => void): ((...args: A) => R) | undefined {
  return call && ((...args: A) => {
    bump();
    return call(...args);
  });
}

export function recordConnector(connector: TrustedConnector): { connector: TrustedConnector; recorded: Recorded } {
  const recorded: Recorded = { queries: [], observations: [], ownerCalls: emptyOwnerCalls(), dispatches: [] };
  const query = connector.query?.bind(connector);
  const observation = connector.observation;
  const cancelCounted = countedOwner(connector.cancel?.bind(connector), () => { recorded.ownerCalls.cancel++; });
  const lookupCounted = countedOwner(connector.lookup?.bind(connector), () => { recorded.ownerCalls.lookup++; });
  const readbackCounted = countedOwner(connector.readback?.bind(connector), () => { recorded.ownerCalls.readback++; });
  const recording: TrustedConnector = {
    ...connector,
    dispatch: async (request, signal) => {
      recorded.ownerCalls.dispatch++;
      const result = await connector.dispatch(request, signal);
      recorded.dispatches.push(result);
      return result;
    },
    ...(cancelCounted ? { cancel: cancelCounted } : {}),
    ...(lookupCounted ? { lookup: lookupCounted } : {}),
    ...(readbackCounted ? { readback: readbackCounted } : {}),
    ...(query ? {
      query: (request, signal) => {
        const entry: RecordedQuery = { request };
        recorded.queries.push(entry);
        return recordCall(entry, () => Promise.resolve(query(request, signal)));
      },
    } : {}),
    ...(observation ? {
      observation: {
        ...observation,
        fetch: (request, signal) => {
          const entry: RecordedObservation = { request };
          recorded.observations.push(entry);
          return recordCall(entry, () => Promise.resolve(observation.fetch(request, signal)));
        },
      },
    } : {}),
  };
  return { connector: recording, recorded };
}
