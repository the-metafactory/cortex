import type { Database } from "bun:sqlite";
import type { CapabilityInstallView } from "./routine-capability-contract";
import type { RoutineResult } from "./routine-action-contract";

export interface CapabilityInstall extends CapabilityInstallView { config_hash: string; refs: string }
export const CAPABILITY_INSTALL = "capability.install";

export function recordInstallOutcome(db: Database, id: string, outcome: RoutineResult, now: number): RoutineResult {
  return db.transaction(() => {
    const install = readCapabilityInstall(db, id);
    if (!install) throw new Error("The capability installation receipt is missing.");
    const result: RoutineResult = outcome.ok ? { ok: true, message: `Installed ${install.bundle}; waiting for local presence.` } : { ...outcome, error: `install failed: ${outcome.error}` };
    db.query("UPDATE desk_capability_installs SET state = ?, error = ?, at = ? WHERE id = ?").run(outcome.ok ? "installed" : outcome.uncertain ? "running" : "failed", outcome.ok ? null : outcome.error, now, id);
    db.query("UPDATE desk_done SET status = ?, message = ?, updated_at = ? WHERE action = ? AND item_key = ?").run(result.ok ? "done" : "failed", result.ok ? result.message : result.error, now, CAPABILITY_INSTALL, id);
    return result;
  })();
}

export function pendingCapabilityInstalls(db: Database): CapabilityInstallView[] {
  return db.query<CapabilityInstall, []>("SELECT * FROM desk_capability_installs WHERE state IN ('running', 'undoing') ORDER BY at").all().map(capabilityInstallView);
}

export function finishBundleRemoval(db: Database, bundle: string): void {
  db.query("UPDATE desk_capability_installs SET state = 'undone', error = NULL WHERE bundle = ? AND state IN ('installed', 'undoing')").run(bundle);
  db.query("DELETE FROM desk_done WHERE action = ? AND item_key IN (SELECT id FROM desk_capability_installs WHERE bundle = ? AND state = 'undone')").run(CAPABILITY_INSTALL, bundle);
}

export function readCapabilityInstall(db: Database, id: string): CapabilityInstall | null {
  return db.query<CapabilityInstall, [string]>("SELECT * FROM desk_capability_installs WHERE id = ?").get(id);
}

export function latestCapabilityInstall(db: Database, hash: string, ref: string): CapabilityInstall | null {
  return db.query<CapabilityInstall, [string, string]>("SELECT * FROM desk_capability_installs WHERE config_hash = ? AND EXISTS (SELECT 1 FROM json_each(refs) WHERE value = ?) ORDER BY rowid DESC LIMIT 1").get(hash, ref);
}

export function capabilityInstallView(install: CapabilityInstall): CapabilityInstallView {
  const { id, bundle, state, error, at } = install;
  return { id, bundle, state, error, at };
}
