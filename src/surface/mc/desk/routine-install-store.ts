import type { Database } from "bun:sqlite";
import type { CapabilityInstallView } from "./routine-capability-contract";

export interface CapabilityInstall extends CapabilityInstallView { config_hash: string; refs: string }
export const CAPABILITY_INSTALL = "capability.install";

export function pendingCapabilityInstalls(db: Database): CapabilityInstallView[] {
  return db.query<CapabilityInstall, []>("SELECT * FROM desk_capability_installs WHERE state IN ('running', 'undoing') ORDER BY at").all().map(capabilityInstallView);
}

export function finishPackRemoval(db: Database, pack: string): void {
  db.query("UPDATE desk_capability_installs SET state = 'undone', error = NULL WHERE pack = ? AND state IN ('installed', 'undoing')").run(pack);
  db.query("DELETE FROM desk_done WHERE action = ? AND item_key IN (SELECT id FROM desk_capability_installs WHERE pack = ? AND state = 'undone')").run(CAPABILITY_INSTALL, pack);
}

export function readCapabilityInstall(db: Database, id: string): CapabilityInstall | null {
  return db.query<CapabilityInstall, [string]>("SELECT * FROM desk_capability_installs WHERE id = ?").get(id);
}

export function latestCapabilityInstall(db: Database, hash: string, ref: string): CapabilityInstall | null {
  return db.query<CapabilityInstall, [string, string]>("SELECT * FROM desk_capability_installs WHERE config_hash = ? AND EXISTS (SELECT 1 FROM json_each(refs) WHERE value = ?) ORDER BY rowid DESC LIMIT 1").get(hash, ref);
}

export function capabilityInstallView(install: CapabilityInstall): CapabilityInstallView {
  const { id, pack, state, error, at } = install;
  return { id, pack, state, error, at };
}
