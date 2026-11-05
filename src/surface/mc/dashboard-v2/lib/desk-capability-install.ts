import { RoutineResultSchema, type RoutineResult } from "../../desk/routine-action-contract";
import type { CapabilityInstallRequest } from "../../desk/routine-install";

export async function submitCapabilityInstall(request: CapabilityInstallRequest): Promise<RoutineResult> {
  const response = await fetch("/api/desk/routines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  return RoutineResultSchema.parse(await response.json());
}
