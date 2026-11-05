import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { RoutineResult } from "./routine-action-contract";
import { finishBundleRemoval, readCapabilityInstall, recordInstallOutcome } from "./routine-install-store";

export const CapabilityResolveRequestSchema = z.object({
  action: z.literal("capability.resolve"),
  id: z.string().regex(/^[\w-]{8,64}$/),
  state: z.enum(["running", "undoing"]),
  at: z.number().int().nonnegative(),
  outcome: z.enum(["installed", "absent"]),
}).strict();

export function resolveCapabilityInstall(db: Database, request: z.infer<typeof CapabilityResolveRequestSchema>, timeoutMs: number, now: number): RoutineResult {
  return db.transaction((): RoutineResult => {
    const install = readCapabilityInstall(db, request.id);
    if (install?.state !== request.state || install.at !== request.at) return { ok: false, error: "The bundle command changed. Refresh before checking its outcome." };
    if (!install.error && now - install.at < timeoutMs) return { ok: false, error: "The bundle command is still waiting for its result. Wait before checking its outcome." };
    if (request.outcome === "absent") finishBundleRemoval(db, install.bundle);
    if (request.outcome === "installed" || install.state === "running") recordInstallOutcome(db, install.id, request.outcome === "installed" ? { ok: true, message: "Confirmed installed." } : { ok: false, error: "the principal checked that the bundle is absent" }, now);
    return { ok: true, message: `Recorded ${install.bundle} as ${request.outcome}.` };
  })();
}
