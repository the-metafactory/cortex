import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { RoutineResult } from "./routine-action-contract";
import { CAPABILITY_INSTALL, finishPackRemoval, readCapabilityInstall } from "./routine-install-store";

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
    if (install?.state !== request.state || install.at !== request.at) return { ok: false, error: "The pack command changed. Refresh before checking its outcome." };
    if (!install.error && now - install.at < timeoutMs) return { ok: false, error: "The pack command is still waiting for its result. Wait before checking its outcome." };
    if (request.outcome === "absent" && install.state === "undoing") finishPackRemoval(db, install.pack);
    else {
      const installed = request.outcome === "installed";
      const message = installed ? `Installed ${install.pack}; waiting for local presence.` : "install failed: the principal checked that the pack is absent";
      db.query("UPDATE desk_capability_installs SET state = ?, error = ?, at = ? WHERE id = ?").run(installed ? "installed" : "failed", installed ? null : "the principal checked that the pack is absent", now, install.id);
      db.query("UPDATE desk_done SET status = ?, message = ?, updated_at = ? WHERE action = ? AND item_key = ?").run(installed ? "done" : "failed", message, now, CAPABILITY_INSTALL, install.id);
    }
    return { ok: true, message: `Recorded ${install.pack} as ${request.outcome}.` };
  })();
}
