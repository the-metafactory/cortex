import type { BalanceSurfaceAccess } from "../desk/balance-surfaces";
import { BALANCE_SURFACES_DESTINATIONS, BALANCE_SURFACES_TASK } from "../desk/balance-surface-schema";
import { handleDeskSurface } from "./desk-surface";

const MAX_REF = 512;

export async function handleDeskBalanceSurfaces(req: Request, url: URL, access: BalanceSurfaceAccess | undefined): Promise<Response> {
  return handleDeskSurface(req, url, access, {
    label: "desk balance surfaces",
    destinations: BALANCE_SURFACES_DESTINATIONS,
    item: BALANCE_SURFACES_TASK,
    unknown: "Unknown Balance surface route.",
    invalid: "A Balance task reference and its area are required.",
    failure: "The Balance connection could not be read.",
    items: candidate => {
      const ref = candidate.searchParams.get("ref") ?? "";
      const area = candidate.searchParams.get("area") ?? "";
      return ref.trim().length === 0 || area.trim().length === 0 || ref.length > MAX_REF || area.length > MAX_REF ? null : { ref, area };
    },
    destinationsOf: reader => reader.destinations(),
    itemOf: (reader, input) => reader.task(input.ref, input.area),
  });
}
